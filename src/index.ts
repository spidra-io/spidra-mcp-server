import dotenv from "dotenv";
import { FastMCP, OAuthProvider, UserError, type Logger } from "fastmcp";
import type { IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  SpidraClient,
  SpidraError,
  SpidraJobError,
  SpidraRateLimitError,
  SpidraTimeoutError,
  SpidraValidationError,
} from "spidra";

dotenv.config({ debug: false, quiet: true });

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Transport / environment
// ---------------------------------------------------------------------------

const HTTP_MODE = process.env.HTTP_STREAMABLE_SERVER === "true";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "localhost";

interface SessionData {
  spidraApiKey?: string;
  [key: string]: unknown;
}

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

const logger = new ConsoleLogger();

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

const oauthProvider = OAUTH_ENABLED
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

async function authenticate(request?: { headers: IncomingHttpHeaders }): Promise<SessionData> {
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

function getClient(session?: SessionData): SpidraClient {
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

// MAX_STRING_LENGTH used to be 5,000, which turned out far too conservative
// against an 80,000 total budget: confirmed live (2026-09-26) that a
// spidra_scrape call asking for "every 2026 changelog entry" got a
// perfectly reasonable, already-AI-condensed 6,180-character answer (not a
// raw markdown dump) truncated at 5,000 anyway, losing everything from
// mid-April back to January. Raised 4x so a single long scrape/crawl-page
// answer usually fits whole, while still well under the total budget so a
// batch/crawl response with many items doesn't have just one of them eat
// the whole thing.
const MAX_STRING_LENGTH = 20_000;
const MAX_OUTPUT_LENGTH = 80_000;

function truncateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} of ${value.length} chars. To see the rest, ask a narrower question: a specific date/section range, a JSON schema for just the fields you need, or fewer URLs at once.]`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncateDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateDeep(v);
    }
    return out;
  }
  return value;
}

function asText(value: unknown): string {
  const text = JSON.stringify(truncateDeep(value), null, 2) ?? String(value);
  return text.length > MAX_OUTPUT_LENGTH
    ? `${text.slice(0, MAX_OUTPUT_LENGTH)}\n... [output truncated at ${MAX_OUTPUT_LENGTH} chars, ask a narrower question next time (fewer URLs/pages, a smaller limit, or one specific field) to see everything]`
    : text;
}

/**
 * Convert SDK errors into messages that steer the LLM correctly: retryable
 * errors say how long to wait; non-retryable ones say not to retry.
 */
function toToolError(err: unknown): Error {
  if (err instanceof SpidraTimeoutError) {
    return new Error(
      `The job did not finish within the wait window, but it is STILL RUNNING server-side` +
        (err.jobId ? ` (jobId: ${err.jobId})` : "") +
        `. Do NOT resubmit. Poll the matching status tool until it reaches a terminal state.`
    );
  }
  if (err instanceof SpidraRateLimitError) {
    const wait = err.retryAfterMs != null ? `${Math.ceil(err.retryAfterMs / 1000)} seconds` : "a minute";
    return new Error(
      `Rate limited (${err.code ?? "429"}): ${err.message}. Wait ${wait} before retrying.`
    );
  }
  if (err instanceof SpidraValidationError) {
    return new Error(
      `Invalid request, fix these problems and try again (do not retry unchanged): ${err.errors.join("; ") || err.message}`
    );
  }
  if (err instanceof SpidraJobError) {
    // A browser step that couldn't be done names itself: "Action 2 (click "#login") failed: <reason>".
    if (/Action \d+ \(.*\) failed:/.test(err.message)) {
      return new Error(
        `The scrape job failed (failed jobs are free): ${err.message} ` +
          `Fix that step (its selector, a longer timeout, or a waitFor before it), then call again.`
      );
    }
    return new Error(`The ${err.jobStatus === "cancelled" ? "job was cancelled" : "job failed"}: ${err.message}`);
  }
  if (err instanceof SpidraError) {
    const retryable = err.status >= 500;
    return new Error(
      `Spidra API error ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}. ` +
        (retryable ? "This may be transient, retrying once after a short wait is OK." : "Do not retry with the same input.")
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
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

// A step inside forEach: any action except forEach.
const stepSchema = z
  .object({ type: z.enum(STEP_TYPES).describe("The action"), ...stepFields })
  .passthrough();

const browserActionSchema = z
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

const jsonSchemaParam = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "JSON Schema enforcing the exact output shape. Define EVERY field you want extracted, " +
      "an untyped object with no properties comes back empty. Missing fields return null instead of hallucinated values."
  );

const proxyParams = {
  useProxy: z.boolean().optional().describe("Route through a residential proxy (for blocked/geo-restricted sites)"),
  proxyCountry: z
    .string()
    .optional()
    .describe('Two-letter country code for the proxy, e.g. "us", "de", "jp", or "eu"/"global"'),
};

const TERMINAL_NOTE =
  "Job statuses: waiting/active/running are in progress; completed, failed, and cancelled are terminal.";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new FastMCP<SessionData>({
  name: "spidra-mcp",
  version: packageVersion as `${number}.${number}.${number}`,
  instructions:
    "Spidra is an AI-powered web scraping, crawling, and search service. " +
    "First question: do you already know the URL(s)? If not, start with spidra_search to find them. " +
    "If you do know the URL, use spidra_scrape for a single extraction from it (it waits and returns the result). " +
    "Use spidra_batch_scrape (2-50 known URLs) for anything involving more than one URL, each gets its own independent result (async, poll spidra_check_batch_status) -- do NOT call spidra_scrape once per URL and try to compare/combine the answers yourself across separate calls when a single batch call does it cleanly. " +
    "Use spidra_parse to turn a PDF, Word, Excel or PowerPoint document (a link, or a small file as base64) into Markdown or extracted JSON. " +
    "Use spidra_map to list a site's page URLs quickly (1 credit, waits and returns), then scrape the ones you need. " +
    "Use spidra_crawl to discover and process pages starting from one URL when you do NOT know the page URLs upfront (async, poll spidra_check_crawl_status). " +
    "Every scraped URL costs credits (base 1 per URL plus AI tokens), so prefer the narrowest tool and smallest page counts that answer the question.",
  logger,
  roots: { enabled: false },
  ...(oauthProvider ? { auth: oauthProvider } : {}),
  authenticate,
  health: { enabled: true, message: "ok", path: "/health", status: 200 },
});

// ---------------------------------------------------------------------------
// Scrape tools
// ---------------------------------------------------------------------------

server.addTool({
  name: "spidra_scrape",
  annotations: {
    title: "Scrape web pages",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Scrape one known URL and extract its content with AI. This tool WAITS for the result (typically a couple seconds for ordinary pages, up to 60 for hard ones) and returns the extracted content directly.

**Best for:** one known URL.
**Not for:** discovering pages on a site (use spidra_crawl), or more than one URL, even just to compare two pages. Use spidra_batch_scrape for that instead, so each URL gets its own clean, attributable result rather than one answer that risks blending or misattributing facts between sources.

Behavior notes:
- Omit "prompt" and "schema" to get the page content as readable markdown. For pages handled by one of Spidra's site scrapers (Amazon, LinkedIn, Google Maps, Instagram, Reddit and others), the result also has "structuredData", an object with the page's fields. The markdown does not include that data.
- "output" is "markdown" (default) or "json". With "json" and no prompt or schema, a site scraper page returns its structured data as is, with no AI; other pages use the default AI extraction.
- Pass "prompt" for free-form AI extraction, and add "schema" when you need a guaranteed JSON shape. Define every field in the schema, untyped objects come back empty.
- Use "actions" to work with the page before it is captured (see Browser actions below), or "instruction" for one plain-English task instead.
- By default (when you don't set "scrapeMode" or "useProxy" yourself, and there are no "actions" or "instruction"), this tries a fast HTTP-only fetch first, no browser, no proxy, and only pays for a full browser render with a proxy if that first attempt's content came back suspiciously thin. Most ordinary pages finish in a couple seconds this way; a bot-protected page costs a second attempt (2 credits total instead of 1) but still resolves automatically. Set "scrapeMode" or "useProxy" yourself to skip this and go straight to a specific mode, e.g. for a site you already know needs a proxy.
- Costs: 1 credit per URL plus AI tokens (2 if the automatic fallback above kicks in); CAPTCHA solves cost 5 credits each.

**Browser actions** ("actions": steps run in order in a real browser before the page is captured; at most 50, and 60 seconds of waiting in total):
- click, check, uncheck, hover: {"selector"}
- type: {"selector" (optional, default the first visible text field), "value": the text}
- select: {"selector", "value": the option's label or value}
- press: {"key": "Enter" | "Tab" | "Escape" | "Control+A" ..., "selector" (optional)}
- wait: {"duration": ms, 1-30000}. Prefer waitFor, which waits only as long as needed.
- waitFor: {"selector", "state": "visible" (default) | "attached" | "hidden" | "detached"}
- scroll: {"to": 0-100 | "top" | "bottom" | an element} or {"pixels": n}
- scrollUntilEnd: {"maxScrolls" 1-30, "pause" ms, "clickSelector" for a "Load more" button}: keeps going until the page stops growing
- evaluate: {"script"}: runs JavaScript in the page; its value comes back in actionResults
- screenshot: {"fullPage"}: its link comes back in actionResults
- forEach: {"observe", "mode": "click" | "inline" | "navigate", "captureSelector", "maxItems" 1-50, "itemPrompt", "actions" (per item, 10 max, no forEach), "pagination": {"nextSelector", "maxPages" 1-10}}: goes through a list and captures each item. It must be the single, LAST action.

Rules:
- "selector" is a CSS selector, an XPath, or plain English ("the Sign in button"). Prefer CSS when you know it: it is exact and faster.
- Every step except forEach takes "timeout" (ms to find the element, 100-30000, default 10000) and "optional". A step that fails fails the whole job with "Action N (type "target") failed: <reason>" (failed jobs are free). Mark steps that may not be there (cookie banners, popups) "optional": true so they are skipped instead.
- Use "actions" OR "instruction", never both. Either one always runs in a real browser, and such a run is never retried automatically, since steps like a form submission can have side effects.
- Read "actionResults" in the result: one entry per step with "status" (ok, skipped or failed), "error", "result" (evaluate) and "screenshotUrl". "warnings" lists skipped steps and a forEach that fell back to the whole page or stopped early.

**Usage example:**
\`\`\`json
{
  "name": "spidra_scrape",
  "arguments": {
    "url": "https://spidra.io/pricing",
    "prompt": "Extract all pricing plans with name, price, and included features",
    "output": "json"
  }
}
\`\`\`

**Usage example with actions:**
\`\`\`json
{
  "name": "spidra_scrape",
  "arguments": {
    "url": "https://quotes.toscrape.com/login",
    "actions": [
      { "type": "click", "selector": "#cookie-accept", "optional": true, "timeout": 2000 },
      { "type": "type", "selector": "#username", "value": "demo" },
      { "type": "type", "selector": "#password", "value": "demo" },
      { "type": "click", "selector": "input[type='submit']" },
      { "type": "waitFor", "selector": "a[href='/logout']" }
    ],
    "prompt": "List the first 3 quotes with their authors",
    "output": "json"
  }
}
\`\`\`
**Returns:** extracted content plus token/credit stats, and "structuredData", "canonicalUrl" (the cleaned link a site scraper used), "actionResults", "forEachItems" (how many items a forEach captured) and "warnings" (anything asked for that was not done) when present. If the wait window is exceeded, the job keeps running, poll spidra_check_scrape_status with the returned jobId.
`,
  parameters: z.object({
    url: z.string().describe("The URL to scrape"),
    prompt: z.string().optional().describe("What to extract, in plain English. Omit for raw markdown."),
    output: z.enum(["json", "markdown"]).optional().describe('Output format (default "markdown")'),
    schema: jsonSchemaParam,
    actions: z
      .array(browserActionSchema)
      .max(50)
      .optional()
      .describe("Browser steps to run in order before the page is captured. A forEach must be the single, last one. Can't be combined with instruction."),
    instruction: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'One plain-English task for the browser to carry out before the page is captured (e.g. "search for wireless headphones and open the first result"). Use this instead of "actions" when the steps aren\'t known ahead of time; never send both.'
      ),
    cookies: z.string().optional().describe('Raw Cookie header string for pages behind a login, e.g. "session=abc"'),
    screenshot: z.boolean().optional().describe("Capture a viewport screenshot (URL returned)"),
    extractContentOnly: z.boolean().optional().describe("Strip navigation/ads/boilerplate before extraction"),
    scrapeMode: z.enum(["default", "fast"]).optional().describe('"default" = full browser, "fast" = HTTP only (no browser), cheaper but less capable. Leave unset to let this tool pick automatically (fast first, falls back to a full browser+proxy attempt only if needed; with actions or instruction it goes straight to the browser).'),
    ...proxyParams,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Scraping", { url: args.url });
    return run(async () => {
      const runScrape = (scrapeMode: "default" | "fast", useProxy: boolean) =>
        client.scrape(
          {
            urls: [
              {
                url: args.url,
                ...(args.actions ? { actions: args.actions as never } : {}),
                ...(args.instruction ? { instruction: args.instruction } : {}),
              },
            ],
            prompt: args.prompt ?? "",
            ...(args.output ? { output: args.output } : {}),
            ...(args.schema ? { schema: args.schema } : {}),
            ...(args.cookies ? { cookies: args.cookies } : {}),
            ...(args.screenshot != null ? { screenshot: args.screenshot } : {}),
            ...(args.extractContentOnly != null ? { extractContentOnly: args.extractContentOnly } : {}),
            useProxy,
            ...(args.proxyCountry ? { proxyCountry: args.proxyCountry } : {}),
            scrapeMode,
          } as never,
          { timeout: 240_000 }
        );

      // Auto fast-mode fallback: only when the caller didn't already pick a
      // scrapeMode/useProxy explicitly, since that means they know what they
      // want (e.g. a known-hard site). Otherwise, try the cheap HTTP-only
      // path first (no browser, no proxy) -- confirmed live (2026-09-26) it
      // produces near-identical content to full browser mode for ordinary
      // article-style pages in a fraction of the time (~1s vs ~9s in one
      // real test). Only escalate to a full browser+proxy attempt if the
      // fast attempt's own content came back suspiciously thin (lowContent),
      // which usually means real bot protection rather than a page that just
      // needs JS -- the backend already retries fast-mode-needs-JS cases
      // internally before this ever sees the result.
      //
      // Actions and instructions skip all of that: they need a browser, so
      // they go straight to it, and they run exactly once. A second run would
      // repeat their steps (a form submitted twice, an item added twice).
      const hasSteps = Boolean(args.actions?.length || args.instruction);
      const autoMode = args.scrapeMode === undefined && args.useProxy === undefined && !hasSteps;
      let result = await runScrape(autoMode ? "fast" : args.scrapeMode ?? "default", autoMode ? false : args.useProxy ?? false);
      let usedFallback = false;

      if (autoMode && result.data?.[0]?.lowContent) {
        usedFallback = true;
        result = await runScrape("default", true);
      }

      // structuredData/canonicalUrl/warnings/actionResults are raw API fields;
      // typed loosely so this compiles against spidra SDK versions that predate them.
      const first = result.data?.[0] as
        | {
            structuredData?: unknown;
            canonicalUrl?: string;
            warnings?: string[];
            actionResults?: unknown[];
            forEachItems?: number;
            lowContent?: boolean;
          }
        | undefined;
      // The job's warnings include this URL's own plus any about credits running short.
      const warnings = (result as { warnings?: string[] }).warnings ?? first?.warnings;
      // In json mode without a prompt/schema, content already IS the
      // structured data, so only add it separately when it isn't duplicated.
      const includeStructured = args.output !== "json";

      return asText({
        content: result.content,
        ...(includeStructured && first?.structuredData !== undefined ? { structuredData: first.structuredData } : {}),
        ...(first?.canonicalUrl ? { canonicalUrl: first.canonicalUrl } : {}),
        ...(first?.actionResults?.length ? { actionResults: first.actionResults } : {}),
        ...(first?.forEachItems !== undefined ? { forEachItems: first.forEachItems } : {}),
        ...(warnings?.length ? { warnings } : {}),
        screenshots: result.screenshots,
        extractionEmpty: result.extraction_empty || undefined,
        lowContent: first?.lowContent || undefined,
        ...(usedFallback
          ? { note: "Initial fast attempt returned thin content, automatically retried with full browser rendering and a proxy." }
          : hasSteps && first?.lowContent && !args.useProxy
            ? { note: "The page came back nearly empty. Steps are not re-run automatically. If the site blocks automated browsers, call again with useProxy: true." }
            : {}),
        stats: result.stats,
      });
    });
  },
});

server.addTool({
  name: "spidra_check_scrape_status",
  annotations: {
    title: "Check scrape status",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Check the status of a scrape job by jobId. Only needed when spidra_scrape reported that its wait window was exceeded. ${TERMINAL_NOTE}
`,
  parameters: z.object({ jobId: z.string().describe("The scrape job id") }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.getScrape(args.jobId)));
  },
});

// ---------------------------------------------------------------------------
// Search tools
// ---------------------------------------------------------------------------

server.addTool({
  name: "spidra_search",
  annotations: {
    title: "Search the web",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Run a real search query and get back structured results (titles, links, descriptions, thumbnails), the same data a search engine itself would show. This tool WAITS for the result and returns it directly.

**Best for:** finding pages when you don't already know the URL, checking what's out there before deciding what to scrape, getting news/image/video results, or finding academic papers (research) / GitHub issues and PRs (developer).
**Not for:** a URL you already know (use spidra_scrape directly, it's cheaper and gives you AI extraction/schemas that search doesn't).

Behavior notes:
- Only "web" results come back unless you add "sources". Each source runs independently, one being empty doesn't affect the others. "research" covers arXiv/PubMed/bioRxiv/medRxiv; "developer" covers GitHub issues and PRs; neither honors includeDomains/excludeDomains/filetype.
- Use "includeDomains" or "excludeDomains" (never both) to restrict results to or away from specific sites.
- Need more results than one call returned? Pass that source's token from the previous response's "nextPageTokens" back as "pageTokens" (e.g. \`{"web": "<token>"}\`) to fetch the next page -- results continue the same rank numbering (11, 12, ... after a first page of 10), they don't restart at 1. A source with no "nextPageTokens" entry has no more pages.
- Add "scrapeOptions" to also fetch each web result's actual page content (clean markdown) in the SAME call, no separate spidra_scrape step needed. This makes the call take as long as its slowest scraped page (not the usual few seconds), and costs the normal per-page scrape credits on top of the search. A result that fails to scrape is just left without markdown, not an error. Pages read by one of Spidra's site scrapers also get "structuredData" with the page's fields.
- Want AI extraction, a schema, or a screenshot instead of plain markdown from one specific result? Scrape that URL directly with spidra_scrape.

**Costs:** 1 credit per 10 results actually returned, per source, rounded up (10 web results is 1 credit, 15 is 2, a source that returns nothing is free). Requesting more sources or a higher "limit" only costs more if it actually delivers more results.

**Usage example:**
\`\`\`json
{
  "name": "spidra_search",
  "arguments": {
    "query": "best espresso machine 2026",
    "sources": ["web", "news"],
    "limit": 5
  }
}
\`\`\`
**Returns:** results per requested source, plus stats. If the wait window is exceeded, the job keeps running, poll spidra_check_search_status with the returned jobId.
`,
  parameters: z.object({
    query: z.string().describe("What to search for"),
    sources: z
      .array(z.enum(["web", "news", "images", "videos", "research", "developer"]))
      .optional()
      .describe('Which result types to fetch (default: ["web"]). "research" = arXiv/PubMed/bioRxiv/medRxiv papers, "developer" = GitHub issues/PRs.'),
    limit: z.number().min(1).max(20).optional().describe("Results per source, 1-20 (default 10)"),
    pageTokens: z
      .record(z.string(), z.string())
      .optional()
      .describe('Per-source continuation token(s) from a prior response\'s "nextPageTokens", to fetch that source\'s next page (e.g. {"web": "<token>"}). Falls back to a fresh search for that source if a token is stale.'),
    timeRange: z
      .enum(["hour", "day", "week", "month", "year"])
      .optional()
      .describe("Restrict results to a recency window. Support varies by which engine answers -- an unsupported window is just ignored, never an error."),
    country: z.string().optional().describe('Two-letter country code, or "global"/"eu"/"asia", for localized results'),
    includeDomains: z
      .array(z.string())
      .optional()
      .describe("Only return web results from these domains. Mutually exclusive with excludeDomains."),
    excludeDomains: z
      .array(z.string())
      .optional()
      .describe("Keep web results from these domains out. Mutually exclusive with includeDomains."),
    filetype: z.enum(["pdf"]).optional().describe("Restrict web results to PDF files."),
    scrapeOptions: z
      .object({
        formats: z.array(z.enum(["markdown"])).min(1).describe('Markdown-only for search. Want a screenshot of a specific result instead? Use spidra_scrape on that URL.'),
        maxResults: z.number().min(1).max(20).optional().describe("Cap how many top-ranked web results get scraped (default: all, up to 10)"),
      })
      .optional()
      .describe("Opt-in: also scrape each web result's page content in this same call"),
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Searching", { query: args.query, sources: args.sources });
    return run(async () => {
      const result = await client.search(
        {
          query: args.query,
          ...(args.sources ? { sources: args.sources } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.pageTokens ? { pageTokens: args.pageTokens } : {}),
          ...(args.timeRange ? { timeRange: args.timeRange } : {}),
          ...(args.country ? { country: args.country } : {}),
          ...(args.includeDomains ? { includeDomains: args.includeDomains } : {}),
          ...(args.excludeDomains ? { excludeDomains: args.excludeDomains } : {}),
          ...(args.filetype ? { filetype: args.filetype } : {}),
          ...(args.scrapeOptions ? { scrapeOptions: args.scrapeOptions } : {}),
        },
        { timeout: 240_000 }
      );
      return asText(result);
    });
  },
});

server.addTool({
  name: "spidra_check_search_status",
  annotations: {
    title: "Check search status",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Check the status of a search job by jobId. Only needed when spidra_search reported that its wait window was exceeded (rare, only likely with scrapeOptions on many results). ${TERMINAL_NOTE}
`,
  parameters: z.object({ jobId: z.string().describe("The search job id") }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.getSearch(args.jobId)));
  },
});

// ---------------------------------------------------------------------------
// Batch tools
// ---------------------------------------------------------------------------

server.addTool({
  name: "spidra_batch_scrape",
  annotations: {
    title: "Batch scrape URLs",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Scrape a list of 2-50 known URLs in parallel with the same extraction prompt/schema. Each URL is processed INDEPENDENTLY and gets its OWN result -- this is the tool for anything involving more than one URL, spidra_scrape only ever takes one. By default this returns IMMEDIATELY with a batchId, it does not wait.

**Best for:** running the same extraction on each of many similar pages (product pages, listings, articles) where you need separate data per URL, even for just 2 URLs.
**Workflow:** call this, then poll spidra_check_batch_status with the batchId every 10-15 seconds until the batch reaches a terminal state. Do NOT resubmit while a batch is pending.
- For 10 URLs or fewer, set "wait" to true to get the finished results back directly from this call instead of polling, this can still take a couple minutes for a slow batch. Above 10 URLs "wait" is ignored and the normal batchId is returned, since waiting on a large batch would just tie up this call for as long as the slowest item takes anyway.

"output" is "markdown" (the default) or "json"; passing a schema forces "json". Each finished item has its "result", plus "structuredData" (an object with the page's fields) when the URL was handled by one of Spidra's site scrapers. Markdown results do not include that data.

Costs: 1 credit per URL plus AI tokens. Failed items can be retried with spidra_retry_batch, or the whole batch cancelled with spidra_cancel_batch (credits for unprocessed items are refunded).
`,
  parameters: z.object({
    urls: z.array(z.string()).min(2).max(50).describe("2-50 URLs to scrape in parallel (plain strings)"),
    prompt: z.string().optional().describe("What to extract from each page. Omit for raw markdown."),
    output: z.enum(["json", "markdown"]).optional().describe('Output format (default "markdown"; a schema forces "json")'),
    schema: jsonSchemaParam,
    cookies: z.string().optional(),
    extractContentOnly: z.boolean().optional(),
    scrapeMode: z.enum(["default", "fast"]).optional().describe('"default" = full browser (the default), "fast" = HTTP only (no browser)'),
    wait: z.boolean().optional().describe("For batches of 10 URLs or fewer, wait and return the finished results directly instead of a batchId to poll. Ignored above 10 URLs."),
    ...proxyParams,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Submitting batch", { count: args.urls.length });
    return run(async () => {
      const params = {
        urls: args.urls,
        prompt: args.prompt ?? "",
        ...(args.output ? { output: args.output } : {}),
        ...(args.schema ? { schema: args.schema } : {}),
        ...(args.cookies ? { cookies: args.cookies } : {}),
        ...(args.extractContentOnly != null ? { extractContentOnly: args.extractContentOnly } : {}),
        ...(args.useProxy != null ? { useProxy: args.useProxy } : {}),
        ...(args.proxyCountry ? { proxyCountry: args.proxyCountry } : {}),
        ...(args.scrapeMode ? { scrapeMode: args.scrapeMode } : {}),
      } as never;

      if (args.wait && args.urls.length <= 10) {
        // client.batchScrape() submits then polls to completion client-side --
        // proven, already-published code, reused as-is rather than adding a
        // second wait mechanism at this layer. A timeout here surfaces as a
        // SpidraTimeoutError, which run()/toToolError already turn into a
        // helpful "still running, poll spidra_check_batch_status with this
        // batchId" message, so a slow batch degrades gracefully either way.
        const finished = await client.batchScrape(params, { timeout: 180_000 });
        return asText(finished);
      }

      const queued = await client.startBatchScrape(params);
      return asText({
        batchId: queued.batchId,
        total: queued.total,
        next: `Batch queued. Poll spidra_check_batch_status with batchId "${queued.batchId}" every 10-15 seconds until status is terminal.`,
      });
    });
  },
});

server.addTool({
  name: "spidra_check_batch_status",
  annotations: {
    title: "Check batch status",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Check the status of a batch scrape by batchId. Returns per-URL statuses and results for finished items. Batch statuses: pending/running are in progress; completed, failed, and cancelled are terminal. A completed batch can still contain failed items, check failedCount.
`,
  parameters: z.object({ batchId: z.string().describe("The batch id returned by spidra_batch_scrape") }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.getBatchScrape(args.batchId)));
  },
});

server.addTool({
  name: "spidra_retry_batch",
  annotations: {
    title: "Retry failed batch items",
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Re-queue only the failed items in a batch scrape, successful items are left alone and not re-run. Every option from the original batch is kept. Cookies are never stored, so a batch that used cookies retries logged out. Use this after spidra_check_batch_status shows failedCount > 0 and you want another attempt at just those URLs.
`,
  parameters: z.object({ batchId: z.string() }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.retryBatchScrape(args.batchId)));
  },
});

server.addTool({
  name: "spidra_cancel_batch",
  annotations: {
    title: "Cancel a batch",
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  },
  description: `
Cancel a pending or running batch scrape. Credits for unprocessed items are refunded; already-finished items keep their results.
`,
  parameters: z.object({ batchId: z.string() }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.cancelBatchScrape(args.batchId)));
  },
});

// ---------------------------------------------------------------------------
// Parse tools
// ---------------------------------------------------------------------------

const PARSE_WAIT_MS = 50_000;

server.addTool({
  name: "spidra_parse",
  annotations: {
    title: "Parse a document",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Turn a document into Markdown, page by page: PDF, Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, CSV or HTML. Pass a link to the document ("url"), a small file as base64 ("fileBase64" with "fileName", up to about 10 MB), or a "fileId" from an earlier parse. Scanned pages are read with AI. Add "prompt" or "schema" to get extracted fields as JSON.

Costs 1 credit per page parsed, plus AI tokens for extraction; pages that fail are free. Use "pages" (like "1-5") or "maxPages" to parse only what you need from long documents. Waits for the result; very long documents return a jobId to check with spidra_check_parse_status.

**Best for:** reports, papers, invoices, contracts and spreadsheets, whether they are online or the user gave you the file.
**Not for:** web pages (use spidra_scrape).

**Usage example:**
\`\`\`json
{
  "name": "spidra_parse",
  "arguments": { "url": "https://arxiv.org/pdf/1706.03762", "pages": "1-3" }
}
\`\`\`
`,
  parameters: z.object({
    url: z.string().optional().describe("Link to the document"),
    fileBase64: z.string().max(14_000_000).optional().describe("The file's bytes, base64-encoded (up to about 10 MB)"),
    fileName: z.string().optional().describe("The file's name with its extension, required with fileBase64, e.g. report.pdf"),
    fileId: z.string().optional().describe("A fileId from an earlier parse, to parse the same file again with other options"),
    mode: z.enum(["auto", "fast", "ocr"]).optional().describe('"auto" (default) uses AI only for scanned pages, "fast" never, "ocr" on every page'),
    pages: z.string().optional().describe('PDF pages to parse, like "1-5, 9" or "10-"'),
    maxPages: z.number().int().min(1).optional().describe("Parse at most this many pages"),
    includePages: z.boolean().optional().describe("Also return per-page Markdown"),
    prompt: z.string().max(5000).optional().describe("Fields to extract, in plain words; the result is in json"),
    schema: jsonSchemaParam,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    const { url, fileBase64, fileName, fileId, ...options } = args;
    const sources = [url, fileBase64, fileId].filter(Boolean).length;
    if (sources !== 1) throw new UserError('Pass exactly one of "url", "fileBase64" (with "fileName") or "fileId".');
    if (fileBase64 && !fileName) throw new UserError('"fileName" is required with "fileBase64", e.g. "report.pdf".');
    const input = url ? { url } : fileId ? { fileId } : { file: Buffer.from(fileBase64!, "base64"), fileName: fileName! };
    log.info("Parsing document", { source: url ?? fileName ?? fileId });
    return run(async () => {
      const job = await client.startParse(input as never, { ...options, schema: options.schema as Record<string, unknown> | undefined });
      const deadline = Date.now() + PARSE_WAIT_MS;
      let current = job;
      while ((current.status === "queued" || current.status === "running") && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        current = await client.getParse(job.jobId, { includePages: options.includePages });
      }
      if (current.status === "queued" || current.status === "running") {
        return asText({ jobId: job.jobId, status: current.status, next: `Still parsing. Call spidra_check_parse_status with jobId "${job.jobId}" in a little while.` });
      }
      return asText(current);
    });
  },
});

server.addTool({
  name: "spidra_check_parse_status",
  annotations: {
    title: "Check parse status",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Check a parse job started by spidra_parse. While running, shows which page it is on; when completed, returns the Markdown (and JSON if extraction was asked for). ${TERMINAL_NOTE}
`,
  parameters: z.object({
    jobId: z.string().describe("The jobId returned by spidra_parse"),
    includePages: z.boolean().optional().describe("Also return per-page Markdown"),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.getParse(args.jobId, { includePages: args.includePages })));
  },
});

// ---------------------------------------------------------------------------
// Crawl tools
// ---------------------------------------------------------------------------

server.addTool({
  name: "spidra_map",
  annotations: {
    title: "List a site's URLs",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
List the page URLs of a website without scraping them, from its sitemap and the links on its main pages. WAITS and returns the URLs directly, usually in a few seconds. Costs 1 credit per call, nothing when no URLs are found.

**Best for:** finding the right pages on a site before scraping them ("which page on stripe.com covers refunds?"), or getting a full URL list cheaply.
**Workflow:** map with a "search" to rank URLs by relevance, pick the ones you need, then call spidra_scrape or spidra_batch_scrape on exactly those. This is often cheaper than spidra_crawl when you only need a few pages.

**Usage example:**
\`\`\`json
{
  "name": "spidra_map",
  "arguments": { "url": "https://docs.python.org/3/", "search": "asyncio", "limit": 20 }
}
\`\`\`
`,
  parameters: z.object({
    url: z.string().describe("The website to map"),
    search: z.string().optional().describe("Only return URLs related to these words, best matches first"),
    limit: z.number().int().min(1).max(5000).optional().describe("Most URLs returned (default 500). Keep it small when you only need a few."),
    sitemap: z
      .enum(["include", "only", "skip"])
      .optional()
      .describe('"include" (default) reads the sitemap and page links, "only" the sitemap (fastest), "skip" the links only'),
    includeSubdomains: z.boolean().optional(),
    ignoreQueryParams: z.boolean().optional().describe("Treat URLs that differ only by query string as one (default true)"),
    respectRobots: z.boolean().optional().describe("Leave out URLs the site's robots.txt disallows"),
    cookies: z.string().optional(),
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Mapping site", { url: args.url });
    return run(async () => asText(await client.map(args)));
  },
});

server.addTool({
  name: "spidra_crawl",
  annotations: {
    title: "Crawl a website",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Crawl a website starting from one URL: Spidra discovers pages by following links according to your plain-language instruction, and optionally extracts structured data from every page. Returns IMMEDIATELY with a jobId, it does not wait.

**Best for:** extracting from many pages when you do NOT know their URLs upfront (docs sites, blogs, product catalogs).
**Not for:** URLs you already know (use spidra_scrape or spidra_batch_scrape, cheaper and faster).
**Workflow:** call this, then poll spidra_check_crawl_status with the jobId every 10-15 seconds until terminal. Do NOT resubmit while a crawl is pending. Cancel a mistake with spidra_cancel_crawl.

Behavior notes:
- "crawlInstruction" controls which links are followed (e.g. "Follow blog post links only, skip tag pages").
- "transformInstruction" controls what is extracted per page; omit it (and schema) for raw markdown with no AI token cost.
- Keep "maxPages" small (default 5), every page returned costs credits. The most allowed per crawl depends on the plan: Free 100, Starter 1,000, Builder 5,000, Pro 10,000. Category and listing pages read only to find the wanted pages are free.
- After it finishes, spidra_crawl_report explains what was skipped and why, if a page you expected is missing.

**Usage example:**
\`\`\`json
{
  "name": "spidra_crawl",
  "arguments": {
    "baseUrl": "https://spidra.io/blog",
    "crawlInstruction": "Follow blog post links only, skip tag and category pages",
    "transformInstruction": "Extract the title, author, and publish date",
    "maxPages": 10
  }
}
\`\`\`
`,
  parameters: z.object({
    baseUrl: z.string().describe("Starting URL for the crawl"),
    crawlInstruction: z.string().describe("Which links to follow, in plain language"),
    transformInstruction: z
      .string()
      .optional()
      .describe("What to extract from each page. Omit for raw markdown (no AI cost)."),
    schema: jsonSchemaParam,
    maxPages: z.number().int().min(1).max(10000).optional().describe("Most pages to return (default 5; plan limits: Free 100, Starter 1,000, Builder 5,000, Pro 10,000). Keep it small, each page costs 1 credit."),
    maxDepth: z.number().optional().describe("Max link depth from the base URL. 0 = base URL only."),
    includePaths: z.array(z.string()).optional().describe('URL path patterns to include, e.g. ["/blog/*"]'),
    excludePaths: z.array(z.string()).optional().describe('URL path patterns to skip, e.g. ["/tag/*"]'),
    allowSubdomains: z.boolean().optional(),
    crawlEntireDomain: z.boolean().optional(),
    ignoreQueryParams: z.boolean().optional(),
    cookies: z.string().optional(),
    useSitemap: z.boolean().optional().describe("Read the site's sitemap to find pages (default true)"),
    respectRobots: z.boolean().optional().describe("Follow the site's robots.txt rules and Crawl-delay (default false)"),
    ...proxyParams,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Submitting crawl", { baseUrl: args.baseUrl, maxPages: args.maxPages });
    return run(async () => {
      const { schema, ...rest } = args;
      const queued = await client.startCrawl({ ...rest, ...(schema ? { schema } : {}) } as never);
      return asText({
        jobId: queued.jobId,
        next: `Crawl queued. Poll spidra_check_crawl_status with jobId "${queued.jobId}" every 10-15 seconds until status is terminal.`,
      });
    });
  },
});

server.addTool({
  name: "spidra_check_crawl_status",
  annotations: {
    title: "Check crawl status",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Check the status of a crawl job by jobId. While running, returns a progress message describing what's happening right now (e.g. "Scraping (3/10) https://..."), not a page count, poll again for an updated one. When completed, returns the extracted data for the pages (the first 100 for large crawls; "totalPages" says how many there are, and spidra_crawl_pages reads the rest). ${TERMINAL_NOTE}
`,
  parameters: z.object({ jobId: z.string().describe("The crawl job id returned by spidra_crawl") }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.getCrawl(args.jobId)));
  },
});

server.addTool({
  name: "spidra_crawl_pages",
  annotations: {
    title: "Get crawled pages",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Get per-page results for a crawl, including signed download URLs for each page's raw HTML and markdown (links expire after 1 hour). Works on completed crawls and on cancelled crawls (returns the pages processed before cancellation). Returns up to 1,000 pages per call: for large crawls pass "offset" and "limit", and keep "limit" small (e.g. 50) to save context. The response has "total" and "hasMore".
`,
  parameters: z.object({
    jobId: z.string(),
    offset: z.number().int().min(0).optional().describe("Pages to skip (default 0)"),
    limit: z.number().int().min(1).max(1000).optional().describe("Pages to return (default 1,000)"),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    const { jobId, ...params } = args;
    return run(async () => asText(await client.crawlPages(jobId, params)));
  },
});

server.addTool({
  name: "spidra_crawl_report",
  annotations: {
    title: "Explain what a crawl skipped",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Explain a finished crawl: how it understood the instruction, how many pages it read only to find the wanted ones (not billed), and the links it did NOT follow, grouped by reason with counts. Pass "reason" to list the URLs for one reason, each with the page it was found on.

Use this when a page you expected is missing from the results, then adjust crawlInstruction, includePaths or maxPages and crawl again. Reasons: not_relevant, outside_domain, include_pattern, exclude_pattern, file_type, other_version_or_language, duplicate_page, redirected_off_site, robots_txt, action_link.
`,
  parameters: z.object({
    jobId: z.string().describe("The crawl job id"),
    reason: z.string().optional().describe('List skipped URLs for this reason only, e.g. "not_relevant"'),
    limit: z.number().int().min(1).max(2000).optional().describe("How many skipped URLs to return (default 200)"),
    offset: z.number().int().min(0).optional(),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    const { jobId, ...params } = args;
    return run(async () => asText(await client.crawlReport(jobId, params)));
  },
});

server.addTool({
  name: "spidra_crawl_extract",
  annotations: {
    title: "Re-extract from a crawl",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Run a NEW extraction prompt over an already-completed crawl without re-crawling any pages, much cheaper than crawling again (only AI token credits are charged). Returns a new jobId immediately; poll spidra_check_crawl_status with it. The source crawl must have status "completed".
`,
  parameters: z.object({
    jobId: z.string().describe("The completed source crawl job id"),
    transformInstruction: z.string().max(5000).describe("The new extraction instruction to apply to every crawled page"),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => {
      const queued = await client.crawlExtract(args.jobId, args.transformInstruction);
      return asText({
        jobId: queued.jobId,
        next: `Re-extraction queued. Poll spidra_check_crawl_status with jobId "${queued.jobId}".`,
      });
    });
  },
});

server.addTool({
  name: "spidra_cancel_crawl",
  annotations: {
    title: "Cancel a crawl",
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  },
  description: `
Cancel a queued or running crawl job. Pages already processed are preserved and retrievable with spidra_crawl_pages; credits for unprocessed pages are refunded.
`,
  parameters: z.object({ jobId: z.string() }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.cancelCrawl(args.jobId)));
  },
});

server.addTool({
  name: "spidra_retry_crawl_page",
  annotations: {
    title: "Retry one crawled page's AI transformation",
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Re-run the AI transformation for a single already-crawled page, using the crawl's own transformInstruction. Use this when just one or two pages failed extraction rather than re-running spidra_crawl_extract over the whole crawl. Get the pageId from spidra_crawl_pages (each entry's "id" field). Only charges credits for that page's transformation.
`,
  parameters: z.object({
    jobId: z.string().describe("The crawl job id"),
    pageId: z.string().describe('The specific page\'s id, from spidra_crawl_pages'),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.retryCrawlPage(args.jobId, args.pageId)));
  },
});

// ---------------------------------------------------------------------------
// Account tools
// ---------------------------------------------------------------------------

server.addTool({
  name: "spidra_scrape_logs",
  annotations: {
    title: "List scrape logs",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
List past scrape jobs for this account with optional filters. Useful for finding a previous job's result, debugging failures, or checking what a key has been used for. Fetch a single log's full AI output by passing its uuid.
`,
  parameters: z.object({
    uuid: z.string().optional().describe("Fetch one log entry (with full extraction output) instead of listing"),
    status: z.enum(["success", "failed"]).optional(),
    searchTerm: z.string().optional().describe("Filter by URL or prompt substring"),
    limit: z.number().min(1).max(50).optional().describe("Results per page (default 10 here)"),
    page: z.number().min(1).optional(),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => {
      if (args.uuid) return asText(await client.getScrapeLog(args.uuid));
      const { logs, total } = await client.scrapeLogs({
        ...(args.status ? { status: args.status } : {}),
        ...(args.searchTerm ? { searchTerm: args.searchTerm } : {}),
        limit: args.limit ?? 10,
        ...(args.page ? { page: args.page } : {}),
      });
      return asText({ total, logs });
    });
  },
});

server.addTool({
  name: "spidra_usage",
  annotations: {
    title: "Get usage statistics",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  description: `
Get this account's request/credit/token usage broken down by day or week. Use it to answer "how many credits have I used" style questions or to check remaining headroom before a large batch/crawl.
`,
  parameters: z.object({
    range: z.enum(["7d", "30d", "weekly"]).optional().describe('Time range (default "30d")'),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.usage(args.range ?? "30d")));
  },
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (HTTP_MODE) {
  void server.start({
    transportType: "httpStream",
    httpStream: { port: PORT, host: HOST, stateless: true },
  });
} else {
  void server.start({ transportType: "stdio" });
}
