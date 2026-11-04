import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Prompts: starters a user picks from their client's prompt menu (for example "/" in Claude Code or the + menu in
// Claude). Each one turns a few fields into a brief that walks the model through the right tools, in order, with
// the cost checks. Prompt arguments are always strings in MCP.
// ---------------------------------------------------------------------------

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  args: Record<string, z.ZodType>;
  text: (args: Record<string, string | undefined>) => string;
}

const opt = (description: string) => z.string().optional().describe(description);
const req = (description: string) => z.string().describe(description);
const lines = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join("\n");

export const PROMPTS: PromptDefinition[] = [
  {
    name: "find_local_leads",
    title: "Find local business leads",
    description: "Businesses of one kind in an area, from Google Maps, with phone, website and rating, using the Google Maps leads template.",
    args: {
      business: req('The kind of business, e.g. "dentist" or "coffee shop"'),
      area: req('Where, e.g. "Lekki, Lagos" or "Austin, TX". Several areas can be separated with semicolons.'),
      count: opt("Roughly how many businesses you want (default: what one results page gives, about 20)"),
      contacts: opt('"yes" to also visit each business website for emails and social links (costs more)'),
    },
    text: a =>
      lines(
        `Find ${a.business} businesses in ${a.area} on Google Maps${a.count ? `, about ${a.count} of them` : ""}.`,
        "",
        "Use the ready-made template, not your own scrapes:",
        '1. spidra_get_template {"slug": "google-maps-leads"} to see its inputs.',
        `2. spidra_run_template with "estimate": true and those inputs, to see the cost.${a.contacts === "yes" ? " Turn on the input that visits each website for contacts." : ""}`,
        "3. If the cost is reasonable for what was asked, run it for real with the same inputs.",
        '4. If it returns a "runId" with status "running", call spidra_get_job {"type": "template_run", "id": <runId>, "waitSeconds": 30} until it finishes. Never start the run again.',
        "",
        "Then show the businesses as a table: name, category, phone, website, rating and address. Say how many credits it used.",
      ),
  },
  {
    name: "track_prices",
    title: "Track product prices",
    description: "Read the current price on one or more product pages, then set up a monitor that alerts when a price changes.",
    args: {
      urls: req("The product page URLs, separated by spaces or new lines"),
      schedule: opt('How often to check, e.g. "daily at 09:00 Africa/Lagos" or "every 6 hours" (default: daily)'),
      alertWhen: opt('When to alert, e.g. "any price change" (default) or "the price drops below 25"'),
    },
    text: a =>
      lines(
        `Track the prices on these pages: ${a.urls}`,
        "",
        "1. Read the current price first, so the user sees what will be watched:",
        '   - one URL: spidra_scrape with output "json" and a schema with name, price, currency and inStock;',
        "   - two or more: spidra_batch_scrape with the same schema and \"wait\": true (never one scrape per URL).",
        '   If a page comes back with "lowContent": true, call it again with "useProxy": true.',
        `2. Call spidra_create_monitor with "estimate": true: sources [{"kind": "urls", "urls": [...]}], alertOn "changed", watchFields ["price"], schedule ${a.schedule ? `for "${a.schedule}"` : "daily"}${a.alertWhen ? `, and a goal or rule for "${a.alertWhen}"` : ""}.`,
        "3. Show the user the prices and the monthly cost, and ask them to confirm before creating the monitor. Then create it with the same fields and no estimate.",
        "4. Say where alerts go (the account's email unless they asked for Slack, Discord or a webhook) and how to pause it.",
      ),
  },
  {
    name: "research_topic",
    title: "Research a topic",
    description: "Search the web (or papers or news), read the best sources and write a short answer with links.",
    args: {
      topic: req("What to research, as a question or a topic"),
      sources: opt('Where to look: "web" (default), "news", "research" for papers, or several separated by commas'),
      depth: opt('"quick" (3 sources, the default) or "deep" (up to 8 sources)'),
    },
    text: a => {
      const max = a.depth === "deep" ? 8 : 3;
      const sources = (a.sources ?? "web").split(/[,\s]+/).filter(Boolean);
      return lines(
        `Research this: ${a.topic}`,
        "",
        `1. spidra_search with the query as a person would type it, "sources": ${JSON.stringify(sources)} and "limit": 10. Don't add the current year unless the topic needs it.`,
        `2. Pick the ${max} most useful results. Read them with ONE spidra_batch_scrape call ("wait": true) and a short prompt for what matters to the question, not one scrape per page. A PDF result goes to spidra_parse instead.`,
        "3. If the sources disagree or leave a gap, do at most one more search.",
        "",
        "Answer in a few short paragraphs, then list the sources you used with their links. Say what you couldn't confirm.",
      );
    },
  },
  {
    name: "crawl_docs",
    title: "Crawl docs into Markdown",
    description: "Turn a documentation site, or one section of it, into clean Markdown pages.",
    args: {
      url: req('Where the docs start, e.g. "https://docs.python.org/3/library/asyncio.html"'),
      section: opt('Which pages, in plain words, e.g. "the asyncio reference pages" (default: every docs page under the URL)'),
      maxPages: opt("The most pages to return (default 25). Each page costs 1 credit."),
    },
    text: a => {
      const max = Number(a.maxPages) > 0 ? Number(a.maxPages) : 25;
      return lines(
        `Get the documentation at ${a.url} as Markdown${a.section ? `: ${a.section}` : ""}, at most ${max} pages.`,
        "",
        `1. spidra_map {"url": "${a.url}"${a.section ? `, "search": <a few words from the section>` : ""}, "limit": 100} to see how many pages there are (1 credit).`,
        `2. If you only need a handful of the URLs it found, read exactly those with spidra_batch_scrape. Otherwise use spidra_crawl with a crawlInstruction describing the pages, "maxPages": ${max}, and no transformInstruction or schema, so it's Markdown with no AI cost.`,
        `3. The crawl returns a jobId. Call spidra_get_job {"type": "crawl", "id": <jobId>, "waitSeconds": 45} until it's completed. Don't start it again. Then read the pages with spidra_crawl_pages, 20 to 50 at a time.`,
        "4. If pages you expected are missing, spidra_crawl_report says why each link was skipped.",
        "",
        "Give the user the page titles and URLs, and the Markdown of each page (or save it to files if you can write files).",
      );
    },
  },
  {
    name: "extract_document_table",
    title: "Extract a table from a document",
    description: "Pull a table (or any fields) out of a PDF, Word, Excel or PowerPoint file as JSON rows.",
    args: {
      url: req("A link to the document"),
      table: req('What to extract, e.g. "the BLEU scores table" or "every line item with amount and date"'),
      pages: opt('Pages to read, like "8" or "3-5" (default: find out first)'),
    },
    text: a =>
      lines(
        `From the document at ${a.url}, extract ${a.table} as JSON rows.`,
        "",
        a.pages
          ? `1. Only pages ${a.pages} are needed.`
          : '1. spidra_parse {"url": ..., "dryRun": true} for the page count and cost (free). For a long document, find the right pages first: parse a few likely pages without a prompt, or the table of contents.',
        `2. spidra_parse with the url, "pages": ${a.pages ? `"${a.pages}"` : "the pages you need"}, and a "schema" for one row per table row (every column as a field). The rows come back in "json".`,
        '3. If numbers or columns come back garbled or merged, parse the same pages again with "mode": "ocr", which reads the page as an image and handles tables and math better. Pass the "fileId" from the first parse instead of the url so the file isn\'t fetched again.',
        "",
        "Show the rows as a table and say which pages they came from.",
      ),
  },
  {
    name: "use_template",
    title: "Use a ready-made template",
    description: "Find the ready-made template for a common data job on a well-known site, check its cost and run it.",
    args: {
      task: req('What data you want, e.g. "Amazon products for wireless earbuds", "Polymarket odds on the election" or "jobs for data engineers in Berlin on LinkedIn"'),
    },
    text: a =>
      lines(
        `The user wants: ${a.task}`,
        "",
        '1. spidra_find_templates with "q" (a word or two) or "site" to find the template that fits. Templates are free to look up.',
        "2. spidra_get_template for its inputs and columns. Fill the inputs from the request; ask the user only if a required one can't be worked out.",
        '3. spidra_run_template with "estimate": true to see the cost, then run it.',
        '4. A run still going returns a runId: spidra_get_job {"type": "template_run", "id": <runId>, "waitSeconds": 30}. Page through rows with "offset" and "limit".',
        "",
        "If no template fits, say so and use spidra_scrape, spidra_batch_scrape or spidra_crawl instead. Show the rows as a table and say how many credits it used.",
      ),
  },
  {
    name: "watch_page",
    title: "Watch a page for changes",
    description: "Get an alert when a page changes: new items in a list, a changed field, or any text change.",
    args: {
      url: req("The page to watch"),
      what: opt('What counts as a change, e.g. "new job posts", "the stock status" or "any text change" (default)'),
      schedule: opt('How often to check, e.g. "hourly" or "daily at 08:00 Europe/London" (default: daily)'),
    },
    text: a =>
      lines(
        `Watch ${a.url} and alert the user when ${a.what ?? "the page text changes"}.`,
        "",
        "1. spidra_scrape the page once to see what's on it and confirm it reads well.",
        '2. Pick how to watch it: alertOn "page" for any text change; for new or changed items in a list, save a preset first (spidra_save_preset, kind "tool", tool "scrape", with a prompt that lists the items) and watch the preset with alertOn "new" or "changed". A "goal" in plain words keeps alerts to the changes that matter.',
        `3. spidra_create_monitor with "estimate": true and schedule ${a.schedule ? `"${a.schedule}"` : "daily"} (spidra_account shows the plan's shortest schedule). Tell the user the cost and confirm, then create it.`,
        "4. Say where alerts go and that the first check only records the starting point.",
      ),
  },
];

export function registerPrompts(mcp: McpServer): void {
  for (const p of PROMPTS) {
    mcp.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: z.object(p.args) },
      (args: Record<string, unknown>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args as Record<string, string | undefined>) } }],
      })
    );
  }
}
