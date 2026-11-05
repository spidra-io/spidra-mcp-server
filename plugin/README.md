# Spidra plugin

Spidra gets data from the web for Claude. Ask in plain words and Claude searches the web, reads the pages you name, crawls a site for the pages you describe, lists a site's URLs, parses PDF, Word, Excel and PowerPoint files, runs ready-made templates for popular sites (leads from a map, product prices and rank, job listings, reviews and more), and sets up monitors that tell you when a page changes. Results come back as Markdown or as JSON in the shape you ask for.

## Install

In Claude Code:

```
/plugin install spidra --marketplace spidra-io/spidra-mcp-server
```

In claude.ai, Claude Desktop and Cowork, add Spidra from the directory once it's listed there.

## What's in it

- **The Spidra MCP server**, at `https://mcp.spidra.io/mcp`. It's the same server as the Spidra connector, so if you have both you see one set of tools.
- **A `web-data` skill** that helps Claude pick the right tool, keep jobs small, use templates first and write code against the Spidra API and SDKs.

There are no hooks, scripts or local programs in this plugin.

## Signing in

The first time Claude uses a Spidra tool, a Spidra page opens in your browser. Sign in or create an account and click **Approve**. You don't need to copy an API key. To disconnect later, open **Connected apps** on the API keys page of the [Spidra dashboard](https://app.spidra.io) and click **Revoke**.

## What it sends and where

- Your requests (search queries, URLs, extraction prompts, file links, template inputs) go to Spidra at `mcp.spidra.io`, which runs them through the Spidra API at `api.spidra.io`.
- Spidra fetches the web pages and files you ask for and returns their content to Claude.
- Each job is saved to your Spidra account's history with its inputs, result and cost, which you can see under Logs in the dashboard.
- Nothing else is sent anywhere, and the plugin reads nothing from your machine.

## Credits

Every tool call uses credits from your Spidra account, the same as the API. Failed pages, blank results and searches that find nothing are free. Claude can check your balance with the account tool before a big job. New accounts get free credits to start; see [plans and credits](https://docs.spidra.io/billing/how-credits-work).

## Links

- Documentation: https://docs.spidra.io/sdks/mcp
- Privacy policy: https://spidra.io/privacy
- Terms: https://spidra.io/terms
- Support: https://spidra.io/contact or hello@spidra.io

## License

MIT
