import { UserError } from "fastmcp";
import { z } from "zod";
import { getClient, reply, run, type Server } from "../shared.js";

export function registerPresetTools(server: Server): void {
  server.addTool({
    name: "spidra_list_presets",
    annotations: { title: "List saved presets", readOnlyHint: true, openWorldHint: false },
    description: `
List the user's saved presets, newest first: saved template runs (a template and its inputs) and saved tool requests. Pass "presetId" to get one in full. Run one with spidra_run_preset.
`,
    parameters: z.object({
      presetId: z.string().optional().describe("Get this one preset in full instead of listing"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      limit: z.number().int().min(1).max(50).optional().describe("Presets per page (default 10)"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        const keep = (p: Record<string, unknown>) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          kind: p.kind,
          tool: p.tool,
          template: p.template,
          inputs: p.inputs,
          config: p.config,
          inputsSummary: p.inputsSummary,
          updatedAt: p.updatedAt,
        });
        if (args.presetId) return reply(keep(await client.getPreset(args.presetId)));
        const { presets, total } = await client.listPresets({ page: args.page, limit: args.limit });
        return reply({ total, presets: presets.map(keep) });
      });
    },
  });

  server.addTool({
    name: "spidra_save_preset",
    annotations: { title: "Save a preset", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: `
Save a job so it can run again with one call, or change a saved one.

- A template preset: "kind": "template", the template's "template" slug and its "inputs".
- A tool preset: "kind": "tool", the "tool" (scrape, batch, crawl, map, search or parse) and "config", the request body exactly as that tool takes it. Cookies are never stored.
- To change one, pass its "presetId" and only the fields that change ("name", "description", "inputs" or "config").

Presets can also be watched for changes with spidra_create_monitor.
`,
    parameters: z.object({
      presetId: z.string().optional().describe("Change this preset instead of creating one"),
      name: z.string().optional().describe("The preset's name (required when creating)"),
      description: z.string().optional(),
      kind: z.enum(["template", "tool"]).optional().describe("Required when creating"),
      template: z.string().optional().describe('Template presets: the template\'s slug, e.g. "google-maps-leads"'),
      inputs: z.record(z.string(), z.unknown()).optional().describe("Template presets: the inputs by key"),
      tool: z.enum(["scrape", "batch", "crawl", "map", "search", "parse"]).optional().describe("Tool presets: which tool"),
      config: z.record(z.string(), z.unknown()).optional().describe("Tool presets: the request body for that tool"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        if (args.presetId) {
          const { presetId, kind: _kind, template: _template, tool: _tool, ...changes } = args;
          await client.updatePreset(presetId, changes);
          return reply({ id: presetId, updated: Object.keys(changes) });
        }
        if (!args.name || !args.kind) throw new UserError('Creating a preset needs "name" and "kind".');
        if (args.kind === "template") {
          if (!args.template || !args.inputs) throw new UserError('A template preset needs "template" and "inputs".');
          const { id } = await client.createPreset({ kind: "template", name: args.name, description: args.description, template: args.template, inputs: args.inputs });
          return reply({ id, next: `Run it with spidra_run_preset {"presetId": "${id}"}.` });
        }
        if (!args.tool || !args.config) throw new UserError('A tool preset needs "tool" and "config".');
        const { id } = await client.createPreset({ kind: "tool", name: args.name, description: args.description, tool: args.tool, config: args.config });
        return reply({ id, next: `Run it with spidra_run_preset {"presetId": "${id}"}.` });
      });
    },
  });

  server.addTool({
    name: "spidra_run_preset",
    annotations: { title: "Run a preset", readOnlyHint: true, openWorldHint: true },
    description: `
Run a saved preset. "overrides" changes template inputs, or request fields of a tool preset, for this run only.

A template preset returns its template run (check a running one with spidra_get_job, type "template_run"). A tool preset returns that tool's own answer: map links straight away, or a scrape, batch, crawl or search job id to check with spidra_get_job. Costs what the same job costs when run directly.
`,
    parameters: z.object({
      presetId: z.string().describe("The preset's id, from spidra_list_presets"),
      overrides: z.record(z.string(), z.unknown()).optional().describe("Inputs or request fields to change for this run only"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => reply(await client.runPreset(args.presetId, { overrides: args.overrides, wait: true })));
    },
  });

  server.addTool({
    name: "spidra_delete_preset",
    annotations: { title: "Delete a preset", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: `
Delete a saved preset. Runs already made from it stay in the history. A monitor that watches it starts failing until its sources are changed. Confirm with the user before deleting.
`,
    parameters: z.object({ presetId: z.string().describe("The preset's id") }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        await client.deletePreset(args.presetId);
        return reply({ deleted: args.presetId });
      });
    },
  });
}
