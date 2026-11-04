// Prompts: listed and filled in by the SDK 2.x client (2026-07-28) and the SDK 1.x client (2025 era), over stdio
// and HTTP. Prompts need no credentials, so they work before sign-in on the hosted server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "dist", "index.js");

const PROMPTS = [
  "crawl_docs",
  "extract_document_table",
  "find_local_leads",
  "research_topic",
  "track_prices",
  "use_template",
  "watch_page",
];

const children = [];
after(() => children.forEach(c => c.kill()));

async function startHttp() {
  const srv = createNetServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, SPIDRA_API_KEY: "", HTTP_STREAMABLE_SERVER: "true", PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return base;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("server didn't start");
}

async function exercise(client) {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), PROMPTS);
  for (const p of prompts) {
    assert.ok(p.title && p.description, `${p.name} has a title and description`);
    assert.ok(p.arguments?.length, `${p.name} has arguments`);
    for (const a of p.arguments) assert.ok(a.description, `${p.name}.${a.name} has a description`);
    assert.doesNotMatch(p.description, /\u2014/, `${p.name}: no em dashes`);
  }
  const leads = prompts.find(p => p.name === "find_local_leads");
  assert.deepEqual(leads.arguments.filter(a => a.required).map(a => a.name).sort(), ["area", "business"]);

  const filled = await client.getPrompt({ name: "find_local_leads", arguments: { business: "dentist", area: "Lekki, Lagos" } });
  const text = filled.messages[0].content.text;
  assert.equal(filled.messages[0].role, "user");
  assert.match(text, /Find dentist businesses in Lekki, Lagos/);
  assert.match(text, /google-maps-leads/);
  assert.match(text, /"estimate": true/);

  const crawl = await client.getPrompt({ name: "crawl_docs", arguments: { url: "https://docs.example.com", maxPages: "10" } });
  assert.match(crawl.messages[0].content.text, /"maxPages": 10/);

  // Every prompt fills in with only its required arguments, and none leaks "undefined" into the text.
  for (const p of prompts) {
    const args = Object.fromEntries(p.arguments.filter(a => a.required).map(a => [a.name, "x"]));
    const r = await client.getPrompt({ name: p.name, arguments: args });
    assert.doesNotMatch(r.messages[0].content.text, /undefined|\u2014/, `${p.name} text is clean`);
  }

  // A missing required argument is refused.
  await assert.rejects(client.getPrompt({ name: "find_local_leads", arguments: { business: "dentist" } }));
}

const stdioEnv = () => ({ ...process.env, SPIDRA_API_KEY: "" });

test("stdio: the SDK 2.x client (2026-07-28) lists and fills prompts", async () => {
  const client = new ModernClient({ name: "modern", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new ModernStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    assert.ok(client.getServerCapabilities()?.prompts, "prompts capability advertised");
    await exercise(client);
  } finally {
    await client.close();
  }
});

test("stdio: the SDK 1.x client (2025 era) lists and fills prompts", async () => {
  const client = new LegacyClient({ name: "legacy", version: "1" });
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    assert.ok(client.getServerCapabilities()?.prompts, "prompts capability advertised");
    await exercise(client);
  } finally {
    await client.close();
  }
});

test("http: both eras get prompts without credentials", async t => {
  const base = await startHttp();
  await t.test("SDK 2.x, 2026-07-28", async () => {
    const client = new ModernClient({ name: "modern", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new ModernHttp(new URL(`${base}/mcp`)));
    await exercise(client);
    await client.close();
  });
  await t.test("SDK 1.x, 2025 era", async () => {
    const client = new LegacyClient({ name: "legacy", version: "1" });
    await client.connect(new LegacyHttp(new URL(`${base}/mcp`)));
    await exercise(client);
    await client.close();
  });
});
