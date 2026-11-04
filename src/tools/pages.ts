import { z } from "zod";
import { browserActionSchema, cookiesParam, getClient, jsonSchemaParam, MAX_WAIT_MS, proxyParams, reply, run, type Server } from "../shared.js";
import { batchScrapeOutput, scrapeOutput } from "../outputs.js";

export function registerPageTools(server: Server): void {
  server.addTool({
    name: "spidra_scrape",
    annotations: { title: "Scrape a web page", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    output: scrapeOutput,
    description: `
Read one known URL and get its content as Markdown, or the data you describe as JSON. Waits and returns the result, usually in a few seconds. A page that takes over 45 seconds returns its jobId instead: check it with spidra_get_job (type "scrape") rather than scraping again.

**Use it for** one URL. Links to PDF, Word, Excel and PowerPoint files work too.
**Don't use it for** more than one URL, even to compare two: spidra_batch_scrape gives each URL its own result. To find pages on a site, use spidra_map or spidra_crawl.

- No "prompt" or "schema": the page as Markdown.
- "prompt": what you want, in plain words; the AI picks the shape. Add "schema" for exact fields and types (null where the page has nothing).
- Popular sites (Amazon, Google Maps, LinkedIn, YouTube, Zillow, Indeed and others): with "output": "json" and no prompt, "content" is the page's data in named fields, no AI needed. Otherwise that data is in "structuredData". The same goes for Polymarket, Kalshi, CoinMarketCap, Crunchbase News, Google Business profiles and Google Search result pages.
- "actions" runs browser steps first (click, type, scroll, forEach to go through a list); "instruction" does one task described in plain words instead. Never both. Steps run once and are never retried automatically, since a step like a form submission has effects.
- If the result has "lowContent": true, the page came back nearly empty, usually because the site blocks automated visits. Call again with "useProxy": true.

**Cost:** 1 credit, plus AI credits for the tokens used with a prompt or schema (often 1 or 2), plus 5 per CAPTCHA solved. A page that can't be read costs nothing.

**Browser actions:** up to 50 steps (click, type, check, uncheck, hover, select, press, wait, waitFor, scroll, scrollUntilEnd, evaluate, screenshot, forEach), with waits adding up to 60 seconds at most. "selector" is CSS, XPath, or plain words ("the Sign in button"); prefer CSS when you know it. A failed step fails the job (free) with "Action N (...) failed: <reason>"; mark steps that may not be there, like cookie banners, "optional": true. forEach goes through a list of items and must be the single, last action. "actionResults" reports each step as ok, skipped or failed.

**Example:** {"url": "https://books.toscrape.com", "prompt": "Return the title and price of every book", "output": "json"}
**Example with actions:** {"url": "https://quotes.toscrape.com/login", "actions": [{"type": "type", "selector": "#username", "value": "demo"}, {"type": "type", "selector": "#password", "value": "demo"}, {"type": "click", "selector": "input[type='submit']"}, {"type": "waitFor", "selector": "a[href='/logout']"}], "prompt": "List the first 3 quotes with their authors", "output": "json"}
`,
    parameters: z.object({
      url: z.string().describe("The page to read"),
      prompt: z.string().optional().describe("What to extract, in plain words. Leave out for the page as Markdown."),
      output: z.enum(["markdown", "json"]).optional().describe('"markdown" (default) or "json"'),
      schema: jsonSchemaParam,
      actions: z
        .array(browserActionSchema)
        .max(50)
        .optional()
        .describe("Browser steps to run in order before the page is read. A forEach must be the single, last one. Not with instruction."),
      instruction: z
        .string()
        .max(2000)
        .optional()
        .describe('One task in plain words to do before the page is read, e.g. "search for wireless headphones and open the first result". Not with actions.'),
      cookies: cookiesParam,
      screenshot: z.boolean().optional().describe("Take a screenshot of the visible page (a link comes back)"),
      fullPageScreenshot: z.boolean().optional().describe("Take a screenshot of the whole page"),
      extractContentOnly: z.boolean().optional().describe("Leave out menus, headers, footers and ads"),
      scrapeMode: z
        .enum(["default", "fast"])
        .optional()
        .describe('"fast" fetches the page and opens a browser only if the page needs one; "default" always uses a browser. Unset: "fast", or a browser when there are actions or an instruction.'),
      deliveryZip: z.string().optional().describe('Amazon and Walmart product pages: the delivery postcode to check price and stock for, e.g. "90210"'),
      ...proxyParams,
    }),
    execute: async (args, { session, log, signal }) => {
      const client = getClient(session);
      log.info("Scraping", { url: args.url });
      const hasSteps = Boolean(args.actions?.length || args.instruction);
      return run(async () => {
        const result = await client.scrape(
          {
            urls: [
              {
                url: args.url,
                ...(args.actions ? { actions: args.actions as never } : {}),
                ...(args.instruction ? { instruction: args.instruction } : {}),
                ...(args.deliveryZip ? { deliveryZip: args.deliveryZip } : {}),
              },
            ],
            prompt: args.prompt ?? "",
            ...(args.output ? { output: args.output } : {}),
            ...(args.schema ? { schema: args.schema } : {}),
            ...(args.cookies ? { cookies: args.cookies } : {}),
            ...(args.screenshot != null ? { screenshot: args.screenshot } : {}),
            ...(args.fullPageScreenshot != null ? { fullPageScreenshot: args.fullPageScreenshot } : {}),
            ...(args.extractContentOnly != null ? { extractContentOnly: args.extractContentOnly } : {}),
            useProxy: args.useProxy ?? false,
            ...(args.proxyCountry ? { proxyCountry: args.proxyCountry } : {}),
            scrapeMode: args.scrapeMode ?? (hasSteps ? "default" : "fast"),
          } as never,
          { timeout: MAX_WAIT_MS, signal }
        );

        const first = result.data?.[0] as
          | {
              structuredData?: unknown;
              canonicalUrl?: string;
              warnings?: string[];
              actionResults?: unknown[];
              forEachItems?: number;
              lowContent?: boolean;
              screenshotUrl?: string;
            }
          | undefined;
        // The job's warnings include this URL's own plus any about credits running short.
        const warnings = (result as { warnings?: string[] }).warnings ?? first?.warnings;
        // With output "json" and no prompt on a popular site, content already is the structured data.
        const includeStructured = args.output !== "json" && first?.structuredData !== undefined;

        return reply({
          content: result.content,
          ...(includeStructured ? { structuredData: first?.structuredData } : {}),
          ...(first?.canonicalUrl ? { canonicalUrl: first.canonicalUrl } : {}),
          ...(first?.actionResults?.length ? { actionResults: first.actionResults } : {}),
          ...(first?.forEachItems !== undefined ? { forEachItems: first.forEachItems } : {}),
          ...(warnings?.length ? { warnings } : {}),
          ...(result.screenshots?.length ? { screenshots: result.screenshots } : {}),
          ...(result.ai_extraction_failed ? { aiExtractionFailed: true } : {}),
          ...(first?.lowContent
            ? {
                lowContent: true,
                note: args.useProxy
                  ? "The page came back nearly empty even with Stealth Mode. It may need a login (cookies), browser actions, or it may not be readable."
                  : 'The page came back nearly empty, usually because the site blocks automated visits. Call again with "useProxy": true.',
              }
            : {}),
          stats: result.stats,
        });
      });
    },
  });

  server.addTool({
    name: "spidra_batch_scrape",
    annotations: { title: "Scrape many URLs", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    output: batchScrapeOutput,
    description: `
Read 2 to 50 known URLs, each on its own with its own result, using the same prompt or schema for all.

**Use it for** anything with more than one URL: product pages, listings, articles, or just two pages to compare.
**Waiting:** with "wait": true and 10 URLs or fewer, it waits (up to 45 seconds) and returns the finished batch, or the batchId if it isn't done by then. Otherwise it returns a "batchId" straight away; check it with spidra_get_job (type "batch", with "waitSeconds" to wait for it) until "status" is completed or cancelled. Don't start the batch again while it runs.

- "output" is "markdown" (default) or "json"; a schema sets "json". Popular-site pages also get "structuredData".
- A completed batch can still have failed items: check "failedCount" and each item's "error". spidra_retry_batch re-runs only the failed ones.
- Browser actions aren't supported in a batch; use spidra_scrape for pages that need them.

**Cost:** per URL, the same as spidra_scrape. Failed URLs cost nothing.

**Example:** {"urls": ["https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", "https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html"], "prompt": "Title and price", "output": "json", "wait": true}
`,
    parameters: z.object({
      urls: z.array(z.string()).min(2).max(50).describe("2 to 50 URLs"),
      prompt: z.string().optional().describe("What to extract from each page. Leave out for Markdown."),
      output: z.enum(["markdown", "json"]).optional().describe('"markdown" (default) or "json"'),
      schema: jsonSchemaParam,
      cookies: cookiesParam,
      extractContentOnly: z.boolean().optional().describe("Leave out menus, headers, footers and ads"),
      scrapeMode: z.enum(["default", "fast"]).optional().describe('"default" always uses a browser; "fast" fetches pages and opens a browser only when needed'),
      wait: z.boolean().optional().describe("With 10 URLs or fewer, wait and return the finished batch instead of a batchId"),
      ...proxyParams,
    }),
    execute: async (args, { session, log, signal }) => {
      const client = getClient(session);
      log.info("Submitting batch", { count: args.urls.length });
      return run(async () => {
        const { wait, ...rest } = args;
        const params = { ...rest, prompt: args.prompt ?? "" } as never;
        if (wait && args.urls.length <= 10) {
          // A slow batch surfaces as a timeout, which run() turns into "still running, check it with spidra_get_job".
          return reply(await client.batchScrape(params, { timeout: MAX_WAIT_MS, signal }));
        }
        const queued = await client.startBatchScrape(params);
        return reply({
          batchId: queued.batchId,
          total: queued.total,
          next: `Queued. Check it with spidra_get_job {"type": "batch", "id": "${queued.batchId}", "waitSeconds": 30} until status is completed.`,
        });
      });
    },
  });
}
