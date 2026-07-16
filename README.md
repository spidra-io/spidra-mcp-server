# Spidra MCP Server

The official [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for [Spidra](https://spidra.io) — give your AI assistant the ability to scrape pages, batch-process URLs, and crawl entire websites with AI-powered extraction.

## Quick start

Get your API key at [app.spidra.io](https://app.spidra.io) under **Settings** > **API Keys**.

### Claude Code

```bash
claude mcp add spidra -e SPIDRA_API_KEY=spd_YOUR_API_KEY -- npx -y spidra-mcp
```

### Cursor / Windsurf / Claude Desktop

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

### VS Code

```json
{
  "mcp": {
    "servers": {
      "spidra": {
        "command": "npx",
        "args": ["-y", "spidra-mcp"],
        "env": { "SPIDRA_API_KEY": "spd_YOUR_API_KEY" }
      }
    }
  }
}
```

## Tools

Pick by what you want back:

| You want | Use | Waits? |
|---|---|---|
| One combined answer from 1–3 known URLs (multi-URL content is merged; the AI answers once — good for comparing pages) | `spidra_scrape` | Yes — returns extracted content directly |
| Separate results per URL, 2–50 known URLs (each processed independently) | `spidra_batch_scrape` | No — poll `spidra_check_batch_status` |
| Data from pages you don't know yet, starting from one URL | `spidra_crawl` | No — poll `spidra_check_crawl_status` |

Full list:

| Tool | Purpose |
|---|---|
| `spidra_scrape` | Scrape 1–3 URLs with AI extraction, browser actions, proxies, cookies, screenshots. Waits for the result. |
| `spidra_check_scrape_status` | Check a scrape job if the wait window was exceeded. |
| `spidra_batch_scrape` | Submit up to 50 URLs with one prompt/schema. Returns a `batchId` immediately. |
| `spidra_check_batch_status` | Per-URL statuses and results for a batch. |
| `spidra_cancel_batch` | Cancel a batch; credits for unprocessed items are refunded. |
| `spidra_crawl` | Discover and process pages from a starting URL, guided by plain-language instructions. Returns a `jobId` immediately. |
| `spidra_check_crawl_status` | Crawl progress, and the extracted data once completed. |
| `spidra_crawl_pages` | Per-page results with signed HTML/markdown download URLs. |
| `spidra_crawl_extract` | Re-run a new extraction over a completed crawl without re-crawling. |
| `spidra_cancel_crawl` | Cancel a crawl; processed pages are kept. |
| `spidra_scrape_logs` | Browse past jobs and their outputs. |
| `spidra_usage` | Credit/request/token usage for the account. |

## Configuration

| Env var | Required | Description |
|---|---|---|
| `SPIDRA_API_KEY` | yes | Your Spidra API key (`spd_...`) |
| `SPIDRA_API_URL` | no | Override the API base URL (self-hosted / staging) |
| `HTTP_STREAMABLE_SERVER` | no | `true` to serve HTTP streamable transport at `http://localhost:3000/mcp` instead of stdio |
| `PORT` / `HOST` | no | HTTP transport bind address (default `3000` / `localhost`) |

On the HTTP transport, the API key can also be sent per-request via `X-Spidra-API-Key` or `Authorization: Bearer` headers.

## Credits

Every scraped URL costs credits (base 2 per URL, plus AI tokens; CAPTCHA solves cost 10). The tool descriptions steer the model toward the cheapest tool that answers the question, and cancelling unfinished work refunds unprocessed items.

## Development

```bash
npm install
npm run build     # bundles to dist/index.js
npm test          # black-box smoke tests: spawns the built binary against a fake API
npm run typecheck
```

## License

MIT
