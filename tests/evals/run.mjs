#!/usr/bin/env node
// Runs the eval tasks (tasks.mjs) through a real model: Claude Code headless (`claude -p`) with this server over
// stdio as its only tools, against a Spidra API you point it at. Scores each task on tool choice, arguments, number
// of calls, credits spent and whether the answer is right.
//
//   npm run build
//   SPIDRA_EVAL_API_URL=http://localhost:4321/api SPIDRA_EVAL_API_KEY_FILE=/path/to/key node tests/evals/run.mjs --tasks credits_only,price_one
//
// Options: --tasks a,b (default: all), --model sonnet (default), --list, --out <dir> (default tests/evals/results),
// --runs <n> (default 1), --skill <off|on|both> (default off).
//
// --skill measures what the plugin's skill adds on top of this server. Both arms use the same local server; "on"
// also loads a copy of ../../plugin with its skills only (no .mcp.json, so the hosted server is never contacted),
// and "both" runs each task without and with it and prints the pass rates side by side. Claude Code's own
// `claude plugin eval` can't measure this: its baseline drops the whole plugin, server included.
// Env: SPIDRA_EVAL_API_URL (default http://localhost:4321/api), SPIDRA_EVAL_API_KEY or SPIDRA_EVAL_API_KEY_FILE.
//
// It refuses to run against production or port 3000. It spends real credits on that account and model usage on
// the Claude account it runs as, so run a few tasks at a time.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "..", "dist", "index.js");

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes("--list")) {
  for (const t of TASKS) console.log(`${t.id.padEnd(24)} ${t.kind.padEnd(22)} ${t.prompt.slice(0, 90)}`);
  process.exit(0);
}

const API_URL = process.env.SPIDRA_EVAL_API_URL || "http://localhost:4321/api";
const API_KEY = (process.env.SPIDRA_EVAL_API_KEY || (process.env.SPIDRA_EVAL_API_KEY_FILE ? readFileSync(process.env.SPIDRA_EVAL_API_KEY_FILE, "utf8") : "")).trim();
const MODEL = flag("model") || "sonnet";
const OUT = flag("out") || path.join(__dirname, "results");
const TIMEOUT_MS = 10 * 60_000;
const RUNS = Math.max(1, Number(flag("runs") || 1));
const SKILL = flag("skill") || "off";
if (!["off", "on", "both"].includes(SKILL)) throw new Error("--skill is off, on or both");
const ARMS = SKILL === "both" ? ["off", "on"] : [SKILL];

/** A copy of the plugin with its skills and manifest only, so the run's MCP server stays the local one. */
function skillOnlyPlugin() {
  const dir = mkdtempSync(path.join(tmpdir(), "spidra-skill-plugin-"));
  const src = path.join(__dirname, "..", "..", "plugin");
  cpSync(path.join(src, ".claude-plugin"), path.join(dir, ".claude-plugin"), { recursive: true });
  cpSync(path.join(src, "skills"), path.join(dir, "skills"), { recursive: true });
  return dir;
}
const SKILL_PLUGIN = ARMS.includes("on") ? skillOnlyPlugin() : undefined;

const apiHost = new URL(API_URL);
if (/spidra\.io$/i.test(apiHost.hostname) || apiHost.port === "3000") {
  console.error(`Refusing to run evals against ${API_URL}: use a local backend, never production or port 3000.`);
  process.exit(1);
}
if (!API_KEY) {
  console.error("Set SPIDRA_EVAL_API_KEY or SPIDRA_EVAL_API_KEY_FILE to a key for the test account.");
  process.exit(1);
}

const wanted = flag("tasks")?.split(",").map(s => s.trim());
const tasks = wanted ? TASKS.filter(t => wanted.includes(t.id)) : TASKS;
if (wanted && tasks.length !== wanted.length) {
  console.error(`Unknown task ids: ${wanted.filter(w => !TASKS.some(t => t.id === w)).join(", ")}`);
  process.exit(1);
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const creditsUsed = async () => Number((await api("/account")).data?.credits?.used ?? NaN);
const monitorIds = async () => ((await api("/monitors")).monitors ?? []).map(m => m.id);
const presetIds = async () => ((await api("/presets?limit=50")).presets ?? []).map(p => p.id);

/** One task through `claude -p`, returning the Spidra tool calls in order and the final answer. */
function runClaude(task, workDir, arm = "off") {
  const config = { mcpServers: { spidra: { command: process.execPath, args: [SERVER_ENTRY], env: { SPIDRA_API_KEY: API_KEY, SPIDRA_API_URL: API_URL } } } };
  const configPath = path.join(workDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const args = [
    "-p",
    task.prompt,
    "--mcp-config",
    configPath,
    "--strict-mcp-config",
    // The Skill tool in both arms, so the only difference between them is whether the plugin's skill exists.
    "--tools",
    "Skill",
    "--allowedTools",
    "mcp__spidra,Skill",
    ...(arm === "on" ? ["--plugin-dir", SKILL_PLUGIN] : []),
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    MODEL,
    "--append-system-prompt",
    "You are running non-interactively: the user can't answer questions, so make reasonable choices and finish the task.",
  ];
  return new Promise(resolve => {
    const child = spawn("claude", args, { cwd: workDir, env: { ...process.env, SPIDRA_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    let buffer = "";
    let stderr = "";
    const events = [];
    child.stdout.on("data", d => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) {
          try {
            events.push(JSON.parse(line));
          } catch {}
        }
      }
    });
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => {
      clearTimeout(timer);
      const calls = [];
      const byId = new Map();
      let answer = "";
      let result = null;
      let toolsSeen = [];
      const skills = [];
      for (const e of events) {
        if (e.type === "system" && e.subtype === "init") toolsSeen = e.tools ?? [];
        for (const block of e.message?.content ?? []) {
          if (e.type === "assistant" && block.type === "tool_use" && block.name === "Skill") {
            skills.push(block.input?.skill ?? block.input?.command ?? "?");
            continue;
          }
          if (e.type === "assistant" && block.type === "tool_use") {
            const call = { name: block.name.replace(/^mcp__spidra__/, ""), input: block.input, isError: false, text: "" };
            byId.set(block.id, call);
            calls.push(call);
          }
          if (e.type === "user" && block.type === "tool_result" && byId.has(block.tool_use_id)) {
            const call = byId.get(block.tool_use_id);
            call.isError = Boolean(block.is_error);
            const content = Array.isArray(block.content) ? block.content.map(c => c.text ?? "").join("") : String(block.content ?? "");
            call.text = content.slice(0, 2000);
          }
        }
        if (e.type === "result") {
          result = e;
          answer = e.result ?? "";
        }
      }
      resolve({ code, calls, answer, result, toolsSeen, skills, stderr: stderr.slice(-2000) });
    });
  });
}

function score(task, run, credits) {
  const checks = task.checks.map(c => {
    let ok = false;
    try {
      ok = Boolean(c.fn(run.calls, run.answer));
    } catch {}
    return { label: c.label, ok };
  });
  const calls = run.calls.length;
  const callsOk = calls <= task.maxCalls;
  const creditsOk = Number.isFinite(credits) && credits <= task.maxCredits;
  const nonSpidra = run.calls.filter(c => !c.name.startsWith("spidra_")).map(c => c.name);
  const finished = run.code === 0 && run.result && !run.result.is_error;
  const passed = finished && checks.every(c => c.ok) && callsOk && creditsOk && nonSpidra.length === 0;
  return { checks, calls, callsOk, credits, creditsOk, nonSpidra, finished, passed };
}

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(OUT, `${stamp}-${MODEL}.json`);
const report = { model: MODEL, apiUrl: API_URL, startedAt: new Date().toISOString(), tasks: [] };

for (const task of tasks) for (const arm of ARMS) for (let n = 1; n <= RUNS; n++) {
  const workDir = mkdtempSync(path.join(tmpdir(), "spidra-eval-"));
  try {
    const [before, monitorsBefore, presetsBefore] = await Promise.all([creditsUsed(), monitorIds(), presetIds()]);
    const started = Date.now();
    const run = await runClaude(task, workDir, arm);
    // Credits held by jobs still running settle a moment after they finish.
    await new Promise(r => setTimeout(r, 3000));
    const credits = (await creditsUsed()) - before;
    const s = score(task, run, credits);
    // Clean up what the task created, so tasks don't affect each other.
    for (const id of (await monitorIds()).filter(id => !monitorsBefore.includes(id))) await api(`/monitors/${id}`, { method: "DELETE" }).catch(() => {});
    for (const id of (await presetIds()).filter(id => !presetsBefore.includes(id))) await api(`/presets/${id}`, { method: "DELETE" }).catch(() => {});
    const entry = {
      id: task.id,
      kind: task.kind,
      skillArm: arm,
      run: n,
      skillsInvoked: run.skills,
      prompt: task.prompt,
      ...s,
      maxCalls: task.maxCalls,
      maxCredits: task.maxCredits,
      seconds: Math.round((Date.now() - started) / 1000),
      turns: run.result?.num_turns,
      costUsd: run.result?.total_cost_usd,
      spidraToolsAvailable: run.toolsSeen.filter(t => t.startsWith("mcp__spidra__")).length,
      otherToolsAvailable: run.toolsSeen.filter(t => !t.startsWith("mcp__spidra__")),
      toolCalls: run.calls,
      answer: run.answer,
      ...(run.code !== 0 ? { exitCode: run.code, stderr: run.stderr } : {}),
    };
    report.tasks.push(entry);
    const mark = s.passed ? "PASS" : "FAIL";
    console.log(
      `${mark} ${task.id.padEnd(24)} ${ARMS.length > 1 || arm === "on" ? `skill ${arm.padEnd(3)} ` : ""}${run.skills.length ? "[skill] " : ""}calls ${s.calls}/${task.maxCalls}  credits ${s.credits}/${task.maxCredits}  ${entry.seconds}s  ` +
        `${run.calls.map(c => c.name.replace("spidra_", "") + (c.isError ? "!" : "")).join(" > ")}`
    );
    for (const c of s.checks.filter(c => !c.ok)) console.log(`     x ${c.label}`);
    if (!s.finished) console.log(`     x didn't finish (exit ${run.code}) ${run.stderr.slice(0, 200)}`);
    if (s.nonSpidra.length) console.log(`     x used other tools: ${s.nonSpidra.join(", ")}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    writeFileSync(outFile, JSON.stringify(report, null, 1));
  }
}

if (SKILL_PLUGIN) rmSync(SKILL_PLUGIN, { recursive: true, force: true });
const passed = report.tasks.filter(t => t.passed).length;
if (ARMS.length > 1) {
  console.log(`\n${"task".padEnd(24)} without skill    with skill       (passed runs, avg credits, avg model cost)`);
  for (const task of tasks) {
    const cell = arm => {
      const rows = report.tasks.filter(t => t.id === task.id && t.skillArm === arm);
      const ok = rows.filter(t => t.passed).length;
      const avg = k => rows.reduce((a, t) => a + (Number(t[k]) || 0), 0) / (rows.length || 1);
      return `${ok}/${rows.length} ${avg("credits").toFixed(1)}cr $${avg("costUsd").toFixed(2)}`.padEnd(16);
    };
    console.log(`${task.id.padEnd(24)} ${cell("off")} ${cell("on")}`);
  }
}
console.log(`\n${passed}/${report.tasks.length} passed. Details: ${outFile}`);
