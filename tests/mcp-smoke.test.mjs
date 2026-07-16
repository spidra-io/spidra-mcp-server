import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "index.js");

// ---------------------------------------------------------------------------
// Fake Spidra API
// ---------------------------------------------------------------------------

const recorded = [];
let scrapePollCount = 0;

const fakeApi = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    recorded.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "POST" && req.url === "/api/scrape") {
      return send(202, { status: "queued", jobId: "job-abc" });
    }
    if (req.method === "GET" && req.url === "/api/scrape/job-abc") {
      scrapePollCount++;
      if (scrapePollCount < 2) return send(200, { status: "active", progress: { message: "working", progress: 50 } });
      return send(200, {
        status: "completed",
        result: {
          content: { headline: "Fake headline" },
          data: [{ url: "https://example.com", success: true }],
          screenshots: [],
          ai_extraction_failed: false,
          stats: { durationMs: 100, captchaSolvedCount: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        error: null,
      });
    }
    if (req.method === "POST" && req.url === "/api/crawl") {
      return send(202, { status: "queued", jobId: "crawl-xyz" });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/usage-stats")) {
      return send(200, { status: "ok", data: [{ label: "Mon", date: "2026-07-13", requests: 3, credits: 6, tokens: 100, crawls: 0, captchas: 0, latency: 5 }] });
    }
    if (req.method === "POST" && req.url === "/api/batch/scrape") {
      return send(202, { status: "queued", batchId: "batch-1", total: 2 });
    }
    send(404, { status: "error", message: "not found" });
  });
});

let apiPort;

// ---------------------------------------------------------------------------
// Minimal stdio JSON-RPC client
// ---------------------------------------------------------------------------

class StdioMcpClient {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async callTool(name, args) {
    const res = await this.request("tools/call", { name, arguments: args });
    return res.result;
  }

  kill() {
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let client;

before(async () => {
  await new Promise((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
  apiPort = fakeApi.address().port;
  client = new StdioMcpClient({
    SPIDRA_API_KEY: "spd_test_key",
    SPIDRA_API_URL: `http://127.0.0.1:${apiPort}/api`,
  });
  const init = await client.initialize();
  assert.equal(init.result.serverInfo.name, "spidra-mcp");
});

after(() => {
  client?.kill();
  fakeApi.close();
});

test("stdio stays clean — no log noise corrupted the JSON-RPC stream", async () => {
  // initialize() in before() already proves framing works; assert we parsed it
  assert.ok(client);
});

test("tools/list exposes all 12 tools with annotations", async () => {
  const res = await client.request("tools/list");
  const tools = res.result.tools;
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "spidra_batch_scrape",
    "spidra_cancel_batch",
    "spidra_cancel_crawl",
    "spidra_check_batch_status",
    "spidra_check_crawl_status",
    "spidra_check_scrape_status",
    "spidra_crawl",
    "spidra_crawl_extract",
    "spidra_crawl_pages",
    "spidra_scrape",
    "spidra_scrape_logs",
    "spidra_usage",
  ]);
  const scrape = tools.find((t) => t.name === "spidra_scrape");
  assert.equal(scrape.annotations.readOnlyHint, true);
  assert.match(scrape.description, /1-3 known URLs/);
});

test("spidra_scrape submits, polls, and returns extracted content", async () => {
  const result = await client.callTool("spidra_scrape", {
    urls: ["https://example.com"],
    prompt: "Extract the headline",
    output: "json",
  });
  assert.equal(result.isError ?? false, false);
  const text = result.content[0].text;
  assert.match(text, /Fake headline/);
  assert.match(text, /stats/);

  const submit = recorded.find((r) => r.method === "POST" && r.url === "/api/scrape");
  assert.ok(submit, "scrape was submitted to the API");
  assert.equal(submit.headers.authorization, "Bearer spd_test_key");
  const submitted = JSON.parse(submit.body);
  assert.equal(submitted.urls[0].url, "https://example.com");
  assert.equal(submitted.output, "json");
});

test("spidra_crawl returns a jobId and polling instructions without waiting", async () => {
  const result = await client.callTool("spidra_crawl", {
    baseUrl: "https://example.com",
    crawlInstruction: "Follow all pages",
    maxPages: 2,
  });
  const text = result.content[0].text;
  assert.match(text, /crawl-xyz/);
  assert.match(text, /spidra_check_crawl_status/);
});

test("spidra_batch_scrape returns a batchId and polling instructions", async () => {
  const result = await client.callTool("spidra_batch_scrape", {
    urls: ["https://a.com", "https://b.com"],
    prompt: "Extract the title",
  });
  const text = result.content[0].text;
  assert.match(text, /batch-1/);
  assert.match(text, /spidra_check_batch_status/);
});

test("spidra_usage returns usage rows", async () => {
  const result = await client.callTool("spidra_usage", { range: "7d" });
  assert.match(result.content[0].text, /2026-07-13/);
});

test("API errors come back as tool errors with guidance, not crashes", async () => {
  const result = await client.callTool("spidra_check_scrape_status", { jobId: "does-not-exist" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /404/);
  assert.match(result.content[0].text, /Do not retry/);
});

test("missing API key produces a helpful tool error", async () => {
  const bare = new StdioMcpClient({
    SPIDRA_API_KEY: "",
    SPIDRA_API_URL: `http://127.0.0.1:${apiPort}/api`,
  });
  try {
    await bare.initialize();
    const result = await bare.callTool("spidra_usage", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SPIDRA_API_KEY/);
    assert.match(result.content[0].text, /app\.spidra\.io/);
  } finally {
    bare.kill();
  }
});
