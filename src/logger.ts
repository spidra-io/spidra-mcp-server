// stdio uses stdout for JSON-RPC framing, so this logger is silent there. Over HTTP it writes to stderr, which PM2
// keeps in the error log, and stdout stays free for the request log.

export const HTTP_MODE = process.env.HTTP_STREAMABLE_SERVER === "true";

const stamp = () => new Date().toISOString();

export const logger = {
  debug(...args: unknown[]): void {
    if (HTTP_MODE && process.env.MCP_DEBUG === "true") console.error("[DEBUG]", stamp(), ...args);
  },
  info(...args: unknown[]): void {
    if (HTTP_MODE) console.log("[INFO]", stamp(), ...args);
  },
  warn(...args: unknown[]): void {
    if (HTTP_MODE) console.error("[WARN]", stamp(), ...args);
  },
  error(...args: unknown[]): void {
    if (HTTP_MODE) console.error("[ERROR]", stamp(), ...args);
  },
};
