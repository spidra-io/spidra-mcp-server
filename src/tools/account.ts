import { z } from "zod";
import { getClient, reply, run, type Server, UserError } from "../shared.js";
import { accountOutput } from "../outputs.js";

export function registerAccountTools(server: Server): void {
  server.addTool({
    name: "spidra_account",
    annotations: { title: "Credits, plan and usage", readOnlyHint: true, openWorldHint: false },
    output: accountOutput,
    description: `
The user's plan, credits left this billing period, Stealth Mode bandwidth, and how many monitors the plan allows. Use it before a large batch, crawl or template run to check there's enough, or to answer "how many credits do I have".

- "usage" adds credits, requests and tokens per day ("7d", "30d") or per week ("weekly").
- "byTool": true adds credits per day split by tool (scrape, crawl, search, parse, map) for the last 7 days, or the "usage" range.

"credits.used" includes credits held by jobs still running; unused held credits come back when they finish.
`,
    parameters: z.object({
      usage: z.enum(["7d", "30d", "weekly"]).optional().describe("Also return usage history for this range"),
      byTool: z.boolean().optional().describe("Also return credits per day split by tool"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        const [account, limits] = await Promise.all([client.account(), client.monitorLimits()]);
        const range = args.usage === "30d" ? "30d" : "7d";
        const [usage, byTool] = await Promise.all([
          args.usage ? client.usage(args.usage) : Promise.resolve(undefined),
          args.byTool ? client.usageBreakdown({ range }) : Promise.resolve(undefined),
        ]);
        return reply({
          ...account,
          monitors: { allowed: limits.maxMonitors, used: limits.used, shortestScheduleMinutes: limits.minIntervalMinutes },
          ...(usage ? { usage } : {}),
          ...(byTool ? { creditsByTool: byTool } : {}),
        });
      });
    },
  });

  server.addTool({
    name: "spidra_logs",
    annotations: { title: "Past runs", readOnlyHint: true, openWorldHint: false },
    description: `
Find past runs, newest first, or open one by its id. Every run is logged, including ones made in the dashboard, and logs last after the job itself can no longer be read with spidra_get_job.

- "tool": scrape, search, map, parse, crawl, batch or template.
- "id": open one log in full, with its result. For scrape, search and map this is the log's "uuid" (not the job's id); for crawl and template it's the job's id. A parse log's "jobId" opens with spidra_get_job (type "parse"), and a batch with spidra_get_job (type "batch").
- "status" and "searchTerm" filter scrape, search, map and parse logs. Scrape: success, error, in_progress. Search: also cancelled. Map: success, empty, error. Parse: queued, running, completed, failed.
`,
    parameters: z.object({
      tool: z.enum(["scrape", "search", "map", "parse", "crawl", "batch", "template"]).describe("Which tool's runs"),
      id: z.string().optional().describe("Open this one log instead of listing"),
      status: z
        .enum(["success", "error", "in_progress", "cancelled", "empty", "queued", "running", "completed", "failed"])
        .optional()
        .describe("Only runs with this status. Each tool has its own values; see the description."),
      searchTerm: z.string().optional().describe("Matches the URL, query, prompt or file name"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      limit: z.number().int().min(1).max(50).optional().describe("Runs per page (default 10)"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      const page = args.page;
      const limit = args.limit ?? 10;
      const filters = { status: args.status as never, searchTerm: args.searchTerm, page, limit };
      return run(async () => {
        switch (args.tool) {
          case "scrape":
            return reply(args.id ? await client.getScrapeLog(args.id) : await client.scrapeLogs(filters));
          case "search":
            return reply(args.id ? await client.getSearchLog(args.id) : await client.searchLogs(filters));
          case "map":
            return reply(args.id ? await client.getMapLog(args.id) : await client.mapLogs(filters));
          case "parse":
            if (args.id) throw new UserError('Open a parse log with spidra_get_job {"type": "parse", "id": "<jobId>"}.');
            return reply(await client.parseLogs(filters));
          case "crawl":
            return reply(args.id ? await client.crawlJobDetails(args.id) : await client.crawlHistory({ page, limit }));
          case "batch":
            if (args.id) return reply(await client.getBatchScrape(args.id));
            return reply(await client.listBatchScrapes({ page, limit }));
          case "template":
            if (args.id) return reply(await client.getTemplateRun(args.id, { rows: false }));
            return reply(await client.listTemplateRuns({ page, limit }));
        }
      });
    },
  });
}
