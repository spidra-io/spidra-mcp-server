import { FastMCP, OAuthProvider, type ContentResult, type Logger } from "fastmcp";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
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

// ---------------------------------------------------------------------------
// Transport / environment
// ---------------------------------------------------------------------------

export const HTTP_MODE = process.env.HTTP_STREAMABLE_SERVER === "true";

export interface SessionData {
  spidraApiKey?: string;
  [key: string]: unknown;
}

export type Server = FastMCP<SessionData>;

// ---------------------------------------------------------------------------
// Logging: stdio uses stdout for JSON-RPC framing, so never log there.
// ---------------------------------------------------------------------------

class ConsoleLogger implements Logger {
  private shouldLog = HTTP_MODE;

  debug(...args: unknown[]): void {
    if (this.shouldLog) console.debug("[DEBUG]", new Date().toISOString(), ...args);
  }
  error(...args: unknown[]): void {
    if (this.shouldLog) console.error("[ERROR]", new Date().toISOString(), ...args);
  }
  info(...args: unknown[]): void {
    if (this.shouldLog) console.info("[INFO]", new Date().toISOString(), ...args);
  }
  log(...args: unknown[]): void {
    if (this.shouldLog) console.log("[LOG]", new Date().toISOString(), ...args);
  }
  warn(...args: unknown[]): void {
    if (this.shouldLog) console.warn("[WARN]", new Date().toISOString(), ...args);
  }
}

export const logger = new ConsoleLogger();

// ---------------------------------------------------------------------------
// Auth: env var for stdio, headers for HTTP transports
// ---------------------------------------------------------------------------

function extractApiKey(headers: IncomingHttpHeaders): string | undefined {
  const headerKey = headers["x-spidra-api-key"] ?? headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim().startsWith("spd_")) return headerKey.trim();

  const authHeader = headers["authorization"];
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    // Only treat this as a raw API key if it actually looks like one, an
    // OAuth access token (below) arrives the same way but isn't one.
    if (token.startsWith("spd_")) return token;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OAuth: lets clients do a browser login instead of pasting an API key.
// fastmcp's OAuthProvider handles the entire outer OAuth 2.1 dance (PKCE,
// dynamic client registration, consent, discovery) on its own; Spidra's
// backend is configured here as the single upstream confidential client it
// talks to. Optional, only active when all three env vars below are set.
// ---------------------------------------------------------------------------

const OAUTH_ENABLED =
  HTTP_MODE &&
  Boolean(process.env.MCP_OAUTH_CLIENT_ID && process.env.MCP_OAUTH_CLIENT_SECRET && process.env.MCP_PUBLIC_URL);

export const oauthProvider = OAUTH_ENABLED
  ? new OAuthProvider({
      baseUrl: process.env.MCP_PUBLIC_URL!,
      clientId: process.env.MCP_OAUTH_CLIENT_ID!,
      clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET!,
      authorizationEndpoint: `${process.env.SPIDRA_API_URL}/oauth/authorize`,
      tokenEndpoint: `${process.env.SPIDRA_API_URL}/oauth/token`,
      // fastmcp's default (loopback-only: http://localhost:*, http://127.0.0.1:*)
      // covers CLI-style loopback clients (Claude Code, Cursor desktop, VS Code
      // desktop, Windsurf), but several clients proxy the OAuth callback through
      // their own hosted domain instead of a local port. Each is listed as an
      // exact literal (no wildcard), so this doesn't widen the open-redirect
      // surface beyond these specific, vendor-documented URLs:
      //   - Claude (web/Desktop/mobile/Cowork): https://claude.com/docs/connectors/building/authentication#callback-urls
      //   - Cursor (web/cloud agents):          https://cursor.com/docs/mcp
      //   - VS Code (vscode.dev / web):         https://code.visualstudio.com/api/extension-guides/ai/mcp
      //   - Antigravity:                        https://antigravity.google/docs/mcp
      allowedRedirectUriPatterns: [
        "http://localhost:*",
        "http://127.0.0.1:*",
        "https://claude.ai/api/mcp/auth_callback",
        "https://www.cursor.com/agents/mcp/oauth/callback",
        "https://vscode.dev/redirect",
        "https://insiders.vscode.dev/redirect",
        "https://antigravity.google/oauth-callback",
      ],
    })
  : undefined;

// Resolves a validated OAuth session (an upstream access token WE issued via
// /api/oauth/token) to the real Spidra API key it maps to. Server-to-server
// only, never exposed to the browser or the MCP client.
async function introspectOAuthToken(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${process.env.SPIDRA_API_URL}/oauth/introspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MCP_OAUTH_CLIENT_SECRET}`,
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!response.ok) {
      logger.error(`OAuth token introspection failed: HTTP ${response.status}`);
      return undefined;
    }
    const data = (await response.json()) as { active: boolean; apiKey?: string };
    if (!data.active || !data.apiKey) {
      logger.error("OAuth token introspection returned an inactive/invalid token");
      return undefined;
    }
    return data.apiKey;
  } catch (err) {
    logger.error("OAuth token introspection request failed:", err);
    return undefined;
  }
}

export async function authenticate(request?: { headers: IncomingHttpHeaders }): Promise<SessionData> {
  // FastMCP invokes authenticate(undefined) for the stdio transport
  if (!request) {
    return { spidraApiKey: process.env.SPIDRA_API_KEY };
  }

  const headerKey = extractApiKey(request.headers);
  if (headerKey) return { spidraApiKey: headerKey };

  if (oauthProvider) {
    try {
      const session = await oauthProvider.authenticate(request as Parameters<typeof oauthProvider.authenticate>[0]);
      const apiKey = session?.accessToken ? await introspectOAuthToken(session.accessToken) : undefined;
      if (apiKey) return { spidraApiKey: apiKey };
    } catch (err) {
      // No valid OAuth session either, fall through to the same
      // "no key configured" behavior a missing API key already gets,
      // surfaced with a clear message at tool-call time in getClient().
      logger.error("OAuth session validation failed:", err);
    }
  }

  return { spidraApiKey: process.env.SPIDRA_API_KEY };
}

export function getClient(session?: SessionData): SpidraClient {
  const apiKey = session?.spidraApiKey ?? process.env.SPIDRA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Spidra credentials found. Log in with OAuth (supported clients prompt for this " +
        "automatically on /mcp or first connect), or set the SPIDRA_API_KEY environment " +
        "variable / send an Authorization: Bearer header with a key from https://app.spidra.io " +
        "under API Keys."
    );
  }
  return new SpidraClient({
    apiKey,
    ...(process.env.SPIDRA_API_URL ? { baseUrl: process.env.SPIDRA_API_URL } : {}),
  });
}

// ---------------------------------------------------------------------------
// Output shaping: keep tool results inside sane LLM context budgets
// ---------------------------------------------------------------------------

// One long string (a page's Markdown, a long AI answer) is capped at 20,000 characters, and a whole result at
// 80,000 (about 20k tokens, under Claude Code's default 25k-token limit for a tool result). A single scrape answer
// usually fits whole, and a batch or crawl with many items can't have one item eat the whole budget.
const MAX_STRING_LENGTH = 20_000;
const MAX_OUTPUT_LENGTH = 80_000;

function truncateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} of ${value.length} chars. To see the rest, ask a narrower question: a specific section, a JSON schema for just the fields you need, or fewer URLs or pages at once.]`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncateDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v);
    return out;
  }
  return value;
}

/**
 * A tool result: the data as JSON text for every client, and the same data as `structuredContent` for clients that
 * read fields directly. Over-long output is cut, with a note saying how to get the rest.
 */
export function reply(value: unknown): ContentResult {
  const shaped = truncateDeep(value);
  const text = JSON.stringify(shaped, null, 2) ?? String(shaped);
  if (text.length > MAX_OUTPUT_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `${text.slice(0, MAX_OUTPUT_LENGTH)}\n... [output truncated at ${MAX_OUTPUT_LENGTH} chars. Ask for less next time: fewer URLs or pages, a smaller limit, a JSON schema for just the fields you need, or page through with offset/limit.]`,
        },
      ],
    };
  }
  const structured =
    shaped !== null && typeof shaped === "object" && !Array.isArray(shaped)
      ? (shaped as Record<string, unknown>)
      : { result: shaped };
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Turn SDK errors into messages that steer the model: what happened, what to do next, and whether to retry.
 */
function toToolError(err: unknown): Error {
  if (err instanceof SpidraTimeoutError) {
    return new Error(
      `The job did not finish within the wait window, but it is STILL RUNNING` +
        (err.jobId ? ` (id: ${err.jobId})` : "") +
        `. Do NOT start it again. Check it with spidra_get_job until it finishes.`
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
    return new Error(
      `Not found: ${err.message.replace(/\.$/, "")}. Check the ID. Finished scrape and search jobs can only be read for about an hour; after that, find them with spidra_logs.`
    );
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
    .describe('With useProxy, the country to browse from: a two-letter code such as "us", "gb" or "de", or "global", "eu" or "asia"'),
};

export const cookiesParam = z
  .string()
  .optional()
  .describe('Cookies from the user\'s own signed-in browser session, for pages behind a login, e.g. "session=abc; token=xyz". Never stored.');

export const TERMINAL_NOTE =
  "Statuses: queued, waiting, active and running are still in progress; completed, partial, failed and cancelled are final.";
