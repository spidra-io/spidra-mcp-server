/**
 * Patches fastmcp's built-in consent screen with the Spidra design.
 * Runs automatically after `npm install` via the postinstall hook.
 *
 * fastmcp does not expose a way to customize the consent HTML via config,
 * so we rewrite the generateConsentScreen() method in the dist file.
 * If the method signature changes in a future fastmcp version this script
 * will detect the mismatch and exit cleanly rather than corrupting the file.
 *
 * fastmcp's bundler names its chunk files with a content hash (e.g.
 * chunk-OJG4XYXA.js), which changes on every fastmcp release — so we can't
 * hardcode a filename. Instead we scan fastmcp's dist directory for
 * whichever chunk actually contains the target method.
 *
 * Where fastmcp actually lives on disk also isn't fixed: npm may nest it
 * under spidra-mcp's own node_modules, or hoist it up to the consuming
 * project's top-level node_modules, depending on the wider dependency tree.
 * We resolve it via Node's own module resolution (same algorithm `import
 * "fastmcp"` uses at runtime) instead of assuming a fixed relative path.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOGO_PATH = join(ROOT, "img/logo.png");

const require = createRequire(import.meta.url);
let DIST_DIR;
try {
  // Resolve the bare specifier (not a package.json subpath, which fastmcp's
  // "exports" map blocks) — this walks node_modules exactly like a real
  // `import "fastmcp"` would, correctly finding it whether nested or hoisted.
  // The "require" condition lands on the .cjs build; we patch every dist
  // file with a matching chunk below (both .js and .cjs), so this is only
  // used to locate the directory, not the specific file that gets edited.
  DIST_DIR = dirname(require.resolve("fastmcp"));
} catch {
  console.warn("patch-fastmcp-consent: fastmcp package not found, skipping.");
  process.exit(0);
}

const START_MARKER = "  generateConsentScreen(data) {";
const END_MARKER = "  /**\n   * Sign consent data for cookie\n   */";

// ── locate every dist chunk that defines generateConsentScreen ─────────────────

let dirEntries;
try {
  dirEntries = readdirSync(DIST_DIR).filter((f) => f.endsWith(".js") || f.endsWith(".cjs"));
} catch {
  console.warn("patch-fastmcp-consent: fastmcp dist directory not found, skipping.");
  process.exit(0);
}

const targets = [];
for (const file of dirEntries) {
  const path = join(DIST_DIR, file);
  const text = readFileSync(path, "utf8");
  const startIdx = text.indexOf(START_MARKER);
  const endIdx = text.indexOf(END_MARKER, startIdx);
  if (startIdx !== -1 && endIdx !== -1) targets.push({ path, text, startIdx, endIdx });
}

if (targets.length === 0) {
  console.warn(
    "patch-fastmcp-consent: target method not found in any dist chunk — already patched or fastmcp's internals changed. Skipping."
  );
  process.exit(0);
}

// ── logo ──────────────────────────────────────────────────────────────────────

let logoSrc = "";
try {
  const logoB64 = readFileSync(LOGO_PATH).toString("base64");
  logoSrc = `data:image/png;base64,${logoB64}`;
} catch {
  console.warn("patch-fastmcp-consent: logo not found, rendering without it.");
}

// ── HTML template (matches spidra-frontend login/signup design) ───────────────

const HTML = `<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='UTF-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>Authorization Request</title>
  <link rel='preconnect' href='https://fonts.googleapis.com'>
  <link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>
  <link href='https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap' rel='stylesheet'>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --blue: #2563eb;
      --blue-hover: #1d4ed8;
      --gray-50: #f9fafb;
      --gray-200: #e5e7eb;
      --gray-300: #d1d5db;
      --gray-400: #9ca3af;
      --gray-600: #4b5563;
      --gray-700: #374151;
    }
    body {
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--gray-50);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
      color: var(--gray-700);
      -webkit-font-smoothing: antialiased;
    }
    .wrap { width: 100%; max-width: 448px; }
    .logo-row { display: flex; justify-content: center; margin-bottom: 24px; }
    .logo-row img { width: 50px; height: 50px; border-radius: 12px; }
    .card {
      background: #fff;
      border: 1px solid var(--gray-200);
      border-radius: 12px;
      padding: 32px;
    }
    .card-header { text-align: center; margin-bottom: 32px; }
    .card-header h1 { font-size: 24px; font-weight: 600; color: var(--gray-700); margin-bottom: 4px; letter-spacing: -0.01em; }
    .card-header p { font-size: 14px; color: var(--gray-600); }
    .card-header p span { font-size: 13px; color: var(--gray-400); }
    .app-info {
      background: var(--gray-50);
      border: 1px solid var(--gray-200);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .app-info h2 { font-size: 15px; font-weight: 600; color: var(--gray-700); margin-bottom: 12px; }
    .client-name { color: var(--blue); }
    .perm-label {
      font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
      text-transform: uppercase; color: var(--gray-400); margin-bottom: 8px;
    }
    .perm-list { list-style: none; }
    .perm-list li {
      font-size: 13px; color: var(--gray-600);
      padding: 5px 0 5px 20px; position: relative;
    }
    .perm-list li::before {
      content: '✓'; position: absolute; left: 0; top: 5px;
      font-size: 11px; font-weight: 700; color: #16a34a;
    }
    .warning {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-left: 3px solid #f59e0b;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 24px;
    }
    .warning p { font-size: 13px; color: #78350f; line-height: 1.5; }
    .actions { display: flex; gap: 12px; }
    button {
      flex: 1; padding: 12px 20px; border: none;
      border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: all 0.2s;
      font-family: 'Geist', -apple-system, sans-serif;
    }
    .approve { background: var(--blue); color: #fff; }
    .approve:hover { background: var(--blue-hover); }
    .deny { background: transparent; color: var(--gray-600); border: 1px solid var(--gray-300); }
    .deny:hover { background: var(--gray-50); }
    .footer { margin-top: 24px; text-align: center; font-size: 13px; color: var(--gray-600); }
    @media (prefers-color-scheme: dark) {
      body { background: #09090b; color: #fff; }
      .card { background: #0d1117; border-color: rgba(255,255,255,0.1); }
      .card-header h1 { color: #fff; }
      .card-header p { color: var(--gray-400); }
      .app-info { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1); }
      .app-info h2 { color: #fff; }
      .perm-list li { color: var(--gray-400); }
      .warning { background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.2); border-left-color: #f59e0b; }
      .warning p { color: #fcd34d; }
      .deny { background: transparent; color: var(--gray-400); border-color: rgba(255,255,255,0.1); }
      .deny:hover { background: rgba(255,255,255,0.05); color: #fff; }
      .footer { color: var(--gray-400); }
    }
  </style>
</head>
<body>
  <div class='wrap'>
    <div class='logo-row'>
      <img src='__LOGO__' alt='Spidra' />
    </div>
    <div class='card'>
      <div class='card-header'>
        <h1>Authorization Request</h1>
        <p>via <span>__PROVIDER__</span></p>
      </div>
      <div class='app-info'>
        <h2><span class='client-name'>__CLIENT__</span> requests access</h2>
        <div class='perm-label'>This will allow the app to</div>
        <ul class='perm-list'>__PERMS__</ul>
      </div>
      <div class='warning'>
        <p><strong>Important:</strong> Only approve if you trust this application. By approving, you authorize it to access your Spidra account.</p>
      </div>
      <form method='POST' action='/oauth/consent'>
        <input type='hidden' name='transaction_id' value='__TXN__'>
        <div class='actions'>
          <button type='submit' name='action' value='deny' class='deny'>Deny</button>
          <button type='submit' name='action' value='approve' class='approve'>Approve</button>
        </div>
      </form>
      <div class='footer'><p>This consent is required to prevent unauthorized access.</p></div>
    </div>
  </div>
</body>
</html>`;

// ── new method ────────────────────────────────────────────────────────────────

const newMethod = `  generateConsentScreen(data) {
    const { clientName, provider, scope, transactionId } = data;
    const esc = (s) => this.escapeHtml(s);
    const perms = scope.map((s) => "<li>" + esc(this.formatScope(s)) + "</li>").join("");
    return ${JSON.stringify(HTML.replace("__LOGO__", logoSrc))}
      .replace("__PROVIDER__", esc(provider))
      .replace("__CLIENT__", esc(clientName || "An application"))
      .replace("__PERMS__", perms)
      .replace("__TXN__", esc(transactionId));
  }
  `;

// ── apply ─────────────────────────────────────────────────────────────────────

for (const { path, text, startIdx, endIdx } of targets) {
  const patched = text.slice(0, startIdx) + newMethod + text.slice(endIdx);
  writeFileSync(path, patched, "utf8");
}
console.log(`✅  fastmcp consent screen patched with Spidra design (${targets.length} file(s)).`);
