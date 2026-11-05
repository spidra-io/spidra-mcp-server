/**
 * The Streamable HTTP server (hosted at mcp.spidra.io, or self-hosted with HTTP_STREAMABLE_SERVER=true).
 *
 * One endpoint, /mcp, serves both protocol eras from the same tools: 2026-07-28 clients (no handshake, a _meta
 * envelope on every request) and 2025-era clients (initialize, then stateless requests). The MCP SDK's
 * createMcpHandler does the era detection; this file adds what sits in front of it: auth, the OAuth routes, CORS,
 * a health check, and request logging.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { buildServer, VERSION } from "./server.js";
import { OAuthProvider, oauthConfigFromEnv } from "./oauth.js";
import { logger } from "./logger.js";
import { platformOf, startEgressRefresh, type Platform } from "./egress.js";

// A parse request can carry a 10 MB file as base64 (about 14 MB of JSON). The SDK's default is 4 MB. Without
// credentials there's no reason for a big body, so those get 1 MB.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ANONYMOUS_BODY_BYTES = 1024 * 1024;

// Per-minute limits (MCP_SECOND_REVIEW M7). Anonymous /mcp traffic and the sign-in pages are per IP; calls with
// credentials are per caller. Tunable with the environment for load tests.
const LIMITS = {
  anonymous: Number(process.env.MCP_RATE_ANONYMOUS || 60),
  authenticated: Number(process.env.MCP_RATE_AUTHENTICATED || 600),
  signIn: Number(process.env.MCP_RATE_SIGN_IN || 30),
  // AI platforms that call from their own servers (claude.ai and the Claude apps, ChatGPT) reach us from a few
  // addresses shared by all their users, so those addresses get buckets sized for that, still capped. egress.ts.
  platformAnonymous: Number(process.env.MCP_RATE_PLATFORM_ANONYMOUS || 3000),
  platformSignIn: Number(process.env.MCP_RATE_PLATFORM_SIGN_IN || 600),
};

/** A fixed one-minute window per key. In memory, which is right for one process; nginx can add more in front. */
class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  /** Seconds to wait when over the limit, or 0 when the request may go ahead. */
  hit(key: string, limit: number): number {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) {
        for (const [k, v] of this.windows) if (now - v.start >= 60_000) this.windows.delete(k);
      }
    }
    w.count++;
    return w.count > limit ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
  }
}

/**
 * The caller's IP and which AI platform it belongs to, if any. Behind the hosted proxy chain (Cloudflare, nginx, the
 * backend's proxy) the socket is the proxy, so the edge's header is used; a spoofed header only picks a bucket.
 * Only Cloudflare's cf-connecting-ip (which Cloudflare sets and a client can't override through it) or the socket
 * itself can mark a caller as a platform; a forged X-Forwarded-For can't. A forged cf-connecting-ip sent straight to
 * the origin only reaches the capped platform bucket.
 */
function callerAddress(req: IncomingMessage, behindProxy: boolean): { ip: string; platform?: Platform } {
  if (behindProxy) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return { ip: cf, platform: platformOf(cf) };
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return { ip: xff.split(",")[0].trim() };
  }
  const ip = req.socket.remoteAddress ?? "unknown";
  return { ip, platform: platformOf(ip) };
}

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

interface Caller {
  apiKey?: string;
  clientId: string;
}

/** A Spidra API key from the headers, "malformed" for a key header that can't be one, or undefined. */
function apiKeyFromHeaders(req: IncomingMessage): string | "malformed" | undefined {
  const headerKey = req.headers["x-spidra-api-key"] ?? req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim().startsWith("spd_") ? headerKey.trim() : "malformed";
  const bearer = bearerToken(req);
  return bearer?.startsWith("spd_") ? bearer : undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || undefined;
  return undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve("too_large");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

type JsonRpcMessage = { method?: unknown; params?: { name?: unknown; uri?: unknown; _meta?: Record<string, unknown> } };

const messagesOf = (body: unknown): JsonRpcMessage[] =>
  (Array.isArray(body) ? body : [body]).filter((m): m is JsonRpcMessage => Boolean(m) && typeof m === "object");

/**
 * Claude's connector relay can send a 2026-07-28 body (version in _meta) with a stale `MCP-Protocol-Version:
 * 2025-11-25` header, or without the Mcp-Method and Mcp-Name headers (anthropics/claude-code#93290). A strict
 * server rejects every such call with -32020 (header mismatch). Those headers only mirror the body for gateways, and
 * nothing in front of this server routes on them, so we make them agree with the body instead of failing the call.
 */
function alignStandardHeaders(req: IncomingMessage, body: unknown): void {
  const [message, ...rest] = messagesOf(body);
  if (!message || rest.length) return;
  const version = message.params?._meta?.[PROTOCOL_VERSION_KEY];
  if (typeof version !== "string") return; // a 2025-era request: nothing to align
  const fixes: string[] = [];
  if (req.headers["mcp-protocol-version"] !== version) {
    req.headers["mcp-protocol-version"] = version;
    fixes.push("MCP-Protocol-Version");
  }
  if (typeof message.method === "string" && req.headers["mcp-method"] !== message.method) {
    req.headers["mcp-method"] = message.method;
    fixes.push("Mcp-Method");
  }
  const name =
    message.method === "tools/call" || message.method === "prompts/get"
      ? message.params?.name
      : message.method === "resources/read"
        ? message.params?.uri
        : undefined;
  if (typeof name === "string" && req.headers["mcp-name"] !== name && /^[\x20-\x7e]*$/.test(name)) {
    req.headers["mcp-name"] = name;
    fixes.push("Mcp-Name");
  }
  if (fixes.length) logger.debug(`Aligned ${fixes.join(", ")} with the request body`);
}

function cors(res: ServerResponse): void {
  // nginx buffers proxied responses by default, which would hold back the keepalives; this turns that off.
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
}

function preflight(req: IncomingMessage, res: ServerResponse): void {
  const requested = req.headers["access-control-request-headers"];
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // "*" doesn't cover Authorization, so echo what the browser asks for.
    "Access-Control-Allow-Headers":
      typeof requested === "string" && requested.length < 2000
        ? requested
        : "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, X-Spidra-Api-Key",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

/** A short label for the request log: never the key, and not the whole sealed client id. */
function describeCaller(caller: Caller | undefined): string {
  if (!caller) return "anonymous";
  if (caller.clientId.startsWith("https://")) return `oauth ${new URL(caller.clientId).host}`;
  if (caller.clientId.startsWith("smc_")) return `oauth ${caller.clientId.slice(0, 12)}`;
  return caller.clientId;
}

export interface HttpServerOptions {
  port: number;
  host: string;
}

export function startHttpServer({ port, host }: HttpServerOptions) {
  const oauthConfig = oauthConfigFromEnv();
  const oauth = oauthConfig ? new OAuthProvider(oauthConfig) : undefined;
  const envKey = process.env.SPIDRA_API_KEY;
  if (oauth && envKey) {
    logger.warn("SPIDRA_API_KEY is set but OAuth is on. Over HTTP the server never falls back to it; callers must sign in or send a key.");
  }

  const handler = createMcpHandler(
    ({ authInfo }) => buildServer({ spidraApiKey: (authInfo?.extra as { spidraApiKey?: string } | undefined)?.spidraApiKey }),
    {
      maxRequestBodySize: MAX_BODY_BYTES,
      // Stream every response and send a keepalive comment every 15 s. A tool can wait minutes for a batch or a
      // scrape, and a silent response is cut by nginx after 60 s and Cloudflare after 100 s, with no job id.
      responseMode: "sse",
      keepAliveMs: Number(process.env.MCP_SSE_KEEPALIVE_MS || 15_000),
      onerror: err => logger.error("MCP handler error:", err.message),
    }
  );
  const node = toNodeHandler(handler);

  // A server bound to this machine only answers this machine (DNS rebinding protection). The hosted server binds
  // localhost behind the backend's proxy, so it opts out with MCP_PUBLIC_URL / ALLOWED_HOSTS.
  const loopbackBind = ["localhost", "127.0.0.1", "::1"].includes(host) && !process.env.MCP_PUBLIC_URL;
  const validateHost = loopbackBind ? localhostHostValidation() : undefined;
  const validateOrigin = loopbackBind ? localhostOriginValidation() : undefined;

  function resolveCaller(req: IncomingMessage): Caller | { reject: string; challenge: boolean } | undefined {
    const key = apiKeyFromHeaders(req);
    if (key === "malformed") {
      // A typo in a pasted key: say so, and don't send the client off to an OAuth sign-in it didn't ask for.
      return { reject: "That API key doesn't look like a Spidra key (they start with spd_). Copy it again from https://app.spidra.io under API Keys.", challenge: false };
    }
    if (key) return { apiKey: key, clientId: "api-key" };
    const token = bearerToken(req);
    if (token && oauth) {
      const verified = oauth.verifyAccessToken(token);
      return verified ? { apiKey: verified.apiKey, clientId: verified.clientId } : { reject: "The access token is invalid or expired.", challenge: true };
    }
    if (oauth) return undefined; // anonymous: gets a 401 that starts sign-in
    return envKey ? { apiKey: envKey, clientId: "env" } : undefined;
  }

  const limiter = new RateLimiter();
  const stopEgressRefresh = startEgressRefresh();
  const behindProxy = Boolean(process.env.MCP_PUBLIC_URL);
  const tooMany = (res: ServerResponse, retryAfter: number) =>
    jsonRpcError(res, 429, -32000, `Too many requests. Try again in ${retryAfter} seconds.`, { "Retry-After": String(retryAfter) });

  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Who's calling comes from the headers alone, so a request without credentials is answered before its body is
    // read (MCP_SECOND_REVIEW M7).
    const caller = resolveCaller(req);
    const from = callerAddress(req, behindProxy);
    const identified = caller && !("reject" in caller) && caller.apiKey;
    const wait = identified
      ? limiter.hit(`key:${createHash("sha256").update(caller.apiKey!).digest("hex").slice(0, 16)}`, LIMITS.authenticated)
      : from.platform
        ? limiter.hit(`${from.platform}:${from.ip}`, LIMITS.platformAnonymous)
        : limiter.hit(`ip:${from.ip}`, LIMITS.anonymous);
    if (wait) {
      req.resume();
      return tooMany(res, wait);
    }
    if (caller && "reject" in caller) {
      req.resume();
      return jsonRpcError(res, 401, -32001, caller.reject, {
        ...(caller.challenge && oauth ? { "WWW-Authenticate": oauth.challenge({ code: "invalid_token", description: caller.reject }) } : {}),
      });
    }
    if (!caller && oauth) {
      req.resume();
      // Every MCP request without credentials gets a 401, from the first one (initialize, server/discover or
      // tools/list). Claude, ChatGPT, Cursor and VS Code start sign-in on a connect-time 401 with this header; Cursor
      // never does when only tool calls get it (MCP_SECOND_REVIEW H2). Discovery and the OAuth routes stay open. No
      // error code: none is sent when no credentials were (RFC 6750 section 3.1).
      return jsonRpcError(res, 401, -32001, "Sign in to Spidra to use this server.", { "WWW-Authenticate": oauth.challenge() });
    }

    let parsed: unknown;
    if (req.method === "POST") {
      const limit = identified ? MAX_BODY_BYTES : MAX_ANONYMOUS_BODY_BYTES;
      const raw = await readBody(req, limit);
      if (raw === "too_large") return jsonRpcError(res, 413, -32600, `Request body is larger than ${limit / 1024 / 1024} MB.`);
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return jsonRpcError(res, 400, -32700, "Parse error: the body isn't valid JSON.");
      }
    }

    if (parsed !== undefined) alignStandardHeaders(req, parsed);
    if (caller?.apiKey) {
      const authInfo: AuthInfo = {
        token: "redacted",
        clientId: caller.clientId,
        scopes: [],
        extra: { spidraApiKey: caller.apiKey },
      };
      (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
    }
    await node(req, res, parsed);
    // Each tool call logs its own outcome (server.ts); here only what the tools never see.
    if (res.statusCode >= 400) logger.info(`${req.method} /mcp -> ${res.statusCode} (${describeCaller(caller)})`);
  }

  // Graceful shutdown (MCP_SECOND_REVIEW M3): on SIGTERM or SIGINT (pm2 reload), stop taking new work, let calls in
  // flight finish (none waits longer than about 45 s), then exit. /health answers 503 meanwhile.
  let inFlight = 0;
  let draining = false;

  const server = createServer(async (req, res) => {
    inFlight++;
    res.on("close", () => inFlight--);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        res.writeHead(draining ? 503 : 200, { "Content-Type": "text/plain" });
        res.end(draining ? "draining" : "ok");
        return;
      }
      if (draining) {
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5", Connection: "close" });
        res.end(JSON.stringify({ error: "unavailable", message: "The server is restarting. Try again in a few seconds." }));
        return;
      }
      if (validateHost && !validateHost(req, res)) return;
      if (validateOrigin && !validateOrigin(req, res)) return;

      if (oauth && (url.pathname === "/oauth/authorize" || url.pathname === "/oauth/register")) {
        const from = callerAddress(req, behindProxy);
        const wait = from.platform
          ? limiter.hit(`signin-${from.platform}:${from.ip}`, LIMITS.platformSignIn)
          : limiter.hit(`signin:${from.ip}`, LIMITS.signIn);
        if (wait) {
          res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": String(wait) });
          res.end("Too many sign-in attempts. Try again in a minute.");
          return;
        }
      }
      if (oauth && (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/"))) {
        if (await oauth.handle(req, res, url)) return;
      }
      if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
        cors(res);
        if (req.method === "OPTIONS") return preflight(req, res);
        await serveMcp(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: "The MCP endpoint is /mcp." }));
    } catch (err) {
      logger.error("Request failed:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
      else res.end();
    }
  });
  // Tool calls can wait several minutes (a batch or a crawl); don't let Node cut them off.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  server.listen(port, host, () => {
    logger.info(`spidra-mcp ${VERSION} listening on http://${host}:${port}/mcp (OAuth ${oauth ? "on" : "off"})`);
  });

  const drainMs = Number(process.env.MCP_DRAIN_MS || 50_000);
  const shutdown = async () => {
    if (draining) return;
    draining = true;
    stopEgressRefresh();
    logger.info(`Shutting down: waiting up to ${drainMs / 1000} s for ${inFlight} request(s) in flight`);
    server.close();
    server.closeIdleConnections();
    const deadline = Date.now() + drainMs;
    while (inFlight > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    await handler.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
