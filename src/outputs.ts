import { z } from "zod";

// ---------------------------------------------------------------------------
// Output schemas (outputSchema) for the tools whose results have a stable shape.
//
// They're built to never get in the way:
// - Every field is optional, and every object allows fields it doesn't list, so a new API field, or a field the API
//   leaves out, never fails a call.
// - They list the fields a client or model is most likely to read, not every field the API returns. The rest pass
//   through untouched.
// - If a value still doesn't match (the API changed a type), server.ts drops just that field from structuredContent
//   and the text result keeps it, rather than failing the call. tests/output-schemas.test.mjs checks real recorded
//   results against each schema.
//
// Shapes come from real results recorded against the Spidra API (tests/fixtures/outputs) and the spidra SDK types.
// They're kept shallow on purpose: every field here is sent in tools/list.
// ---------------------------------------------------------------------------

type Shape = Record<string, z.ZodType>;

/** A loose object whose fields are all optional. */
const o = (shape: Shape) =>
  z.looseObject(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as Shape);

const s = z.string();
const sn = z.string().nullable();
const n = z.number();
const nn = z.number().nullable();
const b = z.boolean();
const any = z.unknown();
const list = (item: z.ZodType) => z.array(item);
const strings = list(s);

// --- search and map --------------------------------------------------------

// data has one list per source ("web", "news", "research"...), each of these items, plus extras and nextPageTokens.
const searchItem = o({ title: s, url: s, description: s, position: n });

export const searchOutput = o({
  success: b,
  data: z
    .looseObject({ extras: any.optional(), nextPageTokens: z.record(z.string(), z.string()).optional() })
    .catchall(list(searchItem)),
  logUuid: s,
});

export const mapOutput = o({ links: list(o({ url: s, title: s })), total: n, scanned: n, creditsUsed: n });

// --- pages -------------------------------------------------------------------

export const scrapeOutput = o({
  content: any,
  structuredData: any,
  actionResults: list(o({ index: n, status: s, error: s })),
  warnings: strings,
  lowContent: b,
  stats: any,
});

const batchFields = {
  batchId: s,
  status: s,
  failedCount: n,
  items: list(o({ url: s, status: s, result: any, error: sn })),
};

export const batchScrapeOutput = o({ ...batchFields, next: s });

// --- crawl -------------------------------------------------------------------

export const queuedOutput = o({ jobId: s, next: s });

export const crawlPagesOutput = o({
  pages: list(o({ id: s, url: s, status: s, data: any })),
  total: n,
  hasMore: b,
});

export const crawlReportOutput = o({
  report: o({
    understoodAs: sn,
    skipped: list(o({ reason: s, count: n })),
    skippedUrls: list(o({ url: s, reason: s })),
  }).nullable(),
});

export const retryCrawlPageOutput = o({ data: any, creditsUsed: n });

// --- parse -------------------------------------------------------------------

// One document, a batch, or a dry-run estimate.
export const parseOutput = o({
  jobId: s,
  batchId: s,
  status: s,
  fileId: sn,
  totalPages: nn,
  credits: n,
  creditsUsed: n,
  markdown: s,
  json: any,
  pages: list(o({ pageNumber: n, markdown: s })),
  documents: list(any),
  next: s,
});

// --- templates and presets ---------------------------------------------------

export const findTemplatesOutput = o({ templates: list(o({ slug: s, title: s, site: sn })), sites: strings });

export const getTemplateOutput = o({
  slug: s,
  inputs: list(o({ key: s, type: s, required: b })),
  columns: list(any),
});

// A finished or running run, or an estimate.
export const runTemplateOutput = o({
  runId: s,
  status: s,
  creditsUsed: nn,
  rows: list(any),
  rowsShown: any,
  next: s,
  credits: nn,
});

export const listPresetsOutput = o({ total: n, presets: list(o({ id: s, name: s, kind: s, tool: sn })), id: s });

export const savePresetOutput = o({ id: s, next: s });

export const runPresetOutput = o({ presetId: s, run: any });

export const deletedOutput = o({ deleted: s });

// --- monitors ----------------------------------------------------------------

const monitor = o({ id: s, name: s, status: s, nextRunAt: sn });

// The new monitor, an estimate, or a test notification's result.
export const createMonitorOutput = o({ monitor, creditsPerCheck: n, creditsPerMonth: n, sent: n });

export const listMonitorsOutput = o({ monitors: list(monitor), id: s });

export const updateMonitorOutput = o({ monitor });

export const messageOutput = o({ message: s, next: s });

export const monitorChangesOutput = o({
  checks: list(o({ id: s, hasChanges: b, summary: sn })),
  hasChanges: b,
  sources: list(o({ label: s, baseline: b })),
});

// --- jobs and account --------------------------------------------------------

// Any job type: the fields each kind of job has, all optional.
export const getJobOutput = o({
  ...batchFields,
  status: s,
  jobId: s,
  runId: s,
  result: any,
  error: sn,
  documents: list(any),
  markdown: s,
  rows: list(any),
  next: s,
});

export const cancelJobOutput = o({ status: s, creditsRefunded: n });

export const retryBatchOutput = o({ retriedCount: n });

export const accountOutput = o({
  plan: o({ name: s }),
  credits: o({ limit: n, used: n, remaining: n }),
  monitors: o({ allowed: n, used: n }),
});

// ---------------------------------------------------------------------------
// JSON Schema, kept small: no $schema (2020-12 is the MCP default), no "additionalProperties": {} (open is the
// default), and ["string", "null"] instead of an anyOf of plain types. Used for input and output schemas.
// ---------------------------------------------------------------------------

export function compactJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactJsonSchema);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema") continue;
    if (k === "additionalProperties" && v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = compactJsonSchema(v);
  }
  const anyOf = out.anyOf;
  if (
    Array.isArray(anyOf) &&
    anyOf.every(a => a && typeof a === "object" && Object.keys(a).length === 1 && typeof (a as { type?: unknown }).type === "string")
  ) {
    delete out.anyOf;
    out.type = anyOf.map(a => (a as { type: string }).type);
  }
  return out;
}

/**
 * Drop whatever doesn't match the schema from a result, field by field, so a changed API type costs that one field
 * in structuredContent (the text result still has it) instead of the whole call. Returns the fitted value and the
 * paths it dropped.
 */
export function fitToSchema(schema: z.ZodType, value: Record<string, unknown>): { value: Record<string, unknown>; dropped: string[] } {
  if (schema.safeParse(value).success) return { value, dropped: [] };
  const copy = structuredClone(value);
  const dropped: string[] = [];
  for (let round = 0; round < 6; round++) {
    const parsed = schema.safeParse(copy);
    if (parsed.success) return { value: copy, dropped };
    // Early rounds drop the exact field; later ones its top-level key, which always fits since every field is optional.
    for (const issue of parsed.error.issues) {
      const path = round < 3 ? issue.path : issue.path.slice(0, 1);
      if (!path.length) return { value: {}, dropped: [...dropped, "(everything)"] };
      let parent: unknown = copy;
      for (const key of path.slice(0, -1)) parent = parent == null ? undefined : (parent as Record<PropertyKey, unknown>)[key as PropertyKey];
      const last = path[path.length - 1] as PropertyKey;
      if (parent && typeof parent === "object" && last in (parent as object)) {
        if (Array.isArray(parent) && typeof last === "number") parent[last] = {};
        else delete (parent as Record<PropertyKey, unknown>)[last];
        dropped.push(path.join("."));
      }
    }
  }
  return schema.safeParse(copy).success ? { value: copy, dropped } : { value: {}, dropped: [...dropped, "(everything)"] };
}
