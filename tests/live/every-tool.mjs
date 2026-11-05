#!/usr/bin/env node
// Calls every tool this server lists, once, through the real server over stdio, against a Spidra API you point it
// at. No model is involved: each call has fixed, small arguments, and later calls use the ids earlier ones return
// (a crawl's pages, a preset, a monitor). It is the "run every tool" check the Claude directory asks for before a
// connector is submitted, and a quick release check.
//
//   npm run build
//   SPIDRA_CHECK_API_URL=http://localhost:4321/api SPIDRA_CHECK_API_KEY_FILE=/path/to/key node tests/live/every-tool.mjs
//
// It spends a few credits on that account (a search, a map, a handful of pages, a short crawl, a parse and a small
// template run) and cleans up the preset and monitor it creates. It refuses port 3000. Against production it asks
// for SPIDRA_CHECK_ALLOW_PRODUCTION=1, since it spends real credits there.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "..", "dist", "index.js");
const API_URL = process.env.SPIDRA_CHECK_API_URL || "http://localhost:4321/api";
const API_KEY = (process.env.SPIDRA_CHECK_API_KEY || (process.env.SPIDRA_CHECK_API_KEY_FILE ? readFileSync(process.env.SPIDRA_CHECK_API_KEY_FILE, "utf8") : "")).trim();

if (!API_KEY) throw new Error("Set SPIDRA_CHECK_API_KEY or SPIDRA_CHECK_API_KEY_FILE.");
if (/:3000\b/.test(API_URL)) throw new Error("Port 3000 is not used for checks.");
if (/api\.spidra\.io/.test(API_URL) && process.env.SPIDRA_CHECK_ALLOW_PRODUCTION !== "1") {
  throw new Error("This spends real credits on production. Set SPIDRA_CHECK_ALLOW_PRODUCTION=1 to run it there.");
}

const PAGE = "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html";
const PAGE_2 = "https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html";
const MISSING = "https://books.toscrape.com/catalogue/this-page-does-not-exist_0/index.html";
const PDF = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_ENTRY],
  env: { ...process.env, SPIDRA_API_KEY: API_KEY, SPIDRA_API_URL: API_URL },
  stderr: "ignore",
});
const client = new Client({ name: "every-tool-check", version: "1.0.0" });
await client.connect(transport);

const listed = (await client.listTools()).tools.map((t) => t.name);
const called = new Set();
const results = [];

/** Calls a tool and records ok or the error. Returns the structured content (or parsed text) for chaining. */
async function call(name, args, { expectError } = {}) {
  called.add(name);
  const started = Date.now();
  let out;
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    out = res.structuredContent ?? (() => { try { return JSON.parse(text); } catch { return { text }; } })();
    const ok = expectError ? Boolean(res.isError) : !res.isError;
    results.push({ name, ok, seconds: (Date.now() - started) / 1000, note: res.isError ? text.slice(0, 160) : "" });
  } catch (err) {
    results.push({ name, ok: false, seconds: (Date.now() - started) / 1000, note: String(err.message).slice(0, 160) });
  }
  return out ?? {};
}

const find = (obj, keys) => {
  // The first value under any of these keys, searching nested objects and arrays.
  const seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return undefined;
    seen.add(o);
    for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k];
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return undefined;
  };
  return walk(obj);
};

// Account and history.
await call("spidra_account", {});
await call("spidra_logs", { tool: "scrape", limit: 3 });

// Finding pages.
await call("spidra_search", { query: "books to scrape sandbox", limit: 3 });
await call("spidra_map", { url: "https://books.toscrape.com", limit: 10 });

// Reading pages.
const scrape = await call("spidra_scrape", { url: PAGE, prompt: "The book's title and price", output: "json" });
// One missing page, so the batch has a failed item to retry (failed pages are free).
const batch = await call("spidra_batch_scrape", { urls: [PAGE, MISSING], prompt: "The book's title and price", output: "json", wait: true });
const batchId = find(batch, ["batchId", "id"]);
if (batchId) await call("spidra_retry_batch", { batchId });
else results.push({ name: "spidra_retry_batch", ok: false, note: "no batch id to retry" }), called.add("spidra_retry_batch");

// A short crawl, then everything that reads or reworks it.
const crawl = await call("spidra_crawl", { baseUrl: "https://books.toscrape.com", crawlInstruction: "Book detail pages in the Poetry category", transformInstruction: "The book's title and price", maxPages: 2 });
const crawlId = find(crawl, ["jobId", "crawlId", "id"]);
let crawlJob = crawl;
if (crawlId && !/completed/.test(JSON.stringify(crawl.status ?? ""))) {
  crawlJob = await call("spidra_get_job", { type: "crawl", id: crawlId, waitSeconds: 45 });
  for (let i = 0; i < 6 && !/completed|failed/.test(String(crawlJob.status)); i++) {
    crawlJob = await call("spidra_get_job", { type: "crawl", id: crawlId, waitSeconds: 45 });
  }
}
if (crawlId) {
  const pages = await call("spidra_crawl_pages", { jobId: crawlId, limit: 5 });
  await call("spidra_crawl_report", { jobId: crawlId, limit: 5 });
  await call("spidra_crawl_extract", { jobId: crawlId, transformInstruction: "The book's title" });
  const pageId = find(pages, ["pageId", "id"]);
  if (pageId) await call("spidra_retry_crawl_page", { jobId: crawlId, pageId });
}

// Documents.
await call("spidra_parse", { url: PDF });

// Templates.
await call("spidra_find_templates", { site: "github" });
await call("spidra_get_template", { slug: "github-repo-details" });
await call("spidra_run_template", { slug: "github-repo-details", inputs: { repos: ["spidra-io/spidra-mcp-server"] }, estimate: true });
await call("spidra_run_template", { slug: "github-repo-details", inputs: { repos: ["spidra-io/spidra-mcp-server"] } });

// Presets: save, list, run, change, delete.
const preset = await call("spidra_save_preset", { kind: "tool", tool: "scrape", name: "Every-tool check", config: { urls: [{ url: PAGE }], output: "markdown" } });
const presetId = find(preset, ["presetId", "id"]);
if (presetId) {
  await call("spidra_list_presets", {});
  await call("spidra_run_preset", { presetId });
  await call("spidra_delete_preset", { presetId });
}

// Monitors: create, list, change, check now, read changes, delete.
const monitor = await call("spidra_create_monitor", {
  name: "Every-tool check",
  sources: [{ kind: "urls", urls: [PAGE] }],
  schedule: { every: "1d", at: "09:00", timezone: "UTC" },
  alertOn: "changed",
});
const monitorId = find(monitor, ["monitorId", "id"]);
if (monitorId) {
  await call("spidra_list_monitors", {});
  await call("spidra_update_monitor", { monitorId, name: "Every-tool check (renamed)" });
  await call("spidra_check_monitor", { monitorId });
  await call("spidra_monitor_changes", { monitorId, limit: 3 });
  await call("spidra_delete_monitor", { monitorId });
}

// Jobs: start one that doesn't wait, look it up, cancel it.
const started = await call("spidra_batch_scrape", { urls: [PAGE, PAGE_2], wait: false });
const startedId = find(started, ["batchId", "id"]);
if (startedId) {
  await call("spidra_get_job", { type: "batch", id: startedId });
  await call("spidra_cancel_job", { type: "batch", id: startedId });
}
void scrape;

await client.close();

const missing = listed.filter((n) => !called.has(n));
for (const n of missing) results.push({ name: n, ok: false, note: "not called (an earlier step gave no id)" });
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)} ${r.seconds != null ? `${r.seconds.toFixed(1)}s` : ""} ${r.note}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${listed.length} tools listed, ${called.size} called, ${results.length} calls, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
