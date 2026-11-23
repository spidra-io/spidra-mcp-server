import { z } from "zod";
import { cookiesParam, getClient, MAX_WAIT_MS, reply, run, type Server } from "../shared.js";
import { mapOutput, searchOutput } from "../outputs.js";

// The values the API accepts (spidra-backend services/search/queryOperators.ts and locale.ts).
const SEARCH_FILETYPES = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf", "odt", "ods", "odp", "epub"] as const;
const SEARCH_LANGUAGES = [
  "ar", "bg", "ca", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "he", "hr", "hu", "id", "is", "it", "ja",
  "ko", "lt", "lv", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "th", "tr", "uk", "vi", "zh-CN", "zh-TW",
] as const;

export function registerFindTools(server: Server): void {
  server.addTool({
    name: "spidra_search",
    annotations: { title: "Search the web", readOnlyHint: true, openWorldHint: true },
    output: searchOutput,
    description: `
Search the web and get back ranked results: titles, links and descriptions, as a search engine shows them. Waits and returns the results, usually in a few seconds. One that takes over 45 seconds (with scrapeOptions) returns a jobId for spidra_get_job.

**Use it when** you don't know the URL yet, want news, images or videos, or want research papers (arXiv, PubMed, bioRxiv, medRxiv) or GitHub issues, pull requests, repositories or users.
**Don't use it** for a URL you already have: spidra_scrape reads it directly and can extract fields with a prompt or schema.

- Only "web" results come back unless you set "sources". Each source runs on its own, and an empty one doesn't affect the others. "research" and "developer" ignore includeDomains, excludeDomains and filetype.
- "includeDomains" or "excludeDomains" (never both) keeps results to, or away from, certain sites.
- "language", "startDate"/"endDate", "sort", "safeSearch" and "filetype" each work on some sources only (see each). A requested source that can't apply one runs without it and "warnings" says so; if no requested source can, the call fails and costs nothing.
- More results: send a source's token from "nextPageTokens" back as "pageTokens" (e.g. {"web": "<token>"}) with the same query and options. Ranks continue (11, 12, ...). A source with no token has no more results, so stop.
- "scrapeOptions" also returns each web result's page as Markdown in the same call. It then takes as long as the slowest page and costs a scrape per page. Results from popular sites (Amazon, LinkedIn, YouTube and others) also get "structuredData".
- Don't add the current year to queries unless the user asked for it; it skews results.

**Cost:** 1 credit per 10 results per source, rounded up. A source with no results is free. "creditsUsed" in the result says what the search cost.

**Example:** {"query": "best espresso machine", "sources": ["web", "news"], "limit": 5}
`,
    parameters: z.object({
      query: z.string().describe("What to search for, as you'd type it into a search engine"),
      sources: z
        .array(z.enum(["web", "news", "images", "videos", "research", "developer"]))
        .optional()
        .describe('Result types (default ["web"]). "research" = academic papers, "developer" = GitHub (issues and PRs by default, see developerTypes).'),
      limit: z.number().int().min(1).max(20).optional().describe("The most results per source, 1 to 20 (default 10). A source with fewer matches returns fewer."),
      pageTokens: z
        .record(z.string(), z.string())
        .optional()
        .describe('Tokens from a previous response\'s "nextPageTokens", to get the next page of those sources'),
      timeRange: z
        .enum(["hour", "day", "week", "month", "year"])
        .optional()
        .describe("Favor results from this recent window (web, news, images, videos). Not with startDate/endDate."),
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Only results on or after this date, YYYY-MM-DD (web, news, videos). Not in the future. Not with timeRange.'),
      endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Only results on or before this date, YYYY-MM-DD (web, news, videos). Not with timeRange."),
      sort: z.enum(["relevance", "date"]).optional().describe('"date" returns news newest first. News only. Default "relevance".'),
      language: z
        .enum(SEARCH_LANGUAGES)
        .optional()
        .describe('Prefer pages in this language, e.g. "de" (web, news, videos). Separate from country.'),
      safeSearch: z.enum(["off", "strict"]).optional().describe('"strict" filters adult results (web, news, images, videos). Default "off".'),
      country: z.string().optional().describe('Two-letter country code for local results, or "global", "eu" or "asia"'),
      includeDomains: z.array(z.string()).optional().describe("Only web results from these domains. Not with excludeDomains."),
      excludeDomains: z.array(z.string()).optional().describe("No web results from these domains. Not with includeDomains."),
      filetype: z.enum(SEARCH_FILETYPES).optional().describe("Only web results that are files of this type"),
      developerTypes: z
        .array(z.enum(["issues", "repositories", "users"]))
        .min(1)
        .optional()
        .describe('The "developer" source only: which GitHub results, each up to "limit" (default ["issues"], which includes PRs)'),
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
      // The installed spidra SDK types predate the newer options; the request body goes to the API as is.
      return run(async () => reply(await client.search(args as never, { timeout: MAX_WAIT_MS, signal })));
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
