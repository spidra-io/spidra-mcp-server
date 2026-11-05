import { z } from "zod";
import type { SpidraClient, TemplateDetail, TemplateRun } from "spidra";
import { getClient, reply, run, type Server } from "../shared.js";
import { findTemplatesOutput, getTemplateOutput, runTemplateOutput } from "../outputs.js";

// Template definitions change rarely; cache columns per slug and version so row trimming costs one lookup.
const columnsCache = new Map<string, string[]>();

async function columnKeys(client: SpidraClient, slug: string, version?: number): Promise<string[]> {
  const cacheKey = `${slug}@${version ?? "latest"}`;
  const cached = columnsCache.get(cacheKey);
  if (cached) return cached;
  const template = await client.getTemplate(slug);
  const keys = (template.columns ?? []).map(c => c.key);
  columnsCache.set(cacheKey, keys);
  return keys;
}

const getPath = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), row);

export const rowParams = {
  detail: z
    .enum(["columns", "full"])
    .optional()
    .describe('"columns" (default) returns each row with just the template\'s table columns; "full" returns every field (Google Maps rows have about 50)'),
  offset: z.number().int().min(0).optional().describe("Rows to skip (default 0)"),
  limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 50)"),
};

/** A finished run, with rows trimmed to the template's columns unless asked for in full, and paged. */
export async function shapeRun(
  client: SpidraClient,
  runResult: TemplateRun,
  opts: { detail?: "columns" | "full"; offset?: number; limit?: number }
): Promise<Record<string, unknown>> {
  const { rows, ...rest } = runResult;
  if (!rows) return rest;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  const page = rows.slice(offset, offset + limit);
  let shaped: unknown[] = page;
  if (opts.detail !== "full") {
    const keys = await columnKeys(client, runResult.template, runResult.templateVersion);
    if (keys.length) shaped = page.map(row => Object.fromEntries(keys.map(k => [k, getPath(row as Record<string, unknown>, k)])));
  }
  const more = offset + page.length < rows.length;
  return {
    ...rest,
    rows: shaped,
    rowsShown: { offset, count: page.length, total: rows.length },
    ...(more
      ? { next: `More rows: call spidra_get_job {"type": "template_run", "id": "${runResult.runId}", "offset": ${offset + page.length}}.` }
      : {}),
  };
}

function conciseInputs(template: TemplateDetail) {
  return template.inputs.map(i => ({
    key: i.key,
    label: i.label,
    type: i.type,
    ...(i.required ? { required: true } : {}),
    ...(i.default !== undefined ? { default: i.default } : {}),
    ...(i.example !== undefined ? { example: i.example } : {}),
    ...(i.help ? { help: i.help } : {}),
    ...(i.options ? { options: i.options.map(o => o.value) } : {}),
    ...(i.min !== undefined ? { min: i.min } : {}),
    ...(i.max !== undefined ? { max: i.max } : {}),
    ...(i.maxItems !== undefined ? { maxItems: i.maxItems } : {}),
    ...(i.showIf ? { showIf: i.showIf } : {}),
  }));
}

export function registerTemplateTools(server: Server): void {
  server.addTool({
    name: "spidra_find_templates",
    annotations: { title: "Find ready-made templates", readOnlyHint: true, openWorldHint: false },
    output: findTemplatesOutput,
    description: `
Find ready-made templates: jobs that turn a few inputs into a table of results, such as Google Maps leads with emails, Amazon keyword rank, LinkedIn or Indeed jobs, YouTube transcripts, Zillow homes or Google Flights prices. Free.
New sites and templates are added often, so search here rather than assuming one doesn't exist.

**Use it first** when the task is a common data job on a well-known site. A template is usually cheaper and more complete than writing scrapes yourself.
**Then:** spidra_get_template for its inputs, and spidra_run_template to run it.

Filter with "q" (words, e.g. "reviews"), "site" (e.g. "google-maps", "amazon") or "category". With no filter you get every template; the response also lists the site keys and categories to filter by.
`,
    parameters: z.object({
      q: z.string().optional().describe("Words to look for in template titles and summaries"),
      site: z.string().optional().describe('A site key, e.g. "google-maps", "amazon", "linkedin"'),
      category: z
        .enum(["lead-generation", "reviews", "ecommerce", "jobs", "social-media", "real-estate", "ai-and-documents", "research", "travel"])
        .optional()
        .describe("Only templates in this category"),
    }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        const { templates, categories, sites } = await client.listTemplates(args);
        return reply({
          templates: templates.map(t => ({
            slug: t.slug,
            title: t.title,
            summary: t.summary,
            site: t.site?.name ?? null,
            ...(t.usesAi ? { usesAi: true } : {}),
            ...(t.status === "beta" ? { beta: true } : {}),
            ...(t.availability ? { availability: t.availability } : {}),
          })),
          ...(args.q || args.site || args.category
            ? {}
            : { sites: sites.map(s => s.key), categories: categories.map(c => c.key) }),
        });
      });
    },
  });

  server.addTool({
    name: "spidra_get_template",
    annotations: { title: "Get a template's inputs", readOnlyHint: true, openWorldHint: false },
    output: getTemplateOutput,
    description: `
Get what a template needs and what it returns: its inputs (send them by "key" to spidra_run_template; "required" ones must be set, others have defaults), its columns, and its limits in plain words. Free.
`,
    parameters: z.object({ slug: z.string().describe('The template\'s slug, e.g. "google-maps-leads"') }),
    execute: async (args, { session }) => {
      const client = getClient(session);
      return run(async () => {
        const t = await client.getTemplate(args.slug);
        return reply({
          slug: t.slug,
          title: t.title,
          ...(t.description ? { description: t.description } : { summary: t.summary }),
          site: t.site?.name ?? null,
          ...(t.usesAi ? { usesAi: true } : {}),
          inputs: conciseInputs(t),
          columns: (t.columns ?? []).map(c => ({ key: c.key, label: c.label })),
          limits: t.limits ?? [],
          ...(t.availability ? { availability: t.availability } : {}),
        });
      });
    },
  });

  server.addTool({
    name: "spidra_run_template",
    annotations: { title: "Run a template", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    output: runTemplateOutput,
    description: `
Run a template and get its rows. Most runs finish in this call (it waits up to about 45 seconds). A longer one returns a "runId"; check it with spidra_get_job (type "template_run", with "waitSeconds" to wait for it) until "status" isn't "running".

- Get the inputs from spidra_get_template first. Send them in "inputs" by key.
- "estimate": true checks the inputs and returns the credits it should cost, for free, without running.
- Rows come back with the template's columns. "detail": "full" returns every field. Rows page with "offset" and "limit" (default 50).
- A "partial" run had some pages fail; its rows are still there, with the failures listed.

**Cost:** what the same job costs with the tool behind it, usually 1 credit per page read. Failed pages and failed runs cost nothing.

**Example:** {"slug": "google-maps-leads", "inputs": {"query": "dentist", "areas": ["Lekki, Lagos"]}}
`,
    parameters: z.object({
      slug: z.string().describe('The template\'s slug, e.g. "google-maps-leads"'),
      inputs: z.record(z.string(), z.unknown()).describe("The template's inputs by key"),
      estimate: z.boolean().optional().describe("Return the cost without running"),
      ...rowParams,
    }),
    execute: async (args, { session, log }) => {
      const client = getClient(session);
      return run(async () => {
        if (args.estimate) return reply(await client.estimateTemplate(args.slug, { inputs: args.inputs }));
        log.info("Running template", { slug: args.slug });
        const started = await client.startTemplateRun(args.slug, { inputs: args.inputs, wait: true });
        if (started.status === "running") {
          return reply({
            runId: started.runId,
            status: started.status,
            ...(started.progress ? { progress: started.progress } : {}),
            next: `Still running. Check it with spidra_get_job {"type": "template_run", "id": "${started.runId}", "waitSeconds": 30}.`,
          });
        }
        return reply(await shapeRun(client, started, args));
      });
    },
  });
}
