/**
 * OAuth for the hosted server (mcp.spidra.io): lets MCP clients sign in with a browser instead of pasting an API key.
 *
 * This server is the OAuth authorization server that MCP clients talk to (discovery, client registration, consent,
 * code and token endpoints). Behind it, Spidra's backend (/api/oauth/*) is the real identity provider, and this
 * server is the single confidential client it trusts. The flow:
 *
 *   client -> GET /oauth/authorize          consent screen, bound to this browser by a cookie
 *          -> POST /oauth/consent           approve, then redirect to the backend's /oauth/authorize (login)
 *   backend -> GET /oauth/callback          we get the backend's code and hand the client our own code
 *   client -> POST /oauth/token             we check PKCE, redeem the backend code, and return wrapped tokens
 *   client -> POST /mcp (Bearer <token>)    we unwrap the token: inside is the backend's token, the API credential
 *
 * Nothing is kept in memory. Client registrations, the consent transaction, authorization codes and tokens are all
 * sealed blobs (AES-256-GCM, with the blob type as associated data so one kind can't be passed off as another).
 * The key comes from MCP_OAUTH_SIGNING_KEY or, when that isn't set, is derived from MCP_OAUTH_CLIENT_SECRET, so a
 * restart or deploy doesn't sign anyone out. Rotating the secret signs everyone out, which is what you'd want.
 *
 * Single use of authorization codes is enforced by the backend: our code carries the backend's code, which the
 * backend redeems once (and expires after 2 minutes).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { renderConsentPage, renderErrorPage } from "./consent.js";
import { CLIENT_LOGOS } from "./logos.js";
import { logger } from "./logger.js";
import { apiBaseUrl } from "./shared.js";

export interface OAuthConfig {
  /** Public origin of this server, e.g. https://mcp.spidra.io (no trailing slash). The OAuth issuer. */
  baseUrl: string;
  /** The MCP endpoint, `${baseUrl}/mcp`. The protected resource. */
  resource: string;
  /** The backend's API root, e.g. https://api.spidra.io/api. */
  upstreamApiUrl: string;
  upstreamClientId: string;
  upstreamClientSecret: string;
  /** Extra exact redirect URIs to accept (MCP_OAUTH_EXTRA_REDIRECT_URIS, comma-separated). */
  extraRedirectUris: string[];
}

export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const { MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET, MCP_PUBLIC_URL, SPIDRA_API_URL } = env;
  if (!MCP_OAUTH_CLIENT_ID || !MCP_OAUTH_CLIENT_SECRET || !MCP_PUBLIC_URL) return undefined;
  if (!SPIDRA_API_URL) {
    logger.error("OAuth is configured but SPIDRA_API_URL isn't set, so sign-in can't reach the backend. OAuth is off.");
    return undefined;
  }
  try {
    apiBaseUrl();
  } catch (err) {
    logger.error(`${(err as Error).message} OAuth is off.`);
    return undefined;
  }
  const baseUrl = MCP_PUBLIC_URL.replace(/\/+$/, "");
  return {
    baseUrl,
    resource: `${baseUrl}/mcp`,
    upstreamApiUrl: SPIDRA_API_URL.replace(/\/+$/, ""),
    upstreamClientId: MCP_OAUTH_CLIENT_ID,
    upstreamClientSecret: MCP_OAUTH_CLIENT_SECRET,
    extraRedirectUris: (env.MCP_OAUTH_EXTRA_REDIRECT_URIS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Sealed blobs
// ---------------------------------------------------------------------------

type BlobType = "client" | "txn" | "code" | "access" | "refresh";

const TTL = {
  txn: 10 * 60, // consent screen, then the backend login, must finish in 10 minutes
  code: 2 * 60, // the backend's own code lasts 2 minutes, ours can't outlive it
} as const;

/** The longest sealed blob accepted. A client_id goes inside the transaction, so registrations stay well under this. */
const MAX_BLOB = 8192;

class Sealer {
  private readonly keys: Buffer[];
  private readonly macKeys: Buffer[];

  /** secrets: newest first. New blobs use the first; open() also accepts the older ones, for a key rotation. */
  constructor(secrets: string[]) {
    const derive = (secret: string, info: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), "spidra-mcp", info, 32));
    this.keys = secrets.map(s => derive(s, "oauth-seal-v1"));
    this.macKeys = secrets.map(s => derive(s, "oauth-mac-v1"));
  }

  private get key(): Buffer {
    return this.keys[0];
  }

  seal(type: BlobType, payload: Record<string, unknown>, ttlSeconds?: number): string {
    const body = ttlSeconds ? { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds } : payload;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(type));
    const ct = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
  }

  open<T extends Record<string, unknown>>(type: BlobType, token: string | undefined | null): T | undefined {
    if (!token || token.length > MAX_BLOB) return undefined;
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 12 + 16 + 2) return undefined;
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(type));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const pt = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
        const body = JSON.parse(pt) as T & { exp?: number };
        if (typeof body.exp === "number" && body.exp < Date.now() / 1000) return undefined;
        return body;
      } catch {
        // not this key; try the next
      }
    }
    return undefined;
  }

  mac(value: string): string {
    return createHmac("sha256", this.macKeys[0]).update(value).digest("base64url");
  }

  /** A MAC made with the current key or one being rotated out. */
  checkMac(value: string, mac: string): boolean {
    return this.macKeys.some(k => safeEqual(mac, createHmac("sha256", k).update(value).digest("base64url")));
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

// Hosted callbacks of clients that don't use a loopback redirect. Each is an exact, vendor-documented URL:
//   Claude (web, Desktop, mobile, Cowork): https://claude.com/docs/connectors/building/authentication#callback-urls
//   ChatGPT: https://developers.openai.com/plugins/build/auth (stable URL with RFC 9207 iss, else per-connector)
//   Cursor (desktop custom scheme, and web/cloud agents), VS Code for the web, Antigravity: their MCP docs
const EXACT_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "https://vscode.dev/redirect",
  "https://insiders.vscode.dev/redirect",
  "https://antigravity.google/oauth-callback",
]);
// ChatGPT's older per-connector callback: https://chatgpt.com/connector/oauth/{callback_id}
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
// Cline's VS Code extension: vscode://saoudrizwan.claude-dev/mcp-auth/callback/<hash> (from its source).
const CLINE_CALLBACK = /^vscode:\/\/saoudrizwan\.claude-dev\/mcp-auth\/callback\/[A-Za-z0-9_-]{1,128}$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A loopback redirect (RFC 8252): http, a loopback host, any port, and nothing hidden in userinfo. */
function loopback(uri: string): URL | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    if (url.username || url.password || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Whether this server will ever send an authorization code to this URI. */
export function isAllowedRedirectUri(uri: string, extra: string[] = []): boolean {
  if (typeof uri !== "string" || uri.length > 2048) return false;
  if (loopback(uri)) return true;
  return EXACT_REDIRECTS.has(uri) || CHATGPT_CALLBACK.test(uri) || CLINE_CALLBACK.test(uri) || extra.includes(uri);
}

/** Does the requested redirect match one the client registered? Loopback ports are ignored (RFC 8252 7.3). */
function redirectMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  const req = loopback(requested);
  if (!req) return false;
  return registered.some(r => {
    const reg = loopback(r);
    return Boolean(reg && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search);
  });
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri;
  }
};

// ---------------------------------------------------------------------------
// Clients: dynamic registration (sealed client_id) and Client ID Metadata Documents
// ---------------------------------------------------------------------------

interface Client {
  clientId: string;
  name: string;
  /** Who vouches for the name: the CIMD host, or nobody (DCR names are self-asserted). */
  verifiedHost?: string;
  /** The logo the CIMD document publishes (never taken from a self-asserted DCR registration). */
  logoUri?: string;
  redirectUris: string[];
  authMethod: "none" | "client_secret_basic" | "client_secret_post";
}

const CLIENT_PREFIX = "smc_";
const cimdCache = new Map<string, { client: Client; expires: number }>();

function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    v6.startsWith("::") || // ::, ::1, ::/96 and ::ffff: in hex form
    /^f[cd]/.test(v6) || // unique local fc00::/7
    /^fe[89ab]/.test(v6) || // link local fe80::/10
    v6.startsWith("ff") || // multicast
    v6.startsWith("64:ff9b:") || // NAT64
    v6.startsWith("2002:") || // 6to4
    v6.startsWith("100::") // discard
  );
}

export interface GuardedResponse {
  contentType: string;
  body: Buffer;
}

/**
 * GET a public https URL with no redirects, a size cap and an overall deadline, refusing private and loopback
 * addresses (checked on the address actually connected to). Used for client metadata documents and app logos.
 */
export function guardedGet(url: URL, opts: { accept: string; maxBytes: number; timeoutMs: number }): Promise<GuardedResponse> {
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.startsWith("[") || isIP(url.hostname)) {
    return Promise.reject(new Error("only https URLs on a host name are fetched"));
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: { Accept: opts.accept, "User-Agent": "spidra-mcp" },
        // One deadline for the whole request, so a server that drips a byte at a time can't hold it open.
        signal: AbortSignal.timeout(opts.timeoutMs),
        // Check the address actually connected to, so DNS can't be swapped between a check and the connection.
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true })
            .then(addresses => {
              const ok = addresses.find(a => !isPrivateAddress(a.address));
              if (!ok || addresses.some(a => isPrivateAddress(a.address))) {
                callback(new Error("client_id host resolves to a private address"), "", 4);
                return;
              }
              if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
              else callback(null, ok.address, ok.family);
            })
            .catch(err => callback(err, "", 4));
        },
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            req.destroy(new Error(`larger than ${opts.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchMetadataDocument(url: URL): Promise<unknown> {
  const { body } = await guardedGet(url, { accept: "application/json", maxBytes: 64 * 1024, timeoutMs: 5000 });
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("not valid JSON");
  }
}

const cimdFailures = new Map<string, number>(); // client_id -> until when to refuse without fetching again

async function resolveCimdClient(clientId: string): Promise<Client> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.expires > Date.now()) return cached.client;
  if ((cimdFailures.get(clientId) ?? 0) > Date.now()) {
    throw new OAuthError("invalid_client", "Couldn't read the app's metadata document. Try again in a minute.");
  }

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("invalid_client", "client_id isn't a valid URL.");
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password || url.hostname.startsWith("[") || isIP(url.hostname)) {
    throw new OAuthError("invalid_client", "A URL client_id must be an https URL with a path, on a host name.");
  }
  const doc = (await fetchMetadataDocument(url).catch(err => {
    // The detail goes to the log, not the page: it can say things about the network this server is on.
    logger.warn(`OAuth: couldn't read the client metadata document ${clientId}: ${err.message}`);
    cimdFailures.set(clientId, Date.now() + 60_000);
    if (cimdFailures.size > 1000) cimdFailures.delete(cimdFailures.keys().next().value!);
    throw new OAuthError("invalid_client", "Couldn't read the app's metadata document.");
  })) as Record<string, unknown>;
  if (!doc || typeof doc !== "object" || doc.client_id !== clientId) {
    throw new OAuthError("invalid_client", "The client metadata document's client_id doesn't match its URL.");
  }
  const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!redirectUris.length) throw new OAuthError("invalid_client", "The client metadata document lists no redirect_uris.");

  const client: Client = {
    clientId,
    name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : url.host,
    verifiedHost: url.host,
    ...(typeof doc.logo_uri === "string" ? { logoUri: doc.logo_uri } : {}),
    redirectUris,
    // CIMD clients are public: we don't support private_key_jwt, so PKCE is what protects the code.
    authMethod: "none",
  };
  cimdCache.set(clientId, { client, expires: Date.now() + 10 * 60 * 1000 });
  if (cimdCache.size > 500) cimdCache.delete(cimdCache.keys().next().value!);
  return client;
}

// ---------------------------------------------------------------------------
// App logos on the consent page
// ---------------------------------------------------------------------------

// Known clients by the host that publishes their metadata document. Their real logo is shown only when the client is
// verified on that host: a self-registered (DCR) app calling itself "Claude" gets its initial, not Claude's logo.
const KNOWN_HOSTS: [RegExp, (clientId: string) => string][] = [
  [/(^|\.)claude\.(ai|com)$/, () => "claude"],
  [/(^|\.)(chatgpt|openai)\.com$/, id => (/codex/i.test(id) ? "codex" : "chatgpt")],
  [/(^|\.)vscode\.dev$|^code\.visualstudio\.com$/, () => "vscode"],
  [/(^|\.)cursor\.(com|sh)$/, () => "cursor"],
  [/(^|\.)(windsurf|codeium)\.com$/, () => "windsurf"],
  [/^github\.com$|(^|\.)githubcopilot\.com$/, () => "copilot"],
  [/(^|\.)geminicli\.com$|^gemini\.google\.com$/, () => "gemini"],
];

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
const logoCache = new Map<string, { value?: string; expires: number }>();

/** The bytes really are the image type they claim (SVG is checked for an svg element). */
function looksLike(type: string, body: Buffer): boolean {
  if (type === "image/png") return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === "image/jpeg") return body[0] === 0xff && body[1] === 0xd8;
  if (type === "image/gif") return body.subarray(0, 3).toString("latin1") === "GIF";
  if (type === "image/webp") return body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP";
  return /<svg[\s>]/i.test(body.subarray(0, 4096).toString("utf8"));
}

/**
 * The logo to show for a client, as a data URI, or undefined for its initial. The page only allows data: images, so
 * a published logo is fetched here (https, public addresses only, 100 KB, 3 s, image types only) and inlined.
 * Shown inside <img>, an SVG can't run scripts.
 */
export async function logoForClient(client: { clientId: string; verifiedHost?: string; logoUri?: string }): Promise<string | undefined> {
  if (!client.verifiedHost) return undefined;
  const host = client.verifiedHost.toLowerCase().replace(/:\d+$/, "");
  const known = KNOWN_HOSTS.find(([re]) => re.test(host));
  if (known) return CLIENT_LOGOS[known[1](client.clientId)];
  if (!client.logoUri) return undefined;
  const cached = logoCache.get(client.logoUri);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value: string | undefined;
  try {
    const { contentType, body } = await guardedGet(new URL(client.logoUri), { accept: "image/*", maxBytes: 100 * 1024, timeoutMs: 3000 });
    const type = contentType.split(";")[0].trim().toLowerCase();
    if (IMAGE_TYPES.has(type) && looksLike(type, body)) value = `data:${type};base64,${body.toString("base64")}`;
  } catch (err) {
    logger.debug(`OAuth: couldn't fetch the logo ${client.logoUri}: ${(err as Error).message}`);
  }
  logoCache.set(client.logoUri, { value, expires: Date.now() + (value ? 60 : 10) * 60_000 });
  if (logoCache.size > 500) logoCache.delete(logoCache.keys().next().value!);
  return value;
}

// ---------------------------------------------------------------------------
// Errors and HTTP helpers
// ---------------------------------------------------------------------------

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
    readonly headers: Record<string, string> = {}
  ) {
    super(description);
  }
}

/** The sign-in service is busy or down: a 503 the client retries, never an error that makes it sign the user out. */
const unavailable = () =>
  new OAuthError("temporarily_unavailable", "Sign-in is temporarily unavailable. Try again in a moment.", 503, { "Retry-After": "30" });

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

// No form-action: Chrome and WebKit apply it to every redirect after the form is posted (the backend login, then the
// app's own callback, which can be a custom scheme), so Approve would be blocked. frame-ancestors 'none' and
// X-Frame-Options stop clickjacking, and the form posts to a fixed relative path. tests/consent-browser.test.mjs
// clicks Approve in Chromium, WebKit and Firefox to keep it that way.
export const CONSENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; frame-ancestors 'none'; base-uri 'none'";

function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CONSENT_CSP,
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  res.end();
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new OAuthError("invalid_request", "Request body too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));
    } catch {
      throw new OAuthError("invalid_request", "Body isn't valid JSON.");
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // A badly encoded cookie from elsewhere on the domain: skip it rather than fail the sign-in.
    }
  }
  return out;
}

/** POST to the backend's /oauth/token or /oauth/revoke with this server's client credentials (HTTP Basic). */
async function upstreamToken(
  cfg: OAuthConfig,
  params: Record<string, string>,
  endpoint: "token" | "revoke" = "token"
): Promise<{ status: number; body: Record<string, unknown> }> {
  const basic = Buffer.from(`${encodeURIComponent(cfg.upstreamClientId)}:${encodeURIComponent(cfg.upstreamClientSecret)}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(`${cfg.upstreamApiUrl}/oauth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.error(`OAuth: the backend's /oauth/${endpoint} can't be reached: ${(err as Error).message}`);
    throw unavailable();
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------


interface Txn extends Record<string, unknown> {
  c: string; // client_id
  r: string; // client redirect_uri
  s?: string; // client state
  cc: string; // PKCE code_challenge (S256)
  n: string; // browser nonce, also in the consent cookie
}

interface Code extends Record<string, unknown> {
  u: string; // the backend's authorization code
  c: string; // client_id
  r: string; // redirect_uri
  cc: string; // PKCE code_challenge
}

export interface VerifiedToken {
  apiKey: string;
  clientId: string;
  expiresAt: number;
}

export class OAuthProvider {
  private readonly sealer: Sealer;

  constructor(readonly cfg: OAuthConfig) {
    // MCP_OAUTH_SIGNING_KEYS (comma-separated, newest first) allows a rotation without signing everyone out;
    // MCP_OAUTH_SIGNING_KEY is one key. Without either, the key is derived from the backend client secret, so
    // rotating that secret signs everyone out (MCP_SECOND_REVIEW L10).
    const keys = (process.env.MCP_OAUTH_SIGNING_KEYS || process.env.MCP_OAUTH_SIGNING_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
    if (!keys.length && cfg.baseUrl.startsWith("https://")) {
      logger.warn("MCP_OAUTH_SIGNING_KEY isn't set, so OAuth blobs are sealed with a key derived from MCP_OAUTH_CLIENT_SECRET. Set a separate signing key.");
    }
    this.sealer = new Sealer(keys.length ? keys : [cfg.upstreamClientSecret]);
  }

  get resourceMetadataUrl(): string {
    return `${this.cfg.baseUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  protectedResourceMetadata() {
    return {
      resource: this.cfg.resource,
      authorization_servers: [this.cfg.baseUrl],
      bearer_methods_supported: ["header"],
      resource_name: "Spidra",
      resource_documentation: "https://docs.spidra.io/mcp-server",
    };
  }

  authorizationServerMetadata() {
    const base = this.cfg.baseUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [],
      service_documentation: "https://docs.spidra.io/mcp-server",
    };
  }

  /** The WWW-Authenticate value for a 401 on /mcp. */
  challenge(error?: { code: string; description: string }): string {
    const parts = [`resource_metadata="${this.resourceMetadataUrl}"`];
    if (error) parts.unshift(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`);
    return `Bearer ${parts.join(", ")}`;
  }

  // -- token verification on /mcp --------------------------------------------

  /**
   * Unwrap an access token we issued and get the API credential for it. Undefined when it isn't valid.
   *
   * No call to the backend: the sealed token holds the backend's access token, which is what the API accepts as the
   * credential (the backend's /oauth/introspect hands back that same token), and it expires with ours. The backend's
   * token is a stateless JWT with no revocation, so introspecting it on every request would add nothing but a shared
   * rate limit and an outage that signs people out (MCP_SECOND_REVIEW H3). If the backend ever starts revoking
   * tokens, the API answers 401 on use.
   */
  verifyAccessToken(token: string): VerifiedToken | undefined {
    const opened = this.sealer.open<{ u: string; c: string; aud: string; exp: number }>("access", token);
    if (!opened || opened.aud !== this.cfg.resource || typeof opened.u !== "string") return undefined;
    return { apiKey: opened.u, clientId: opened.c, expiresAt: opened.exp };
  }

  // -- routing ----------------------------------------------------------------

  /** Handles OAuth and discovery routes. Returns false when the path isn't one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    try {
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        if (method === "OPTIONS") return this.preflight(res), true;
        sendJson(res, 200, this.protectedResourceMetadata(), { "Access-Control-Allow-Origin": "*" });
        return true;
      }
      if (
        path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/oauth-authorization-server/mcp"
      ) {
        if (method === "OPTIONS") return this.preflight(res), true;
        sendJson(res, 200, this.authorizationServerMetadata(), { "Access-Control-Allow-Origin": "*" });
        return true;
      }
      if (path === "/oauth/register") {
        if (method === "OPTIONS") return this.preflight(res), true;
        if (method !== "POST") return this.methodNotAllowed(res), true;
        await this.register(req, res);
        return true;
      }
      if (path === "/oauth/authorize" && method === "GET") {
        await this.authorize(req, res, url);
        return true;
      }
      if (path === "/oauth/consent" && method === "POST") {
        await this.consent(req, res);
        return true;
      }
      if (path === "/oauth/callback" && method === "GET") {
        this.callback(req, res, url);
        return true;
      }
      if (path === "/oauth/token") {
        if (method === "OPTIONS") return this.preflight(res), true;
        if (method !== "POST") return this.methodNotAllowed(res), true;
        await this.token(req, res);
        return true;
      }
      if (path === "/oauth/revoke") {
        if (method === "OPTIONS") return this.preflight(res), true;
        if (method !== "POST") return this.methodNotAllowed(res), true;
        await this.revoke(req, res);
        return true;
      }
    } catch (err) {
      if (res.headersSent) return true;
      if (err instanceof OAuthError) {
        sendJson(res, err.status, { error: err.code, error_description: err.description }, { "Access-Control-Allow-Origin": "*", ...err.headers });
      } else {
        logger.error("OAuth endpoint failed:", err);
        sendJson(res, 500, { error: "server_error", error_description: "Something went wrong. Try again." });
      }
      return true;
    }
    return false;
  }

  private preflight(res: ServerResponse): void {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
  }

  private methodNotAllowed(res: ServerResponse): void {
    sendJson(res, 405, { error: "invalid_request", error_description: "Method not allowed." });
  }

  // -- dynamic client registration (RFC 7591) ---------------------------------

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof OAuthError) throw err;
      throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 10 || redirectUris.some(u => typeof u !== "string")) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a list of 1 to 10 URLs.");
    }
    const rejected = (redirectUris as string[]).find(u => !isAllowedRedirectUri(u, this.cfg.extraRedirectUris));
    if (rejected) {
      throw new OAuthError(
        "invalid_redirect_uri",
        `Redirect URI not allowed: ${rejected}. Spidra accepts loopback redirects (http://localhost or http://127.0.0.1, any port) and the hosted callbacks of supported clients. To use another client, connect with an API key instead.`
      );
    }
    const requested = body.token_endpoint_auth_method;
    const authMethod: Client["authMethod"] =
      requested === "none" || requested === "client_secret_post" || requested === "client_secret_basic" ? requested : "client_secret_basic";
    if (requested !== undefined && requested !== authMethod) {
      throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method "${String(requested)}" isn't supported.`);
    }
    if (JSON.stringify(redirectUris).length > 2048) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris are too long in total (2 KB at most).");
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;

    const clientId = CLIENT_PREFIX + this.sealer.seal("client", { r: redirectUris, n: name, a: authMethod });
    // The client_id rides inside the sign-in transaction, which has to fit in one sealed blob.
    if (clientId.length > MAX_BLOB / 2) throw new OAuthError("invalid_client_metadata", "The registration is too large.");
    const now = Math.floor(Date.now() / 1000);
    sendJson(
      res,
      201,
      {
        client_id: clientId,
        client_id_issued_at: now,
        ...(authMethod === "none" ? {} : { client_secret: this.sealer.mac(clientId), client_secret_expires_at: 0 }),
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: authMethod,
        ...(typeof body.application_type === "string" ? { application_type: body.application_type } : {}),
      },
      { "Access-Control-Allow-Origin": "*" }
    );
  }

  private async resolveClient(clientId: string | null): Promise<Client> {
    if (!clientId) throw new OAuthError("invalid_request", "client_id is required.");
    if (clientId.startsWith("https://")) return resolveCimdClient(clientId);
    if (clientId.startsWith(CLIENT_PREFIX)) {
      const sealed = this.sealer.open<{ r: string[]; n?: string; a: Client["authMethod"] }>("client", clientId.slice(CLIENT_PREFIX.length));
      if (sealed && Array.isArray(sealed.r)) {
        return { clientId, name: sealed.n || "An unnamed app", redirectUris: sealed.r, authMethod: sealed.a ?? "client_secret_basic" };
      }
    }
    throw new OAuthError(
      "invalid_client",
      "Unknown client_id. Clients registered before this server's OAuth upgrade need to register again (most clients do this when you reconnect)."
    );
  }

  // -- authorization endpoint -------------------------------------------------

  private async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams;
    let client: Client;
    try {
      client = await this.resolveClient(q.get("client_id"));
    } catch (err) {
      const message = err instanceof OAuthError ? err.description : "Unknown client.";
      sendHtml(res, 400, renderErrorPage("This sign-in link isn't valid", message));
      return;
    }
    const redirectUri = q.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
    if (!redirectUri || !redirectMatches(redirectUri, client.redirectUris) || !isAllowedRedirectUri(redirectUri, this.cfg.extraRedirectUris)) {
      // Never redirect to a URI we can't trust; show the error here instead.
      sendHtml(res, 400, renderErrorPage("This sign-in link isn't valid", "The app's redirect address isn't registered or isn't allowed."));
      return;
    }

    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string) => redirect(res, this.clientRedirect(redirectUri, { error, error_description: description, state }));

    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
    }
    const resource = q.get("resource");
    if (resource && !this.isOurResource(resource)) return fail("invalid_target", `Tokens here are only for ${this.cfg.resource}.`);

    const nonce = randomBytes(16).toString("base64url");
    const txn = this.sealer.seal("txn", { c: client.clientId, r: redirectUri, s: state, cc: challenge, n: nonce } satisfies Txn, TTL.txn);
    sendHtml(
      res,
      200,
      renderConsentPage({
        clientName: client.name,
        verifiedHost: client.verifiedHost,
        appLogo: await logoForClient(client),
        redirectHost: hostOf(redirectUri),
        loopbackOnly: Boolean(loopback(redirectUri)),
        transaction: txn,
      }),
      { "Set-Cookie": this.cookie(nonce, nonce, TTL.txn) }
    );
  }

  private async consent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const txn = this.sealer.open<Txn>("txn", form.transaction);
    if (!txn) {
      sendHtml(res, 400, renderErrorPage("This sign-in has expired", "Go back to your app and connect again."));
      return;
    }
    const cookie = parseCookies(req.headers.cookie)[this.cookieName(txn.n)];
    if (!cookie || !safeEqual(cookie, txn.n)) {
      sendHtml(res, 400, renderErrorPage("This sign-in can't be confirmed", "Start the connection again from your app, in this browser."));
      return;
    }
    if (form.action !== "approve") {
      redirect(res, this.clientRedirect(txn.r, { error: "access_denied", error_description: "You denied access.", state: txn.s }), {
        "Set-Cookie": this.cookie(txn.n, "", 0),
      });
      return;
    }
    // The transaction rides through the backend login as its state, and comes back to /oauth/callback.
    const upstream = new URL(`${this.cfg.upstreamApiUrl}/oauth/authorize`);
    upstream.searchParams.set("client_id", this.cfg.upstreamClientId);
    upstream.searchParams.set("redirect_uri", `${this.cfg.baseUrl}/oauth/callback`);
    upstream.searchParams.set("response_type", "code");
    upstream.searchParams.set("state", form.transaction);
    redirect(res, upstream.toString());
  }

  private callback(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const q = url.searchParams;
    const txn = this.sealer.open<Txn>("txn", q.get("state"));
    if (!txn) {
      sendHtml(res, 400, renderErrorPage("This sign-in has expired", "Go back to your app and connect again."));
      return;
    }
    const cookie = parseCookies(req.headers.cookie)[this.cookieName(txn.n)];
    if (!cookie || !safeEqual(cookie, txn.n)) {
      sendHtml(res, 400, renderErrorPage("This sign-in can't be confirmed", "Start the connection again from your app, in this browser."));
      return;
    }
    const clear = { "Set-Cookie": this.cookie(txn.n, "", 0) };
    const upstreamError = q.get("error");
    const upstreamCode = q.get("code");
    if (upstreamError || !upstreamCode) {
      redirect(
        res,
        this.clientRedirect(txn.r, { error: upstreamError || "server_error", error_description: q.get("error_description") ?? "Sign-in failed.", state: txn.s }),
        clear
      );
      return;
    }
    const code = this.sealer.seal("code", { u: upstreamCode, c: txn.c, r: txn.r, cc: txn.cc } satisfies Code, TTL.code);
    redirect(res, this.clientRedirect(txn.r, { code, state: txn.s }), clear);
  }

  // -- token endpoint ---------------------------------------------------------

  /** Client authentication for /token and /revoke: HTTP Basic first, then client_id and client_secret in the form. */
  private async authenticateClient(req: IncomingMessage, form: Record<string, string>): Promise<Client> {
    const basic = String(req.headers.authorization ?? "");
    let clientId = form.client_id;
    let clientSecret = form.client_secret;
    if (basic.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(basic.slice(6).trim(), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i > 0) {
        try {
          clientId = decodeURIComponent(decoded.slice(0, i));
          clientSecret = decodeURIComponent(decoded.slice(i + 1));
        } catch {
          throw new OAuthError("invalid_client", "Client authentication failed: the Basic credentials aren't valid.", 401);
        }
      }
    }
    const client = await this.resolveClient(clientId ?? null).catch(err => {
      throw err instanceof OAuthError ? new OAuthError("invalid_client", err.description, 401) : err;
    });
    if (client.authMethod !== "none") {
      if (!clientSecret || !this.sealer.checkMac(client.clientId, clientSecret)) {
        throw new OAuthError("invalid_client", "Client authentication failed.", 401);
      }
    }
    return client;
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const client = await this.authenticateClient(req, form);
    if (form.resource && !this.isOurResource(form.resource)) {
      throw new OAuthError("invalid_target", `Tokens here are only for ${this.cfg.resource}.`);
    }

    if (form.grant_type === "authorization_code") {
      const code = this.sealer.open<Code>("code", form.code);
      if (!code || code.c !== client.clientId) throw new OAuthError("invalid_grant", "The authorization code is invalid or expired.");
      if (form.redirect_uri && form.redirect_uri !== code.r) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
      const verifier = form.code_verifier;
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256(verifier), code.cc)) {
        throw new OAuthError("invalid_grant", "PKCE verification failed.");
      }
      const upstream = await upstreamToken(this.cfg, {
        grant_type: "authorization_code",
        code: code.u,
        redirect_uri: `${this.cfg.baseUrl}/oauth/callback`,
        // Which app this is, for the Connected apps list in the dashboard. Sent server to server, so the browser
        // can't change it. A metadata-document client is named by its URL; a registered one by a hash of its id,
        // which is long and means nothing to a person.
        mcp_client_id: client.clientId.startsWith("https://") ? client.clientId : `dcr:${sha256(client.clientId).slice(0, 22)}`,
        mcp_client_name: client.name.slice(0, 120),
      });
      this.sendTokens(res, client, upstream);
      return;
    }

    if (form.grant_type === "refresh_token") {
      const refresh = this.sealer.open<{ u: string; c: string }>("refresh", form.refresh_token);
      if (!refresh || refresh.c !== sha256(client.clientId)) throw new OAuthError("invalid_grant", "The refresh token is invalid.");
      const upstream = await upstreamToken(this.cfg, { grant_type: "refresh_token", refresh_token: refresh.u });
      this.sendTokens(res, client, upstream);
      return;
    }

    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  // -- revocation (RFC 7009) -----------------------------------------------------

  /**
   * Revokes one of our refresh or access tokens by forwarding the backend token inside it to the backend's
   * /oauth/revoke. Revoking a refresh token ends the whole connection: it and every token rotated from it stop
   * working. The backend's access tokens are stateless, so a revoked access token runs out on its own (15 minutes).
   *
   * Answers 200 for any token we can't open (unknown, expired, another client's, or garbage), as RFC 7009 asks, so
   * the endpoint can't be used to probe tokens. Client credentials are optional: holding the token is enough to
   * give it up, but credentials that are sent must be right. 503 only when the backend can't be reached, so the
   * client can try again instead of believing the token is dead.
   */
  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const hasCredentials = !!form.client_id || String(req.headers.authorization ?? "").toLowerCase().startsWith("basic ");
    const client = hasCredentials ? await this.authenticateClient(req, form) : undefined;
    if (!form.token) throw new OAuthError("invalid_request", "token is required.");
    const ok = () => sendJson(res, 200, {}, { "Access-Control-Allow-Origin": "*" });

    const hint = form.token_type_hint;
    const asRefresh = () => this.sealer.open<{ u: string; c: string }>("refresh", form.token);
    const asAccess = () => this.sealer.open<{ u: string; c: string; aud: string }>("access", form.token);
    let upstream: string | undefined;
    if (hint === "access_token") {
      const a = asAccess();
      if (a && (!client || a.c === client.clientId)) upstream = a.u;
      else {
        const r = asRefresh();
        if (r && (!client || r.c === sha256(client.clientId))) upstream = r.u;
      }
    } else {
      const r = asRefresh();
      if (r && (!client || r.c === sha256(client.clientId))) upstream = r.u;
      else {
        const a = asAccess();
        if (a && (!client || a.c === client.clientId)) upstream = a.u;
      }
    }
    if (typeof upstream !== "string" || !upstream) return ok();

    const result = await upstreamToken(this.cfg, { token: upstream }, "revoke");
    if (result.status === 429 || result.status >= 500) {
      logger.error(`OAuth: the backend's /oauth/revoke answered HTTP ${result.status}`);
      throw unavailable();
    }
    if (result.status === 401) {
      logger.error("OAuth: the backend refused this server's client credentials on /oauth/revoke.");
      throw new OAuthError("server_error", "Revocation is misconfigured on the server. Try again later.", 500);
    }
    ok();
  }

  private sendTokens(res: ServerResponse, client: Client, upstream: { status: number; body: Record<string, unknown> }): void {
    const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = upstream.body;
    if (upstream.status !== 200 || typeof access !== "string") {
      const error = typeof upstream.body.error === "string" ? upstream.body.error : undefined;
      // Busy or down: the grant is still good, so the client should retry, not drop the refresh token.
      if (upstream.status === 429 || upstream.status >= 500 || upstream.status === 200) {
        logger.error(`OAuth: the backend's /oauth/token answered HTTP ${upstream.status}`);
        throw unavailable();
      }
      // Our own credentials were refused: a server problem, not the user's.
      if (upstream.status === 401 || error === "invalid_client") {
        logger.error("OAuth: the backend refused this server's client credentials (MCP_OAUTH_CLIENT_ID / SECRET).");
        throw new OAuthError("server_error", "Sign-in is misconfigured on the server. Try again later.", 500);
      }
      // The backend answers invalid_grant for a used, expired or revoked code or refresh token.
      if (error === "invalid_grant" || !error) throw new OAuthError("invalid_grant", "The grant was rejected. Sign in again.");
      throw new OAuthError(error, typeof upstream.body.error_description === "string" ? upstream.body.error_description : "The sign-in request was refused.");
    }
    const ttl = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
    const accessToken = this.sealer.seal("access", { u: access, c: client.clientId, aud: this.cfg.resource }, ttl);
    sendJson(
      res,
      200,
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ttl,
        ...(typeof refresh === "string" ? { refresh_token: this.sealer.seal("refresh", { u: refresh, c: sha256(client.clientId) }) } : {}),
      },
      { "Access-Control-Allow-Origin": "*", Pragma: "no-cache" }
    );
  }

  // -- helpers ------------------------------------------------------------------

  private isOurResource(resource: string): boolean {
    const r = resource.replace(/\/+$/, "");
    return r === this.cfg.resource || r === this.cfg.baseUrl;
  }

  private clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("iss", this.cfg.baseUrl); // RFC 9207
    return url.toString();
  }

  /**
   * One cookie per sign-in, so two sign-ins in parallel (two servers in one client, or two clients) don't overwrite
   * each other's nonce. On https it has the __Host- prefix, so no other *.spidra.io page can plant it.
   */
  private cookieName(nonce: string): string {
    const id = `smc_${sha256(`cookie:${nonce}`).slice(0, 10)}`;
    return this.cfg.baseUrl.startsWith("https://") ? `__Host-${id}` : id;
  }

  private cookie(nonce: string, value: string, maxAge: number): string {
    const secure = this.cfg.baseUrl.startsWith("https://") ? "; Secure" : "";
    return `${this.cookieName(nonce)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }
}
