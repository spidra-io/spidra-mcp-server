// Eval tasks: realistic requests a user makes of an assistant with the Spidra MCP server, each with checks on the
// tools it picks, its arguments, how many calls it makes, what it spends and whether it gets the answer.
//
// A check is { label, fn(calls, answer) => boolean }. calls are the Spidra tool calls in order, each
// { name, input, isError, text } (name without the "mcp__spidra__" prefix). Targets are public test sites
// (books.toscrape.com, quotes.toscrape.com) and stable documents, so the right answer is known.
//
// The ids in "Earlier runs" tasks (a crawl and a batch) exist only on the local test account they were recorded on;
// change them for another account.

const BOOK_1 = "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html";
const BOOK_2 = "https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html";
const PAPER = "https://arxiv.org/pdf/1706.03762";
const CRAWL_ID = "fa48e78c-1529-4641-a5c9-702b0eef9023";
const BATCH_ID = "5c0e5653-4ab7-4d11-b3b3-72f79a7c3412";

// --- helpers -----------------------------------------------------------------
const of = (calls, name) => calls.filter(c => c.name === name);
const used = name => ({ label: `uses ${name}`, fn: calls => of(calls, name).length > 0 });
const notUsed = (...names) => ({ label: `doesn't use ${names.join(" or ")}`, fn: calls => !calls.some(c => names.includes(c.name)) });
const atMost = (name, n) => ({ label: `${name} at most ${n}x`, fn: calls => of(calls, name).length <= n });
const some = (name, label, pred) => ({ label, fn: calls => of(calls, name).some(c => pred(c.input ?? {})) });
const every = (name, label, pred) => ({ label, fn: calls => of(calls, name).every(c => pred(c.input ?? {})) });
const says = (re, label = `answer matches ${re}`) => ({ label, fn: (_calls, answer) => re.test(answer) });
const realRun = i => !i.estimate;

export const TASKS = [
  // --- leads and ready-made templates ------------------------------------------
  {
    id: "leads_maps",
    kind: "leads",
    prompt: "Find dentists in Lekki, Lagos on Google Maps and give me 5 of them with their phone numbers.",
    maxCalls: 6,
    maxCredits: 10,
    checks: [
      some("spidra_run_template", "runs the google-maps-leads template", i => i.slug === "google-maps-leads" && realRun(i)),
      notUsed("spidra_scrape", "spidra_crawl", "spidra_batch_scrape"),
      says(/\d{3}[\s-]?\d{3}/, "answer has phone numbers"),
    ],
  },
  {
    id: "template_discover",
    kind: "templates (no spend)",
    prompt: "Is there a ready-made way to get YouTube video transcripts with Spidra? Don't run anything yet, just tell me what inputs it needs.",
    maxCalls: 4,
    maxCredits: 0,
    checks: [
      used("spidra_find_templates"),
      used("spidra_get_template"),
      { label: "doesn't run the template", fn: calls => !of(calls, "spidra_run_template").some(c => realRun(c.input ?? {})) },
      notUsed("spidra_scrape", "spidra_search"),
      says(/transcript/i),
    ],
  },
  {
    id: "template_typo_recover",
    kind: "error recovery",
    prompt: "Run the Spidra template 'google-maps-lead' for cafes in Ikeja, Lagos and show me the first 3 results.",
    maxCalls: 7,
    maxCredits: 10,
    checks: [
      { label: "the wrong slug fails", fn: calls => calls.some(c => c.isError) || !calls.some(c => c.input?.slug === "google-maps-lead") },
      some("spidra_run_template", "recovers and runs google-maps-leads", i => i.slug === "google-maps-leads" && realRun(i)),
      atMost("spidra_run_template", 3),
      says(/caf|coffee/i, "answer lists cafes"),
    ],
  },
  {
    id: "new_site_template",
    kind: "templates (new sites)",
    prompt: "What are the biggest Polymarket markets right now by volume? Give me the top 5 with their odds.",
    maxCalls: 6,
    maxCredits: 10,
    checks: [
      {
        label: "finds a Polymarket template",
        fn: calls => calls.some(c => (c.name === "spidra_find_templates" && /polymarket/i.test(JSON.stringify(c.input))) || (c.name === "spidra_run_template" && /^polymarket/.test(c.input?.slug ?? ""))),
      },
      some("spidra_run_template", "runs a polymarket template", i => /^polymarket/.test(i.slug ?? "") && realRun(i)),
      notUsed("spidra_crawl"),
      says(/%|\d\.\d/, "answer has odds"),
    ],
  },

  // --- prices -----------------------------------------------------------------
  {
    id: "price_one",
    kind: "price check",
    prompt: `What's the current price of the book at ${BOOK_1}?`,
    maxCalls: 2,
    maxCredits: 3,
    checks: [used("spidra_scrape"), atMost("spidra_scrape", 1), notUsed("spidra_batch_scrape", "spidra_crawl", "spidra_search"), says(/51\.77/)],
  },
  {
    id: "price_compare",
    kind: "price check",
    prompt: `Compare the prices of these two books and tell me which is cheaper: ${BOOK_1} and ${BOOK_2}`,
    maxCalls: 3,
    maxCredits: 5,
    checks: [
      used("spidra_batch_scrape"),
      notUsed("spidra_crawl", "spidra_search"),
      atMost("spidra_scrape", 0),
      says(/51\.77/),
      says(/53\.74/),
    ],
  },
  {
    id: "structured_json",
    kind: "extraction",
    prompt: "Give me the title, price and availability of every book on the first page of https://books.toscrape.com as JSON.",
    maxCalls: 2,
    maxCredits: 5,
    checks: [
      some("spidra_scrape", "asks for JSON with a prompt or schema", i => i.output === "json" || Boolean(i.schema) || Boolean(i.prompt)),
      notUsed("spidra_crawl", "spidra_batch_scrape"),
      says(/A Light in the Attic/),
    ],
  },
  {
    id: "monitor_price",
    kind: "monitor",
    prompt: `Set up a daily price alert at 9am Lagos time for ${BOOK_1}. Email is fine. I confirm the cost, go ahead and create it.`,
    maxCalls: 5,
    maxCredits: 3,
    checks: [
      some("spidra_create_monitor", "creates a monitor", realRun),
      some("spidra_create_monitor", "watches the price", i => realRun(i) && (i.watchFields?.includes("price") || Boolean(i.rule) || /price/i.test(i.goal ?? ""))),
      some("spidra_create_monitor", "daily at 09:00 Africa/Lagos", i => realRun(i) && i.schedule?.every === "1d" && i.schedule?.at === "09:00" && i.schedule?.timezone === "Africa/Lagos"),
    ],
  },
  {
    id: "preset_save_run",
    kind: "presets",
    prompt: "Save a reusable preset called 'Books sitemap' that maps books.toscrape.com with a limit of 10 URLs, then run it once and tell me how many URLs it found.",
    maxCalls: 3,
    maxCredits: 2,
    checks: [
      some("spidra_save_preset", "saves a map tool preset", i => i.kind === "tool" && i.tool === "map"),
      used("spidra_run_preset"),
      notUsed("spidra_map"),
      says(/\b10\b|\bten\b/i),
    ],
  },

  // --- research and finding pages -----------------------------------------------
  {
    id: "research_paper",
    kind: "research",
    prompt: "Find the arXiv paper that introduced the Transformer architecture and tell me its title, authors and year.",
    maxCalls: 4,
    maxCredits: 6,
    checks: [used("spidra_search"), notUsed("spidra_crawl"), says(/Attention Is All You Need/i), says(/2017/)],
  },
  {
    id: "news_week",
    kind: "research",
    prompt: "What's been in the news this week about AI regulation? Give me 3 headlines with links.",
    maxCalls: 3,
    maxCredits: 3,
    checks: [
      some("spidra_search", "searches news", i => i.sources?.includes("news")),
      some("spidra_search", "limits to recent results", i => ["day", "week"].includes(i.timeRange)),
      notUsed("spidra_crawl", "spidra_batch_scrape"),
      says(/https?:\/\//, "answer has links"),
    ],
  },
  {
    id: "find_doc_page",
    kind: "no expensive tool",
    prompt: "Which page of the Python 3 docs at docs.python.org/3 covers asyncio queues? Just give me the URL.",
    maxCalls: 3,
    maxCredits: 3,
    checks: [
      { label: "uses spidra_map or spidra_search", fn: calls => calls.some(c => c.name === "spidra_map" || c.name === "spidra_search") },
      notUsed("spidra_crawl", "spidra_batch_scrape"),
      says(/asyncio-queue\.html/),
    ],
  },
  {
    id: "cheap_category_urls",
    kind: "no expensive tool",
    prompt: "List the URLs of all the book category pages on books.toscrape.com. Just the URLs.",
    maxCalls: 3,
    maxCredits: 2,
    checks: [used("spidra_map"), notUsed("spidra_crawl", "spidra_batch_scrape"), says(/category\/books\//)],
  },
  {
    id: "credits_only",
    kind: "no expensive tool",
    prompt: "How many Spidra credits do I have left?",
    maxCalls: 1,
    maxCredits: 0,
    checks: [used("spidra_account"), says(/\d/)],
  },

  // --- crawls and long jobs -------------------------------------------------------
  {
    id: "crawl_authors",
    kind: "long async job",
    prompt: "Get the author pages on quotes.toscrape.com, at most 5 of them, as Markdown, and tell me which authors you got.",
    maxCalls: 8,
    maxCredits: 7,
    checks: [
      {
        label: "crawls (one job) or maps then batch-scrapes",
        fn: calls => of(calls, "spidra_crawl").length === 1 || (of(calls, "spidra_map").length > 0 && of(calls, "spidra_batch_scrape").length > 0),
      },
      every("spidra_crawl", "maxPages 5 or fewer", i => (i.maxPages ?? 5) <= 5),
      every("spidra_crawl", "no AI extraction (Markdown is free of AI cost)", i => !i.transformInstruction && !i.schema),
      { label: "waits with waitSeconds instead of rapid polling", fn: calls => of(calls, "spidra_get_job").every(c => (c.input?.waitSeconds ?? 0) > 0) },
      says(/Einstein|Austen|Rowling|Twain|Gide|Edison|Roosevelt|Martin|Huxley|Eleanor/),
    ],
  },
  {
    id: "batch_async_12",
    kind: "long async job",
    prompt:
      "Get the first quote and its author from each of these 12 pages: " +
      Array.from({ length: 10 }, (_, i) => `https://quotes.toscrape.com/page/${i + 1}/`).join(", ") +
      ", https://quotes.toscrape.com/tag/love/, https://quotes.toscrape.com/tag/life/",
    maxCalls: 6,
    maxCredits: 30,
    checks: [
      atMost("spidra_batch_scrape", 1),
      used("spidra_batch_scrape"),
      atMost("spidra_scrape", 0),
      { label: "waits with waitSeconds", fn: calls => of(calls, "spidra_get_job").every(c => (c.input?.waitSeconds ?? 0) > 0) },
      says(/Einstein/),
    ],
  },
  {
    id: "crawl_report_why",
    kind: "no expensive tool",
    prompt: `My crawl ${CRAWL_ID} returned only 2 pages. Why did it stop there, and was anything skipped?`,
    maxCalls: 3,
    maxCredits: 0,
    checks: [
      { label: "reads the report or the job", fn: calls => calls.some(c => c.name === "spidra_crawl_report" || c.name === "spidra_get_job" || c.name === "spidra_logs") },
      notUsed("spidra_crawl", "spidra_crawl_extract"),
      says(/maxPages|max pages|limit/i, "answer names the page limit"),
    ],
  },
  {
    id: "batch_retry",
    kind: "jobs",
    prompt: `Check my batch ${BATCH_ID} and retry anything that failed.`,
    maxCalls: 4,
    maxCredits: 2,
    checks: [
      some("spidra_get_job", "checks the batch", i => i.type === "batch"),
      used("spidra_retry_batch"),
      notUsed("spidra_batch_scrape", "spidra_scrape"),
    ],
  },

  // --- documents --------------------------------------------------------------------
  {
    id: "parse_page",
    kind: "documents",
    prompt: `Summarize the abstract on page 1 of ${PAPER} in two sentences.`,
    maxCalls: 3,
    maxCredits: 3,
    checks: [
      { label: "uses spidra_parse or spidra_scrape", fn: calls => calls.some(c => c.name === "spidra_parse" || c.name === "spidra_scrape") },
      every("spidra_parse", "parses only the first pages", i => Boolean(i.dryRun) || /^1(\s*-\s*[12])?$/.test(String(i.pages ?? "").trim()) || (i.maxPages ?? 99) <= 2),
      says(/attention|transformer/i),
    ],
  },
  {
    id: "parse_table",
    kind: "documents",
    prompt: `From ${PAPER}, extract Table 2 (BLEU scores and training cost for each model) as JSON rows.`,
    maxCalls: 5,
    maxCredits: 10,
    checks: [
      used("spidra_parse"),
      { label: "doesn't parse all 15 pages with AI", fn: calls => of(calls, "spidra_parse").every(c => c.input?.dryRun || c.input?.pages || c.input?.maxPages || !(c.input?.prompt || c.input?.schema)) },
      says(/28\.4/, "answer has the Transformer (big) EN-DE score"),
    ],
  },

  // --- errors -------------------------------------------------------------------------
  {
    id: "error_dead_domain",
    kind: "error recovery",
    prompt: "Scrape https://this-domain-does-not-exist-spidra.example/ and tell me what the page says.",
    maxCalls: 3,
    maxCredits: 0,
    checks: [used("spidra_scrape"), atMost("spidra_scrape", 2), says(/couldn|could not|can't|cannot|fail|not exist|unreachable|resolve/i, "answer says it failed")],
  },
];
