import { z } from "zod";
import { getClient, reply, run, type Server, UserError } from "../shared.js";
import { createMonitorOutput, deletedOutput, listMonitorsOutput, messageOutput, monitorChangesOutput, updateMonitorOutput } from "../outputs.js";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("template"),
    template: z.string().describe('The template\'s slug, e.g. "google-maps-leads"'),
    inputs: z.record(z.string(), z.unknown()).describe("The template's inputs by key"),
    label: z.string().optional(),
  }),
  z.object({ kind: z.literal("preset"), presetId: z.string().describe("A saved preset's id"), label: z.string().optional() }),
  z.object({ kind: z.literal("urls"), urls: z.array(z.string()).min(1).max(50).describe("Pages to watch (up to 50)"), label: z.string().optional() }),
]);

const monitorFields = {
  name: z.string().optional().describe("A name for the monitor"),
  sources: z.array(sourceSchema).min(1).max(10).optional().describe("What to watch: templates, presets or lists of pages"),
  schedule: z
    .object({
      every: z.enum(["5m", "15m", "30m", "1h", "6h", "12h", "1d", "1w"]).optional().describe("How often to check"),
      at: z.string().optional().describe('For 1d and 1w: the time, "HH:MM" in the timezone'),
      day: z.number().int().min(0).max(6).optional().describe("For 1w: the weekday, 0 is Sunday"),
      cron: z.string().optional().describe("A cron expression instead of every"),
      timezone: z.string().optional().describe('An IANA time zone, e.g. "Africa/Lagos" (default UTC)'),
    })
    .optional()
    .describe("When to check (default once a day). The plan sets the shortest allowed: Free daily, Starter hourly, Builder 15 minutes, Pro 5 minutes."),
  alertOn: z
    .enum(["new", "changed", "removed", "page", "every"])
    .optional()
    .describe('What counts as a change: "new" items (default), "changed" items, "removed" items, "page" text changes (for page lists), or "every" check'),
  watchFields: z.array(z.string()).optional().describe('For "changed": only these fields count, e.g. ["price"]'),
  rule: z
    .object({
      field: z.string(),
      op: z.enum(["lt", "lte", "gt", "gte", "eq", "neq", "contains", "drops_by_pct", "rises_by_pct"]),
      value: z.union([z.number(), z.string()]),
    })
    .nullable()
    .optional()
    .describe('Alert only when a field passes a threshold, e.g. {"field": "price", "op": "lt", "value": 25}. null removes it.'),
  goal: z
    .string()
    .nullable()
    .optional()
    .describe('What matters, in plain words, e.g. "only tell me if the price drops". AI reads each change against it and only meaningful ones alert. null removes it.'),
  notify: z
    .object({
      email: z
        .object({ enabled: z.boolean().optional(), recipients: z.array(z.string()).max(10).optional() })
        .optional()
        .describe("The account's email (default on). Extra recipients get alerts after confirming by email."),
      webhook: z.object({ url: z.string(), secret: z.string().optional() }).optional().describe("A signed POST to this URL"),
      slack: z.object({ webhookUrl: z.string() }).optional(),
      discord: z.object({ webhookUrl: z.string() }).optional(),
    })
    .optional()
    .describe("Where alerts go. On update, it replaces all channels."),
};

// The same fields for updates, without repeating every description (they're on spidra_create_monitor), which keeps
// the tool list smaller for the model.
const leanSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), template: z.string(), inputs: z.record(z.string(), z.unknown()), label: z.string().optional() }),
  z.object({ kind: z.literal("preset"), presetId: z.string(), label: z.string().optional() }),
  z.object({ kind: z.literal("urls"), urls: z.array(z.string()).min(1).max(50), label: z.string().optional() }),
]);

const updateFields = {
  name: z.string().optional(),
  sources: z.array(leanSource).min(1).max(10).optional().describe("Replaces the sources. New sources start a new comparison."),
  schedule: z
    .object({
      every: z.enum(["5m", "15m", "30m", "1h", "6h", "12h", "1d", "1w"]).optional(),
      at: z.string().optional(),
      day: z.number().int().min(0).max(6).optional(),
      cron: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  alertOn: z.enum(["new", "changed", "removed", "page", "every"]).optional(),
  watchFields: z.array(z.string()).optional(),
  rule: z
    .object({
      field: z.string(),
      op: z.enum(["lt", "lte", "gt", "gte", "eq", "neq", "contains", "drops_by_pct", "rises_by_pct"]),
      value: z.union([z.number(), z.string()]),
    })
    .nullable()
    .optional()
    .describe("null removes it"),
  goal: z.string().nullable().optional().describe("null removes it"),
  notify: z
    .object({
      email: z.object({ enabled: z.boolean().optional(), recipients: z.array(z.string()).max(10).optional() }).optional(),
      webhook: z.object({ url: z.string(), secret: z.string().optional() }).optional(),
      slack: z.object({ webhookUrl: z.string() }).optional(),
      discord: z.object({ webhookUrl: z.string() }).optional(),
    })
    .optional()
    .describe("Replaces all channels"),
};

export function registerMonitorTools(server: Server): void {
  server.addTool({
    name: "spidra_create_monitor",
    annotations: { title: "Create a monitor", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    output: createMonitorOutput,
    description: `
Watch a template, a preset or a list of pages on a schedule and get an alert when something changes: new or removed items, changed fields (like a price), or page text changes.

- The first check runs straight away and records the starting point without alerting.
- "estimate": true returns the credits per check and per month, for free, without creating it.
- "testNotification": true sends a sample alert to the "notify" channels, without creating anything, to check a webhook, Slack or Discord URL.
- The plan limits how many monitors the user can have and how often they check (spidra_account shows it).
- Confirm the schedule and channels with the user before creating, since each check costs credits.

**Cost:** each check costs what running its sources costs. A "goal" adds a little AI on checks where something changed.

**Example:** {"name": "Cable price", "sources": [{"kind": "urls", "urls": ["https://www.amazon.com/dp/B0CG1LGWR6"]}], "schedule": {"every": "1d", "at": "09:00", "timezone": "Africa/Lagos"}, "alertOn": "changed", "watchFields": ["price"], "goal": "Only tell me if the price drops"}
`,
    parameters: z.object({
      ...monitorFields,
      estimate: z.boolean().optional().describe("Return the cost without creating it"),
      testNotification: z.boolean().optional().describe("Send a sample alert to notify, without creating anything"),
      checkNow: z.boolean().optional().describe("Run the first check now (default true)"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      const { estimate, testNotification, checkNow, ...monitor } = args;
      return run(async () => {
        if (testNotification) {
          if (!monitor.notify) throw new UserError('Send "notify" with the channels to test.');
          return reply(await client.testMonitorNotification({ notify: monitor.notify, name: monitor.name }));
        }
        if (!monitor.sources?.length) throw new UserError('Send "sources": what to watch.');
        const params = { ...monitor, sources: monitor.sources };
        if (estimate) return reply(await client.estimateMonitor(params as never));
        return reply(await client.createMonitor({ ...params, ...(checkNow === false ? { checkNow: false } : {}) } as never));
      });
    },
  });

  server.addTool({
    name: "spidra_list_monitors",
    annotations: { title: "List monitors", readOnlyHint: true, openWorldHint: false },
    output: listMonitorsOutput,
    description: `
List the user's monitors with their schedule, last check and next check. Pass "monitorId" to get one in full. What changed is in spidra_monitor_changes.
`,
    parameters: z.object({ monitorId: z.string().optional().describe("Get this one monitor instead of listing") }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        if (args.monitorId) return reply(await client.getMonitor(args.monitorId));
        const monitors = await client.listMonitors();
        return reply({
          monitors: monitors.map(m => ({
            id: m.id,
            name: m.name,
            status: m.status,
            sources: m.sources.map(s => s.label),
            schedule: m.schedule,
            alertOn: m.alertOn,
            lastCheckAt: m.lastCheckAt,
            lastSummary: m.lastSummary,
            nextRunAt: m.nextRunAt,
          })),
        });
      });
    },
  });

  server.addTool({
    name: "spidra_update_monitor",
    annotations: { title: "Change a monitor", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    output: updateMonitorOutput,
    description: `
Change a monitor, or pause and resume it. Send only what changes; the fields are the same as spidra_create_monitor. "status": "paused" stops checks and keeps the history; "active" starts them again. Changing "sources" restarts the comparison for new sources, and "notify" replaces all channels.
`,
    parameters: z.object({
      monitorId: z.string().describe("The monitor's id"),
      status: z.enum(["active", "paused"]).optional().describe("Pause or resume checks"),
      ...updateFields,
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      const { monitorId, status, ...changes } = args;
      return run(async () => {
        const hasChanges = Object.values(changes).some(v => v !== undefined);
        let result: unknown = undefined;
        if (hasChanges) result = await client.updateMonitor(monitorId, changes as never);
        if (status === "paused") result = { monitor: await client.pauseMonitor(monitorId) };
        if (status === "active") result = { monitor: await client.resumeMonitor(monitorId) };
        if (result === undefined) throw new UserError('Send "status" or a field to change.');
        return reply(result);
      });
    },
  });

  server.addTool({
    name: "spidra_delete_monitor",
    annotations: { title: "Delete a monitor", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    output: deletedOutput,
    description: `
Delete a monitor and its check history. To stop checks but keep the history, pause it with spidra_update_monitor instead. Confirm with the user before deleting.
`,
    parameters: z.object({ monitorId: z.string().describe("The monitor's id") }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        await client.deleteMonitor(args.monitorId);
        return reply({ deleted: args.monitorId });
      });
    },
  });

  server.addTool({
    name: "spidra_check_monitor",
    annotations: { title: "Check a monitor now", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    output: messageOutput,
    description: `
Run a monitor's check now, outside its schedule. It runs in the background, costs what a scheduled check costs, and alerts like one. Once a minute at most per monitor. Read the result with spidra_monitor_changes after a little while.
`,
    parameters: z.object({ monitorId: z.string().describe("The monitor's id") }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        const { message } = await client.checkMonitorNow(args.monitorId);
        return reply({ message, next: `Read it with spidra_monitor_changes {"monitorId": "${args.monitorId}"} in about a minute.` });
      });
    },
  });

  server.addTool({
    name: "spidra_monitor_changes",
    annotations: { title: "What a monitor found", readOnlyHint: true, openWorldHint: false },
    output: monitorChangesOutput,
    description: `
A monitor's checks, newest first, with a one-line summary of each. Pass "checkId" for everything one check found, per source: new, changed and removed items (with old and new values), and page text changes. A source's first check has "baseline": true and only records the starting point. Checks are kept for 30 days.
`,
    parameters: z.object({
      monitorId: z.string().describe("The monitor's id"),
      checkId: z.string().optional().describe("One check in full instead of the list"),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Checks per page (default 10)"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        if (args.checkId) return reply(await client.getMonitorCheck(args.monitorId, args.checkId));
        return reply(await client.listMonitorChecks(args.monitorId, { page: args.page, limit: args.limit ?? 10 }));
      });
    },
  });
}
