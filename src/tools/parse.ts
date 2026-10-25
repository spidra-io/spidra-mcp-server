import { UserError } from "fastmcp";
import { z } from "zod";
import { getClient, jsonSchemaParam, reply, run, type Server } from "../shared.js";

const WAIT_MS = 50_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function registerParseTools(server: Server): void {
  server.addTool({
    name: "spidra_parse",
    annotations: { title: "Parse documents", readOnlyHint: true, openWorldHint: true },
    description: `
Turn documents into Markdown, page by page, and into JSON with a "prompt" or "schema". PDF, Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, CSV and HTML files work, and scanned pages are read with AI.

**Use it for** reports, papers, invoices, contracts and spreadsheets, online or given to you as a file.
**Don't use it for** web pages (spidra_scrape).

Send the documents one way:
- "url": a link to one document.
- "fileBase64" and "fileName": a file you have, base64-encoded (up to about 10 MB).
- "fileId": a document parsed in the last 24 hours, to parse again with other options.
- "urls" or "fileIds": several documents at once (up to 50), each parsed with the same options.

- "pages" ("1-5, 9" or "10-") or "maxPages" parses only part of a long PDF.
- "dryRun": true returns the page count and cost, for free, without parsing.
- It waits up to about 50 seconds. A long document or a batch still running returns an id; check it with spidra_get_job (type "parse" or "parse_batch").

**Cost:** 1 credit per page parsed, plus AI credits with a prompt or schema. Formats without pages count one page per 3,000 characters. Failed pages and documents cost nothing.

**Example:** {"url": "https://arxiv.org/pdf/1706.03762", "pages": "1-3"}
`,
    parameters: z.object({
      url: z.string().optional().describe("A link to one document"),
      fileBase64: z.string().max(14_000_000).optional().describe("One file's bytes, base64-encoded (up to about 10 MB)"),
      fileName: z.string().optional().describe('The file\'s name with its extension, required with fileBase64, e.g. "report.pdf"'),
      fileId: z.string().optional().describe("A fileId from a parse in the last 24 hours"),
      urls: z.array(z.string()).max(50).optional().describe("Links to several documents (a batch)"),
      fileIds: z.array(z.string()).max(50).optional().describe("Several fileIds (a batch)"),
      mode: z.enum(["auto", "fast", "ocr"]).optional().describe('"auto" (default) uses AI only on scanned pages, "fast" never, "ocr" on every page'),
      pages: z.string().optional().describe('PDF pages to parse, like "1-5, 9" or "10-"'),
      maxPages: z.number().int().min(1).optional().describe("Parse at most this many pages"),
      includePages: z.boolean().optional().describe("Also return each page's Markdown on its own"),
      prompt: z.string().max(5000).optional().describe("Fields to extract, in plain words. The result is in json."),
      schema: jsonSchemaParam,
      dryRun: z.boolean().optional().describe("Return the pages and cost without parsing or charging"),
    }),
    execute: async (args, { session, log }) => {
      const client = getClient(session);
      const { url, fileBase64, fileName, fileId, urls, fileIds, dryRun, includePages, ...rest } = args;
      const options = { ...rest, includePages, schema: rest.schema as Record<string, unknown> | undefined };

      const isBatch = Boolean(urls?.length || fileIds?.length);
      const singles = [url, fileBase64, fileId].filter(Boolean).length;
      if (isBatch && singles) throw new UserError('Send either one document (url, fileBase64 or fileId) or a batch (urls or fileIds), not both.');
      if (!isBatch && singles !== 1) throw new UserError('Send one of "url", "fileBase64" (with "fileName"), "fileId", or a batch in "urls" or "fileIds".');
      if (fileBase64 && !fileName) throw new UserError('"fileName" is required with "fileBase64", e.g. "report.pdf".');

      return run(async () => {
        if (isBatch) {
          const inputs = [...(urls ?? []).map(u => ({ url: u })), ...(fileIds ?? []).map(id => ({ fileId: id }))];
          log.info("Parsing batch", { documents: inputs.length });
          const started = await client.startParseBatch(inputs, { ...options, ...(dryRun ? { dryRun: true } : {}) } as never);
          if (dryRun) return reply(started);
          const deadline = Date.now() + WAIT_MS;
          let batch = await client.getParseBatch(started.batchId);
          while (batch.status === "running" && Date.now() < deadline) {
            await sleep(3000);
            batch = await client.getParseBatch(started.batchId);
          }
          if (batch.status === "running") {
            return reply({
              ...batch,
              next: `Still parsing. Check it with spidra_get_job {"type": "parse_batch", "id": "${started.batchId}"} in a little while.`,
            });
          }
          return reply(await client.getParseBatch(started.batchId, { includeResults: true }));
        }

        const input = url ? { url } : fileId ? { fileId } : { file: Buffer.from(fileBase64!, "base64"), fileName: fileName! };
        log.info("Parsing document", { source: url ?? fileName ?? fileId });
        if (dryRun) return reply(await client.estimateParse(input as never, options as never));
        const job = await client.startParse(input as never, options as never);
        const deadline = Date.now() + WAIT_MS;
        let current = job;
        while ((current.status === "queued" || current.status === "running") && Date.now() < deadline) {
          await sleep(2000);
          current = await client.getParse(job.jobId, { includePages });
        }
        if (current.status === "queued" || current.status === "running") {
          return reply({
            jobId: job.jobId,
            status: current.status,
            ...(current.progress ? { progress: current.progress } : {}),
            next: `Still parsing. Check it with spidra_get_job {"type": "parse", "id": "${job.jobId}"} in a little while.`,
          });
        }
        return reply(current);
      });
    },
  });
}
