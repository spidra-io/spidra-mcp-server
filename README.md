<div align="center">
  <a name="readme-top"></a>
  <img
    src="https://raw.githubusercontent.com/spidra-io/spidra-mcp-server/main/img/logo.png"
    height="172"
  >
</div>

# Spidra MCP Server

The official [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Spidra](https://spidra.io).

MCP is the standard that lets AI assistants use external tools. When you connect this server to an assistant like Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, or Antigravity, the assistant can search the web, read pages, crawl sites, parse documents, run ready-made templates and watch pages for changes, on its own.

All you have to do is describe what you want in plain language, and the assistant picks the right Spidra tool, runs it, and works with the extracted data directly in the conversation.

## Features

- Search the web, news, images, videos, research papers and GitHub, and read each result's page in the same call
- Read any page as Markdown, or get exactly the fields you describe as JSON, with a prompt or a JSON schema
- Links from popular sites (Amazon, Google Maps, LinkedIn, YouTube, Zillow, Indeed and more) come back with their data already in named fields
- Read 2 to 50 URLs at once, each with its own result
- List a site's URLs in seconds, or crawl it for every page of one kind
- Parse PDF, Word, Excel and PowerPoint files, by link or as a file
- Run ready-made templates: Google Maps leads with emails, Amazon keyword rank, LinkedIn and Indeed jobs, Google Flights prices and more than 90 others
- Save jobs as presets, and watch templates, presets or pages with monitors that alert by email, webhook, Slack or Discord
- Browser actions before reading a page: click, type, select, scroll to the end, run JavaScript, loop over a list
- Stealth Mode through residential proxies for sites that block automated visits or vary by country
- Hosted at `mcp.spidra.io` with OAuth or an API key, or run it locally over stdio
- Built to protect your credits: the narrowest tool first, no hidden second runs, and errors that say whether to retry

## Before you start

You need two things:

1. **A Spidra account.** Sign up at [app.spidra.io](https://app.spidra.io). Using the API-key method below instead of OAuth? Create one under **API Keys**, keys start with `spd_`.
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

> Logging in via OAuth automatically creates (and reuses) a dedicated API key labeled **MCP (OAuth)** on your account, visible and revocable anytime under **API Keys**, exactly like any other key.

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

Once connected, ask for web data in normal language. You never call the tools by name; the assistant does that. Some things to try:

> "Search for the best espresso machines and summarize the top 3."

> "Get me 20 dentists in Ikeja, Lagos from Google Maps with their phone numbers and websites."

> "Compare the pricing pages of stripe.com and paddle.com and tell me which is cheaper for a small SaaS."

> "Here are 12 product URLs. Get me the name, price and rating for each one as a table."

> "Read pages 1 to 3 of https://arxiv.org/pdf/1706.03762 and summarize the method."

> "Watch this Amazon product every day and tell me when the price drops."

If the assistant answers with real data, everything is working.

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

The same guidance is built into the tool descriptions, so the assistant follows it on its own.

- **You don't know the URL:** `spidra_search`. You know the site but not the page: `spidra_map`, then read the pages you need.
- **One URL:** `spidra_scrape`. **Two or more, even to compare two:** `spidra_batch_scrape`, so each gets its own result.
- **Many pages of one kind on a site, URLs unknown:** `spidra_crawl`.
- **A document, not a web page:** `spidra_parse`.
- **A common job on a well-known site:** `spidra_find_templates`, then `spidra_run_template`. Usually cheaper and more complete than building it from scrapes.
- **Something to keep an eye on:** `spidra_create_monitor`.

Tools that don't wait to the end return an id. The assistant checks it with `spidra_get_job` instead of starting the job again.

### All tools

| Group | Tool | What it does | Waits? |
|---|---|---|---|
| Find | `spidra_search` | Web, news, images, videos, research papers, GitHub | Yes |
| | `spidra_map` | A site's URLs, optionally ranked by a search | Yes |
| Read pages | `spidra_scrape` | One URL as Markdown or JSON, with optional browser actions | Yes |
| | `spidra_batch_scrape` | 2 to 50 URLs, one result each | With `wait` and up to 10 URLs |
| | `spidra_crawl` | Every page of one kind on a site | No, returns a `jobId` |
| | `spidra_crawl_pages` | A crawl's pages, paged, with file links | Yes |
| | `spidra_crawl_report` | Why a crawl skipped pages | Yes |
| | `spidra_crawl_extract` | New extraction over a finished crawl, without re-crawling | No, returns a `jobId` |
| | `spidra_retry_crawl_page` | Redo one crawled page's extraction | Yes |
| Documents | `spidra_parse` | One or many documents to Markdown or JSON, or the cost with `dryRun` | Up to about 50 seconds |
| Ready-made | `spidra_find_templates` | Search the templates | Yes |
| | `spidra_get_template` | A template's inputs, columns and limits | Yes |
| | `spidra_run_template` | Run one, or price it with `estimate` | Up to about 45 seconds |
| | `spidra_list_presets` | Saved presets, or one in full | Yes |
| | `spidra_save_preset` | Save or change a preset | Yes |
| | `spidra_run_preset` | Run a preset, with optional overrides | Depends on the job |
| | `spidra_delete_preset` | Delete a preset | Yes |
| Monitors | `spidra_create_monitor` | Create, price with `estimate`, or send a test alert | Yes |
| | `spidra_list_monitors` | All monitors, or one in full | Yes |
| | `spidra_update_monitor` | Change, pause or resume | Yes |
| | `spidra_delete_monitor` | Delete a monitor and its history | Yes |
| | `spidra_check_monitor` | Run a check now | No, runs in the background |
| | `spidra_monitor_changes` | What each check found | Yes |
| Jobs | `spidra_get_job` | Status and result of any scrape, search, batch, crawl, parse or template run | Yes |
| | `spidra_cancel_job` | Cancel a batch, crawl or search | Yes |
| | `spidra_retry_batch` | Re-run a batch's failed URLs | Yes |
| Account | `spidra_account` | Credits left, plan, bandwidth, monitor limits, usage | Yes |
| | `spidra_logs` | Past runs of any tool, or one in full | Yes |

Every API capability is covered except three that don't suit an assistant: downloading a crawl as a ZIP file, uploading files over 10 MB (the assistant can pass a link instead), and deleting a stored document early (they're deleted after 24 hours anyway).

### Output format

When you need specific fields, ask for JSON and describe them, or give a JSON schema. The assistant gets a small, focused answer instead of a whole page, which is faster and cheaper. Define every field in a schema: an object with no properties comes back empty.

Template rows come back with just the template's table columns by default (name, phone, website and so on). Ask for full detail when you need every field; a Google Maps place has about 50.

## Credits and how this server protects them

Pages cost 1 credit each, plus AI credits when extraction runs, plus 5 credits per CAPTCHA solved. Search costs 1 credit per 10 results per source. Templates, presets and monitor checks cost what the job behind them costs. Failed pages and failed jobs cost nothing. Agent loops can burn credits quickly, so this server is built to prevent that:

- Tool descriptions steer the assistant to the narrowest tool and small limits, and `spidra_account` lets it check the balance before a big job.
- Templates, monitors and parse can be priced first, for free (`estimate` and `dryRun`).
- `spidra_scrape` runs once. If a page comes back nearly empty, the result says so and suggests Stealth Mode, rather than quietly paying for a second run.
- Jobs that don't finish in the call return an id with instructions to check it, never to start again. Duplicate submissions within a few seconds are also merged on the server.
- Errors say what to do: wait this long (rate limits), fix these fields (validation), or don't retry (out of credits, overdue payment, a plan limit).
- Cancelling returns the credits held for work that hadn't started.

## Output size

Tool results are capped so they fit in the assistant's context: any one string at 20,000 characters and a whole result at 80,000 (about 20,000 tokens). Every cut says how to get the rest. Big lists page with `offset` and `limit`, template rows come back trimmed to their columns, and crawl results leave out per-page file links, which `spidra_crawl_pages` provides. Results also come back as `structuredContent` for clients that read fields directly.

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

## What changed in 0.7.0

- **New:** templates, presets and monitors (`spidra_find_templates`, `spidra_get_template`, `spidra_run_template`, the preset tools and the monitor tools), `spidra_account` for the credit balance, and `spidra_logs` for every tool's history.
- **One tool for job status:** `spidra_get_job` replaces `spidra_check_scrape_status`, `spidra_check_search_status`, `spidra_check_batch_status`, `spidra_check_parse_status` and `spidra_check_crawl_status`. `spidra_cancel_job` replaces `spidra_cancel_batch` and `spidra_cancel_crawl`. `spidra_account` replaces `spidra_usage`, and `spidra_logs` replaces `spidra_scrape_logs`. If you allow-list tools by name in your client, update the list.
- **`spidra_scrape` no longer runs a page twice.** It used to retry a thin page in a browser with a proxy, which cost twice. Now it runs once and tells the assistant when Stealth Mode might help.
- **`spidra_parse`** takes several documents at once and prices them with `dryRun`.
- Results include `structuredContent`, error messages are clearer (out of credits, plan limits, validation errors by field), and a failed-scrape filter in the logs works again.

## Troubleshooting

- **The assistant does not see any Spidra tools.** Restart your client after adding the config. Most clients only read MCP configuration at startup. In Claude Code, run `/mcp` to check the connection status.
- **"No Spidra API key configured."** For local/stdio setups, the `SPIDRA_API_KEY` variable is not reaching the server, make sure it is inside the `env` block of the server entry, not at the top level of the config file. For the hosted endpoint, check your header name and value (below).
- **Hosted endpoint returns a 401.** The header is missing, misnamed, or the key has been revoked. It must be exactly `Authorization: Bearer spd_...`, and the key must still exist under **API Keys** in your dashboard.
- **OAuth login doesn't open a browser, or the client falls back to asking for a key.** Not every MCP client supports OAuth yet, use the API key method for that client instead. If a browser window did open but the flow failed partway through, retry; if it keeps failing, confirm you're logged into [app.spidra.io](https://app.spidra.io) in that browser.
- **OAuth login fails with "Invalid or expired transaction" or similar, then the assistant reports no credentials found.** The login attempt was interrupted before it finished, usually from taking too long on the approve screen (the flow expires after 10 minutes) or retrying a stale login link. Remove and re-add the connector to start clean, and approve access promptly. Falls back to the API key method for that client if it keeps happening.
- **A scrape "timed out."** The job is still running on the server and nothing is lost. The error includes the job ID, and the assistant fetches the result with `spidra_get_job`. Bot-protected sites can take a couple of minutes.
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
