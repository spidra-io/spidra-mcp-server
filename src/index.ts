import dotenv from "dotenv";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HTTP_MODE } from "./logger.js";
import { buildServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { apiBaseUrl } from "./shared.js";

// .env is read only when self-hosting over HTTP (or with SPIDRA_MCP_DOTENV=1). Never by default on stdio: clients
// start `npx spidra-mcp` in the open project's folder, and a .env shipped in a repo could point SPIDRA_API_URL at
// someone else's server and collect the user's key (MCP_SECOND_REVIEW H1). Clients pass settings through their own
// env block. HTTP_STREAMABLE_SERVER itself has to come from the real environment, as before.
if (HTTP_MODE || process.env.SPIDRA_MCP_DOTENV === "1") dotenv.config({ debug: false, quiet: true });

// Say once, on stderr, which API a custom SPIDRA_API_URL points at (stdout is the JSON-RPC stream on stdio).
if (process.env.SPIDRA_API_URL) {
  try {
    process.stderr.write(`spidra-mcp: using the Spidra API at ${new URL(apiBaseUrl()!).origin}\n`);
  } catch (err) {
    process.stderr.write(`spidra-mcp: ${(err as Error).message}\n`);
  }
}

if (HTTP_MODE) {
  startHttpServer({ port: Number(process.env.PORT || 3000), host: process.env.HOST || "localhost" });
} else {
  // npx spidra-mcp: one connection, either protocol era, keyed by SPIDRA_API_KEY.
  const handle = serveStdio(() => buildServer({ spidraApiKey: process.env.SPIDRA_API_KEY }));
  const close = () => void handle.close().finally(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
