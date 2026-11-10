import {
  SpidraClient,
  SpidraError,
  SpidraInsufficientCreditsError,
  SpidraJobError,
  SpidraNotFoundError,
  SpidraPaymentRequiredError,
  SpidraRateLimitError,
  SpidraTimeoutError,
  SpidraValidationError,
} from "spidra";
import { z } from "zod";

export { HTTP_MODE, logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Tool registration. Each tools/*.ts file registers its tools through this small interface; server.ts maps it onto
// the MCP SDK, so the tool definitions don't depend on any one framework.
// ---------------------------------------------------------------------------

/** Who is calling: the Spidra API key for this request (from the header, OAuth, or SPIDRA_API_KEY on stdio). */
export interface SessionData {
  spidraApiKey?: string;
}

export interface ToolLog {
  info(message: string, data?: Record<string, unknown>): void;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a tool gets besides its arguments. signal aborts when the client cancels the call or goes away. */
export interface ToolContext {
  session: SessionData;
  log: ToolLog;
  signal?: AbortSignal;
}

/**
 * The longest any one call waits for a job, in ms. Codex, Cline and the MCP SDK client give up on a tool call at
 * 60 s, and a client that gives up while the job runs leads to a second run and a second charge
 * (MCP_SECOND_REVIEW M1). Past this, tools return the job's id for spidra_get_job.
 */
export const MAX_WAIT_MS = 45_000;

/** A sleep that ends early, with an AbortError, when the call is cancelled. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  parameters: S;
  /**
   * The result's shape, advertised as outputSchema. Every field is optional and objects allow extra fields (see
   * outputs.ts), so a new API field never fails a call.
   */
  output?: z.ZodType;
  execute: (args: z.infer<S>, context: ToolContext) => Promise<ToolResult>;
}

export interface Server {
  addTool<S extends z.ZodObject>(tool: ToolDefinition<S>): void;
}

/** An error in the model's request that it can fix: its message is shown to the model as is. */
export class UserError extends Error {}

export function getClient(session?: SessionData): SpidraClient {
  const apiKey = session?.spidraApiKey;
  if (!apiKey) {
    throw new UserError(
      "No Spidra credentials found. Sign in with OAuth (your client prompts for it on the hosted server, " +
        "https://mcp.spidra.io/mcp), or set the SPIDRA_API_KEY environment variable, or send an " +
        "Authorization: Bearer header with a key from https://app.spidra.io under API Keys."
    );
  }
  const baseUrl = apiBaseUrl();
  return new SpidraClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * SPIDRA_API_URL, checked: https anywhere, or http only on this computer, so the key never travels in the clear.
 * Undefined means the SDK's default (https://api.spidra.io/api).
 */
export function apiBaseUrl(): string | undefined {
  const raw = process.env.SPIDRA_API_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`SPIDRA_API_URL isn't a valid URL ("${raw}"). Leave it unset to use https://api.spidra.io/api.`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return raw;
  throw new UserError(
    `SPIDRA_API_URL must be an https URL (or http on localhost), and "${url.origin}" isn't, so your API key won't be sent there. Leave it unset to use https://api.spidra.io/api.`
  );
}

// ---------------------------------------------------------------------------
// Output shaping: keep tool results inside sane LLM context budgets
// ---------------------------------------------------------------------------

// A whole result is capped at 80,000 characters (about 20k tokens, under Claude Code's default 25k-token limit for a
// tool result). Long strings (a page's Markdown, a long AI answer) are cut first, at 20,000 characters each, then
// tighter if the result still doesn't fit, so a batch or crawl with many items can't have one item eat the budget
// and the result stays valid JSON with its structuredContent.
const STRING_CAPS = [20_000, 8_000, 3_000, 1_000];
const MAX_OUTPUT_LENGTH = 80_000;

function truncateDeep(value: unknown, cap: number): unknown {
  if (typeof value === "string") {
    return value.length > cap
      ? `${value.slice(0, cap)}... [truncated ${value.length - cap} of ${value.length} chars. To see the rest, ask a narrower question: a specific section, a JSON schema for just the fields you need, or fewer URLs or pages at once.]`
      : value;
  }
  if (Array.isArray(value)) return value.map(v => truncateDeep(v, cap));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v, cap);
    return out;
  }
  return value;
}

// When cutting strings isn't enough (too many items), lists are cut to their first N items, then fewer.
const ARRAY_CAPS = [50, 20, 10, 5, 1];

function limitArrays(value: unknown, max: number, cut: { count: number }): unknown {
  if (Array.isArray(value)) {
    if (value.length > max) cut.count += value.length - max;
    return value.slice(0, max).map(v => limitArrays(v, max, cut));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = limitArrays(v, max, cut);
    return out;
  }
  return value;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };

/**
 * A tool result: the data as compact JSON text for every client, and the same data as `structuredContent` for
 * clients that read fields directly. Over-long output is cut, with a note saying how to get the rest. The text is
 * always valid JSON and `structuredContent` is always there, so tools with an outputSchema never fail on size.
 */
export function reply(value: unknown): ToolResult {
  for (const cap of STRING_CAPS) {
    const shaped = truncateDeep(value, cap);
    const text = JSON.stringify(shaped) ?? String(shaped);
    if (text.length <= MAX_OUTPUT_LENGTH) return { content: [{ type: "text", text }], structuredContent: asObject(shaped) };
  }
  // Too many items even with every string cut short: keep the first items of each list.
  const shortStrings = truncateDeep(value, STRING_CAPS[STRING_CAPS.length - 1]);
  for (const max of ARRAY_CAPS) {
    const cut = { count: 0 };
    const structured = {
      ...asObject(limitArrays(shortStrings, max, cut)),
      truncated: `Lists were cut to their first ${max} items (${cut.count} items left out) and long text to 1,000 characters to fit. Ask for less next time: fewer URLs or pages, a smaller limit, a JSON schema for just the fields you need, or page through with offset/limit.`,
    };
    const text = JSON.stringify(structured);
    if (text.length <= MAX_OUTPUT_LENGTH) return { content: [{ type: "text", text }], structuredContent: structured };
  }
  const structured = {
    truncated: `The result was too large to return (over ${MAX_OUTPUT_LENGTH} characters even when shortened). Ask for less: fewer URLs or pages, a smaller limit, or a JSON schema for just the fields you need.`,
  };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

/**
 * Turn SDK errors into messages that steer the model: what happened, what to do next, and whether to retry.
 */
function toToolError(err: unknown): Error {
  if (err instanceof SpidraTimeoutError) {
    return new Error(
      `The job did not finish within the wait window, but it is STILL RUNNING` +
        (err.jobId ? ` (id: ${err.jobId})` : "") +
        `. Do NOT start it again. Check it with spidra_get_job, with "waitSeconds": 30, until it finishes.`
    );
  }
  // The SDK maps every 403 to this class, but 403 also means a plan limit, another account's job, or a feature
  // that isn't on for the account. Tell them apart by code and message.
  if (err instanceof SpidraInsufficientCreditsError) {
    if (err.code === "MONITOR_LIMIT") {
      return new Error(`${err.message} Delete or reuse a monitor (spidra_list_monitors), or the user can upgrade. Do not retry.`);
    }
    if (err.code === "FORBIDDEN") {
      return new Error(`That job belongs to another account: ${err.message} Check the ID. Do not retry.`);
    }
    if (/credit/i.test(err.message)) {
      return new Error(
        `Out of credits: ${err.message} Do not retry. The user can top up or upgrade at https://app.spidra.io/dashboard/billing. spidra_account shows the balance.`
      );
    }
    return new Error(`Not allowed (403): ${err.message} Do not retry.`);
  }
  if (err instanceof SpidraPaymentRequiredError) {
    return new Error(
      `The account's payment is overdue (${err.code ?? "402"}). Do not retry. The user needs to update their payment method at https://app.spidra.io/dashboard/billing.`
    );
  }
  if (err instanceof SpidraRateLimitError) {
    const wait = err.retryAfterMs != null ? `${Math.ceil(err.retryAfterMs / 1000)} seconds` : "a minute";
    const pending = err.code === "TOO_MANY_PENDING_JOBS";
    return new Error(
      `${pending ? "Too many unfinished jobs" : "Rate limited"} (${err.code ?? "429"}): ${err.message} ` +
        (pending ? "Wait for running jobs to finish (check them with spidra_get_job), then try again." : `Wait ${wait}, then try again.`)
    );
  }
  if (err instanceof SpidraValidationError) {
    return new Error(
      `Invalid request. Fix these and try again (don't retry unchanged): ${err.errors.join("; ") || err.message}`
    );
  }
  if (err instanceof SpidraNotFoundError) {
    // Point at the tool that lists the right kind of thing (the API's own hint names a REST path, not a tool).
    const message = err.message.replace(/\s*GET \/api\/\S+ lists them\.?/i, "").replace(/\.$/, "");
    const hint = /template/i.test(message)
      ? "Find the right slug with spidra_find_templates."
      : /preset/i.test(message)
        ? "spidra_list_presets lists the saved presets and their ids."
        : /monitor/i.test(message)
          ? "spidra_list_monitors lists the monitors and their ids."
          : "Check the ID. Finished scrape and search jobs can only be read for about an hour; after that, find them with spidra_logs.";
    return new Error(`Not found: ${message}. ${hint}`);
  }
  if (err instanceof SpidraJobError) {
    // A browser step that couldn't be done names itself: "Action 2 (click "#login") failed: <reason>".
    if (/Action \d+ \(.*\) failed:/.test(err.message)) {
      return new Error(
        `The scrape failed (failed jobs are free): ${err.message} ` +
          `Fix that step (its selector, a longer timeout, or a waitFor before it), then call again.`
      );
    }
    return new Error(`The ${err.jobStatus === "cancelled" ? "job was cancelled" : "job failed (you aren't charged)"}: ${err.message}`);
  }
  if (err instanceof SpidraError) {
    if (err.code === "SERVICE_BUSY") {
      return new Error(`Spidra is at capacity right now (SERVICE_BUSY): ${err.message} Wait about a minute, then try again.`);
    }
    const retryable = err.status >= 500;
    return new Error(
      `Spidra API error ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message.replace(/\.$/, "")}. ` +
        (retryable ? "This may be temporary; retrying once after a short wait is fine." : "Don't retry with the same input.")
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toToolError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared parameter schemas
// ---------------------------------------------------------------------------

// Browser actions, matching the API's definition (spidra-backend services/actions/normalize.ts). The API checks
// everything again and answers 422 naming the action, so these limits only help the model get it right first time.
const STEP_TYPES = [
  "click",
  "type",
  "check",
  "uncheck",
  "hover",
  "select",
  "press",
  "wait",
  "waitFor",
  "scroll",
  "scrollUntilEnd",
  "evaluate",
  "screenshot",
] as const;

const stepFields = {
  selector: z
    .string()
    .optional()
    .describe(
      'The element: a CSS selector ("#login"), an XPath, or plain English ("the Sign in button"). Required for click, check, uncheck, hover, select and waitFor; optional for type (default: the first visible text field) and press (default: the page).'
    ),
  value: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("type: the text to type. select: the option to choose (by label or value), or several for a multi-select."),
  key: z.string().optional().describe('press: a key name such as "Enter", "Tab", "Escape", "ArrowDown" or "Control+A"'),
  timeout: z
    .number()
    .min(100)
    .max(30000)
    .optional()
    .describe("Milliseconds to look for the element (default 10000). Raise it for slow pages, e.g. waitFor on content that loads late."),
  optional: z
    .boolean()
    .optional()
    .describe(
      "true: if this step fails, skip it (reported as skipped) and run the rest. Without it, a failed step fails the whole job. Use it for things that may not be there, like cookie banners or popups."
    ),
  duration: z.number().min(1).max(30000).optional().describe("wait: milliseconds to pause"),
  state: z
    .enum(["visible", "attached", "hidden", "detached"])
    .optional()
    .describe('waitFor: the state to wait for (default "visible")'),
  to: z
    .union([z.number(), z.string()])
    .optional()
    .describe('scroll: a percentage of the page height (80 or "80%"), "top", "bottom", or an element to scroll into view'),
  pixels: z.number().optional().describe("scroll: scroll by this many pixels instead of using to (negative scrolls up)"),
  maxScrolls: z.number().int().min(1).max(30).optional().describe("scrollUntilEnd: most rounds (default 10)"),
  pause: z.number().min(200).max(5000).optional().describe("scrollUntilEnd: milliseconds to wait after each round (default 1500)"),
  clickSelector: z
    .string()
    .optional()
    .describe('scrollUntilEnd: a "Load more" button to click each round instead of scrolling'),
  script: z
    .string()
    .max(10000)
    .optional()
    .describe('evaluate: JavaScript run in the page. An expression ("document.title") is returned as is; statements need return. The value comes back in actionResults.'),
  fullPage: z.boolean().optional().describe("screenshot: capture the whole page instead of the viewport"),
};

// A step inside forEach: any action except forEach. Same fields as a top-level step; their descriptions are on the
// top-level schema already, so they aren't repeated here (it keeps the tool list smaller for the model).
const stepSchema = z
  .object({
    type: z.enum(STEP_TYPES),
    selector: z.string().optional(),
    value: z.union([z.string(), z.array(z.string())]).optional(),
    key: z.string().optional(),
    timeout: z.number().min(100).max(30000).optional(),
    optional: z.boolean().optional(),
    duration: z.number().min(1).max(30000).optional(),
    state: z.enum(["visible", "attached", "hidden", "detached"]).optional(),
    to: z.union([z.number(), z.string()]).optional(),
    pixels: z.number().optional(),
    maxScrolls: z.number().int().min(1).max(30).optional(),
    pause: z.number().min(200).max(5000).optional(),
    clickSelector: z.string().optional(),
    script: z.string().max(10000).optional(),
    fullPage: z.boolean().optional(),
  })
  .passthrough()
  .describe("A step, with the same fields as a top-level action (no forEach)");

export const browserActionSchema = z
  .object({
    type: z.enum([...STEP_TYPES, "forEach"]).describe("The action. forEach must be the single, last action."),
    ...stepFields,
    observe: z
      .string()
      .optional()
      .describe('forEach (required): which elements to go through, in plain English, e.g. "each product card"'),
    mode: z
      .enum(["click", "inline", "navigate"])
      .optional()
      .describe('forEach: "click" (default) clicks each item and captures what appears, "inline" reads each item in place, "navigate" opens each item\'s link'),
    captureSelector: z.string().optional().describe("forEach: what to capture for each item (CSS selector, XPath or description)"),
    maxItems: z.number().int().min(1).max(50).optional().describe("forEach: most items across all pages (default 50)"),
    waitAfterClick: z
      .number()
      .min(0)
      .max(10000)
      .optional()
      .describe("forEach: ms to wait after clicking or opening an item before capturing it (default 2500)"),
    itemPrompt: z.string().max(2000).optional().describe("forEach: an extraction prompt run on each item on its own"),
    actions: z
      .array(stepSchema)
      .max(10)
      .optional()
      .describe("forEach: steps to run on each item after it is clicked or opened (no forEach)"),
    pagination: z
      .object({
        nextSelector: z.string().describe('The "next page" button or link (CSS selector, XPath or description)'),
        maxPages: z.number().int().min(1).max(10).optional().describe("Pages in total, counting the first (default 5)"),
      })
      .optional()
      .describe("forEach: move through results pages after the items on the current one"),
  })
  .passthrough();

export const jsonSchemaParam = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "A JSON Schema for the answer. You get exactly these fields and types, with null for anything the page doesn't show. " +
      "Define every field you want: an object with no properties comes back empty. The root must be an object."
  );

export const proxyParams = {
  useProxy: z
    .boolean()
    .optional()
    .describe("Stealth Mode: browse through residential proxies, for sites that block or vary by country. Billed by bandwidth, not credits."),
  proxyCountry: z
    .string()
    .optional()
    .describe('The country to read pages from: a two-letter code such as "us", "gb" or "de", or "eu" or "asia". Setting one uses Stealth Mode (billed by bandwidth) unless useProxy is false. "global" means any country.'),
};

export const cookiesParam = z
  .string()
  .optional()
  .describe('Cookies from the user\'s own signed-in browser session, for pages behind a login, e.g. "session=abc; token=xyz". Never stored.');

export const TERMINAL_NOTE =
  "Statuses: queued, waiting, active and running are still in progress; completed, partial, failed and cancelled are final.";
