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

1. **A Spidra account.** Sign up at [app.spidra.io](https://app.spidra.io). If you'll use an API key instead of signing in, create one under **API Keys**. Keys start with `spd_`.
2. **An MCP client.** Any of the ones below works.

That's all for the hosted server. Running Spidra locally also needs **Node.js 20 or newer** (check with `node --version`); `npx` comes with Node.

## Connect your client

There are two ways to connect:

- **Hosted (recommended).** Point your client at `https://mcp.spidra.io/mcp`. There's nothing to install. You sign in with your Spidra account in the browser, or send an API key in a header.
- **Local.** Your client runs `npx -y spidra-mcp` on your machine and passes your API key as an environment variable. This needs Node.js 20 or newer.

Every request is billed to your Spidra account exactly like a direct API call.

### How signing in works

When your client connects, it opens a Spidra page in your browser. The page names the app asking for access (with a blue **Verified** badge and the app's real logo when its identity is verified, for example claude.ai or vscode.dev; an app that only names itself gets **Name not verified** and its initial) and says where you go back to afterwards. Click **Approve**, log in to Spidra if you aren't already, and the browser hands you back to your client. Most clients then refresh access in the background, so you sign in once.

If your client can't sign in this way, or you're setting up CI, use an API key. Create one at [app.spidra.io](https://app.spidra.io) under **API Keys** (keys start with `spd_`) and send it as `Authorization: Bearer spd_...`.

### Claude (claude.ai, Claude Desktop, mobile)

1. Open **Customize** > **Connectors**, click **+**, then **Add custom connector**.
2. Paste `https://mcp.spidra.io/mcp` and click **Add**.
3. Ask Claude something that needs Spidra. Claude shows a **Connect** button the first time; click it and approve.

On Team and Enterprise plans an owner adds the connector under **Organization settings** > **Connectors**, and each member clicks **Connect**. Claude Desktop reads remote servers only from Connectors, not from `claude_desktop_config.json`. To run Spidra locally in Claude Desktop instead, see [Local](#local).

### Claude Code

```bash
claude mcp add --transport http spidra https://mcp.spidra.io/mcp
claude mcp login spidra
```

`claude mcp login` opens the sign-in page and prints `Authenticated with "spidra"` when you're done. You can also run `/mcp` inside a session. With an API key instead:

```bash
claude mcp add --transport http spidra https://mcp.spidra.io/mcp \
  --header "Authorization: Bearer spd_YOUR_API_KEY"
```

Add `-s user` to either command to make Spidra available in every project.

### ChatGPT

1. Go to **Settings** > **Apps** > **Advanced settings** and turn on **Developer mode**.
2. Click **Create app**, name it Spidra, paste `https://mcp.spidra.io/mcp`, choose **OAuth**, and create it.
3. ChatGPT opens the Spidra sign-in page. Approve, and the app is ready in new chats.

### Cursor

[Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=spidra&config=eyJ1cmwiOiJodHRwczovL21jcC5zcGlkcmEuaW8vbWNwIn0=) (opens Cursor), or add this to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "spidra": {
      "url": "https://mcp.spidra.io/mcp"
    }
  }
}
```

Then open **Cursor Settings**, find Spidra in the MCP servers list and click **Needs login**. If Spidra shows as connected but a tool call fails with "Unauthorized", use an API key:

```json
{
  "mcpServers": {
    "spidra": {
      "url": "https://mcp.spidra.io/mcp",
      "headers": {
        "Authorization": "Bearer spd_YOUR_API_KEY"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Run this in a terminal:

```bash
code --add-mcp '{"name":"spidra","type":"http","url":"https://mcp.spidra.io/mcp"}'
```

It adds Spidra to your user `mcp.json`. Start the server from that file (or from the tools picker in Copilot Chat), allow VS Code to sign in to Spidra when it asks, and approve in the browser. For a workspace with an API key, put this in `.vscode/mcp.json`. VS Code asks for the key once and keeps it in its secret storage:

```json
{
  "inputs": [
    { "type": "promptString", "id": "spidra-key", "description": "Spidra API key", "password": true }
  ],
  "servers": {
    "spidra": {
      "type": "http",
      "url": "https://mcp.spidra.io/mcp",
      "headers": { "Authorization": "Bearer ${input:spidra-key}" }
    }
  }
}
```

### Codex (CLI, IDE extension and app)

Add this to `~/.codex/config.toml`, then run `codex mcp login spidra`:

```toml
[mcp_servers.spidra]
url = "https://mcp.spidra.io/mcp"
tool_timeout_sec = 300
```

`tool_timeout_sec` matters: Codex stops a tool call after 60 seconds by default, and a hard page or a batch can take longer. To use an API key instead of signing in, add `bearer_token_env_var = "SPIDRA_API_KEY"` to the same block and export `SPIDRA_API_KEY` in the shell that starts Codex.

### Gemini CLI

```bash
gemini mcp add --transport http spidra https://mcp.spidra.io/mcp
```

Then run `/mcp auth spidra` inside Gemini CLI to sign in. With an API key instead:

```bash
gemini mcp add --transport http -H "Authorization: Bearer spd_YOUR_API_KEY" spidra https://mcp.spidra.io/mcp
```

### Windsurf (Devin Desktop)

Open the MCP settings in Cascade and edit the raw config (`~/.config/devin/mcp_config.json`, or `%APPDATA%\devin\mcp_config.json` on Windows):

```json
{
  "mcpServers": {
    "spidra": {
      "url": "https://mcp.spidra.io/mcp",
      "transport": "http"
    }
  }
}
```

Click **Authenticate** next to Spidra when it shows "Needs authentication". Older Windsurf builds keep this file at `~/.codeium/windsurf/mcp_config.json` and call the field `serverUrl`. For an API key, add `"headers": { "Authorization": "Bearer spd_YOUR_API_KEY" }`.

### Cline

Open **MCP Servers** > **Configure** and add this to `cline_mcp_settings.json`. Leave `"type"` in: without it Cline uses the old SSE transport. Cline gives up on a tool call after 60 seconds unless you raise `timeout`:

```json
{
  "mcpServers": {
    "spidra": {
      "type": "streamableHttp",
      "url": "https://mcp.spidra.io/mcp",
      "headers": { "Authorization": "Bearer spd_YOUR_API_KEY" },
      "timeout": 300
    }
  }
}
```

Use an API key in Cline for now. Its VS Code extension signs in through a callback address Spidra doesn't accept yet.

### Zed

Add this under `context_servers` in Zed's `settings.json`. Zed opens the sign-in page when it connects:

```json
{
  "context_servers": {
    "spidra": {
      "url": "https://mcp.spidra.io/mcp"
    }
  }
}
```

With an API key, add `"headers": { "Authorization": "Bearer spd_YOUR_API_KEY" }`. Zed skips sign-in when a header is set.

### Goose

Run `goose configure`, choose **Add Extension** > **Remote Extension (Streamable HTTP)**, name it `spidra`, paste `https://mcp.spidra.io/mcp`, and set the timeout to 300. Goose opens the sign-in page the first time it connects.

### Antigravity

Add this to `~/.gemini/config/mcp_config.json`, or `.agents/mcp_config.json` for one workspace. The field is `serverUrl`; Antigravity doesn't accept `httpUrl`. `timeoutSeconds` raises its 180-second limit per tool call:

```json
{
  "mcpServers": {
    "spidra": {
      "serverUrl": "https://mcp.spidra.io/mcp",
      "timeoutSeconds": 300
    }
  }
}
```

Antigravity signs in on its own. For an API key, add `"headers": { "Authorization": "Bearer spd_YOUR_API_KEY" }`.

### Any other client

Add a remote **Streamable HTTP** server with the URL `https://mcp.spidra.io/mcp`. If the client supports OAuth for MCP, it finds the sign-in settings itself. Otherwise send `Authorization: Bearer spd_YOUR_API_KEY` (or `X-Spidra-Api-Key: spd_YOUR_API_KEY`). If the client has a tool timeout setting, set it to 300 seconds.

## Local

Every local setup runs `npx -y spidra-mcp` and passes your key in `SPIDRA_API_KEY`. Put the key in the client's `env` block, not in a `.env` file.

**Claude Code:**

```bash
claude mcp add spidra -e SPIDRA_API_KEY=spd_YOUR_API_KEY -- npx -y spidra-mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.spidra]
command = "npx"
args = ["-y", "spidra-mcp"]
env = { SPIDRA_API_KEY = "spd_YOUR_API_KEY" }
tool_timeout_sec = 300
```

**Claude Desktop, Cursor, Windsurf, Antigravity, Cline and most others** take the same JSON under `mcpServers`. In Claude Desktop it goes in **Settings** > **Developer** > **Edit Config**; quit and reopen Claude afterward.

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

**VS Code** uses `servers` instead of `mcpServers`, with `"type": "stdio"`:

```bash
code --add-mcp '{"name":"spidra","type":"stdio","command":"npx","args":["-y","spidra-mcp"],"env":{"SPIDRA_API_KEY":"spd_YOUR_API_KEY"}}'
```

**Gemini CLI** and **Zed** take `command`, `args` and `env` under `mcpServers` (Gemini, in `~/.gemini/settings.json`) or `context_servers` (Zed).

Using a staging or self-hosted Spidra API? See [Configuration](#configuration).

## Self-hosting

### Running over HTTP instead of stdio

By default the server talks to your client over stdio, which is what all the configs above use and what you want on a single machine. If you need an HTTP endpoint instead (for example, a tool that connects to MCP servers over the network), start the server like this:

```bash
env HTTP_STREAMABLE_SERVER=true SPIDRA_API_KEY=spd_YOUR_API_KEY npx -y spidra-mcp
```

Then connect to `http://localhost:3000/mcp`. On this transport the API key can also be sent per request using an `Authorization: Bearer` header, which is useful when one server instance serves more than one user. Bound to `localhost` (the default), the server only answers requests addressed to this machine, which protects it from DNS rebinding.

This is exactly how the hosted `https://mcp.spidra.io/mcp` endpoint runs in production: one stateless instance, keyed per request, so you don't need to set `SPIDRA_API_KEY` at all when using the hosted URL.

If you set `HOST` to anything other than `localhost` and also set `SPIDRA_API_KEY`, anyone who can reach the port can spend that key's credits. On a shared network, leave `SPIDRA_API_KEY` unset so every caller has to send their own key.

### Protocol versions

Both transports serve the current MCP revision, `2026-07-28` (no handshake, version and capabilities sent with every request), and every earlier one from `2024-11-05` to `2025-11-25` (the `initialize` handshake). Clients don't need any setting for this: the server answers each request in the revision the client speaks.

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
| `SPIDRA_API_URL` | No | Override the API base URL, for staging or self-hosted setups. It must be `https://`, or `http://` on localhost, so your key never travels in the clear; the server names the API host on stderr at startup |
| `HTTP_STREAMABLE_SERVER` | No | Set to `true` to serve HTTP at `http://localhost:3000/mcp` instead of stdio |
| `PORT` / `HOST` | No | Bind address for the HTTP transport. Defaults are `3000` and `localhost` |
| `SPIDRA_MCP_DOTENV` | No | Set to `1` to read a `.env` file on stdio. Off by default: clients start the server in your project folder, and a `.env` in a cloned repo could otherwise point `SPIDRA_API_URL` at someone else's server. Over HTTP, `.env` is read as before |

On the HTTP transport (self-hosted or hosted), the API key can also be sent per request via an `Authorization: Bearer` header (or `X-Spidra-Api-Key`), which is useful when one server instance serves more than one user. If a request carries both a header key and a logged-in OAuth session, the header key wins.

OAuth sign-in is only for the hosted endpoint, where Spidra's backend is the identity provider. It turns on when all of these are set:

| Variable | Description |
|---|---|
| `MCP_PUBLIC_URL` | The server's public origin, e.g. `https://mcp.spidra.io`. The OAuth issuer; the protected resource is `<MCP_PUBLIC_URL>/mcp` |
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` | This server's client credentials at the backend's `/api/oauth/*` endpoints |
| `SPIDRA_API_URL` | The backend API, which also hosts the OAuth endpoints |
| `MCP_OAUTH_SIGNING_KEY` | Recommended. Key for the sealed client IDs, codes and tokens. Without it, the key is derived from the client secret, so rotating the secret signs everyone out |
| `MCP_OAUTH_SIGNING_KEYS` | Optional. Several keys, comma-separated, newest first, for a rotation: new tokens use the first, and the rest still open existing ones |
| `MCP_OAUTH_EXTRA_REDIRECT_URIS` | Optional. Comma-separated exact redirect URIs to accept besides loopback addresses and the built-in client callbacks |

With OAuth on, every MCP request without credentials gets a `401` with the sign-in challenge, from the first one, which is when Cursor, VS Code, Claude and ChatGPT start sign-in. The discovery documents and sign-in pages stay open. Nothing about OAuth is kept in memory, so restarts and deploys don't sign anyone out, and a backend hiccup answers `503` (retry) rather than anything that makes a client drop the session.

The HTTP server also limits requests per minute: `MCP_RATE_ANONYMOUS` (60 per IP without credentials), `MCP_RATE_AUTHENTICATED` (600 per caller) and `MCP_RATE_SIGN_IN` (30 per IP on the sign-in pages). On `SIGTERM` it stops taking new requests and lets calls in flight finish, for up to `MCP_DRAIN_MS` (50,000), so set PM2's `kill_timeout` above that.

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

## Prompts

The server also offers ready-made prompts, which appear in your client's prompt menu (for example `/` in Claude Code). Each one asks for a few details, then walks the assistant through the right tools, with a cost check first:

| Prompt | What it does | Arguments |
|---|---|---|
| `find_local_leads` | Businesses of one kind in an area, from Google Maps | `business`, `area`, optional `count`, `contacts` |
| `track_prices` | Reads current prices, then sets up a monitor for changes | `urls`, optional `schedule`, `alertWhen` |
| `research_topic` | Searches, reads the best sources and answers with links | `topic`, optional `sources`, `depth` |
| `crawl_docs` | Turns a docs site, or one section, into Markdown | `url`, optional `section`, `maxPages` |
| `extract_document_table` | Pulls a table out of a PDF, Word, Excel or PowerPoint file | `url`, `table`, optional `pages` |
| `use_template` | Finds and runs the ready-made template for a common job | `task` |
| `watch_page` | Alerts when a page changes | `url`, optional `what`, `schedule` |

## Credits and how this server protects them

Pages cost 1 credit each, plus AI credits when extraction runs, plus 5 credits per CAPTCHA solved. Search costs 1 credit per 10 results per source. Templates, presets and monitor checks cost what the job behind them costs. Failed pages and failed jobs cost nothing. Agent loops can burn credits quickly, so this server is built to prevent that:

- Tool descriptions steer the assistant to the narrowest tool and small limits, and `spidra_account` lets it check the balance before a big job.
- Templates, monitors and parse can be priced first, for free (`estimate` and `dryRun`).
- `spidra_scrape` runs once. If a page comes back nearly empty, the result says so and suggests Stealth Mode, rather than quietly paying for a second run.
- Jobs that don't finish in the call return an id with instructions to check it, never to start again. Duplicate submissions within a few seconds are also merged on the server.
- Errors say what to do: wait this long (rate limits), fix these fields (validation), or don't retry (out of credits, overdue payment, a plan limit).
- Cancelling returns the credits held for work that hadn't started.
- Tools that can spend a lot in one call (batch scrape, crawl, parse, run template, run preset) aren't marked read-only, so clients that ask before acting ask first.
- No call waits longer than about 45 seconds. Past that you get the job's id, so a client that gives up at 60 seconds doesn't lead to a second run. While it waits, the server sends progress to clients that ask for it, and a call you cancel stops waiting at once.

## Output size

Tool results are capped so they fit in the assistant's context: a whole result at 80,000 characters (about 20,000 tokens), with long strings cut to 20,000 characters each, or shorter when that's what it takes to fit. Every cut says how to get the rest. Big lists page with `offset` and `limit`, template rows come back trimmed to their columns, and crawl results leave out per-page file links, which `spidra_crawl_pages` provides. Results also come back as `structuredContent` for clients that read fields directly, and every tool except `spidra_logs` publishes an `outputSchema` for it. The schemas are loose (every field optional, extra fields allowed), so a new API field never fails a call. When a result has too many items to fit even with short strings, lists are cut to their first items with a note, and it stays valid JSON.

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

## What changed in 0.8.0

- **The current MCP revision, `2026-07-28`, works.** Clients that speak it (current Claude apps and others) were refused by 0.7.0 with "Unsupported protocol version". The server now runs on the official MCP SDK 2.x and answers both the new revision and every 2025-era one, over stdio and HTTP.
- **OAuth sign-in rebuilt:** it starts on a `401` the way Claude and ChatGPT expect, supports Client ID Metadata Documents (Claude Code, ChatGPT) as well as dynamic registration, sends the RFC 9207 `iss` parameter, requires PKCE with S256, and survives server restarts. Redirect addresses are checked strictly.
- **Security: a `.env` file in your project folder is no longer read on stdio.** Clients start `npx spidra-mcp` in the open project's folder, and in 0.7.0 a `.env` there (one shipped in a cloned repo, say) could set `SPIDRA_API_URL` and send your key to another server. `SPIDRA_API_URL` must now also be `https://`, or `http://` on localhost.
- **Sign-in in Chrome and Safari works,** with a redesigned consent page that shows the app's real logo only when its identity is verified. On the hosted server, sign-in now starts when the client first connects, which Cursor needs.
- **`spidra_get_job` can wait:** pass `waitSeconds` (up to 45) and it answers when the job finishes, instead of the assistant calling it over and over. No call waits longer than about 45 seconds, waits send progress, and cancelling a call stops it.
- **Output schemas and prompts:** every tool except `spidra_logs` publishes an `outputSchema`, and seven prompts guide common jobs (see Prompts).
- Tools that can spend a lot in one call ask for confirmation in clients that honor it. Restarts let calls in flight finish.
- Long-running calls over HTTP stream keepalives, so proxies don't cut them off. Results are compact JSON and stay valid JSON when they're shortened. `spidra_logs` and `spidra_crawl_report` take their filters as fixed values, and the crawl report lists the `outside_start_path` reason.
- Tool names and arguments are otherwise unchanged.

## What changed in 0.7.0

- **New:** templates, presets and monitors (`spidra_find_templates`, `spidra_get_template`, `spidra_run_template`, the preset tools and the monitor tools), `spidra_account` for the credit balance, and `spidra_logs` for every tool's history.
- **One tool for job status:** `spidra_get_job` replaces `spidra_check_scrape_status`, `spidra_check_search_status`, `spidra_check_batch_status`, `spidra_check_parse_status` and `spidra_check_crawl_status`. `spidra_cancel_job` replaces `spidra_cancel_batch` and `spidra_cancel_crawl`. `spidra_account` replaces `spidra_usage`, and `spidra_logs` replaces `spidra_scrape_logs`. If you allow-list tools by name in your client, update the list.
- **`spidra_scrape` no longer runs a page twice.** It used to retry a thin page in a browser with a proxy, which cost twice. Now it runs once and tells the assistant when Stealth Mode might help.
- **`spidra_parse`** takes several documents at once and prices them with `dryRun`.
- Results include `structuredContent`, error messages are clearer (out of credits, plan limits, validation errors by field), and a failed-scrape filter in the logs works again.

## Troubleshooting

- **The assistant does not see any Spidra tools.** Restart your client after adding the config. Most clients only read MCP configuration at startup. In Claude Code, run `/mcp` to check the connection status.
- **"No Spidra API key configured."** For local/stdio setups, the `SPIDRA_API_KEY` variable is not reaching the server, make sure it is inside the `env` block of the server entry, not at the top level of the config file. For the hosted endpoint, check your header name and value (below).
- **Hosted endpoint returns a 401.** Without a key, that's the sign-in prompt: calling a tool starts OAuth in clients that support it, and other clients need a key. With a key, the header is missing or misnamed: it must be exactly `Authorization: Bearer spd_...` (or `X-Spidra-Api-Key: spd_...`). A key that was revoked under **API Keys** fails on the tool call instead, with a message saying so.
- **OAuth login doesn't open a browser, or the client falls back to asking for a key.** Not every MCP client supports OAuth yet, use the API key method for that client instead. If a browser window did open but the flow failed partway through, retry; if it keeps failing, confirm you're logged into [app.spidra.io](https://app.spidra.io) in that browser.
- **OAuth sign-in says "This sign-in has expired" or "can't be confirmed".** The attempt took longer than 10 minutes, or the link was opened in a different browser from the one that started it. Start the connection again from your client and finish it in the same browser.
- **"Unknown client_id" after upgrading.** Clients registered with 0.7.0 have to register again. Most do this on their own when you reconnect; otherwise remove and re-add the connector.
- **A tool call stops after exactly 60 seconds.** That's your client's limit, not Spidra's. Codex and Cline default to 60 seconds; raise it to 300 (`tool_timeout_sec` in Codex, `timeout` in Cline, `timeoutSeconds` in Antigravity). The job keeps running either way, so ask for the result with `spidra_get_job` instead of starting it again.
- **Cursor shows Spidra as connected, but tools fail with "Unauthorized".** Cursor didn't start the sign-in. Use the API key config in the [Cursor](#cursor) section.
- **A scrape "timed out."** The job is still running on the server and nothing is lost. The error includes the job ID, and the assistant fetches the result with `spidra_get_job`. Bot-protected sites can take a couple of minutes.
- **Results come back empty when using a schema.** Check the schema: every field you want must be defined with a type. An object with no properties gives the AI nothing to fill in.
- **`npx` cannot find the package.** Make sure you are on Node 20 or newer and that your network allows access to the npm registry. This only applies to local/self-hosted setups, the hosted endpoint doesn't use `npx`.

## Development

```bash
git clone https://github.com/spidra-io/spidra-mcp-server.git
cd spidra-mcp-server
npm install
npm run build       # bundles to dist/index.js
npm test            # spawns the built server against a fake API: every tool, both protocol eras with the
                    # official SDK 2.x and 1.x clients over stdio and HTTP, and the OAuth flow end to end
npm run typecheck
```

`npm test` also clicks through the OAuth consent page in Chromium, WebKit and Firefox when Playwright's browsers are installed (`npx playwright install chromium webkit firefox`), and saves screenshots to `SPIDRA_CONSENT_SHOTS` (default: a temp folder).

`tests/evals/` runs realistic tasks through a real model (Claude Code headless, with only this server's tools) and scores tool choice, arguments, calls, credits and the answer. It spends real credits and model usage, so point it at a local API and run a few tasks at a time: `npm run build`, then `SPIDRA_EVAL_API_URL=http://localhost:4321/api SPIDRA_EVAL_API_KEY_FILE=<key file> node tests/evals/run.mjs --tasks credits_only,price_one` (`--list` shows the tasks).

To run your local build against a local Spidra API, set `SPIDRA_API_URL=http://localhost:4321/api`.

Contributions are welcome. Fork the repository, create a feature branch, make sure `npm test` passes, and open a pull request.

## License

MIT
