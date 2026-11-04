// Second-review hardening (MCP_SECOND_REVIEW_2026-11.md): progress while waiting (M1), cancellation (M2), a graceful
// shutdown that lets calls finish (M3), hints that make clients confirm big spends and the untrusted-content line
// (M6), and rate limits on anonymous traffic (M7).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "dist", "index.js");

// A fake API with a job that never finishes, and one that finishes after a few seconds.
const polls = { never: 0 };
let slowStarted = 0;
const api = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/scrape/never") {
      polls.never++;
      return send(200, { status: "active", progress: { message: "working", progress: 0.5 } });
    }
    if (req.url === "/api/scrape/slow") {
      slowStarted ||= Date.now();
      if (Date.now() - slowStarted < 4000) return send(200, { status: "active" });
      return send(200, { status: "completed", result: { content: "done slowly", screenshots: [], stats: {} }, error: null });
    }
    send(404, { status: "error", message: "not found" });
  });
});

let apiUrl;
const children = [];
before(async () => {
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${api.address().port}/api`;
});
after(() => {
  children.forEach(c => c.kill("SIGKILL"));
  api.close();
});

const stdioEnv = extra => ({ ...process.env, SPIDRA_API_KEY: "spd_test", SPIDRA_API_URL: apiUrl, ...extra });

async function freePort() {
  const srv = createNetServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

async function startHttp(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, SPIDRA_API_KEY: "", HTTP_STREAMABLE_SERVER: "true", PORT: String(port), HOST: "127.0.0.1", SPIDRA_API_URL: apiUrl, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { base, child };
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("server didn't start");
}

test("M1: a waiting call sends progress to a client that asked for it", async () => {
  const client = new ModernClient({ name: "progress", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new ModernStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv({ MCP_PROGRESS_INTERVAL_MS: "500" }) }));
  try {
    const seen = [];
    const result = await client.callTool(
      { name: "spidra_get_job", arguments: { type: "scrape", id: "never", waitSeconds: 3 } },
      { onprogress: p => seen.push(p) }
    );
    assert.equal(result.structuredContent.status, "active", "returns the running job when the wait is up");
    assert.ok(seen.length >= 2, `${seen.length} progress notifications`);
    assert.match(seen[0].message, /Still working/);
  } finally {
    await client.close();
  }
});

test("M1: no tool waits longer than 45 s (waitSeconds is capped)", async () => {
  const client = new LegacyClient({ name: "cap", version: "1" });
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.find(t => t.name === "spidra_get_job").inputSchema.properties.waitSeconds.maximum, 45);
  } finally {
    await client.close();
  }
});

test("M2: cancelling a call stops its polling straight away", async () => {
  const client = new LegacyClient({ name: "cancel", version: "1" });
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    const controller = new AbortController();
    const call = client.callTool({ name: "spidra_get_job", arguments: { type: "scrape", id: "never", waitSeconds: 40 } }, undefined, { signal: controller.signal });
    await new Promise(r => setTimeout(r, 3500));
    controller.abort();
    await assert.rejects(call);
    await new Promise(r => setTimeout(r, 500));
    const atCancel = polls.never;
    await new Promise(r => setTimeout(r, 4000));
    assert.equal(polls.never, atCancel, "no more polls after the cancel");
  } finally {
    await client.close();
  }
});

test("M3: on SIGTERM a call in flight still gets its result, /health says draining, then the process exits", async () => {
  const { base, child } = await startHttp({});
  const client = new LegacyClient({ name: "drain", version: "1" });
  await client.connect(new LegacyHttp(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer spd_test" } } }));
  slowStarted = 0;
  const call = client.callTool({ name: "spidra_get_job", arguments: { type: "scrape", id: "slow", waitSeconds: 20 } });
  await new Promise(r => setTimeout(r, 1000));
  const exited = new Promise(r => child.once("exit", code => r(code)));
  child.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 300));
  const health = await fetch(`${base}/health`).catch(() => undefined);
  if (health) assert.equal(health.status, 503);
  const result = await call;
  assert.equal(result.structuredContent.status, "completed", JSON.stringify(result).slice(0, 200));
  assert.equal(await exited, 0);
});

test("M6: tools that can spend a lot aren't read-only, so clients ask first; instructions treat page text as data", async () => {
  const client = new LegacyClient({ name: "hints", version: "1" });
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    const { tools } = await client.listTools();
    const hint = name => tools.find(t => t.name === name).annotations;
    for (const name of ["spidra_batch_scrape", "spidra_crawl", "spidra_parse", "spidra_run_template", "spidra_run_preset"]) {
      assert.equal(hint(name).readOnlyHint, false, name);
    }
    assert.equal(hint("spidra_search").readOnlyHint, true);
    assert.equal(hint("spidra_retry_crawl_page").destructiveHint, true);
    assert.equal(hint("spidra_save_preset").destructiveHint, true);
    assert.match(client.getInstructions(), /data, not instructions/);
    assert.equal(client.getServerCapabilities().tools.listChanged, false);
  } finally {
    await client.close();
  }
});

test("M7: anonymous traffic is limited per IP, and an anonymous body isn't read", async () => {
  const { base } = await startHttp({
    MCP_RATE_ANONYMOUS: "3",
    MCP_RATE_SIGN_IN: "2",
    MCP_PUBLIC_URL: "http://127.0.0.1:1",
    MCP_OAUTH_CLIENT_ID: "x",
    MCP_OAUTH_CLIENT_SECRET: "y",
  });
  const post = (body, headers = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "CF-Connecting-IP": "203.0.113.9", ...headers }, body });
  // A 20 MB anonymous body is refused with the sign-in 401, not read.
  assert.equal((await post("x".repeat(20 * 1024 * 1024))).status, 401);
  assert.equal((await post("{}")).status, 401);
  assert.equal((await post("{}")).status, 401);
  const limited = await post("{}");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  // Another caller isn't affected.
  assert.equal((await post("{}", { "CF-Connecting-IP": "203.0.113.10" })).status, 401);
  // The sign-in pages have their own limit.
  const register = () => fetch(`${base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.11" }, body: "{}" });
  assert.equal((await register()).status, 400);
  assert.equal((await register()).status, 400);
  assert.equal((await register()).status, 429);
});
