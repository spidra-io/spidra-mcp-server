import dotenv from "dotenv";
import { FastMCP, type Logger } from "fastmcp";
import type { IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  SpidraClient,
  SpidraError,
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
// Logging — stdio uses stdout for JSON-RPC framing, so never log there.
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

// ---------------------------------------------------------------------------
// Auth — env var for stdio, headers for HTTP transports
// ---------------------------------------------------------------------------

function extractApiKey(headers: IncomingHttpHeaders): string | undefined {
  const headerKey = headers["x-spidra-api-key"] ?? headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();

  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

async function authenticate(request?: { headers: IncomingHttpHeaders }): Promise<SessionData> {
  // FastMCP invokes authenticate(undefined) for the stdio transport
  if (!request) {
    return { spidraApiKey: process.env.SPIDRA_API_KEY };
  }
  return { spidraApiKey: extractApiKey(request.headers) ?? process.env.SPIDRA_API_KEY };
}

function getClient(session?: SessionData): SpidraClient {
  const apiKey = session?.spidraApiKey ?? process.env.SPIDRA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Spidra API key configured. Set the SPIDRA_API_KEY environment variable " +
        "(get a key at https://app.spidra.io under Settings > API Keys), " +
        "or send an X-Spidra-API-Key / Authorization: Bearer header on HTTP transports."
    );
  }
  return new SpidraClient({
    apiKey,
    ...(process.env.SPIDRA_API_URL ? { baseUrl: process.env.SPIDRA_API_URL } : {}),
  });
}

// ---------------------------------------------------------------------------
// Output shaping — keep tool results inside sane LLM context budgets
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 5_000;
const MAX_OUTPUT_LENGTH = 80_000;

function truncateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`
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
    ? `${text.slice(0, MAX_OUTPUT_LENGTH)}\n... [output truncated]`
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
      `Rate limited (${err.code ?? "429"}): ${err.message} — wait ${wait} before retrying.`
    );
  }
  if (err instanceof SpidraValidationError) {
    return new Error(
      `Invalid request — fix these problems and try again (do not retry unchanged): ${err.errors.join("; ") || err.message}`
    );
  }
  if (err instanceof SpidraError) {
    const retryable = err.status >= 500;
    return new Error(
      `Spidra API error ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}. ` +
        (retryable ? "This may be transient — retrying once after a short wait is OK." : "Do not retry with the same input.")
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

const browserActionSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      type: z.enum(["click", "type", "check", "uncheck", "wait", "scroll", "forEach"]),
      selector: z.string().optional().describe("CSS selector or XPath of the target element"),
      value: z
        .string()
        .optional()
        .describe("Plain-language element description (AI locates it), or the text to type"),
      duration: z.number().optional().describe("Milliseconds to pause — for the wait action"),
      to: z.string().optional().describe('Scroll destination as a percentage, e.g. "80%"'),
      observe: z
        .string()
        .optional()
        .describe('forEach: which elements to find, e.g. "Find all product cards"'),
      mode: z.enum(["click", "inline", "navigate"]).optional().describe("forEach interaction mode"),
      captureSelector: z.string().optional().describe("forEach: CSS selector of content to capture per item"),
      maxItems: z.number().optional().describe("forEach: max elements to process (cap 50)"),
      waitAfterClick: z.number().optional().describe("forEach: ms to wait after click/navigate before capture"),
      itemPrompt: z.string().optional().describe("forEach: per-element extraction prompt"),
      actions: z.array(browserActionSchema).optional().describe("forEach: per-element actions after click/navigate"),
      pagination: z
        .object({
          nextSelector: z.string().describe('Selector or description of the "next page" link'),
          maxPages: z.number().optional().describe("Max extra pages to paginate through (cap 10)"),
        })
        .optional(),
    })
    .passthrough()
) as z.ZodType<Record<string, unknown>>;

const jsonSchemaParam = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "JSON Schema enforcing the exact output shape. Define EVERY field you want extracted — " +
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
    "Spidra is an AI-powered web scraping and crawling service. " +
    "Choosing a tool — the key question is whether you want ONE combined answer or SEPARATE data per URL: " +
    "use spidra_scrape for 1-3 known URLs when you want a single extraction — with multiple URLs their content is merged and the AI answers ONCE across all of them (great for comparing or synthesizing pages; it waits and returns the result); " +
    "use spidra_batch_scrape (2-50 known URLs) when each URL should produce its OWN independent result, e.g. the same fields from every product page (async — poll spidra_check_batch_status); " +
    "use spidra_crawl to discover and process pages starting from one URL when you do NOT know the page URLs upfront (async — poll spidra_check_crawl_status). " +
    "Every scraped URL costs credits (base 2 per URL plus AI tokens), so prefer the narrowest tool and smallest page counts that answer the question.",
  logger: new ConsoleLogger(),
  roots: { enabled: false },
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
Scrape 1-3 known URLs and extract their content with AI. This tool WAITS for the result (typically 10-60 seconds) and returns the extracted content directly.

IMPORTANT: with multiple URLs, their content is COMBINED and the AI produces ONE answer across all of them (the per-URL raw pages are still returned in "pages"). Use several URLs here when you want to compare or synthesize across pages — e.g. "compare the pricing on these two pages". If instead you want the SAME extraction run separately on each URL (own result per URL), use spidra_batch_scrape even for just 2 URLs.

**Best for:** one URL, or one combined answer drawn from 2-3 related URLs.
**Not for:** per-URL independent results (use spidra_batch_scrape) or discovering pages on a site (use spidra_crawl).

Behavior notes:
- Omit "prompt" and "schema" to get the raw page content as markdown.
- Pass "prompt" for free-form AI extraction, and add "schema" when you need a guaranteed JSON shape. Define every field in the schema — untyped objects come back empty.
- Use "actions" to interact with the page first (dismiss cookie banners, type into search boxes, scroll, or loop over elements with forEach).
- Use "useProxy" with "proxyCountry" for geo-restricted or bot-protected sites.
- Costs: 2 credits per URL plus AI tokens; CAPTCHA solves cost 10 credits each.

**Usage example:**
\`\`\`json
{
  "name": "spidra_scrape",
  "arguments": {
    "urls": ["https://example.com/pricing"],
    "prompt": "Extract all pricing plans with name, price, and included features",
    "output": "json"
  }
}
\`\`\`
**Returns:** extracted content plus token/credit stats. If the wait window is exceeded, the job keeps running — poll spidra_check_scrape_status with the returned jobId.
`,
  parameters: z.object({
    urls: z.array(z.string()).min(1).max(3).describe("1-3 URLs to scrape in parallel"),
    prompt: z.string().optional().describe("What to extract, in plain English. Omit for raw markdown."),
    output: z.enum(["json", "markdown", "text", "table"]).optional().describe('Output format (default "markdown")'),
    schema: jsonSchemaParam,
    actions: z
      .array(browserActionSchema)
      .optional()
      .describe("Browser actions to run on each URL before extraction, in order"),
    cookies: z.string().optional().describe('Raw Cookie header string for pages behind a login, e.g. "session=abc"'),
    screenshot: z.boolean().optional().describe("Capture a viewport screenshot (URL returned)"),
    extractContentOnly: z.boolean().optional().describe("Strip navigation/ads/boilerplate before extraction"),
    scrapeMode: z.enum(["default", "fast"]).optional().describe('"fast" = HTTP only (no browser), cheaper but less capable'),
    ...proxyParams,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Scraping", { urls: args.urls });
    return run(async () => {
      const job = await client.scrape.run(
        {
          urls: args.urls.map((url) => ({
            url,
            ...(args.actions ? { actions: args.actions as never } : {}),
          })),
          prompt: args.prompt ?? "",
          ...(args.output ? { output: args.output } : {}),
          ...(args.schema ? { schema: args.schema } : {}),
          ...(args.cookies ? { cookies: args.cookies } : {}),
          ...(args.screenshot != null ? { screenshot: args.screenshot } : {}),
          ...(args.extractContentOnly != null ? { extractContentOnly: args.extractContentOnly } : {}),
          ...(args.useProxy != null ? { useProxy: args.useProxy } : {}),
          ...(args.proxyCountry ? { proxyCountry: args.proxyCountry } : {}),
          ...(args.scrapeMode ? { scrapeMode: args.scrapeMode } : {}),
        } as never,
        { timeout: 240_000 }
      );
      return asText({
        content: job.result.content,
        pages: job.result.data,
        screenshots: job.result.screenshots,
        stats: job.result.stats,
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
    return run(async () => asText(await client.scrape.get(args.jobId)));
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
Scrape a list of 2-50 known URLs in parallel with the same extraction prompt/schema. Each URL is processed INDEPENDENTLY and gets its OWN result (unlike spidra_scrape, which merges multiple URLs into one combined answer). This tool returns IMMEDIATELY with a batchId — it does not wait.

**Best for:** running the same extraction on each of many similar pages (product pages, listings, articles) where you need separate data per URL — even for just 2 URLs.
**Workflow:** call this, then poll spidra_check_batch_status with the batchId every 10-15 seconds until the batch reaches a terminal state. Do NOT resubmit while a batch is pending.

Costs: 2 credits per URL plus AI tokens. Failed items can be retried from the dashboard or cancelled with spidra_cancel_batch (credits for unprocessed items are refunded).
`,
  parameters: z.object({
    urls: z.array(z.string()).min(2).max(50).describe("2-50 URLs to scrape in parallel (plain strings)"),
    prompt: z.string().optional().describe("What to extract from each page. Omit for raw markdown."),
    output: z.enum(["json", "markdown", "text", "table"]).optional(),
    schema: jsonSchemaParam,
    cookies: z.string().optional(),
    extractContentOnly: z.boolean().optional(),
    scrapeMode: z.enum(["default", "fast"]).optional(),
    ...proxyParams,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Submitting batch", { count: args.urls.length });
    return run(async () => {
      const queued = await client.batch.submit({
        urls: args.urls,
        prompt: args.prompt ?? "",
        ...(args.output ? { output: args.output } : {}),
        ...(args.schema ? { schema: args.schema } : {}),
        ...(args.cookies ? { cookies: args.cookies } : {}),
        ...(args.extractContentOnly != null ? { extractContentOnly: args.extractContentOnly } : {}),
        ...(args.useProxy != null ? { useProxy: args.useProxy } : {}),
        ...(args.proxyCountry ? { proxyCountry: args.proxyCountry } : {}),
        ...(args.scrapeMode ? { scrapeMode: args.scrapeMode } : {}),
      } as never);
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
Check the status of a batch scrape by batchId. Returns per-URL statuses and results for finished items. Batch statuses: pending/running are in progress; completed, failed, and cancelled are terminal. A completed batch can still contain failed items — check failedCount.
`,
  parameters: z.object({ batchId: z.string().describe("The batch id returned by spidra_batch_scrape") }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.batch.get(args.batchId)));
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
    return run(async () => asText(await client.batch.cancel(args.batchId)));
  },
});

// ---------------------------------------------------------------------------
// Crawl tools
// ---------------------------------------------------------------------------

server.addTool({
  name: "spidra_crawl",
  annotations: {
    title: "Crawl a website",
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  description: `
Crawl a website starting from one URL: Spidra discovers pages by following links according to your plain-language instruction, and optionally extracts structured data from every page. Returns IMMEDIATELY with a jobId — it does not wait.

**Best for:** extracting from many pages when you do NOT know their URLs upfront (docs sites, blogs, product catalogs).
**Not for:** URLs you already know (use spidra_scrape or spidra_batch_scrape — cheaper and faster).
**Workflow:** call this, then poll spidra_check_crawl_status with the jobId every 10-15 seconds until terminal. Do NOT resubmit while a crawl is pending. Cancel a mistake with spidra_cancel_crawl.

Behavior notes:
- "crawlInstruction" controls which links are followed (e.g. "Follow blog post links only, skip tag pages").
- "transformInstruction" controls what is extracted per page; omit it (and schema) for raw markdown with no AI token cost.
- Keep "maxPages" small (default 5, max 50) — every page costs credits.

**Usage example:**
\`\`\`json
{
  "name": "spidra_crawl",
  "arguments": {
    "baseUrl": "https://example.com/blog",
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
    maxPages: z.number().min(1).max(50).optional().describe("Max pages to crawl (default 5). Keep small — each page costs credits."),
    maxDepth: z.number().optional().describe("Max link depth from the base URL. 0 = base URL only."),
    includePaths: z.array(z.string()).optional().describe('URL path patterns to include, e.g. ["/blog/*"]'),
    excludePaths: z.array(z.string()).optional().describe('URL path patterns to skip, e.g. ["/tag/*"]'),
    allowSubdomains: z.boolean().optional(),
    crawlEntireDomain: z.boolean().optional(),
    ignoreQueryParams: z.boolean().optional(),
    cookies: z.string().optional(),
    ...proxyParams,
  }),
  execute: async (args, { session, log }) => {
    const client = getClient(session);
    log.info("Submitting crawl", { baseUrl: args.baseUrl, maxPages: args.maxPages });
    return run(async () => {
      const { schema, ...rest } = args;
      const queued = await client.crawl.submit({ ...rest, ...(schema ? { schema } : {}) } as never);
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
Check the status of a crawl job by jobId. While running, returns progress (pagesCrawled/maxPages). When completed, returns the extracted data for every page. ${TERMINAL_NOTE}
`,
  parameters: z.object({ jobId: z.string().describe("The crawl job id returned by spidra_crawl") }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.crawl.get(args.jobId)));
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
Get per-page results for a crawl, including signed download URLs for each page's raw HTML and markdown (links expire after 1 hour). Works on completed crawls and on cancelled crawls (returns the pages processed before cancellation).
`,
  parameters: z.object({ jobId: z.string() }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => asText(await client.crawl.pages(args.jobId)));
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
Run a NEW extraction prompt over an already-completed crawl without re-crawling any pages — much cheaper than crawling again (only AI token credits are charged). Returns a new jobId immediately; poll spidra_check_crawl_status with it. The source crawl must have status "completed".
`,
  parameters: z.object({
    jobId: z.string().describe("The completed source crawl job id"),
    transformInstruction: z.string().max(5000).describe("The new extraction instruction to apply to every crawled page"),
  }),
  execute: async (args, { session }) => {
    const client = getClient(session);
    return run(async () => {
      const queued = await client.crawl.extract(args.jobId, args.transformInstruction);
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
    return run(async () => asText(await client.crawl.cancel(args.jobId)));
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
      if (args.uuid) return asText(await client.logs.get(args.uuid));
      const { logs, total } = await client.logs.list({
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
    return run(async () => asText(await client.usage.get(args.range ?? "30d")));
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
