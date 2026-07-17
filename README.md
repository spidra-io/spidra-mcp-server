<div align="center">
  <a name="readme-top"></a>
  <img
    src="https://raw.githubusercontent.com/spidra-io/spidra-mcp-server/main/img/logo.png"
    height="172"
  >
</div>

# Spidra MCP Server

The official [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Spidra](https://spidra.io).

MCP is the standard that lets AI assistants use external tools. When you connect this server to an assistant like Claude Code, Claude Desktop, Cursor, Windsurf, or VS Code, the assistant gains the ability to scrape web pages, process lists of URLs, and crawl entire websites on its own. You describe what you want in plain language, and the assistant picks the right Spidra tool, runs it, and works with the extracted data directly in the conversation.

## Features

- Scrape any page and get clean markdown or structured JSON back
- Extract exactly the fields you want using plain-language prompts or JSON schemas
- Process up to 50 URLs in parallel with one request
- Crawl whole sites by describing which links to follow in plain English
- Run browser actions before scraping: click, type, scroll, or loop over elements
- Route through residential proxies for geo-restricted or bot-protected sites
- Built-in guidance that keeps the assistant from wasting your credits
- Automatic retries for flaky network moments, with clear typed errors otherwise

## Before you start

You need three things:

1. **A Spidra API key.** Sign up at [app.spidra.io](https://app.spidra.io) and create one under **Settings** > **API Keys**. Keys start with `spd_`.
2. **Node.js 20 or newer.** Check with `node --version`. The `npx` command that runs the server ships with Node.
3. **An MCP-compatible client.** Any of the assistants below works.

## Installation

Pick your client. Every setup below does the same thing. It tells your assistant to run `npx -y spidra-mcp` and hands the server your API key through an environment variable.

### Claude Code

Run this one command in your terminal, replacing the placeholder with your real key:

```bash
claude mcp add spidra -e SPIDRA_API_KEY=spd_YOUR_API_KEY -- npx -y spidra-mcp
```

Start a new Claude Code session, then run `/mcp` to confirm the connection shows as active.

### Cursor

1. Open Cursor Settings
2. Go to **Features** > **MCP Servers**
3. Click **+ Add new global MCP server**
4. Paste the following and replace the placeholder key:

```json
{
  "mcpServers": {
    "spidra": {
      "command": "npx",
      "args": ["-y", "spidra-mcp"],
      "env": {
        "SPIDRA_API_KEY": "spd_YOUR_API_KEY"
      }
    }
  }
}
```

You can also put this in a `.cursor/mcp.json` file inside a project if you only want Spidra available there.

### Claude Desktop

1. Open **Settings** > **Developer** > **Edit Config**. This opens `claude_desktop_config.json`
2. Add the `spidra` entry inside `mcpServers` (create the object if the file is empty):

```json
{
  "mcpServers": {
    "spidra": {
      "command": "npx",
      "args": ["-y", "spidra-mcp"],
      "env": {
        "SPIDRA_API_KEY": "spd_YOUR_API_KEY"
      }
    }
  }
}
```

3. Quit and reopen Claude Desktop. The tools appear under the tools icon in the chat input.

### VS Code

Add this to your User Settings (JSON). Press `Ctrl + Shift + P` (or `Cmd + Shift + P` on Mac), type `Preferences: Open User Settings (JSON)`, and add:

```json
{
  "mcp": {
    "servers": {
      "spidra": {
        "command": "npx",
        "args": ["-y", "spidra-mcp"],
        "env": {
          "SPIDRA_API_KEY": "spd_YOUR_API_KEY"
        }
      }
    }
  }
}
```

To share the setup with your team instead, put the same `servers` block in a `.vscode/mcp.json` file in your repository and use a `promptString` input for the key so it never gets committed.

### Windsurf

Add this to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "spidra": {
      "command": "npx",
      "args": ["-y", "spidra-mcp"],
      "env": {
        "SPIDRA_API_KEY": "spd_YOUR_API_KEY"
      }
    }
  }
}
```

### Running over HTTP instead of stdio

By default the server talks to your client over stdio, which is what all the configs above use and what you want on a single machine. If you need an HTTP endpoint instead (for example, a tool that connects to MCP servers over the network), start the server like this:

```bash
env HTTP_STREAMABLE_SERVER=true SPIDRA_API_KEY=spd_YOUR_API_KEY npx -y spidra-mcp
```

Then connect to `http://localhost:3000/mcp`. On this transport the API key can also be sent per request using an `X-Spidra-API-Key` header or an `Authorization: Bearer` header, which is useful when one server instance serves more than one user.

## Try it

Once connected, just ask for web data in normal language. You never call the tools by name; the assistant does that for you. Some things to try:

> "Scrape https://news.ycombinator.com and give me the top 5 stories with their points."

> "Compare the pricing pages of stripe.com and paddle.com and tell me which is cheaper for a small SaaS."

> "Here are 12 product URLs. Get me the name, price, and rating for each one as a table."

> "Crawl the first 10 pages of docs.example.com and summarize what the product does."

If the assistant answers with real data from those pages, everything is working.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SPIDRA_API_KEY` | Yes | Your Spidra API key, starting with `spd_` |
| `SPIDRA_API_URL` | No | Override the API base URL, for staging or self-hosted setups |
| `HTTP_STREAMABLE_SERVER` | No | Set to `true` to serve HTTP at `http://localhost:3000/mcp` instead of stdio |
| `PORT` / `HOST` | No | Bind address for the HTTP transport. Defaults are `3000` and `localhost` |

## How to choose a tool

This section is written for humans, but the same guidance is embedded in the tool descriptions, so the assistant follows it on its own.

The deciding question is not how many URLs you have. It is what you want back:

- **You want one answer, and you know the URL (or 2 to 3 related URLs):** use **scrape**. When you pass several URLs, their content is merged and the AI answers once across all of them. That makes it the right tool for comparing two pricing pages or summarizing three related articles into one answer.
- **You want separate data for each URL in a list:** use **batch scrape**, even if the list only has 2 items. Every URL is processed independently and returns its own result. This is the tool for "extract the same fields from each of these product pages."
- **You do not know the page URLs yet:** use **crawl**. You give it one starting URL and a plain-English instruction about which links to follow, and it discovers the pages itself.

### Quick reference

| Tool | Best for | Waits or polls? |
|---|---|---|
| `spidra_scrape` | One combined answer from 1 to 3 known URLs | Waits, returns the result directly |
| `spidra_check_scrape_status` | Re-checking a scrape that outlived its wait window | Instant lookup |
| `spidra_batch_scrape` | Separate results for each of 2 to 50 known URLs | Returns a `batchId`, assistant polls |
| `spidra_check_batch_status` | Progress and per-URL results for a batch | Instant lookup |
| `spidra_cancel_batch` | Stopping a batch you no longer need | Instant |
| `spidra_crawl` | Discovering and processing pages from one starting URL | Returns a `jobId`, assistant polls |
| `spidra_check_crawl_status` | Progress, then full results, for a crawl | Instant lookup |
| `spidra_crawl_pages` | Per-page results with raw HTML and markdown download links | Instant lookup |
| `spidra_crawl_extract` | Asking a new question of an already-completed crawl | Returns a new `jobId` |
| `spidra_cancel_crawl` | Stopping a crawl you no longer need | Instant |
| `spidra_scrape_logs` | Looking up past jobs and their outputs | Instant lookup |
| `spidra_usage` | Checking credit and request usage | Instant lookup |

### A note on output format

When you need specific fields from a page, ask for JSON and describe the fields, or provide a JSON schema. The assistant gets back a small, focused payload instead of an entire page, which keeps the conversation fast and cheap. Ask for full markdown only when you genuinely need the whole page, such as summarizing a complete article.

If you use a schema, define every field you want extracted. An untyped object with no properties gives the AI nothing to fill in, so those fields come back empty.

## Available tools

### 1. Scrape (`spidra_scrape`)

Scrapes 1 to 3 URLs and extracts their content with AI. This tool waits for the result, typically 10 to 60 seconds, and returns the extracted content directly. No polling needed.

The important behavior to understand: when you pass more than one URL, their content is combined and the AI produces **one answer across all of them**. The raw per-page content still comes back in the `pages` field, but the extraction itself is a single, merged result. Use multiple URLs here when you want the AI to compare or synthesize across pages. If you want the same extraction run separately on each URL, use `spidra_batch_scrape` instead, even for just 2 URLs.

**Best for:**

- Getting content or specific data from a page you already know
- One combined answer drawn from 2 or 3 related pages, like a pricing comparison

**Not recommended for:**

- Separate results per URL (use `spidra_batch_scrape`)
- Discovering pages on a site (use `spidra_crawl`)

**Common mistakes:**

- Passing several unrelated URLs expecting individual results for each. You will get one merged answer. Use batch scrape for per-URL results.
- Omitting a prompt and a schema when you wanted structured data. With neither, you get the page back as raw markdown.

**Prompt example:**

> "Get the product name, price, and description from https://example.com/product."

**Usage example (structured extraction with a schema):**

```json
{
  "name": "spidra_scrape",
  "arguments": {
    "urls": ["https://example.com/product"],
    "prompt": "Extract the product information",
    "output": "json",
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "price": { "type": "number" },
        "description": { "type": "string" }
      },
      "required": ["name", "price"]
    }
  }
}
```

**Usage example (compare two pages in one answer):**

```json
{
  "name": "spidra_scrape",
  "arguments": {
    "urls": ["https://competitor-a.com/pricing", "https://competitor-b.com/pricing"],
    "prompt": "Compare the plans on these two pages and list the differences in price and features",
    "output": "json"
  }
}
```

**Usage example (raw markdown, no AI extraction):**

```json
{
  "name": "spidra_scrape",
  "arguments": {
    "urls": ["https://example.com/blog/some-article"]
  }
}
```

**Other options worth knowing:**

- `actions`: browser steps to run before extraction, in order. Supports `click`, `type`, `check`, `uncheck`, `wait`, `scroll`, and `forEach` (loop over every matching element, optionally with pagination). Use this to dismiss cookie banners, run a search, or expand hidden content before the scrape happens.
- `cookies`: a raw Cookie header string for pages behind a login, for example `"session=abc123; token=xyz"`.
- `useProxy` and `proxyCountry`: route through a residential proxy, optionally pinned to a country like `"us"` or `"de"`. Use for geo-restricted content or sites that block datacenter traffic.
- `screenshot`: capture a viewport screenshot. The result includes a URL to the image.
- `extractContentOnly`: strip navigation, ads, and boilerplate before the AI sees the page.
- `scrapeMode`: `"fast"` uses plain HTTP with no browser. Cheaper and quicker, but it cannot run actions or render JavaScript-heavy pages. The default mode uses a real browser.

**Returns:** the extracted `content`, the per-page raw data in `pages`, any `screenshots`, and `stats` with token counts and timing. If the wait window is ever exceeded, the job keeps running on the server and the error message hands the assistant the job ID to check with `spidra_check_scrape_status`. Nothing is lost.

### 2. Check scrape status (`spidra_check_scrape_status`)

Looks up a scrape job by ID. You only need this in one situation: a scrape took longer than the wait window (very slow or heavily protected sites). The timeout error includes the job ID, and the assistant uses this tool to fetch the result once the job finishes.

```json
{
  "name": "spidra_check_scrape_status",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** the job status (`waiting`, `active`, `completed`, or `failed`) and the full result when completed.

### 3. Batch scrape (`spidra_batch_scrape`)

Submits 2 to 50 URLs that are all processed in parallel with the same prompt or schema. Each URL is handled **independently and gets its own result**. This is the opposite of multi-URL scrape, which merges everything into one answer.

This tool returns immediately with a `batchId`. It does not wait, because a 50-URL batch can take several minutes. The assistant then polls `spidra_check_batch_status` every 10 to 15 seconds until the batch reaches a terminal state. The tool's own response tells the assistant to do exactly that, so you do not have to manage any of it.

**Best for:**

- Running the same extraction on each of many similar pages: product pages, listings, articles, profiles
- Any case where you need a separate row of data per URL, even with only 2 URLs

**Not recommended for:**

- One combined answer across pages (use `spidra_scrape`)
- Pages you have not discovered yet (use `spidra_crawl`)

**Common mistakes:**

- Resubmitting the batch because results did not come back instantly. The batch is running; poll the status instead.

**Prompt example:**

> "Here are 15 product URLs. Extract the name, price, and star rating from each one."

**Usage example:**

```json
{
  "name": "spidra_batch_scrape",
  "arguments": {
    "urls": [
      "https://shop.example.com/product/1",
      "https://shop.example.com/product/2",
      "https://shop.example.com/product/3"
    ],
    "prompt": "Extract the product name, price, and star rating",
    "output": "json",
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "price": { "type": "string" },
        "rating": { "type": "number" }
      }
    }
  }
}
```

**Returns:** `{ "batchId": "...", "total": 3 }` plus instructions for the assistant to poll. URLs here are plain strings, not objects.

### 4. Check batch status (`spidra_check_batch_status`)

Fetches the current state of a batch: overall status, progress counters, and per-URL results for every item that has finished so far.

```json
{
  "name": "spidra_check_batch_status",
  "arguments": {
    "batchId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** batch status (`pending`, `running`, `completed`, `failed`, or `cancelled`), `completedCount`, `failedCount`, and an `items` array where each entry carries its URL, status, extraction result, credits used, and timestamps.

One thing to know: a `completed` batch can still contain individual failed items. Check `failedCount`. Failed items can be retried without re-running the whole batch through the Spidra API or SDKs, which have a batch retry endpoint.

### 5. Cancel batch (`spidra_cancel_batch`)

Cancels a pending or running batch. Items that already finished keep their results, and credits for unprocessed items are refunded automatically.

```json
{
  "name": "spidra_cancel_batch",
  "arguments": {
    "batchId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** the number of cancelled items and the credits refunded.

### 6. Crawl (`spidra_crawl`)

Crawls a website starting from one URL. Spidra discovers pages by following links according to a plain-English instruction you provide, and optionally extracts structured data from every page it visits. This is the tool for "get me something from every page in this section of a site" when you do not have the page URLs.

Like batch, this returns immediately with a `jobId` and the assistant polls `spidra_check_crawl_status` until it finishes.

Two instructions control a crawl, and keeping them straight matters:

- `crawlInstruction` controls **which links get followed**. For example, "Follow blog post links only, skip tag and category pages."
- `transformInstruction` controls **what gets extracted from each page**. For example, "Extract the title, author, and publish date." If you leave it out (and pass no schema), each page comes back as raw markdown and no AI tokens are charged at all.

**Best for:**

- Docs sites, blogs, product catalogs, or any section of a site where you want data from many pages you have not listed out
- Building a structured dataset from a whole site section in one request

**Not recommended for:**

- URLs you already know (scrape or batch scrape are faster and cheaper)
- A single page (use `spidra_scrape`)

**Common mistakes:**

- Setting `maxPages` higher than needed. Every crawled page costs credits. Start small; you can always crawl again.
- Putting extraction wording into `crawlInstruction`. Link-following and extraction are separate instructions.

**Prompt example:**

> "Crawl example.com/blog, follow only the article links, and get me each post's title, author, and date. Cap it at 10 pages."

**Usage example:**

```json
{
  "name": "spidra_crawl",
  "arguments": {
    "baseUrl": "https://example.com/blog",
    "crawlInstruction": "Follow blog post links only, skip tag and category pages",
    "transformInstruction": "Extract the title, author, and publish date",
    "maxPages": 10
  }
}
```

**Scoping options:** `maxPages` (default 5, maximum 50), `maxDepth` (0 means the base URL only), `includePaths` and `excludePaths` (path patterns like `"/blog/*"`), `allowSubdomains`, `crawlEntireDomain`, and `ignoreQueryParams` (treat URLs that differ only by query string as the same page). `cookies`, `useProxy`, and `proxyCountry` work the same as in scrape.

**Returns:** `{ "jobId": "..." }` plus polling instructions for the assistant.

### 7. Check crawl status (`spidra_check_crawl_status`)

Fetches a crawl's progress while it runs, and its full results once it completes.

```json
{
  "name": "spidra_check_crawl_status",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** while running, the status and a progress object with `pagesCrawled` out of `maxPages`. When completed, an array with every crawled page's URL, title, and extracted data. Terminal statuses are `completed`, `failed`, and `cancelled`.

### 8. Crawl pages (`spidra_crawl_pages`)

Fetches per-page results for a crawl, including signed download URLs for each page's raw HTML and markdown. Useful when you want the original page content rather than only the extracted data. The download links expire after 1 hour, so use them promptly.

This also works on cancelled crawls, returning whatever pages finished before the cancellation.

```json
{
  "name": "spidra_crawl_pages",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** an array of pages, each with its URL, status, extracted data, and signed `html` and `markdown` download URLs.

### 9. Re-extract from a crawl (`spidra_crawl_extract`)

Runs a brand new extraction instruction over a crawl that already completed, without fetching any pages again. Spidra kept the page content, so only AI token credits are charged, no per-page scraping cost. This is the cheap way to ask a second question of the same site.

For example: you crawled a competitor's blog extracting titles and dates. Now you want the key topics of each post too. Re-extract instead of re-crawling.

```json
{
  "name": "spidra_crawl_extract",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "transformInstruction": "List the main topics each post covers and its target audience"
  }
}
```

**Returns:** a new `jobId`. The assistant polls `spidra_check_crawl_status` with it, same as a normal crawl. The source crawl must have status `completed`.

### 10. Cancel crawl (`spidra_cancel_crawl`)

Cancels a queued or running crawl. Pages that were already processed are kept and remain retrievable through `spidra_crawl_pages`, and credits for unprocessed pages are refunded.

```json
{
  "name": "spidra_cancel_crawl",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** confirmation with the cancelled job's ID.

### 11. Scrape logs (`spidra_scrape_logs`)

Browses past scrape jobs on the account: what ran, when, whether it succeeded, and how many credits it used. Pass a `uuid` to fetch one log entry with its complete AI output. Useful for finding the result of an earlier job, debugging a failure, or reviewing what a key has been used for.

```json
{
  "name": "spidra_scrape_logs",
  "arguments": {
    "status": "failed",
    "searchTerm": "amazon.com",
    "limit": 10
  }
}
```

**Returns:** a list of log entries with URLs, status, credits, tokens, and timing. With a `uuid`, the single entry including its full extraction result.

### 12. Usage (`spidra_usage`)

Reports the account's request, credit, and token usage broken down by day or week. Ask the assistant "how many credits have I used this week?" and this is the tool it reaches for. Also handy before kicking off a large batch or crawl.

```json
{
  "name": "spidra_usage",
  "arguments": {
    "range": "7d"
  }
}
```

**Returns:** rows of usage data. Accepted ranges are `"7d"`, `"30d"`, and `"weekly"`.

## Credits and how this server protects them

Every scraped URL costs credits: a base of 2 credits per URL, plus AI tokens when extraction runs, plus 10 credits per CAPTCHA solved. Agent loops can burn through credits quickly if the tools let them, so this server is deliberately built to prevent that:

- The tool descriptions steer the assistant toward the cheapest tool that answers the question, and tell it to keep `maxPages` small.
- Long-running jobs return a job ID with explicit polling instructions, so the assistant never resubmits a job that is still running.
- Timeout errors say, in effect, "this job is still running, poll it, do not retry." Duplicate submissions are also deduplicated server-side within a short window.
- Rate limit errors tell the assistant exactly how many seconds to wait. Validation errors list exactly what to fix and say not to retry unchanged. Permanent errors say not to retry at all. This prevents the expensive retry loops agents are prone to.
- Cancelling unfinished work refunds the unprocessed portion, and the cancel tools say so in their descriptions.

## Output size

Large pages and big crawls can produce more text than fits in a model's context window. The server truncates individual strings above 5,000 characters and caps any single tool response at 80,000 characters, marking every truncation clearly. If the assistant needs the complete raw content of crawled pages, `spidra_crawl_pages` provides download links to the full files.

## Error handling

Errors come back as readable messages, not stack traces, and each one carries guidance the assistant can act on:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Rate limited (TOO_MANY_PENDING_JOBS): You have too many jobs queued. Wait 30 seconds before retrying."
    }
  ],
  "isError": true
}
```

Transient network failures and 5xx responses are retried automatically with backoff before you ever see an error, courtesy of the underlying [Spidra Node SDK](https://www.npmjs.com/package/spidra).

## Troubleshooting

- **The assistant does not see any Spidra tools.** Restart your client after adding the config. Most clients only read MCP configuration at startup. In Claude Code, run `/mcp` to check the connection status.
- **"No Spidra API key configured."** The `SPIDRA_API_KEY` variable is not reaching the server. Make sure it is inside the `env` block of the server entry, not at the top level of the config file, and that the key still exists under **Settings** > **API Keys** in your dashboard.
- **A scrape "timed out."** The job is still running on the server and nothing is lost. The error includes the job ID, and the assistant will fetch the result with `spidra_check_scrape_status`. Bot-protected sites can take a couple of minutes.
- **Results come back empty when using a schema.** Check the schema: every field you want must be defined with a type. An object with no properties gives the AI nothing to fill in.
- **`npx` cannot find the package.** Make sure you are on Node 20 or newer and that your network allows access to the npm registry.

## Development

```bash
git clone https://github.com/spidra-io/spidra-mcp-server.git
cd spidra-mcp-server
npm install
npm run build       # bundles to dist/index.js
npm test            # black-box smoke tests: spawns the built binary against a fake API
npm run typecheck
```

To run your local build against a local Spidra API, set `SPIDRA_API_URL=http://localhost:4321/api`.

Contributions are welcome. Fork the repository, create a feature branch, make sure `npm test` passes, and open a pull request.

## License

MIT
