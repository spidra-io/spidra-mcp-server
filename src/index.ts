import dotenv from "dotenv";
import { FastMCP } from "fastmcp";
import { createRequire } from "node:module";

dotenv.config({ debug: false, quiet: true });

import { authenticate, HTTP_MODE, logger, oauthProvider, type SessionData } from "./shared.js";
import { registerFindTools } from "./tools/find.js";
import { registerPageTools } from "./tools/pages.js";
import { registerCrawlTools } from "./tools/crawl.js";
import { registerParseTools } from "./tools/parse.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerPresetTools } from "./tools/presets.js";
import { registerMonitorTools } from "./tools/monitors.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerAccountTools } from "./tools/account.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as { version: string };

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "localhost";

const server = new FastMCP<SessionData>({
  name: "spidra-mcp",
  version: packageVersion as `${number}.${number}.${number}`,
  instructions: [
    "Spidra gets data from the web: search, read pages, crawl sites, parse documents, run ready-made templates and watch pages for changes.",
    "Pick the narrowest tool:",
    "- Don't know the URL? spidra_search. Know the site but not the page? spidra_map, then read the pages you need.",
    "- One URL: spidra_scrape. Two or more: spidra_batch_scrape, never one scrape per URL.",
    "- Many pages of one kind on a site, URLs unknown: spidra_crawl.",
    "- A PDF, Word, Excel or PowerPoint file: spidra_parse.",
    "- A common job on a well-known site (Google Maps leads, Amazon products or rank, LinkedIn or Indeed jobs, YouTube, Zillow, flights): spidra_find_templates first, then spidra_run_template.",
    "- Keep an eye on something over time: spidra_create_monitor.",
    "Tools that don't wait to the end return an id; check it with spidra_get_job and don't start the job again.",
    "Everything costs credits (1 per page, more with AI extraction), so prefer small limits and check spidra_account before big jobs. Failed pages are free.",
  ].join("\n"),
  logger,
  roots: { enabled: false },
  ...(oauthProvider ? { auth: oauthProvider } : {}),
  authenticate,
  health: { enabled: true, message: "ok", path: "/health", status: 200 },
});

registerFindTools(server);
registerPageTools(server);
registerCrawlTools(server);
registerParseTools(server);
registerTemplateTools(server);
registerPresetTools(server);
registerMonitorTools(server);
registerJobTools(server);
registerAccountTools(server);

if (HTTP_MODE) {
  void server.start({
    transportType: "httpStream",
    httpStream: { port: PORT, host: HOST, stateless: true },
  });
} else {
  void server.start({ transportType: "stdio" });
}
