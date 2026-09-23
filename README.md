<div align="center">
  <a name="readme-top"></a>
  <img
    src="https://raw.githubusercontent.com/spidra-io/spidra-mcp-server/main/img/logo.png"
    height="172"
  >
</div>

# Spidra MCP Server

The official [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Spidra](https://spidra.io).

MCP is the standard that lets AI assistants use external tools. When you connect this server to an assistant like Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, or Antigravity, the assistant gains the ability to search the web, scrape pages, process lists of URLs, and crawl entire websites on its own. 

All you have to do is describe what you want in plain language, and the assistant picks the right Spidra tool, runs it, and works with the extracted data directly in the conversation.

## Features

- Search the web, news, images, or video, and optionally get each result's full page content in the same call
- Scrape any page and get clean markdown or structured JSON back
- Extract exactly the fields you want using plain-language prompts or JSON schemas
- Process up to 50 URLs in parallel with one request
- Crawl whole sites by describing which links to follow in plain English
- Run browser actions before scraping: click, type, scroll, or loop over elements
- Route through residential proxies for geo-restricted or bot-protected sites
- Hosted Streamable HTTP endpoint at `mcp.spidra.io`, connect with one URL, nothing to install
- OAuth login for OAuth-capable clients, or a plain API key header for everything else
- Also runs locally over stdio, or as your own self-hosted HTTP service
- Built-in guidance that keeps the assistant from wasting your credits
- Automatic retries for flaky network moments, with clear typed errors otherwise

## Before you start

You need two things:

1. **A Spidra account.** Sign up at [app.spidra.io](https://app.spidra.io). Using the API-key method below instead of OAuth? Create one under **Settings** > **API Keys**, keys start with `spd_`.
2. **An MCP-compatible client.** Any of the assistants below works.

That's it if you use the hosted endpoint below. Running the server yourself additionally needs **Node.js 20 or newer** (check with `node --version`), the `npx` command that runs it ships with Node.

## Hosted (no install)

All you have to do is point your client at `https://mcp.spidra.io/mcp`.

> Every request against the hosted endpoint is billed to your account exactly like a direct API call.

### OAuth (recommended)

Log in with your Spidra account in the browser.

```bash
claude mcp add --transport http spidra https://mcp.spidra.io/mcp
```

Start a new Claude Code session and run `/mcp`. It opens a browser to log in and approve access, then shows the connection as active.

> Logging in via OAuth automatically creates (and reuses) a dedicated API key labeled **MCP (OAuth)** on your account, visible and revocable anytime under **Settings** > **API Keys**, exactly like any other key.

### API key (alternative)

Prefer a static key for CI, scripting, or a client without OAuth support:

#### Claude Code

```bash
claude mcp add --transport http spidra https://mcp.spidra.io/mcp --header "Authorization: Bearer spd_YOUR_API_KEY"
```

Start a new Claude Code session, then run `/mcp` to confirm the connection shows as active.

#### Claude Desktop

Open **Settings** > **Developer** > **Edit Config**, and add the `spidra` entry inside `mcpServers`:

```json
{
  "mcpServers": {
    "spidra": {
      "type": "http",
      "url": "https://mcp.spidra.io/mcp",
      "headers": {
        "Authorization": "Bearer spd_YOUR_API_KEY"
      }
    }
  }
}
```

Quit and reopen Claude Desktop afterward.

#### Cursor

1. Open Cursor Settings
2. Go to **Features** > **MCP Servers**
3. Click **+ Add new global MCP server**
4. Paste the following and replace the placeholder key:

```json
{
  "mcpServers": {
    "spidra": {
      "type": "http",
      "url": "https://mcp.spidra.io/mcp",
      "headers": {
        "Authorization": "Bearer spd_YOUR_API_KEY"
      }
    }
  }
}
```

You can also put this in a `.cursor/mcp.json` file inside a single project if you only want Spidra available there.

#### VS Code

Press `Ctrl + Shift + P` (or `Cmd + Shift + P` on Mac), type `Preferences: Open User Settings (JSON)`, and add:

```json
{
  "mcp": {
    "servers": {
      "spidra": {
        "type": "http",
        "url": "https://mcp.spidra.io/mcp",
        "headers": {
          "Authorization": "Bearer spd_YOUR_API_KEY"
        }
      }
    }
  }
}
```

In a `.vscode/mcp.json` workspace file, drop the outer `"mcp"` wrapper. The root key there is `servers` directly, not `mcpServers`.

#### Windsurf

Add this to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "spidra": {
      "type": "http",
      "url": "https://mcp.spidra.io/mcp",
      "headers": {
        "Authorization": "Bearer spd_YOUR_API_KEY"
      }
    }
  }
}
```

#### Antigravity

Add this to `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace-local). Note the field is `serverUrl`, not `url`/`httpUrl`, Antigravity rejects those field names for remote servers:

```json
{
  "mcpServers": {
    "spidra": {
      "serverUrl": "https://mcp.spidra.io/mcp",
      "headers": {
        "Authorization": "Bearer spd_YOUR_API_KEY"
      }
    }
  }
}
```

## Local installation (stdio)

Prefer to run the server yourself? Every setup below does the same thing: it tells your assistant to run `npx -y spidra-mcp` and hands the server your API key through an environment variable. 

This is also the option to use if you're calling a staging or self-hosted Spidra API instead of the public one, see [Configuration](#configuration).

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

### Antigravity

Add this to `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace-local):

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

Then connect to `http://localhost:3000/mcp`. On this transport the API key can also be sent per request using an `Authorization: Bearer` header, which is useful when one server instance serves more than one user.

This is exactly how the hosted `https://mcp.spidra.io/mcp` endpoint runs in production: one shared instance, keyed per request, so you don't need to set `SPIDRA_API_KEY` at all when using the hosted URL.

## Try it

Once connected, just ask for web data in normal language. You never call the tools by name; the assistant does that for you. Some things to try:

> "Search for the best espresso machines of 2026 and summarize the top 3."

> "Scrape https://news.ycombinator.com and give me the top 5 stories with their points."

> "Compare the pricing pages of stripe.com and paddle.com and tell me which is cheaper for a small SaaS."

> "Here are 12 product URLs. Get me the name, price, and rating for each one as a table."

> "Crawl the first 10 pages of docs.spidra.io and summarize what the product does."

If the assistant answers with real data from those pages, everything is working.

## Configuration

These apply to the local/self-hosted server (npx, manual install, or your own HTTP instance). The hosted endpoint at `mcp.spidra.io` needs none of them, just your API key in a header.

| Variable | Required | Description |
|---|---|---|
| `SPIDRA_API_KEY` | Yes | Your Spidra API key, starting with `spd_` |
| `SPIDRA_API_URL` | No | Override the API base URL, for staging or self-hosted setups |
| `HTTP_STREAMABLE_SERVER` | No | Set to `true` to serve HTTP at `http://localhost:3000/mcp` instead of stdio |
| `PORT` / `HOST` | No | Bind address for the HTTP transport. Defaults are `3000` and `localhost` |

On the HTTP transport (self-hosted or hosted), the API key can also be sent per request via an `Authorization: Bearer` header, which is useful when one server instance serves more than one user. If a request carries both a header key and a logged-in OAuth session, the header key wins.

## How to choose a tool

This section is written for humans, but the same guidance is embedded in the tool descriptions, so the assistant follows it on its own.

The first question is whether you already know the URL:

- **You don't know the URL yet:** use **search**. It finds pages, news, images, or videos for a query, and can optionally fetch each web result's actual page content in the same call.
- **You know the URL (or 2 to 3 related URLs) and want one answer:** use **scrape**. When you pass several URLs, their content is merged and the AI answers once across all of them. That makes it the right tool for comparing two pricing pages or summarizing three related articles into one answer.
- **You want separate data for each URL in a list:** use **batch scrape**, even if the list only has 2 items. Every URL is processed independently and returns its own result. This is the tool for "extract the same fields from each of these product pages."
- **You don't know the page URLs at all, just a starting point:** use **crawl**. You give it one starting URL and a plain-English instruction about which links to follow, and it discovers the pages itself.

### Quick reference

| Tool | Best for | Waits or polls? |
|---|---|---|
| `spidra_search` | Finding pages, news, images, or videos for a query | Waits, returns the result directly |
| `spidra_check_search_status` | Re-checking a search that outlived its wait window (rare) | Instant lookup |
| `spidra_scrape` | One combined answer from 1 to 3 known URLs | Waits, returns the result directly |
| `spidra_check_scrape_status` | Re-checking a scrape that outlived its wait window | Instant lookup |
| `spidra_batch_scrape` | Separate results for each of 2 to 50 known URLs | Returns a `batchId`, assistant polls |
| `spidra_check_batch_status` | Progress and per-URL results for a batch | Instant lookup |
| `spidra_retry_batch` | Re-running just the failed items in a finished batch | Instant |
| `spidra_cancel_batch` | Stopping a batch you no longer need | Instant |
| `spidra_crawl` | Discovering and processing pages from one starting URL | Returns a `jobId`, assistant polls |
| `spidra_check_crawl_status` | Progress, then full results, for a crawl | Instant lookup |
| `spidra_crawl_pages` | Per-page results with raw HTML and markdown download links | Instant lookup |
| `spidra_crawl_extract` | Asking a new question of an already-completed crawl | Returns a new `jobId` |
| `spidra_retry_crawl_page` | Re-running the AI extraction for one page that failed | Instant |
| `spidra_cancel_crawl` | Stopping a crawl you no longer need | Instant |
| `spidra_scrape_logs` | Looking up past jobs and their outputs | Instant lookup |
| `spidra_usage` | Checking credit and request usage | Instant lookup |

### A note on output format

When you need specific fields from a page, ask for JSON and describe the fields, or provide a JSON schema. The assistant gets back a small, focused payload instead of an entire page, which keeps the conversation fast and cheap. Ask for full markdown only when you genuinely need the whole page, such as summarizing a complete article.

If you use a schema, define every field you want extracted. An untyped object with no properties gives the AI nothing to fill in, so those fields come back empty.

## Available tools

### 1. Search (`spidra_search`)

Runs a real search query and returns structured results: titles, links, descriptions, thumbnails, the same data a search engine itself would show. This tool waits for the result and returns it directly, a plain search usually takes a few seconds.

**Best for:**

- Finding pages when you don't already know the URL
- Checking what's out there before deciding what to scrape
- News, image, or video results, not just web pages

**Not recommended for:**

- A URL you already know, use `spidra_scrape` directly. It's cheaper and gives you AI extraction and schemas that search doesn't.

**Prompt example:**

> "Search for the best espresso machines of 2026 and summarize the top 3."

**Usage example:**

```json
{
  "name": "spidra_search",
  "arguments": {
    "query": "best espresso machine 2026",
    "sources": ["web", "news"],
    "limit": 5
  }
}
```

**Other options worth knowing:**

- `sources`: which result types to fetch, any of `web`, `news`, `images`, `videos` (default: just `web`). Each source runs independently, one coming back empty doesn't affect the others.
- `includeDomains` / `excludeDomains`: restrict web results to, or keep them away from, specific domains. Pass one or the other, never both.
- `scrapeOptions`: opt-in, also fetches each web result's actual page content (clean markdown) in this same call, no separate `spidra_scrape` step needed. This makes the call take as long as its slowest scraped page instead of the usual few seconds, and costs the normal per-page scrape credits on top of the search. A result that fails to scrape is simply left without markdown, not an error.

**Returns:** results grouped by requested source, plus `stats`. If the wait window is exceeded (rare, only realistic with `scrapeOptions` on many results), the job keeps running and the error hands the assistant the job ID to check with `spidra_check_search_status`.

### 2. Check search status (`spidra_check_search_status`)

Looks up a search job by ID. Only needed when `spidra_search` reported that its wait window was exceeded.

```json
{
  "name": "spidra_check_search_status",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** the job status (`waiting`, `active`, `completed`, or `failed`) and the full result when completed.

### 3. Scrape (`spidra_scrape`)

Scrapes 1 to 3 URLs and extracts their content with AI. This tool waits for the result, typically 10 to 60 seconds, and returns the extracted content directly. No polling needed.

The important behavior to understand: when you pass more than one URL, their content is combined and the AI produces **one answer across all of them**, there is no per-URL breakdown. Use multiple URLs here when you want the AI to compare or synthesize across pages. If you want the same extraction run separately on each URL, use `spidra_batch_scrape` instead, even for just 2 URLs.

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

> "Get the product name, price, and description from https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html."

**Usage example (structured extraction with a schema):**

```json
{
  "name": "spidra_scrape",
  "arguments": {
    "urls": ["https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"],
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
    "urls": ["https://stripe.com/pricing", "https://www.paddle.com/pricing"],
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
    "urls": ["https://posthog.com/tutorials/web-redact-properties"]
  }
}
```

**Other options worth knowing:**

- `actions`: browser steps to run before extraction, in order. Supports `click`, `type`, `check`, `uncheck`, `wait`, `scroll`, and `forEach` (loop over every matching element, optionally with pagination). Use this to dismiss cookie banners, fill in a search box, or expand hidden content before the scrape happens.
- `instruction`: AI Navigate mode, a single natural-language instruction handling all the interactions automatically (e.g. "search for wireless headphones and open the first result") instead of listing out `actions` steps by hand. Applies to every URL passed.
- `cookies`: a raw Cookie header string for pages behind a login, for example `"session=abc123; token=xyz"`.
- `useProxy` and `proxyCountry`: route through a residential proxy, optionally pinned to a country like `"us"` or `"de"`. Use for geo-restricted content or sites that block datacenter traffic.
- `screenshot`: capture a viewport screenshot. The result includes a URL to the image.
- `extractContentOnly`: strip navigation, ads, and boilerplate before the AI sees the page.
- `scrapeMode`: `"fast"` uses plain HTTP with no browser. Cheaper and quicker, but it cannot run actions or render JavaScript-heavy pages. The default mode uses a real browser.

**Returns:** the extracted `content`, any `screenshots`, and `stats` with token counts and timing. If the wait window is ever exceeded, the job keeps running on the server and the error message hands the assistant the job ID to check with `spidra_check_scrape_status`. Nothing is lost.

### 4. Check scrape status (`spidra_check_scrape_status`)

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

### 5. Batch scrape (`spidra_batch_scrape`)

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
      "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
      "https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html",
      "https://books.toscrape.com/catalogue/soumission_998/index.html"
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

### 6. Check batch status (`spidra_check_batch_status`)

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

One thing to know: a `completed` batch can still contain individual failed items. Check `failedCount`, then retry just those with `spidra_retry_batch` rather than resubmitting the whole batch.

### 7. Retry batch (`spidra_retry_batch`)

Re-queues only the failed items in a batch, successful items are left alone and not re-run.

```json
{
  "name": "spidra_retry_batch",
  "arguments": {
    "batchId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** the number of items re-queued for another attempt.

### 8. Cancel batch (`spidra_cancel_batch`)

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

### 9. Crawl (`spidra_crawl`)

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

> "Crawl spidra.io/blog, follow only the article links, and get me each post's title, author, and date. Cap it at 10 pages."

**Usage example:**

```json
{
  "name": "spidra_crawl",
  "arguments": {
    "baseUrl": "https://spidra.io/blog",
    "crawlInstruction": "Follow blog post links only, skip tag and category pages",
    "transformInstruction": "Extract the title, author, and publish date",
    "maxPages": 10
  }
}
```

**Scoping options:** `maxPages` (default 5, maximum 50), `maxDepth` (0 means the base URL only), `includePaths` and `excludePaths` (path patterns like `"/blog/*"`), `allowSubdomains`, `crawlEntireDomain`, and `ignoreQueryParams` (treat URLs that differ only by query string as the same page). `cookies`, `useProxy`, and `proxyCountry` work the same as in scrape.

**Returns:** `{ "jobId": "..." }` plus polling instructions for the assistant.

### 10. Check crawl status (`spidra_check_crawl_status`)

Fetches a crawl's progress while it runs, and its full results once it completes.

```json
{
  "name": "spidra_check_crawl_status",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Returns:** while running, the status and a progress message describing what's happening right now (e.g. "Scraping (3/10) https://..."), not a page count, poll again for an updated one. When completed, an array with every crawled page's URL, title, and extracted data. Terminal statuses are `completed`, `failed`, and `cancelled`.

### 11. Crawl pages (`spidra_crawl_pages`)

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

### 12. Re-extract from a crawl (`spidra_crawl_extract`)

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

### 13. Retry one crawled page (`spidra_retry_crawl_page`)

Re-runs the AI transformation for a single already-crawled page, using the crawl's own `transformInstruction`. Use this when just one or two pages failed extraction rather than re-running `spidra_crawl_extract` over the whole crawl. Get the page's `id` from `spidra_crawl_pages`.

```json
{
  "name": "spidra_retry_crawl_page",
  "arguments": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "pageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

**Returns:** the re-extracted `data` for that page, plus tokens and credits used. Only charges for that page's transformation.

### 14. Cancel crawl (`spidra_cancel_crawl`)

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

### 15. Scrape logs (`spidra_scrape_logs`)

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

### 16. Usage (`spidra_usage`)

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

Every scraped URL costs credits: a base of 2 credits per URL, plus AI tokens when extraction runs, plus 10 credits per CAPTCHA solved. A plain search costs a small amount based on how many sources you requested, not how many results came back; turning on `scrapeOptions` bills each fetched result at the normal scrape rate on top of that. Agent loops can burn through credits quickly if the tools let them, so this server is deliberately built to prevent that:

- The tool descriptions steer the assistant toward the cheapest tool that answers the question, and tell it to keep `maxPages` small.
- Long-running jobs return a job ID with explicit polling instructions, so the assistant never resubmits a job that is still running.
- Timeout errors say, in effect, "this job is still running, poll it, do not retry." Duplicate submissions are also deduplicated server-side within a short window.
- Rate limit errors tell the assistant exactly how many seconds to wait. Validation errors list exactly what to fix and say not to retry unchanged. Permanent errors say not to retry at all. This prevents the expensive retry loops agents are prone to.
- Cancelling unfinished work refunds the unprocessed portion, and the cancel tools say so in their descriptions.

## Output size

Large pages and big crawls can produce more text than fits in a model's context window. The server truncates individual strings above 5,000 characters and caps any single tool response at 80,000 characters, and every truncation message tells the assistant what to do about it (ask a narrower question, or reach for a more targeted tool). If the assistant needs the complete raw content of crawled pages, `spidra_crawl_pages` provides download links to the full files.

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
- **"No Spidra API key configured."** For local/stdio setups, the `SPIDRA_API_KEY` variable is not reaching the server, make sure it is inside the `env` block of the server entry, not at the top level of the config file. For the hosted endpoint, check your header name and value (below).
- **Hosted endpoint returns a 401.** The header is missing, misnamed, or the key has been revoked. It must be exactly `Authorization: Bearer spd_...`, and the key must still exist under **Settings** > **API Keys** in your dashboard.
- **OAuth login doesn't open a browser, or the client falls back to asking for a key.** Not every MCP client supports OAuth yet, use the API key method for that client instead. If a browser window did open but the flow failed partway through, retry; if it keeps failing, confirm you're logged into [app.spidra.io](https://app.spidra.io) in that browser.
- **OAuth login fails with "Invalid or expired transaction" or similar, then the assistant reports no credentials found.** The login attempt was interrupted before it finished, usually from taking too long on the approve screen (the flow expires after 10 minutes) or retrying a stale login link. Remove and re-add the connector to start clean, and approve access promptly. Falls back to the API key method for that client if it keeps happening.
- **A scrape "timed out."** The job is still running on the server and nothing is lost. The error includes the job ID, and the assistant will fetch the result with `spidra_check_scrape_status`. Bot-protected sites can take a couple of minutes.
- **Results come back empty when using a schema.** Check the schema: every field you want must be defined with a type. An object with no properties gives the AI nothing to fill in.
- **`npx` cannot find the package.** Make sure you are on Node 20 or newer and that your network allows access to the npm registry. This only applies to local/self-hosted setups, the hosted endpoint doesn't use `npx`.

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
