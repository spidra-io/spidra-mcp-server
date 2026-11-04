import { z } from "zod";
import { cookiesParam, getClient, jsonSchemaParam, proxyParams, reply, run, type Server } from "../shared.js";
import { crawlPagesOutput, crawlReportOutput, queuedOutput, retryCrawlPageOutput } from "../outputs.js";

export function registerCrawlTools(server: Server): void {
  server.addTool({
    name: "spidra_crawl",
    annotations: { title: "Crawl a website", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    output: queuedOutput,
    description: `
Start at one URL and follow links to the kind of pages you describe, optionally extracting data from each. Returns a "jobId" straight away.

**Use it when** you need many pages of one kind and don't know their URLs (every blog post, every product in a category, every page of docs).
**Don't use it** when you know the URLs (spidra_batch_scrape) or only need a site's list of URLs (spidra_map, much cheaper).
**Then:** check it with spidra_get_job (type "crawl", with "waitSeconds" to wait for it) until it's completed, failed or cancelled. Don't start it again while it runs. Stop a mistake with spidra_cancel_job.

- "crawlInstruction" says which pages to return, e.g. "Individual book pages" or "Blog posts, not tag pages".
- "transformInstruction" or "schema" extracts data from each page with AI. Leave both out for each page as Markdown, with no AI cost.
- "maxPages" counts only pages returned (default 5). Pages read just to find them are free. Plan limits per crawl: Free 100, Starter 1,000, Builder 5,000, Pro 10,000.
- The crawl stays under the start URL's path unless "crawlEntireDomain" is true.
- A page you expected is missing? spidra_crawl_report says why each link was skipped.

**Cost:** 1 credit per page returned, plus AI credits with a transformInstruction or schema. A crawl that returns nothing is free.

**Example:** {"baseUrl": "https://books.toscrape.com", "crawlInstruction": "Individual book pages", "transformInstruction": "Title and price", "maxPages": 10}
`,
    parameters: z.object({
      baseUrl: z.string().describe("Where the crawl starts"),
      crawlInstruction: z.string().describe("Which pages to return, in plain words"),
      transformInstruction: z.string().optional().describe("What to extract from each page. Leave out for Markdown (no AI cost)."),
      schema: jsonSchemaParam,
      maxPages: z.number().int().min(1).max(10000).optional().describe("Most pages to return (default 5). Each costs 1 credit."),
      maxDepth: z.number().int().min(0).optional().describe("How many links deep to go from the start URL. 0 is the start URL only."),
      includePaths: z.array(z.string()).optional().describe('Only follow URL paths matching these patterns, e.g. ["/blog/*"]'),
      excludePaths: z.array(z.string()).optional().describe('Never follow these URL paths, e.g. ["/tag/*"]'),
      allowSubdomains: z.boolean().optional().describe("Also follow links to subdomains"),
      crawlEntireDomain: z.boolean().optional().describe("Go beyond the start URL's path to the whole site"),
      ignoreQueryParams: z.boolean().optional().describe("Treat URLs that differ only by query string as one"),
      useSitemap: z.boolean().optional().describe("Use the site's sitemap to find pages (default true)"),
      respectRobots: z.boolean().optional().describe("Follow the site's robots.txt rules (default false)"),
      cookies: cookiesParam,
      ...proxyParams,
    }),
    execute: async (args, { session, log }) => {
      const client = getClient(session);
      log.info("Submitting crawl", { baseUrl: args.baseUrl, maxPages: args.maxPages });
      return run(async () => {
        const queued = await client.startCrawl(args as never);
        return reply({
          jobId: queued.jobId,
          ...((queued as { message?: string }).message ? { message: (queued as { message?: string }).message } : {}),
          next: `Queued. Check it with spidra_get_job {"type": "crawl", "id": "${queued.jobId}", "waitSeconds": 30}.`,
        });
      });
    },
  });

  server.addTool({
    name: "spidra_crawl_pages",
    annotations: { title: "Read a crawl's pages", readOnlyHint: true, openWorldHint: false },
    output: crawlPagesOutput,
    description: `
Read a crawl's pages, in order, with each page's data and links to its Markdown and HTML (the links last 1 hour). Use it for crawls of more than 100 pages, since spidra_get_job returns only the first 100, or after a cancelled crawl to get the pages it finished.

Page through with "offset" and "limit" until "hasMore" is false. Keep "limit" small (20 to 50) to save context. Each page's "id" is what spidra_retry_crawl_page needs.
`,
    parameters: z.object({
      jobId: z.string().describe("The crawl's jobId"),
      offset: z.number().int().min(0).optional().describe("Pages to skip (default 0)"),
      limit: z.number().int().min(1).max(1000).optional().describe("Pages to return (default 50 here)"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => reply(await client.crawlPages(args.jobId, { offset: args.offset ?? 0, limit: args.limit ?? 50 })));
    },
  });

  server.addTool({
    name: "spidra_crawl_report",
    annotations: { title: "Why a crawl skipped pages", readOnlyHint: true, openWorldHint: false },
    output: crawlReportOutput,
    description: `
Explain a finished crawl: how it read the instruction, how many pages it read only to find the wanted ones (free), and every link it didn't follow, counted by reason. Pass "reason" to list the URLs for one reason, each with the page it was found on.

Use it when a page you expected is missing, then adjust crawlInstruction, includePaths or maxPages and crawl again. Reasons: not_relevant, outside_start_path (set crawlEntireDomain to include those), outside_domain, include_pattern, exclude_pattern, file_type, other_version_or_language, duplicate_page, redirected_off_site, robots_txt, action_link. The report is empty while the crawl runs.
`,
    parameters: z.object({
      jobId: z.string().describe("The crawl's jobId"),
      reason: z
        .enum([
          "not_relevant",
          "outside_start_path",
          "outside_domain",
          "include_pattern",
          "exclude_pattern",
          "file_type",
          "other_version_or_language",
          "duplicate_page",
          "redirected_off_site",
          "robots_txt",
          "action_link",
        ])
        .optional()
        .describe("List the skipped URLs for this reason only"),
      limit: z.number().int().min(1).max(2000).optional().describe("Skipped URLs to return (default 200)"),
      offset: z.number().int().min(0).optional().describe("Skipped URLs to skip, for paging"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      const { jobId, ...params } = args;
      return run(async () => reply(await client.crawlReport(jobId, params)));
    },
  });

  server.addTool({
    name: "spidra_crawl_extract",
    annotations: { title: "Re-extract from a crawl", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    output: queuedOutput,
    description: `
Run a new extraction over every page a finished crawl saved, without visiting the site again. Much cheaper than crawling again: only AI credits are charged. Returns a new "jobId"; check it with spidra_get_job (type "crawl"). The original crawl doesn't change.
`,
    parameters: z.object({
      jobId: z.string().describe("The finished crawl's jobId"),
      transformInstruction: z.string().max(5000).describe("What to extract from every page"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        const queued = await client.crawlExtract(args.jobId, args.transformInstruction);
        return reply({
          jobId: queued.jobId,
          next: `Queued. Check it with spidra_get_job {"type": "crawl", "id": "${queued.jobId}"}.`,
        });
      });
    },
  });

  server.addTool({
    name: "spidra_retry_crawl_page",
    annotations: { title: "Redo one crawled page", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    output: retryCrawlPageOutput,
    description: `
Run a crawl's extraction again on one saved page and return the new data. It doesn't visit the site, and the page's stored data is replaced. Use it when one or two pages came back empty or wrong. Get "pageId" from spidra_crawl_pages (each page's "id"). Only crawls with a transformInstruction or schema can be retried. Costs only the AI credits for that page.
`,
    parameters: z.object({
      jobId: z.string().describe("The crawl's jobId"),
      pageId: z.string().describe("The page's id, from spidra_crawl_pages"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => reply(await client.retryCrawlPage(args.jobId, args.pageId)));
    },
  });
}
