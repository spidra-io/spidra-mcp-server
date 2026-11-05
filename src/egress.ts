// AI platforms that call MCP servers from their own servers, not from the user's machine: claude.ai, Claude
// Desktop, mobile and Cowork (Anthropic) and ChatGPT (OpenAI). Everyone on one of those platforms reaches us from a
// small set of addresses, so a normal per-IP rate-limit bucket there would be shared by all of their users at once.
// http.ts gives these addresses their own, larger buckets. Clients that run on the user's machine (Claude Code,
// Cursor, VS Code, Windsurf and others) are ordinary callers and keep the normal limits.
import { logger } from "./logger.js";

export type Platform = "anthropic" | "openai";

type Range = [base: number, mask: number];

/**
 * Anthropic's published outbound ranges (https://platform.claude.com/docs/en/api/ip-addresses, checked 2026-11-05).
 * Anthropic says they "will not change without notice", so they are built in. IPv4 only; no IPv6 egress is listed.
 */
const ANTHROPIC = ["160.79.104.0/21", "153.61.208.0/20"];

/** OpenAI's published ChatGPT connector ranges. OpenAI says they change, so they are fetched, not built in. */
const OPENAI_URL = "https://openai.com/chatgpt-connectors.json";
const OPENAI_REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

export function ipv4ToInt(ip: string): number | undefined {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function parseCidr(cidr: string): Range | undefined {
  const [base, bitsText] = cidr.trim().split("/");
  const bits = Number(bitsText ?? "32");
  const n = ipv4ToInt(base ?? "");
  if (n === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return [(n & mask) >>> 0, mask];
}

const inRanges = (n: number, ranges: Range[]) => ranges.some(([base, mask]) => ((n & mask) >>> 0) === base);

const anthropic: Range[] = ANTHROPIC.map((c) => parseCidr(c)!);
let openai: Range[] = [];

/** Which platform an address belongs to, if any. */
export function platformOf(ip: string): Platform | undefined {
  const n = ipv4ToInt(ip);
  if (n === undefined) return undefined;
  if (inRanges(n, anthropic)) return "anthropic";
  if (inRanges(n, openai)) return "openai";
  return undefined;
}

/** Reads OpenAI's ranges from a chatgpt-connectors.json body. Undefined when it doesn't look like that file. */
export function parseOpenAiRanges(body: unknown): Range[] | undefined {
  const prefixes = (body as { prefixes?: unknown })?.prefixes;
  if (!Array.isArray(prefixes)) return undefined;
  const ranges = prefixes
    .map((p) => (typeof p?.ipv4Prefix === "string" ? parseCidr(p.ipv4Prefix) : undefined))
    .filter((r): r is Range => Boolean(r));
  return ranges.length ? ranges : undefined;
}

async function refreshOpenAi(url: string): Promise<void> {
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("file too large");
    const ranges = parseOpenAiRanges(JSON.parse(text));
    if (!ranges) throw new Error("no IPv4 prefixes in the file");
    openai = ranges;
    logger.info(`Loaded ${ranges.length} ChatGPT connector IP ranges`);
  } catch (err) {
    // Keep the last good list; ChatGPT callers fall back to the normal per-IP limits until it loads.
    logger.warn(`Couldn't load ChatGPT connector IP ranges from ${url}: ${(err as Error).message}`);
  }
}

/**
 * Loads OpenAI's ranges now and every 6 hours. MCP_OPENAI_EGRESS_URL overrides the file's address (tests), and
 * "off" turns the fetch off. Returns a function that stops the refresh.
 */
export function startEgressRefresh(): () => void {
  const url = process.env.MCP_OPENAI_EGRESS_URL || OPENAI_URL;
  if (url === "off") return () => {};
  void refreshOpenAi(url);
  const timer = setInterval(() => void refreshOpenAi(url), OPENAI_REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}
