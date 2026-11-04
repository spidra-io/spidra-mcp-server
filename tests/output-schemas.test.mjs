// Output schemas: every advertised outputSchema accepts real results recorded against the Spidra API
// (tests/fixtures/outputs), stays loose, and never makes a call fail, with the SDK 1.x and 2.x clients (both check
// structuredContent against outputSchema on their side).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "dist", "index.js");
const FIXTURES = path.join(__dirname, "fixtures", "outputs");

// Tools without an outputSchema, and why: spidra_logs returns a different raw log shape for each of seven tools.
const NO_SCHEMA = new Set(["spidra_logs"]);

// A fake API with the cases the schema guard has to handle.
const api = createServer((req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  req.resume();
  req.on("end", () => {
    if (req.url === "/api/account") {
      // remaining has changed type and there's a field nobody knows about yet.
      return send(200, { status: "success", data: { plan: { name: "Builder" }, credits: { limit: 100, used: 1, remaining: "lots" }, brandNewField: { x: 1 } } });
    }
    if (req.url === "/api/monitors/limits") return send(200, { status: "success", maxMonitors: 5, used: 0, minIntervalMinutes: 15 });
    if (req.url === "/api/map") {
      // Far too many links for one result, even with every string cut short.
      const links = Array.from({ length: 4000 }, (_, i) => ({ url: `https://big.example.com/page/${i}`, title: `Page number ${i} `.repeat(4) }));
      return send(200, { status: "success", links, total: 4000, scanned: 4000, creditsUsed: 1 });
    }
    send(404, { status: "error", message: "not found" });
  });
});

let apiUrl;
let tools;
let legacy;
let modern;

before(async () => {
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${api.address().port}/api`;
  const env = { ...process.env, SPIDRA_API_KEY: "spd_test", SPIDRA_API_URL: apiUrl };
  legacy = new LegacyClient({ name: "legacy", version: "1" });
  await legacy.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env }));
  modern = new ModernClient({ name: "modern", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await modern.connect(new ModernStdio({ command: process.execPath, args: [SERVER_ENTRY], env }));
  ({ tools } = await legacy.listTools());
});

after(async () => {
  await legacy?.close();
  await modern?.close();
  api.close();
});

const fixtures = () =>
  readdirSync(FIXTURES)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ file: f, ...JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) }));

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach(n => walk(n, visit));
  if (node && typeof node === "object") {
    visit(node);
    Object.values(node).forEach(v => walk(v, visit));
  }
}

test("every tool but spidra_logs advertises a loose object outputSchema", () => {
  for (const t of tools) {
    if (NO_SCHEMA.has(t.name)) {
      assert.equal(t.outputSchema, undefined, `${t.name} has no outputSchema`);
      continue;
    }
    assert.equal(t.outputSchema?.type, "object", `${t.name} has an object outputSchema`);
    walk(t.outputSchema, node => {
      assert.notEqual(node.additionalProperties, false, `${t.name}: every object allows extra fields`);
      assert.ok(!Array.isArray(node.required), `${t.name}: no field is required`);
    });
  }
});

test("schemas carry no $schema or empty additionalProperties (they're sent to the model in tools/list)", () => {
  for (const t of tools) {
    for (const schema of [t.inputSchema, t.outputSchema].filter(Boolean)) {
      walk(schema, node => {
        assert.equal(node.$schema, undefined, `${t.name}: no $schema`);
        if ("additionalProperties" in node) assert.notDeepEqual(node.additionalProperties, {}, `${t.name}: no empty additionalProperties`);
      });
    }
  }
});

test("every recorded real result validates against its tool's outputSchema (draft-07 and 2020-12 validators)", () => {
  const validators = [new Ajv({ strict: false, allErrors: true }), new Ajv2020({ strict: false, allErrors: true })];
  const byTool = new Map(tools.map(t => [t.name, t]));
  const covered = new Set();
  for (const fx of fixtures()) {
    const schema = byTool.get(fx.tool)?.outputSchema;
    if (!schema) continue;
    covered.add(fx.tool);
    for (const ajv of validators) {
      const validate = ajv.compile(schema);
      assert.ok(validate(fx.structuredContent), `${fx.file} (${fx.tool}): ${ajv.errorsText(validate.errors)}`);
    }
  }
  const missing = tools.filter(t => t.outputSchema && !covered.has(t.name)).map(t => t.name);
  assert.deepEqual(missing, [], "every tool with an outputSchema has at least one recorded result");
});

test("a changed API type or a new field never fails the call; only that field leaves structuredContent", async () => {
  for (const client of [legacy, modern]) {
    const result = await client.callTool({ name: "spidra_account", arguments: {} });
    assert.equal(result.isError ?? false, false, JSON.stringify(result));
    assert.equal(result.structuredContent.credits.used, 1);
    assert.equal(result.structuredContent.credits.remaining, undefined, "the mismatched field is dropped");
    assert.deepEqual(result.structuredContent.brandNewField, { x: 1 }, "unknown fields pass through");
    assert.match(result.content[0].text, /"remaining":"lots"/, "the text keeps everything");
  }
});

test("a result too big even with short strings keeps valid JSON and structuredContent, with lists cut", async () => {
  for (const client of [legacy, modern]) {
    const result = await client.callTool({ name: "spidra_map", arguments: { url: "https://big.example.com" } });
    assert.equal(result.isError ?? false, false, JSON.stringify(result).slice(0, 300));
    const text = result.content[0].text;
    assert.ok(text.length <= 80_000, `text is ${text.length} chars`);
    const parsed = JSON.parse(text);
    assert.ok(parsed.links.length >= 1 && parsed.links.length <= 50, `${parsed.links.length} links kept`);
    assert.equal(result.structuredContent.total, 4000);
    assert.match(result.structuredContent.truncated, /first \d+ items/);
  }
});
