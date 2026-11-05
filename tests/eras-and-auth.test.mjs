// Both protocol eras with real clients (MCP SDK 2.x for 2026-07-28, SDK 1.x for 2025-era), over stdio and HTTP,
// plus the OAuth flow end to end against a fake Spidra backend.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// SPIDRA_MCP_ENTRY tests an installed copy instead, e.g. node_modules/spidra-mcp/dist/index.js in spidra-backend.
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "dist", "index.js");
const UPSTREAM_CLIENT_ID = "mcp-upstream-client";
const UPSTREAM_SECRET = "upstream-secret-for-tests";

// ---------------------------------------------------------------------------
// Fake Spidra backend: the API endpoints the tools call, and /api/oauth/* (authorize, token, introspect)
// ---------------------------------------------------------------------------

const seenAuth = [];
let oauthDown = 0; // when set, /api/oauth/* answers with this status (a backend blip)
const upstreamCodes = new Map();
const upstreamRefresh = new Map();
const revokedUpstream = []; // tokens the MCP server forwarded to /api/oauth/revoke
const codeExchanges = []; // the form of each authorization_code exchange, to check the app's identity is sent
let counter = 0;

const backend = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (oauthDown && url.pathname.startsWith("/api/oauth/")) return send(oauthDown, { status: "error", message: "busy" });
    if (url.pathname === "/api/oauth/authorize") {
      // The user is "logged in": issue a code straight away, like the real backend does with a session cookie.
      assert.equal(url.searchParams.get("client_id"), UPSTREAM_CLIENT_ID);
      const code = `up-code-${++counter}`;
      upstreamCodes.set(code, url.searchParams.get("redirect_uri"));
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/api/oauth/token") {
      const expected = "Basic " + Buffer.from(`${UPSTREAM_CLIENT_ID}:${UPSTREAM_SECRET}`).toString("base64");
      if (req.headers.authorization !== expected) return send(401, { error: "invalid_client" });
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        codeExchanges.push(Object.fromEntries(form));
        const redirect = upstreamCodes.get(form.get("code"));
        upstreamCodes.delete(form.get("code")); // single use, like the real one
        if (!redirect || redirect !== form.get("redirect_uri")) return send(400, { error: "invalid_grant" });
      } else if (form.get("grant_type") === "refresh_token") {
        if (!upstreamRefresh.has(form.get("refresh_token"))) return send(400, { error: "invalid_grant" });
        upstreamRefresh.delete(form.get("refresh_token")); // rotated
      } else return send(400, { error: "unsupported_grant_type" });
      const n = ++counter;
      upstreamRefresh.set(`up-rt-${n}`, true);
      return send(200, { access_token: `up-at-${n}`, refresh_token: `up-rt-${n}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (url.pathname === "/api/oauth/revoke") {
      const expected = "Basic " + Buffer.from(`${UPSTREAM_CLIENT_ID}:${UPSTREAM_SECRET}`).toString("base64");
      if (req.headers.authorization !== expected) return send(401, { error: "invalid_client" });
      const token = new URLSearchParams(body).get("token");
      revokedUpstream.push(token);
      upstreamRefresh.delete(token);
      return send(200, {});
    }
    if (url.pathname === "/api/oauth/introspect") {
      if (req.headers.authorization !== `Bearer ${UPSTREAM_SECRET}`) return send(401, { active: false });
      const token = JSON.parse(body).access_token;
      return send(200, token?.startsWith("up-at-") ? { active: true, apiKey: token } : { active: false });
    }
    seenAuth.push(req.headers.authorization);
    if (url.pathname === "/api/map") {
      return send(200, { status: "success", links: [{ url: "https://example.com/pricing", title: "Pricing" }], total: 1, scanned: 3, creditsUsed: 1 });
    }
    if (url.pathname === "/api/account") {
      return send(200, { status: "success", data: { plan: { name: "Builder" }, credits: { limit: 100, used: 1, remaining: 99 } } });
    }
    if (url.pathname === "/api/monitors/limits") return send(200, { status: "success", maxMonitors: 5, used: 0, minIntervalMinutes: 15 });
    send(404, { status: "error", message: "not found" });
  });
});

let backendUrl;
const children = [];

async function freePort() {
  const srv = createNetServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

async function startHttp(extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      SPIDRA_API_KEY: "",
      HTTP_STREAMABLE_SERVER: "true", MCP_OPENAI_EGRESS_URL: "off",
      PORT: String(port),
      HOST: "127.0.0.1",
      SPIDRA_API_URL: `${backendUrl}/api`,
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { base, child };
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("server didn't start");
}

const oauthEnv = base => ({
  MCP_PUBLIC_URL: base,
  MCP_OAUTH_CLIENT_ID: UPSTREAM_CLIENT_ID,
  MCP_OAUTH_CLIENT_SECRET: UPSTREAM_SECRET,
});

const stdioEnv = () => ({ ...process.env, SPIDRA_API_KEY: "spd_stdio_key", SPIDRA_API_URL: `${backendUrl}/api` });

before(async () => {
  await new Promise(r => backend.listen(0, "127.0.0.1", r));
  backendUrl = `http://127.0.0.1:${backend.address().port}`;
});

after(() => {
  for (const c of children) c.kill();
  backend.close();
});

async function exercise(client) {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 28);
  const map = tools.find(t => t.name === "spidra_map");
  assert.equal(map.annotations.readOnlyHint, true);
  assert.equal(map.title, "List a site's URLs");
  const result = await client.callTool({ name: "spidra_map", arguments: { url: "https://example.com", limit: 5 } });
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  assert.equal(result.structuredContent.links[0].url, "https://example.com/pricing");
  assert.match(result.content[0].text, /example\.com\/pricing/);
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

test("stdio: a 2026-07-28 client (SDK 2.x, pinned) lists and calls tools", async () => {
  const client = new ModernClient({ name: "modern", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new ModernStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    assert.equal(client.getProtocolEra(), "modern");
    await exercise(client);
  } finally {
    await client.close();
  }
});

test("stdio: an auto-negotiating SDK 2.x client lands on the modern era", async () => {
  const client = new ModernClient({ name: "auto", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new ModernStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    assert.equal(client.getProtocolEra(), "modern");
  } finally {
    await client.close();
  }
});

test("stdio: a 2025-era client (SDK 1.x) lists and calls tools", async () => {
  const client = new LegacyClient({ name: "legacy", version: "1" });
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env: stdioEnv() }));
  try {
    assert.equal(client.getServerVersion().name, "spidra-mcp");
    assert.match(client.getInstructions(), /Pick the narrowest tool/);
    await exercise(client);
  } finally {
    await client.close();
  }
});

test("stdio: a .env in the working folder is never read (it could redirect the API key)", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "spidra-dotenv-"));
  writeFileSync(path.join(dir, ".env"), `SPIDRA_API_URL=${backendUrl}/steal\nSPIDRA_API_KEY=spd_from_dotenv\n`);
  const before = seenAuth.length;
  const client = new LegacyClient({ name: "dotenv", version: "1" });
  // Left out, not empty: dotenv never overrides a variable that's set, even to "".
  const { SPIDRA_API_KEY: _k, SPIDRA_API_URL: _u, SPIDRA_MCP_DOTENV: _d, ...env } = process.env;
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env, cwd: dir }));
  try {
    const result = await client.callTool({ name: "spidra_map", arguments: { url: "https://example.com" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No Spidra credentials/);
    assert.equal(seenAuth.length, before, "nothing was sent anywhere");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio: an http:// SPIDRA_API_URL that isn't this computer is refused before the key is sent", async () => {
  const client = new LegacyClient({ name: "plain-http", version: "1" });
  await client.connect(new LegacyStdio({ command: process.execPath, args: [SERVER_ENTRY], env: { ...stdioEnv(), SPIDRA_API_URL: "http://api.example.com/api" } }));
  try {
    const result = await client.callTool({ name: "spidra_map", arguments: { url: "https://example.com" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /must be an https URL/);
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// HTTP with an API key
// ---------------------------------------------------------------------------

let keyServer;
test("http: both eras work with an API key", async t => {
  keyServer = await startHttp();
  const headers = { Authorization: "Bearer spd_http_key" };

  await t.test("2026-07-28 client (SDK 2.x)", async () => {
    const client = new ModernClient({ name: "modern", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new ModernHttp(new URL(`${keyServer.base}/mcp`), { requestInit: { headers } }));
    assert.equal(client.getProtocolEra(), "modern");
    await exercise(client);
    await client.close();
  });

  await t.test("2025-era client (SDK 1.x)", async () => {
    const client = new LegacyClient({ name: "legacy", version: "1" });
    await client.connect(new LegacyHttp(new URL(`${keyServer.base}/mcp`), { requestInit: { headers: { "X-Spidra-Api-Key": "spd_http_key" } } }));
    await exercise(client);
    await client.close();
  });

  assert.ok(seenAuth.includes("Bearer spd_http_key"));
});

test("http: the request that failed in production (modern tools/list) now answers 200", async () => {
  const res = await fetch(`${keyServer.base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
    }),
  });
  assert.equal(res.status, 200);
  const body = await rpcBody(res);
  assert.equal(body.result.tools.length, 28);
});

test("http: a 2026-07-28 body with a stale 2025-11-25 header (Claude connector relay) isn't rejected", async () => {
  // anthropics/claude-code#93290: the relay stamps the old header and leaves out Mcp-Method/Mcp-Name.
  const res = await fetch(`${keyServer.base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-11-25",
      Authorization: "Bearer spd_http_key",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "spidra_map",
        arguments: { url: "https://example.com" },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      },
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.match(text, /example\.com\/pricing/);
});

test("http: server/discover advertises both eras", async () => {
  const res = await fetch(`${keyServer.base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
    }),
  });
  const body = await rpcBody(res);
  assert.ok(body.result.supportedVersions.includes("2026-07-28"), JSON.stringify(body));
  assert.equal(body.result._meta["io.modelcontextprotocol/serverInfo"].name, "spidra-mcp");
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** Read a JSON-RPC message from a response that may be SSE (the hosted server streams every response). */
async function rpcBody(res) {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).find(l => l.trim());
  return JSON.parse(data);
}

const getCookie = res => (res.headers.get("set-cookie") ?? "").split(";")[0];

/** What a person does in the browser: open the consent page, approve, go through the backend login, come back. */
async function approveInBrowser(authorizationUrl) {
  const page = await fetch(authorizationUrl, { redirect: "manual" });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const cookie = getCookie(page);
  const transaction = html.match(/name="transaction" value="([^"]+)"/)[1];
  const consent = await fetch(new URL("/oauth/consent", authorizationUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ transaction, action: "approve" }),
  });
  assert.equal(consent.status, 302);
  const login = await fetch(consent.headers.get("location"), { redirect: "manual" });
  const callback = await fetch(login.headers.get("location"), { redirect: "manual", headers: { Cookie: cookie } });
  assert.equal(callback.status, 302, await callback.text());
  return { redirect: new URL(callback.headers.get("location")), html };
}

function memoryProvider(redirectUrl) {
  const store = { authUrl: undefined, info: undefined, tokens: undefined, verifier: undefined };
  return {
    store,
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return { client_name: "Test Client", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    },
    clientInformation: () => store.info,
    saveClientInformation: info => (store.info = info),
    tokens: () => store.tokens,
    saveTokens: tokens => (store.tokens = tokens),
    redirectToAuthorization: url => (store.authUrl = url),
    saveCodeVerifier: v => (store.verifier = v),
    codeVerifier: () => store.verifier,
  };
}

let oauthServer;
test("oauth: discovery documents point clients at the right resource and issuer", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  oauthServer = await (async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, SPIDRA_API_KEY: "", HTTP_STREAMABLE_SERVER: "true", MCP_OPENAI_EGRESS_URL: "off", PORT: String(port), HOST: "127.0.0.1", SPIDRA_API_URL: `${backendUrl}/api`, ...oauthEnv(base) },
      stdio: ["ignore", "ignore", "inherit"],
    });
    children.push(child);
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    return { base, port, child };
  })();

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [base]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
});

test("oauth: every MCP request without credentials gets a 401 challenge, from the first one (Cursor needs that)", async () => {
  const { base } = oauthServer;
  const client = new LegacyClient({ name: "anon", version: "1" });
  await assert.rejects(client.connect(new LegacyHttp(new URL(`${base}/mcp`))), /Sign in to Spidra/);

  const post = body =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify(body),
    });
  for (const body of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spidra_account", arguments: {} } },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 401, body.method);
    const challenge = res.headers.get("www-authenticate");
    assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.doesNotMatch(challenge, /error=/, "no error code when no credentials were sent (RFC 6750 3.1)");
  }
  // Discovery stays open.
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status, 200);
});

test("oauth: a key header that isn't a Spidra key gets a plain 401 saying so, not a sign-in challenge", async () => {
  const { base } = oauthServer;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Spidra-Api-Key": "sdp_typo" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), null);
  assert.match((await res.json()).error.message, /start with spd_/);
});

test("oauth: a 2025-era client (SDK 1.x) signs in through DCR, consent and PKCE, then calls a tool", async () => {
  const { base } = oauthServer;
  const provider = memoryProvider("http://localhost:7777/callback");
  const transport = new LegacyHttp(new URL(`${base}/mcp`), { authProvider: provider });
  // The first request (initialize) gets the 401, and the client goes to sign in.
  await assert.rejects(new LegacyClient({ name: "legacy-oauth", version: "1" }).connect(transport));
  assert.ok(provider.store.authUrl, "the client was sent to the authorization endpoint");
  assert.ok(provider.store.info.client_id.startsWith("smc_"));

  const { redirect, html } = await approveInBrowser(provider.store.authUrl);
  assert.match(html, /Test Client/);
  assert.match(html, /an app on this computer/);
  assert.equal(redirect.searchParams.get("iss"), base);
  await transport.finishAuth(redirect.searchParams.get("code"));
  const client = new LegacyClient({ name: "legacy-oauth", version: "1" });
  await client.connect(new LegacyHttp(new URL(`${base}/mcp`), { authProvider: provider }));

  const result = await client.callTool({ name: "spidra_account", arguments: {} });
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  assert.equal(result.structuredContent.credits.remaining, 99);
  assert.match(seenAuth.at(-1), /^Bearer up-at-\d+$/, "the API was called with the backend's token");
  await client.close();

  // Refresh: the wrapped refresh token is redeemed and rotated upstream.
  const refreshed = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: provider.store.tokens.refresh_token, client_id: provider.store.info.client_id }),
  });
  const tokens = await refreshed.json();
  assert.equal(refreshed.status, 200, JSON.stringify(tokens));
  assert.ok(tokens.access_token && tokens.refresh_token);
  const reused = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: provider.store.tokens.refresh_token, client_id: provider.store.info.client_id }),
  });
  assert.equal((await reused.json()).error, "invalid_grant", "an old refresh token can't be used twice");
  oauthServer.tokens = tokens;
  oauthServer.clientId = provider.store.info.client_id;
});

test("oauth: a 2026-07-28 client (SDK 2.x) signs in the same way", async () => {
  const { base } = oauthServer;
  const provider = memoryProvider("http://127.0.0.1:7778/callback");
  const transport = new ModernHttp(new URL(`${base}/mcp`), { authProvider: provider });
  const options = { versionNegotiation: { mode: { pin: "2026-07-28" } } };
  await assert.rejects(new ModernClient({ name: "modern-oauth", version: "1" }, options).connect(transport));
  assert.ok(provider.store.authUrl);
  const { redirect } = await approveInBrowser(provider.store.authUrl);
  await transport.finishAuth(redirect.searchParams);
  const client = new ModernClient({ name: "modern-oauth", version: "1" }, options);
  await client.connect(new ModernHttp(new URL(`${base}/mcp`), { authProvider: provider }));
  assert.equal(client.getProtocolEra(), "modern");

  const result = await client.callTool({ name: "spidra_account", arguments: {} });
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  assert.equal(result.structuredContent.plan.name, "Builder");
  await client.close();
});

test("oauth: tokens survive a server restart, and a signing key rotation that keeps the old key", async () => {
  const { base, port } = oauthServer;
  oauthServer.child.kill();
  await new Promise(r => oauthServer.child.once("exit", r));
  // Newest key first; the old one (derived from the client secret, as before) still opens existing tokens.
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, SPIDRA_API_KEY: "", HTTP_STREAMABLE_SERVER: "true", MCP_OPENAI_EGRESS_URL: "off", PORT: String(port), HOST: "127.0.0.1", SPIDRA_API_URL: `${backendUrl}/api`, ...oauthEnv(base), MCP_OAUTH_SIGNING_KEYS: `rotated-signing-key,${UPSTREAM_SECRET}` },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  oauthServer.child = child;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  const client = new LegacyClient({ name: "after-restart", version: "1" });
  await client.connect(new LegacyHttp(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${oauthServer.tokens.access_token}` } } }));
  const result = await client.callTool({ name: "spidra_account", arguments: {} });
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  await client.close();
});

test("oauth: a backend outage doesn't sign anyone out: calls keep working, a refresh gets 503 to retry", async () => {
  const { base } = oauthServer;
  for (const status of [503, 429]) {
    oauthDown = status;
    try {
      // No introspection on the hot path, so a signed-in call doesn't touch /api/oauth at all.
      const client = new LegacyClient({ name: "during-outage", version: "1" });
      await client.connect(new LegacyHttp(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${oauthServer.tokens.access_token}` } } }));
      const result = await client.callTool({ name: "spidra_account", arguments: {} });
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      await client.close();

      const refreshed = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oauthServer.tokens.refresh_token, client_id: oauthServer.clientId }),
      });
      assert.equal(refreshed.status, 503, `backend ${status}`);
      assert.equal(refreshed.headers.get("retry-after"), "30");
      assert.equal((await refreshed.json()).error, "temporarily_unavailable", "not invalid_grant, which makes clients drop the session");
    } finally {
      oauthDown = 0;
    }
  }
});

test("oauth: a tampered or foreign token gets a 401 with invalid_token", async () => {
  const { base } = oauthServer;
  const bad = oauthServer.tokens.access_token.slice(0, -4) + "AAAA";
  for (const token of [bad, "some-other-providers-token"]) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
  }
});

test("oauth: registration refuses redirect URIs that only look like localhost", async () => {
  const { base } = oauthServer;
  for (const uri of ["http://localhost:1@evil.example/cb", "http://127.0.0.1:80@attacker.test/x", "https://evil.example/callback", "javascript:alert(1)"]) {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: [uri] }),
    });
    assert.equal(res.status, 400, uri);
    assert.equal((await res.json()).error, "invalid_redirect_uri");
  }
  for (const uri of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/abc_123", "http://[::1]:5000/cb"]) {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: [uri] }),
    });
    assert.equal(res.status, 201, uri);
  }
});

async function registerAndAuthorize(base, { secretMethod = "none" } = {}) {
  const reg = await (
    await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Manual", redirect_uris: ["http://localhost:9000/cb"], token_endpoint_auth_method: secretMethod }),
    })
  ).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${base}/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://localhost:9000/cb", response_type: "code", state: "s1", code_challenge: challenge, code_challenge_method: "S256" });
  return { reg, verifier, url };
}

test("oauth: two sign-ins in parallel each keep their own cookie, and a bad cookie elsewhere doesn't break it", async () => {
  const { base } = oauthServer;
  const first = await registerAndAuthorize(base);
  const second = await registerAndAuthorize(base);
  const page1 = await fetch(first.url, { redirect: "manual" });
  const page2 = await fetch(second.url, { redirect: "manual" });
  const [cookie1, cookie2] = [getCookie(page1), getCookie(page2)];
  assert.notEqual(cookie1.split("=")[0], cookie2.split("=")[0], "one cookie per sign-in");
  assert.match(page1.headers.get("set-cookie"), /Path=\//);
  const transaction = (await page1.text()).match(/name="transaction" value="([^"]+)"/)[1];
  const res = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `${cookie2}; junk=%E0%A4%A; ${cookie1}` },
    body: new URLSearchParams({ transaction, action: "approve" }),
  });
  assert.equal(res.status, 302, "the first sign-in still works after the second started");
});

test("oauth: registration limits, Cline's callback, and malformed Basic credentials", async () => {
  const { base } = oauthServer;
  const register = body => fetch(`${base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const long = Array.from({ length: 10 }, (_, i) => `http://localhost:${9000 + i}/${"x".repeat(400)}`);
  const tooBig = await register({ client_name: "big", redirect_uris: long });
  assert.equal(tooBig.status, 400);
  assert.equal((await tooBig.json()).error, "invalid_client_metadata");
  const cline = await register({ client_name: "Cline", redirect_uris: ["vscode://saoudrizwan.claude-dev/mcp-auth/callback/abc123"], token_endpoint_auth_method: "none" });
  assert.equal(cline.status, 201);
  const badBasic = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "x" }),
  });
  assert.equal(badBasic.status, 401);
  assert.equal((await badBasic.json()).error, "invalid_client");
});

test("oauth: a metadata-document client_id on an IPv6 literal is refused without a fetch, and no detail leaks", async () => {
  const { base } = oauthServer;
  for (const clientId of ["https://[::1]:9/client.json", "https://127.0.0.1/client.json"]) {
    const url = new URL(`${base}/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: "http://localhost:9000/cb", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 400, clientId);
    assert.match(await res.text(), /https URL with a path, on a host name/);
  }
  const unreachable = new URL(`${base}/oauth/authorize`);
  unreachable.search = new URLSearchParams({ client_id: "https://unreachable.invalid/client.json", redirect_uri: "http://localhost:9000/cb", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  const body = await (await fetch(unreachable, { redirect: "manual" })).text();
  assert.match(body, /Couldn(&#39;|')t read the app(&#39;|')s metadata document/);
  assert.doesNotMatch(body, /ENOTFOUND|getaddrinfo/);
});

test("oauth: the consent form can't be submitted from another browser (no cookie)", async () => {
  const { base } = oauthServer;
  const { url } = await registerAndAuthorize(base);
  const page = await fetch(url, { redirect: "manual" });
  const transaction = (await page.text()).match(/name="transaction" value="([^"]+)"/)[1];
  const res = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, action: "approve" }),
  });
  assert.equal(res.status, 400);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});

test("oauth: a wrong PKCE verifier, a replayed code, or a missing client secret is refused", async () => {
  const { base } = oauthServer;
  const { reg, verifier, url } = await registerAndAuthorize(base);
  const { redirect } = await approveInBrowser(url);
  const code = redirect.searchParams.get("code");
  const exchange = v =>
    fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, client_id: reg.client_id, redirect_uri: "http://localhost:9000/cb" }),
    });
  assert.equal((await (await exchange(randomBytes(32).toString("base64url"))).json()).error, "invalid_grant");
  assert.equal((await exchange(verifier)).status, 200);
  assert.equal((await (await exchange(verifier)).json()).error, "invalid_grant", "codes are single use");

  const confidential = await registerAndAuthorize(base, { secretMethod: "client_secret_basic" });
  assert.ok(confidential.reg.client_secret);
  const r2 = await approveInBrowser(confidential.url);
  const noSecret = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: r2.redirect.searchParams.get("code"), code_verifier: confidential.verifier, client_id: confidential.reg.client_id }),
  });
  assert.equal(noSecret.status, 401);
  assert.equal((await noSecret.json()).error, "invalid_client");
});

test("oauth: a Client ID Metadata Document client (Claude Code's real one) gets a consent page naming its host", async t => {
  const { base } = oauthServer;
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  try {
    await fetch(clientId, { signal: AbortSignal.timeout(5000) });
  } catch {
    t.skip("no network");
    return;
  }
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${base}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://localhost:51234/callback",
    response_type: "code",
    state: "cimd",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const { redirect, html } = await approveInBrowser(url);
  assert.match(html, /Claude Code/);
  assert.match(html, /claude\.ai/);
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code"), code_verifier: verifier, client_id: clientId, redirect_uri: "http://localhost:51234/callback" }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const wrongRedirect = new URL(url);
  wrongRedirect.searchParams.set("redirect_uri", "https://claude.ai/somewhere-else");
  assert.equal((await fetch(wrongRedirect, { redirect: "manual" })).status, 400);
});

test("oauth: revoking a refresh token ends the connection, and an unknown token still gets 200", async () => {
  const { base } = oauthServer;
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.revocation_endpoint, `${base}/oauth/revoke`);

  const { reg, verifier, url } = await registerAndAuthorize(base);
  const { redirect } = await approveInBrowser(url);
  const tokens = await (
    await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code"), code_verifier: verifier, client_id: reg.client_id, redirect_uri: "http://localhost:9000/cb" }),
    })
  ).json();
  assert.ok(tokens.refresh_token);
  const exchange = codeExchanges.at(-1);
  assert.equal(exchange.mcp_client_name, "Manual", "the app's name is sent to the backend for Connected apps");
  assert.match(exchange.mcp_client_id, /^dcr:[A-Za-z0-9_-]{22}$/, "a registered client is named by a short hash, not its sealed id");

  const revoke = body => fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const res = await revoke({ token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: reg.client_id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  assert.match(revokedUpstream.at(-1), /^up-rt-\d+$/, "the backend's refresh token was forwarded, not ours");

  const refreshed = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }),
  });
  assert.equal((await refreshed.json()).error, "invalid_grant");

  // An access token works too (no client credentials needed), and forwards the backend's access token.
  assert.equal((await revoke({ token: tokens.access_token })).status, 200);
  assert.match(revokedUpstream.at(-1), /^up-at-\d+$/);

  const forwarded = revokedUpstream.length;
  for (const token of ["not-a-token", "A".repeat(80), tokens.refresh_token.slice(0, -2) + "xx"]) {
    const unknown = await revoke({ token });
    assert.equal(unknown.status, 200, token);
  }
  assert.equal(revokedUpstream.length, forwarded, "nothing is sent upstream for a token we can't open");

  // Another client's token is left alone (still 200), and a wrong secret is refused.
  const other = await registerAndAuthorize(base, { secretMethod: "client_secret_post" });
  assert.equal((await revoke({ token: tokens.access_token, client_id: other.reg.client_id, client_secret: other.reg.client_secret })).status, 200);
  assert.equal(revokedUpstream.length, forwarded);
  const wrong = await revoke({ token: tokens.access_token, client_id: other.reg.client_id, client_secret: "nope" });
  assert.equal(wrong.status, 401);
  assert.equal((await revoke({})).status, 400, "token is required");
});
