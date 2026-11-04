// The OAuth consent and error pages. The design is the approved mock (internal-research-code consent_mock): a deep
// blue band where the app and Spidra connect, then the details card, the permissions and the two buttons, in light
// and dark mode. Everything is inline (styles, the Spidra logo, the app logo as a data URI), so the page's CSP stays
// strict: no scripts, images only from data:, styles and fonts only from Google Fonts.
import { readFileSync } from "node:fs";

let spidraLogo = "";
try {
  spidraLogo = `data:image/png;base64,${readFileSync(new URL("../img/logo.png", import.meta.url)).toString("base64")}`;
} catch {
  // Renders with an initial instead.
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --primary: #007aff; --ink: #1a1a1a; --gray: #4d4d4d; --muted: #737373; --line: #e2e2e2; --page: #fafafa; --card: #ffffff; --soft: #f8f8f8; }
  body {
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--page); color: var(--gray);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; -webkit-font-smoothing: antialiased;
    background-image: radial-gradient(rgba(0,122,255,0.10) 1px, transparent 1.3px); background-size: 16px 16px;
  }
  .wrap { width: 100%; max-width: 460px; }
  .card { background: var(--card); border: 0.5px solid var(--line); border-radius: 18px; overflow: hidden;
    box-shadow: 0 40px 80px -40px rgba(7,105,211,0.25), 0 8px 24px -12px rgba(0,0,0,0.08); }
  .band { position: relative; overflow: hidden; padding: 28px 28px 30px; color: #fff;
    background: radial-gradient(120% 140% at 0% 0%, #2D8CFF 0%, #007AFF 40%, #0657C2 100%); }
  .band::before { content: ""; position: absolute; inset: 0; opacity: 0.18; pointer-events: none;
    background-image: radial-gradient(rgba(255,255,255,0.95) 1px, transparent 1.3px); background-size: 14px 14px;
    -webkit-mask-image: linear-gradient(110deg, transparent 25%, black 75%); mask-image: linear-gradient(110deg, transparent 25%, black 75%); }
  .rings { position: absolute; right: -90px; top: 50%; transform: translateY(-50%); pointer-events: none; }
  .rings span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: 999px; border: 1px solid rgba(255,255,255,0.22); }
  .rings .glow { width: 220px; height: 220px; background: rgba(255,255,255,0.10); filter: blur(40px); border: 0; }
  .rings .r1 { width: 420px; height: 420px; } .rings .r2 { width: 300px; height: 300px; } .rings .r3 { width: 180px; height: 180px; }
  .pill { position: relative; display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px 4px 10px; border-radius: 999px;
    font-size: 12.5px; font-weight: 500; background: rgba(255,255,255,0.14); border: 0.5px solid rgba(255,255,255,0.28); }
  .pill i { width: 6px; height: 6px; border-radius: 999px; background: #fff; box-shadow: 0 0 0 4px rgba(255,255,255,0.18); }
  .link { position: relative; display: flex; align-items: center; justify-content: center; margin: 26px 0 22px; }
  .tile { width: 64px; height: 64px; border-radius: 16px; background: #fff; display: grid; place-items: center; flex: none;
    box-shadow: 0 14px 30px -12px rgba(0,20,80,0.55); }
  .tile img { width: 40px; height: 40px; border-radius: 9px; }
  .tile img.applogo { width: 36px; height: 36px; border-radius: 0; object-fit: contain; }
  .tile .initial { font-size: 26px; font-weight: 600; color: #0657C2; letter-spacing: -0.02em; }
  .wire { position: relative; width: 120px; height: 2px; margin: 0 6px;
    background-image: radial-gradient(rgba(255,255,255,0.9) 1.2px, transparent 1.5px); background-size: 8px 2px; background-repeat: repeat-x; }
  .wire::after { content: ""; position: absolute; top: 50%; left: 0; width: 8px; height: 8px; margin-top: -4px; border-radius: 999px; background: #fff;
    box-shadow: 0 0 12px 3px rgba(255,255,255,0.7); animation: travel 2.6s ease-in-out infinite; }
  @keyframes travel { 0% { left: 0; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { left: calc(100% - 8px); opacity: 0; } }
  .band h1 { position: relative; font-size: 24px; line-height: 1.2; font-weight: 500; letter-spacing: -0.02em; text-align: center; overflow-wrap: anywhere; }
  .band p { position: relative; margin-top: 8px; font-size: 14px; line-height: 1.5; color: rgba(255,255,255,0.8); text-align: center; }
  .body { padding: 22px 24px 24px; }
  .who { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 16px; border-bottom: 0.5px solid var(--line); }
  .who .name { font-size: 15px; font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
  .who .back { margin-top: 3px; font-size: 13px; color: var(--muted); }
  .who .back b { font-family: 'Geist Mono', ui-monospace, monospace; font-weight: 500; color: var(--gray); font-size: 12.5px; overflow-wrap: anywhere; }
  .tag { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; padding: 3px 10px; border-radius: 999px; }
  .tag.ok { color: #0657C2; background: rgba(0,122,255,0.08); border: 0.5px solid rgba(0,122,255,0.25); }
  .tag.ok::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: #007aff; }
  .tag.unverified { color: var(--muted); background: var(--soft); border: 0.5px solid var(--line); }
  .label { margin: 18px 0 10px; font-size: 12px; font-weight: 500; color: var(--muted); }
  .grid { display: grid; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .cell { background: var(--card); padding: 12px 14px 12px 12px; border-top: 1px solid var(--line); display: flex; gap: 10px; align-items: flex-start; }
  .cell:first-child { border-top: 0; }
  .cell .dot { margin: 0; flex: none; height: 20px; width: 14px; display: flex; align-items: center; justify-content: center; }
  .cell .dot::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: var(--primary); box-shadow: 0 0 0 4px rgba(0,122,255,0.10); }
  .cell strong { display: block; font-size: 13.5px; line-height: 20px; font-weight: 500; color: var(--ink); }
  .cell div > span { display: block; margin-top: 2px; font-size: 12.5px; color: var(--muted); line-height: 1.45; }
  .note { margin-top: 16px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
  .note strong { color: var(--ink); font-weight: 500; }
  .note a { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
  .body > .note:first-child { margin-top: 0; }
  .note.local { margin-top: 8px; padding: 10px 12px; border-radius: 10px; background: #fff8eb; border: 0.5px solid #f5d9a8; color: #7a4a0c; }
  .actions { display: flex; gap: 10px; margin-top: 20px; }
  .btn { flex: 1; height: 40px; border-radius: 10px; font: 400 14px 'Geist', sans-serif; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; transition: all .2s; }
  .btn:active { transform: scale(0.95); }
  .btn.light { background: #F8F8F8; color: #374151; border: 0.5px solid #B4B2B2;
    box-shadow: 0 65px 18px 0 rgba(161,161,161,0), 0 41px 17px 0 rgba(161,161,161,0.01), 0 23px 14px 0 rgba(161,161,161,0.05), 0 10px 10px 0 rgba(161,161,161,0.09), 0 3px 6px 0 rgba(161,161,161,0.1); }
  .btn.light:hover { background: #F0F0F0; }
  .btn.primary { color: #fff; border: 0; background: radial-gradient(50% 50% at 50% 50%, #007AFF 0%, #0866CD 100%);
    box-shadow: 0 147px 41px 0 rgba(7,105,211,0), 0 94px 38px 0 rgba(7,105,211,0.01), 0 53px 32px 0 rgba(7,105,211,0.05), 0 24px 24px 0 rgba(7,105,211,0.09), 0 6px 13px 0 rgba(7,105,211,0.1);
    position: relative; overflow: hidden; isolation: isolate; }
  .btn.primary:hover { opacity: 0.9; }
  .btn.primary::after { content: ""; position: absolute; inset: 0; z-index: -1; transform: translateX(-120%);
    background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.35) 50%, transparent 65%); animation: sheen 5.5s ease-in-out 2s infinite; }
  @keyframes sheen { 0%, 70% { transform: translateX(-120%); } 85%, 100% { transform: translateX(120%); } }
  .btn .arrow { transition: transform .2s ease; }
  .btn.primary:hover .arrow { transform: translateX(3px); }
  .foot { margin-top: 18px; text-align: center; font-size: 12.5px; color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .btn.primary::after, .wire::after { animation: none; } }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #fafafa; --gray: #d4d4d4; --muted: #a3a3a3; --line: rgba(255,255,255,0.10); --page: #09090b; --card: #0f1115; --soft: rgba(255,255,255,0.05); }
    body { background-image: radial-gradient(rgba(0,122,255,0.16) 1px, transparent 1.3px); }
    .btn.light { background: rgba(255,255,255,0.05); color: #e5e5e5; border-color: rgba(255,255,255,0.14); box-shadow: none; }
    .btn.light:hover { background: rgba(255,255,255,0.09); }
    .note.local { background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.25); color: #fcd34d; }
    .tag.ok { color: #7bbaff; background: rgba(0,122,255,0.12); border-color: rgba(0,122,255,0.35); }
  }`;

const ARROW = `<svg class="arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;

const spidraTile = () =>
  `<div class="tile">${spidraLogo ? `<img src="${spidraLogo}" alt="">` : `<span class="initial">S</span>`}</div>`;

/** The band at the top: the pill, then either the app and Spidra joined by the wire, or Spidra alone. */
function band(title: string, subtitle: string, appTile?: string): string {
  return `
      <div class="band">
        <div class="rings" aria-hidden="true"><span class="glow"></span><span class="r1"></span><span class="r2"></span><span class="r3"></span></div>
        <span class="pill"><i></i>MCP connection</span>
        <div class="link" aria-hidden="true">
          ${appTile ? `${appTile}\n          <div class="wire"></div>\n          ` : ""}${spidraTile()}
        </div>
        <h1>${esc(title)}</h1>
        <p>${esc(subtitle)}</p>
      </div>`;
}

function page(title: string, card: string, foot?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
  <main class="wrap">
    <section class="card">${card}
    </section>
    ${foot ? `<p class="foot">${esc(foot)}</p>` : ""}
  </main>
</body>
</html>`;
}

export interface ConsentPageData {
  /** The app's name: from its metadata document, or self-declared when it registered. */
  clientName: string;
  /** The host that published the app's metadata document (Client ID Metadata Document clients only). */
  verifiedHost?: string;
  /**
   * The app's logo as a data URI: a built-in one for a known client that's verified on its own domain, or the logo
   * its metadata document publishes. Never set for an unverified client, which gets its initial instead.
   */
  appLogo?: string;
  /** Where the browser goes after approval. Shown so a lookalike app can't hide where the code is sent. */
  redirectHost: string;
  /** The app only redirects to this computer (localhost), so any local program could be posing as it. */
  loopbackOnly: boolean;
  transaction: string;
}

export function renderConsentPage(data: ConsentPageData): string {
  const name = data.clientName.trim() || "An app";
  const initial = esc((Array.from(name)[0] ?? "A").toUpperCase());
  const appTile = `<div class="tile">${data.appLogo ? `<img class="applogo" src="${esc(data.appLogo)}" alt="">` : `<span class="initial">${initial}</span>`}</div>`;
  const tag = data.verifiedHost
    ? `<span class="tag ok">Verified · ${esc(data.verifiedHost)}</span>`
    : `<span class="tag unverified">Name not verified</span>`;
  const back = data.loopbackOnly ? "Returns to an app on this computer" : `Returns to <b>${esc(data.redirectHost)}</b>`;
  const card = `${band(`${name} wants to use your Spidra account`, "Approve to let it search, scrape and run your templates with your credits.", appTile)}
      <div class="body">
        <div class="who">
          <div>
            <div class="name">${esc(name)}</div>
            <div class="back">${back}</div>
          </div>
          ${tag}
        </div>
        <div class="label">It will be able to</div>
        <div class="grid">
          <div class="cell"><span class="dot"></span><div><strong>Get web data</strong><span>Search, scrape, crawl and parse documents, using your credits</span></div></div>
          <div class="cell"><span class="dot"></span><div><strong>Manage your saved work</strong><span>Run, save and delete templates, presets and monitors</span></div></div>
          <div class="cell"><span class="dot"></span><div><strong>See your account</strong><span>Your plan, credit balance and usage history</span></div></div>
        </div>
        <p class="note"><strong>Only approve if you started this.</strong> It can spend your credits until you disconnect it in <a href="https://app.spidra.io/dashboard/api-keys" target="_blank" rel="noopener">Connected apps</a>.</p>
        ${data.loopbackOnly ? `<p class="note local">This app signs in through your own computer (${esc(data.redirectHost)}). Approve only if you just connected it from Claude Code, Cursor, VS Code or another app you trust.</p>` : ""}
        <form class="actions" method="POST" action="/oauth/consent">
          <input type="hidden" name="transaction" value="${esc(data.transaction)}">
          <button class="btn light" type="submit" name="action" value="deny">Deny</button>
          <button class="btn primary" type="submit" name="action" value="approve">Approve ${ARROW}</button>
        </form>
      </div>`;
  return page("Connect to Spidra", card, "You'll sign in to Spidra next if you aren't already.");
}

export function renderErrorPage(title: string, message: string): string {
  const card = `${band(title, message)}
      <div class="body">
        <p class="note"><strong>Nothing was connected.</strong> Go back to your app and start the connection again. If it keeps happening, connect with an API key from app.spidra.io instead.</p>
      </div>`;
  return page(title, card);
}
