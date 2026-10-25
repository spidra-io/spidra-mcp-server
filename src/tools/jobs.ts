import { z } from "zod";
import { getClient, reply, run, TERMINAL_NOTE, type Server } from "../shared.js";
import { rowParams, shapeRun } from "./templates.js";

export function registerJobTools(server: Server): void {
  server.addTool({
    name: "spidra_get_job",
    annotations: { title: "Check a job", readOnlyHint: true, openWorldHint: false },
    description: `
Get any job's status, and its result once finished. Use it for the ids other tools return when they don't wait to the end.

- "scrape", "search": a jobId. Readable for about an hour after it finishes (failed ones 24 hours); after that, use spidra_logs.
- "batch": a batchId. A completed batch can still have failed items; check "failedCount".
- "crawl": a jobId. Returns the first 100 pages; spidra_crawl_pages reads the rest.
- "parse": a jobId. "includePages" adds each page's Markdown.
- "parse_batch": a batchId.
- "template_run": a runId. Rows come back with the template's columns ("detail": "full" for every field) and page with "offset" and "limit".

Check every 10 to 15 seconds while it runs. ${TERMINAL_NOTE}
`,
    parameters: z.object({
      type: z.enum(["scrape", "search", "batch", "crawl", "parse", "parse_batch", "template_run"]).describe("What kind of job"),
      id: z.string().describe("The job's id (jobId, batchId or runId)"),
      includePages: z.boolean().optional().describe("parse: also return each page's Markdown"),
      ...rowParams,
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        switch (args.type) {
          case "scrape":
            return reply(await client.getScrape(args.id));
          case "search":
            return reply(await client.getSearch(args.id));
          case "batch":
            return reply(await client.getBatchScrape(args.id));
          case "crawl": {
            // Each page carries two signed file links (~400 chars each); across 100 pages they'd crowd out the data.
            // They stay available from spidra_crawl_pages.
            const crawl = (await client.getCrawl(args.id)) as unknown as { result?: unknown };
            if (!Array.isArray(crawl.result)) return reply(crawl);
            return reply({
              ...crawl,
              result: crawl.result.map(page => {
                const { html: _html, markdown: _markdown, ...rest } = page as Record<string, unknown>;
                return rest;
              }),
              note: "Links to each page's HTML and Markdown files are left out here; spidra_crawl_pages returns them.",
            });
          }
          case "parse":
            return reply(await client.getParse(args.id, { includePages: args.includePages }));
          case "parse_batch": {
            const batch = await client.getParseBatch(args.id);
            return reply(batch.status === "completed" ? await client.getParseBatch(args.id, { includeResults: true }) : batch);
          }
          case "template_run": {
            const runResult = await client.getTemplateRun(args.id);
            return reply(runResult.status === "running" ? runResult : await shapeRun(client, runResult, args));
          }
        }
      });
    },
  });

  server.addTool({
    name: "spidra_cancel_job",
    annotations: { title: "Cancel a job", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: `
Cancel a running batch, crawl or search.

- "batch": URLs not yet started are stopped and their held credits returned; finished ones keep their results. A cancelled batch can't be retried.
- "crawl": stops at its next check. If it had returned pages, it ends completed with those (charged as usual); if not, cancelled and free. spidra_crawl_pages still reads its pages.
- "search": one not yet started is removed; a running one stops at its next checkpoint and then reports failed with "Search cancelled".
`,
    parameters: z.object({
      type: z.enum(["batch", "crawl", "search"]).describe("What kind of job"),
      id: z.string().describe("The job's id (batchId or jobId)"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        if (args.type === "batch") return reply(await client.cancelBatchScrape(args.id));
        if (args.type === "crawl") return reply(await client.cancelCrawl(args.id));
        return reply(await client.cancelSearch(args.id));
      });
    },
  });

  server.addTool({
    name: "spidra_retry_batch",
    annotations: { title: "Retry a batch's failed URLs", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: `
Run a batch's failed URLs again with the batch's original options; the rest are left alone. Use it after spidra_get_job shows "failedCount" above 0. Cookies are never stored, so pass "cookies" again if the batch used them. Then check the batch with spidra_get_job as before. A URL that fails again costs nothing.
`,
    parameters: z.object({
      batchId: z.string().describe("The batch's id"),
      cookies: z.string().optional().describe("The batch's cookies again, if it used them"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => reply(await client.retryBatchScrape(args.batchId, args.cookies ? { cookies: args.cookies } : undefined)));
    },
  });
}
