import { z } from "zod";
import { cookiesParam, getClient, MAX_WAIT_MS, reply, run, type Server } from "../shared.js";
import { mapOutput, searchOutput } from "../outputs.js";

export function registerFindTools(server: Server): void {
  server.addTool({
    name: "spidra_search",
    annotations: { title: "Search the web", readOnlyHint: true, openWorldHint: true },
    output: searchOutput,
    description: `
Search the web and get back ranked results: titles, links and descriptions, as a search engine shows them. Waits and returns the results, usually in a few seconds. One that takes over 45 seconds (with scrapeOptions) returns a jobId for spidra_get_job.

**Use it when** you don't know the URL yet, want news, images or videos, or want research papers (arXiv, PubMed, bioRxiv, medRxiv) or GitHub issues and pull requests.
**Don't use it** for a URL you already have: spidra_scrape reads it directly and can extract fields with a prompt or schema.

- Only "web" results come back unless you set "sources". Each source runs on its own, and an empty one doesn't affect the others. "research" and "developer" ignore includeDomains, excludeDomains and filetype.
- "includeDomains" or "excludeDomains" (never both) keeps results to, or away from, certain sites.
- More results: send a source's token from "nextPageTokens" back as "pageTokens" (e.g. {"web": "<token>"}). Ranks continue (11, 12, ...). A source with no token has no more pages.
- "scrapeOptions" also returns each web result's page as Markdown in the same call. It then takes as long as the slowest page and costs a scrape per page. Results from popular sites (Amazon, LinkedIn, YouTube and others) also get "structuredData".
- Don't add the current year to queries unless the user asked for it; it skews results.

**Cost:** 1 credit per 10 results per source, rounded up. A source with no results is free.

**Example:** {"query": "best espresso machine", "sources": ["web", "news"], "limit": 5}
`,
    parameters: z.object({
      query: z.string().describe("What to search for, as you'd type it into a search engine"),
      sources: z
        .array(z.enum(["web", "news", "images", "videos", "research", "developer"]))
        .optional()
        .describe('Result types (default ["web"]). "research" = academic papers, "developer" = GitHub issues and PRs.'),
      limit: z.number().int().min(1).max(20).optional().describe("Results per source, 1 to 20 (default 10)"),
      pageTokens: z
        .record(z.string(), z.string())
        .optional()
        .describe('Tokens from a previous response\'s "nextPageTokens", to get the next page of those sources'),
      timeRange: z
        .enum(["hour", "day", "week", "month", "year"])
        .optional()
        .describe("Only results from this recent window"),
      country: z.string().optional().describe('Two-letter country code for local results, or "global", "eu" or "asia"'),
      includeDomains: z.array(z.string()).optional().describe("Only web results from these domains. Not with excludeDomains."),
      excludeDomains: z.array(z.string()).optional().describe("No web results from these domains. Not with includeDomains."),
      filetype: z.enum(["pdf"]).optional().describe("Only PDF files"),
      scrapeOptions: z
        .object({
          formats: z.array(z.enum(["markdown"])).min(1).describe('Always ["markdown"]'),
          maxResults: z.number().int().min(1).max(20).optional().describe("Read only the top N web results (default all, up to 10)"),
        })
        .optional()
        .describe("Also return each web result's page as Markdown, in this same call"),
    }),
    execute: async (args, { session, log, signal }) => {
      const client = getClient(session);
      log.info("Searching", { query: args.query, sources: args.sources });
      return run(async () => reply(await client.search(args, { timeout: MAX_WAIT_MS, signal })));
    },
  });

  server.addTool({
    name: "spidra_map",
    annotations: { title: "List a site's URLs", readOnlyHint: true, openWorldHint: true },
    output: mapOutput,
    description: `
List a website's page URLs without scraping them, from its sitemaps and the links on its pages. Waits and returns the URLs, usually in a few seconds.

**Use it when** you need the right pages on a site before reading them ("which page on stripe.com covers refunds?"), a full list of a site's URLs, or the URLs of one kind of page (every category, product or blog post): put a word from those URLs in "search". That's 1 credit, much cheaper than scraping a page and extracting its links with AI.
**Then:** pick the URLs you need and read exactly those with spidra_scrape or spidra_batch_scrape. That's usually cheaper than spidra_crawl when you only need a few pages.

- "search" keeps only matching URLs, best matches first. Keep "limit" small when you only need a few.
- "total" is how many URLs matched; "scanned" is how many were found in all.

**Cost:** 1 credit per call. Free when no URLs are found.

**Example:** {"url": "https://docs.python.org/3/", "search": "asyncio", "limit": 20}
`,
    parameters: z.object({
      url: z.string().describe("The website to map"),
      search: z.string().optional().describe("Only URLs related to these words, best matches first"),
      limit: z.number().int().min(1).max(5000).optional().describe("Most URLs returned (default 500)"),
      sitemap: z
        .enum(["include", "only", "skip"])
        .optional()
        .describe('"include" (default) uses the sitemap and page links, "only" the sitemap (fastest), "skip" only the links'),
      includeSubdomains: z.boolean().optional().describe("Also list URLs on subdomains"),
      ignoreQueryParams: z.boolean().optional().describe("Treat URLs that differ only by query string as one (default true)"),
      respectRobots: z.boolean().optional().describe("Leave out URLs the site's robots.txt disallows"),
      cookies: cookiesParam,
    }),
    execute: async (args, { session, log }) => {
      const client = getClient(session);
      log.info("Mapping site", { url: args.url });
      return run(async () => reply(await client.map(args)));
    },
  });
}
