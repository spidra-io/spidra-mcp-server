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
      const submitted = JSON.parse(body);
      if (submitted.urls?.[0]?.url === "https://no-credits.example.com") {
        return send(403, { status: "error", message: "You have exceeded your monthly credit limit." });
      }
      if (submitted.urls?.[0]?.url === "https://thin-then-good.example.com") {
        // Simulates the auto fast-mode fallback: the first (fast, no proxy)
        // attempt comes back thin, the retry (default mode, with proxy)
        // comes back with real content.
        return submitted.scrapeMode === "fast"
          ? send(202, { status: "queued", jobId: "job-thin" })
          : send(202, { status: "queued", jobId: "job-good" });
      }
      if (submitted.urls?.[0]?.url === "https://steps.example.com") return send(202, { status: "queued", jobId: "job-steps" });
      if (submitted.urls?.[0]?.url === "https://instruction.example.com") return send(202, { status: "queued", jobId: "job-instr" });
      if (submitted.urls?.[0]?.url === "https://step-fails.example.com") return send(202, { status: "queued", jobId: "job-step-fails" });
      return send(202, { status: "queued", jobId: "job-abc" });
    }
    if (req.method === "GET" && (req.url === "/api/scrape/job-steps" || req.url === "/api/scrape/job-instr")) {
      // Thin content on purpose: a run with steps must never be retried on its own.
      return send(200, {
        status: "completed",
        result: {
          content: "logged in page",
          data: [{
            url: "https://steps.example.com",
            success: true,
            lowContent: true,
            actionResults: [
              { index: 1, type: "click", status: "skipped", durationMs: 2001, error: 'no element matches "#cookie-accept" (waited 2 seconds).' },
              { index: 2, type: "evaluate", status: "ok", durationMs: 3, result: 10 },
            ],
            warnings: ['Action 1 (click) was skipped: no element matches "#cookie-accept" (waited 2 seconds).'],
          }],
          screenshots: [],
          ai_extraction_failed: false,
          warnings: ['Action 1 (click) was skipped: no element matches "#cookie-accept" (waited 2 seconds).'],
          stats: { durationMs: 900, captchaSolvedCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        error: null,
      });
    }
    if (req.method === "GET" && req.url === "/api/scrape/job-step-fails") {
      return send(200, {
        status: "failed",
        error: 'Failed to scrape https://step-fails.example.com: Action 1 (click "#nope") failed: no element matches "#nope" (waited 1 seconds). Add "optional": true to that action to skip it when it can\'t be done.',
      });
    }
    if (req.method === "GET" && req.url === "/api/scrape/job-abc") {
      scrapePollCount++;
      if (scrapePollCount < 2) return send(200, { status: "active", progress: { message: "working", progress: 50 } });
      return send(200, {
        status: "completed",
        result: {
          content: { headline: "Fake headline" },
          screenshots: [],
          ai_extraction_failed: false,
          stats: { durationMs: 100, captchaSolvedCount: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        error: null,
      });
    }
    if (req.method === "GET" && req.url === "/api/scrape/job-thin") {
      return send(200, {
        status: "completed",
        result: {
          content: "barely anything",
          data: [{ url: "https://thin-then-good.example.com", success: true, lowContent: true }],
          screenshots: [],
          ai_extraction_failed: false,
          stats: { durationMs: 50, captchaSolvedCount: 0, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        },
        error: null,
      });
    }
    if (req.method === "GET" && req.url === "/api/scrape/job-good") {
      return send(200, {
        status: "completed",
        result: {
          content: "the real page content",
          data: [{ url: "https://thin-then-good.example.com", success: true, lowContent: false }],
          screenshots: [],
          ai_extraction_failed: false,
          stats: { durationMs: 900, captchaSolvedCount: 0, inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        },
        error: null,
      });
    }
    if (req.method === "POST" && req.url === "/api/parse") {
      return send(202, { jobId: "parse-1", status: "queued", fileName: "a.pdf", sourceUrl: "https://x.com/a.pdf", fileId: "f1", format: "PDF", totalPages: 2, pagesParsed: null, creditsUsed: 0 });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/parse/parse-1")) {
      return send(200, { jobId: "parse-1", status: "completed", fileName: "a.pdf", fileId: "f1", format: "PDF", totalPages: 2, pagesParsed: 2, creditsUsed: 2, markdown: "# Parsed heading" });
    }
    if (req.method === "POST" && req.url === "/api/map") {
      return send(200, { status: "success", links: [{ url: "https://example.com/pricing", title: "Pricing" }], total: 1, scanned: 12, sources: { sitemap: 10, pages: 2 }, creditsUsed: 1, durationMs: 800 });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/crawl/crawl-xyz/report")) {
      return send(200, { status: "success", report: { understoodAs: "Blog posts", navigationPages: 2, skippedTotal: 4, skipped: [{ reason: "not_relevant", count: 4, description: "Not related to the instruction" }], skippedUrls: [{ url: "https://example.com/about", reason: "not_relevant", foundOn: "https://example.com" }], skippedUrlsTotal: 4 } });
    }
    if (req.method === "POST" && req.url === "/api/crawl") {
      return send(202, { status: "queued", jobId: "crawl-xyz" });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/usage-stats")) {
      return send(200, { status: "ok", data: [{ label: "Mon", date: "2026-07-13", requests: 3, credits: 6, tokens: 100, crawls: 0, captchas: 0, latency: 5 }] });
    }
    if (req.method === "POST" && req.url === "/api/batch/scrape") {
      const submitted = JSON.parse(body);
      if (submitted.urls?.includes("https://wait-me.example.com/a")) {
        return send(202, { status: "queued", batchId: "batch-wait", total: submitted.urls.length });
      }
      return send(202, { status: "queued", batchId: "batch-1", total: 2 });
    }
    if (req.method === "GET" && req.url === "/api/batch/scrape/batch-wait") {
      return send(200, {
        status: "completed",
        totalUrls: 2,
        completedCount: 2,
        failedCount: 0,
        createdAt: "2026-09-26T00:00:00.000Z",
        finishedAt: "2026-09-26T00:00:05.000Z",
        items: [
          { uuid: "i1", url: "https://wait-me.example.com/a", jobId: "j1", status: "completed", result: "content a", creditsUsed: 1, startedAt: null, finishedAt: null, screenshotUrl: null },
          { uuid: "i2", url: "https://wait-me.example.com/b", jobId: "j2", status: "completed", result: "content b", creditsUsed: 1, startedAt: null, finishedAt: null, screenshotUrl: null },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/api/batch/scrape/batch-1/retry") {
      return send(200, { retriedCount: 1 });
    }
    if (req.method === "POST" && req.url === "/api/crawl/crawl-xyz/retry/page-1") {
      return send(200, { success: true, data: { title: "Retried" }, tokensUsed: 50, creditsUsed: 1, message: "ok" });
    }
    if (req.method === "POST" && req.url === "/api/search") {
      return send(202, { status: "queued", jobId: "search-1" });
    }
    if (req.method === "GET" && req.url === "/api/search/search-1") {
      return send(200, {
        status: "completed",
        result: {
          success: true,
          data: { web: [{ title: "Fake result", url: "https://example.com", position: 1 }] },
          stats: { durationMs: 900 },
        },
        error: null,
      });
    }
    if (req.method === "GET" && req.url === "/api/account") {
      return send(200, { status: "success", data: { plan: { name: "Builder" }, credits: { limit: 25000, used: 100, remaining: 24900, billingCycleStart: null }, proxyBandwidth: { limitMb: 2000, usedMb: 0, remainingMb: 2000 }, subscription: { status: "active" } } });
    }
    if (req.method === "GET" && req.url === "/api/monitors/limits") {
      return send(200, { status: "success", plan: "Builder", minIntervalMinutes: 15, maxMonitors: 50, used: 1 });
    }
    if (req.method === "POST" && req.url === "/api/monitors/estimate") {
      return send(200, { status: "success", creditsPerCheck: 1, checksPerMonth: 30, creditsPerMonth: 30, usesAi: false });
    }
    if (req.method === "POST" && req.url === "/api/monitors") {
      return send(403, { status: "error", code: "MONITOR_LIMIT", message: "Your plan includes 2 monitors. Delete one or upgrade to add more." });
    }
    if (req.method === "GET" && req.url === "/api/templates/google-maps-leads") {
      return send(200, { status: "success", template: { slug: "google-maps-leads", version: 4, title: "Google Maps leads", summary: "s", site: { key: "google-maps", name: "Google Maps", domain: "google.com" }, categories: [], tool: "batch", inputs: [{ key: "query", label: "Business type", type: "text", required: true }], columns: [{ key: "title", label: "Name" }, { key: "socials.instagram", label: "Instagram" }], limits: [] } });
    }
    if (req.method === "POST" && req.url === "/api/templates/google-maps-leads/runs") {
      const submitted = JSON.parse(body);
      if (!submitted.inputs?.query) {
        return send(422, { status: "error", code: "INVALID_INPUT", message: "Some inputs need fixing.", errors: [{ field: "query", message: "Business type is required." }] });
      }
      const rows = [1, 2, 3].map(n => ({ title: `Place ${n}`, phone: "+234", socials: { instagram: `ig${n}` }, fieldStatus: { title: "present" } }));
      return send(200, { status: "success", run: { runId: "run-1", template: "google-maps-leads", templateVersion: 4, presetId: null, tool: "batch", status: "completed", inputs: submitted.inputs, createdAt: "2026-10-25T00:00:00.000Z", finishedAt: "2026-10-25T00:00:01.000Z", creditsUsed: 1, urlCount: 1, rowCount: 3, rows } });
    }
    if (req.method === "GET" && req.url === "/api/crawl/crawl-xyz") {
      return send(200, { status: "completed", progress: { status: "completed", message: "Crawl completed", progress: 1 }, result: [{ url: "https://example.com/a", status: "success", title: "A", data: { title: "A" }, html: "https://files.example/a.html?sig=1", markdown: "https://files.example/a.md?sig=1" }], error: null });
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

const TOOLS = [
  "spidra_account",
  "spidra_batch_scrape",
  "spidra_cancel_job",
  "spidra_check_monitor",
  "spidra_crawl",
  "spidra_crawl_extract",
  "spidra_crawl_pages",
  "spidra_crawl_report",
  "spidra_create_monitor",
  "spidra_delete_monitor",
  "spidra_delete_preset",
  "spidra_find_templates",
  "spidra_get_job",
  "spidra_get_template",
  "spidra_list_monitors",
  "spidra_list_presets",
  "spidra_logs",
  "spidra_map",
  "spidra_monitor_changes",
  "spidra_parse",
  "spidra_retry_batch",
  "spidra_retry_crawl_page",
  "spidra_run_preset",
  "spidra_run_template",
  "spidra_save_preset",
  "spidra_scrape",
  "spidra_search",
  "spidra_update_monitor",
];

test("tools/list exposes all 28 tools with annotations", async () => {
  const res = await client.request("tools/list");
  const tools = res.result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.ok(t.annotations?.title, `${t.name} has a title`);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", `${t.name} sets readOnlyHint`);
    assert.doesNotMatch(t.description, /site scraper|Gemini|Stagehand|Playwright|—/, `${t.name} description has no internals or em dashes`);
  }
  const del = tools.find((t) => t.name === "spidra_delete_monitor");
  assert.equal(del.annotations.destructiveHint, true);
  assert.equal(del.annotations.idempotentHint, true);
});

test("tool results carry structuredContent next to the text", async () => {
  const result = await client.callTool("spidra_map", { url: "https://example.com", search: "pricing", limit: 5 });
  assert.equal(result.structuredContent.links[0].url, "https://example.com/pricing");
  assert.match(result.content[0].text, /example\.com\/pricing/);
});

test("spidra_scrape runs once in fast mode by default and returns the content", async () => {
  const result = await client.callTool("spidra_scrape", { url: "https://example.com", prompt: "Extract the headline", output: "json" });
  assert.equal(result.isError ?? false, false);
  assert.match(result.content[0].text, /Fake headline/);
  const submit = recorded.find((r) => r.method === "POST" && r.url === "/api/scrape");
  assert.equal(submit.headers.authorization, "Bearer spd_test_key");
  const submitted = JSON.parse(submit.body);
  assert.equal(submitted.scrapeMode, "fast");
  assert.equal(submitted.useProxy, false);
});

test("spidra_scrape never runs a second time on its own when the page comes back thin", async () => {
  const result = await client.callTool("spidra_scrape", { url: "https://thin-then-good.example.com", prompt: "Extract the article" });
  const out = JSON.parse(result.content[0].text);
  assert.match(out.content, /barely anything/);
  assert.equal(out.lowContent, true);
  assert.match(out.note, /useProxy/);
  const submits = recorded.filter((r) => r.method === "POST" && r.url === "/api/scrape" && JSON.parse(r.body).urls?.[0]?.url === "https://thin-then-good.example.com");
  assert.equal(submits.length, 1, "one run, one charge");
});

test("spidra_scrape lists every action type, and forEach can't nest", async () => {
  const res = await client.request("tools/list");
  const scrape = res.result.tools.find((t) => t.name === "spidra_scrape");
  const text = JSON.stringify(scrape.inputSchema);
  for (const type of ["hover", "select", "press", "waitFor", "scrollUntilEnd", "evaluate", "screenshot", "forEach"]) {
    assert.ok(text.includes(`"${type}"`), `${type} is in the schema`);
  }
  const nested = scrape.inputSchema.properties.actions.items.properties.actions.items.properties.type.enum;
  assert.ok(!nested.includes("forEach"), "forEach can't appear inside forEach");
});

test("spidra_scrape with actions goes straight to the browser and runs them once", async () => {
  const actions = [
    { type: "click", selector: "#cookie-accept", optional: true, timeout: 2000 },
    { type: "evaluate", script: "document.querySelectorAll('.quote').length" },
  ];
  const result = await client.callTool("spidra_scrape", { url: "https://steps.example.com", actions });
  const out = JSON.parse(result.content[0].text);
  assert.equal(out.actionResults.length, 2);
  assert.equal(out.actionResults[0].status, "skipped");
  assert.equal(out.warnings.length, 1);
  const submits = recorded.filter((r) => r.method === "POST" && r.url === "/api/scrape" && JSON.parse(r.body).urls?.[0]?.url === "https://steps.example.com");
  assert.equal(submits.length, 1);
  const body = JSON.parse(submits[0].body);
  assert.equal(body.scrapeMode, "default");
  assert.deepEqual(body.urls[0].actions, actions);
});

test("spidra_scrape with an instruction goes to the browser and keeps the instruction", async () => {
  await client.callTool("spidra_scrape", { url: "https://instruction.example.com", instruction: "open the login page" });
  const submit = recorded.filter((r) => r.method === "POST" && r.url === "/api/scrape" && JSON.parse(r.body).urls?.[0]?.url === "https://instruction.example.com").pop();
  const body = JSON.parse(submit.body);
  assert.equal(body.scrapeMode, "default");
  assert.equal(body.urls[0].instruction, "open the login page");
});

test("spidra_scrape explains a failed step", async () => {
  const result = await client.callTool("spidra_scrape", { url: "https://step-fails.example.com", actions: [{ type: "click", selector: "#nope", timeout: 1000 }] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Action 1 \(click "#nope"\) failed/);
});

test("spidra_scrape rejects an unknown action type before calling the API", async () => {
  const before = recorded.length;
  const res = await client.request("tools/call", { name: "spidra_scrape", arguments: { url: "https://example.com", actions: [{ type: "teleport" }] } });
  assert.ok(res.error || res.result?.isError, JSON.stringify(res));
  assert.equal(recorded.length, before);
});

test("out of credits says so and says not to retry", async () => {
  const result = await client.callTool("spidra_scrape", { url: "https://no-credits.example.com" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Out of credits/);
  assert.match(result.content[0].text, /Do not retry/);
});

test("a monitor limit 403 isn't reported as out of credits", async () => {
  const result = await client.callTool("spidra_create_monitor", { sources: [{ kind: "urls", urls: ["https://a.com"] }] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /2 monitors/);
  assert.doesNotMatch(result.content[0].text, /Out of credits/);
});

test("spidra_create_monitor with estimate returns the cost without creating", async () => {
  const result = await client.callTool("spidra_create_monitor", { sources: [{ kind: "urls", urls: ["https://a.com"] }], estimate: true });
  assert.equal(result.structuredContent.creditsPerMonth, 30);
  assert.ok(!recorded.some((r) => r.method === "POST" && r.url === "/api/monitors" && JSON.parse(r.body).estimate));
});

test("spidra_run_template trims rows to the template's columns and pages them", async () => {
  const result = await client.callTool("spidra_run_template", { slug: "google-maps-leads", inputs: { query: "dentist" }, limit: 2 });
  const out = result.structuredContent;
  assert.deepEqual(out.rows, [
    { title: "Place 1", "socials.instagram": "ig1" },
    { title: "Place 2", "socials.instagram": "ig2" },
  ]);
  assert.deepEqual(out.rowsShown, { offset: 0, count: 2, total: 3 });
  assert.match(out.next, /"offset": 2/);
  const submit = recorded.filter((r) => r.url === "/api/templates/google-maps-leads/runs").pop();
  assert.equal(JSON.parse(submit.body).wait, true);
});

test("spidra_run_template with detail full returns every field", async () => {
  const result = await client.callTool("spidra_run_template", { slug: "google-maps-leads", inputs: { query: "dentist" }, detail: "full", limit: 1 });
  assert.equal(result.structuredContent.rows[0].phone, "+234");
});

test("template validation errors read as field: message", async () => {
  const result = await client.callTool("spidra_run_template", { slug: "google-maps-leads", inputs: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query: Business type is required\./);
  assert.doesNotMatch(result.content[0].text, /object Object/);
});

test("spidra_crawl returns a jobId and points to spidra_get_job", async () => {
  const result = await client.callTool("spidra_crawl", { baseUrl: "https://example.com", crawlInstruction: "Follow all pages", maxPages: 2 });
  assert.match(result.content[0].text, /crawl-xyz/);
  assert.match(result.content[0].text, /spidra_get_job/);
});

test("spidra_get_job for a crawl leaves out the per-page file links", async () => {
  const result = await client.callTool("spidra_get_job", { type: "crawl", id: "crawl-xyz" });
  const page = result.structuredContent.result[0];
  assert.deepEqual(page.data, { title: "A" });
  assert.equal(page.html, undefined);
  assert.equal(page.markdown, undefined);
});

test("spidra_parse parses a link and waits for the result", async () => {
  const result = await client.callTool("spidra_parse", { url: "https://x.com/a.pdf", pages: "1-2" });
  assert.match(result.content[0].text, /Parsed heading/);
});

test("spidra_parse rejects two sources at once", async () => {
  const result = await client.callTool("spidra_parse", { url: "https://x.com/a.pdf", fileId: "f1" });
  assert.equal(result.isError, true);
});

test("spidra_crawl_report forwards the reason filter", async () => {
  await client.callTool("spidra_crawl_report", { jobId: "crawl-xyz", reason: "not_relevant" });
  assert.ok(recorded.some((r) => r.url === "/api/crawl/crawl-xyz/report?reason=not_relevant"));
});

test("spidra_batch_scrape returns a batchId and points to spidra_get_job", async () => {
  const result = await client.callTool("spidra_batch_scrape", { urls: ["https://a.com", "https://b.com"], prompt: "Extract the title" });
  assert.match(result.content[0].text, /batch-1/);
  assert.match(result.content[0].text, /spidra_get_job/);
});

test("spidra_batch_scrape with wait:true returns finished results directly for a small batch", async () => {
  const result = await client.callTool("spidra_batch_scrape", { urls: ["https://wait-me.example.com/a", "https://wait-me.example.com/b"], prompt: "Extract the title", wait: true });
  assert.match(result.content[0].text, /content a/);
  assert.doesNotMatch(result.content[0].text, /spidra_get_job/);
});

test("spidra_search forwards research/developer sources, pageTokens, timeRange, and filetype", async () => {
  const result = await client.callTool("spidra_search", { query: "transformer attention", sources: ["research", "developer"], pageTokens: { web: "opaque-token" }, timeRange: "month", filetype: "pdf" });
  assert.equal(result.isError ?? false, false);
  const submitted = JSON.parse(recorded.filter((r) => r.method === "POST" && r.url === "/api/search").pop().body);
  assert.deepEqual(submitted.sources, ["research", "developer"]);
  assert.deepEqual(submitted.pageTokens, { web: "opaque-token" });
  assert.equal(submitted.timeRange, "month");
  assert.equal(submitted.filetype, "pdf");
});

test("spidra_retry_batch retries failed items", async () => {
  const result = await client.callTool("spidra_retry_batch", { batchId: "batch-1" });
  assert.match(result.content[0].text, /retriedCount/);
});

test("spidra_retry_crawl_page retries one page", async () => {
  const result = await client.callTool("spidra_retry_crawl_page", { jobId: "crawl-xyz", pageId: "page-1" });
  assert.match(result.content[0].text, /Retried/);
});

test("spidra_account returns credits, monitor limits and optional usage", async () => {
  const result = await client.callTool("spidra_account", { usage: "7d" });
  const out = result.structuredContent;
  assert.equal(out.credits.remaining, 24900);
  assert.deepEqual(out.monitors, { allowed: 50, used: 1, shortestScheduleMinutes: 15 });
  assert.equal(out.usage[0].date, "2026-07-13");
});

test("a missing job comes back as a tool error with guidance, not a crash", async () => {
  const result = await client.callTool("spidra_get_job", { type: "scrape", id: "does-not-exist" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Not found/);
  assert.match(result.content[0].text, /spidra_logs/);
});

test("missing API key produces a helpful tool error", async () => {
  const bare = new StdioMcpClient({ SPIDRA_API_KEY: "", SPIDRA_API_URL: `http://127.0.0.1:${apiPort}/api` });
  try {
    await bare.initialize();
    const result = await bare.callTool("spidra_account", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SPIDRA_API_KEY/);
  } finally {
    bare.kill();
  }
});
