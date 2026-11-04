// The consent page in real browsers (Chromium, WebKit and Firefox): Approve has to reach the app's callback with a
// code, and Deny has to send access_denied. A fetch-based test can't catch a browser blocking the redirect after the
// form is posted, which is how a CSP form-action directive once broke sign-in in Chrome and Safari
// (MCP_SECOND_REVIEW C1). It also takes screenshots (light, dark, phone) and checks the layout.
//
// Needs Playwright's browsers (npx playwright install chromium webkit firefox); skips when they aren't there.
// Screenshots go to SPIDRA_CONSENT_SHOTS (default: a temp folder, printed at the end).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = process.env.SPIDRA_MCP_ENTRY || path.join(__dirname, "..", "dist", "index.js");
const SHOTS = process.env.SPIDRA_CONSENT_SHOTS || path.join(tmpdir(), "spidra-consent-shots");

let playwright;
try {
  playwright = await import("playwright");
} catch {}

async function launchable(name) {
  try {
    const b = await playwright[name].launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  const srv = createNetServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

// The backend's login: the user is already signed in, so it sends the code straight back (another origin, as in prod).
const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "up-code");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  res.writeHead(404).end();
});

// The app's loopback callback.
const hits = [];
const callback = createServer((req, res) => {
  hits.push(new URL(req.url, "http://127.0.0.1"));
  res.writeHead(200, { "Content-Type": "text/plain" }).end("callback ok");
});

let base;
let callbackUrl;
let child;

before(async () => {
  if (!playwright) return;
  await new Promise(r => backend.listen(0, "127.0.0.1", r));
  await new Promise(r => callback.listen(0, "127.0.0.1", r));
  callbackUrl = `http://127.0.0.1:${callback.address().port}/callback`;
  const port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      SPIDRA_API_KEY: "",
      HTTP_STREAMABLE_SERVER: "true",
      PORT: String(port),
      HOST: "127.0.0.1",
      SPIDRA_API_URL: `http://127.0.0.1:${backend.address().port}/api`,
      MCP_PUBLIC_URL: base,
      MCP_OAUTH_CLIENT_ID: "upstream",
      MCP_OAUTH_CLIENT_SECRET: "upstream-secret",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  mkdirSync(SHOTS, { recursive: true });
});

after(() => {
  child?.kill();
  backend.close();
  callback.close();
  if (playwright) console.log(`Consent page screenshots: ${SHOTS}`);
});

async function authorizeUrl(clientName = "Browser Test") {
  const reg = await (
    await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [callbackUrl], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const url = new URL(`${base}/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: reg.client_id, redirect_uri: callbackUrl, response_type: "code", state: "st", code_challenge: challenge, code_challenge_method: "S256" });
  return url.toString();
}

async function waitForHit(since) {
  for (let i = 0; i < 100 && hits.length <= since; i++) await new Promise(r => setTimeout(r, 50));
  return hits[since];
}

for (const name of ["chromium", "webkit", "firefox"]) {
  test(`${name}: Approve reaches the app's callback with a code, Deny with access_denied`, async t => {
    if (!playwright || !(await launchable(name))) return t.skip(`${name} isn't installed (npx playwright install ${name})`);
    const browser = await playwright[name].launch();
    try {
      const page = await browser.newPage();
      const violations = [];
      page.on("console", m => /Content Security Policy|form-action|Refused/i.test(m.text()) && violations.push(m.text()));

      await page.goto(await authorizeUrl());
      assert.equal(await page.title(), "Connect to Spidra");
      const since = hits.length;
      await page.click('button[value="approve"]');
      const hit = await waitForHit(since);
      assert.ok(hit, `${name} never reached the callback; console: ${violations.join(" | ")}`);
      assert.ok(hit.searchParams.get("code"), "a code came back");
      assert.equal(hit.searchParams.get("state"), "st");
      assert.equal(hit.searchParams.get("iss"), base);
      assert.deepEqual(violations, []);

      await page.goto(await authorizeUrl());
      const sinceDeny = hits.length;
      await page.click('button[value="deny"]');
      const denied = await waitForHit(sinceDeny);
      assert.equal(denied?.searchParams.get("error"), "access_denied");
    } finally {
      await browser.close();
    }
  });
}

test("screenshots: light, dark and phone, with the layout the design calls for", async t => {
  if (!playwright || !(await launchable("chromium"))) return t.skip("chromium isn't installed");
  const browser = await playwright.chromium.launch();
  try {
    const shots = [
      { file: "consent_light.png", colorScheme: "light", viewport: { width: 1280, height: 900 } },
      { file: "consent_dark.png", colorScheme: "dark", viewport: { width: 1280, height: 900 } },
      { file: "consent_phone.png", colorScheme: "light", viewport: { width: 375, height: 812 } },
    ];
    for (const shot of shots) {
      const page = await browser.newPage({ colorScheme: shot.colorScheme, viewport: shot.viewport, deviceScaleFactor: 2 });
      await page.goto(await authorizeUrl("Claude"));
      await page.waitForLoadState("networkidle").catch(() => {});
      const layout = await page.evaluate(() => {
        const css = sel => getComputedStyle(document.querySelector(sel));
        return {
          tiles: document.querySelectorAll(".link .tile").length,
          wire: Boolean(document.querySelector(".link .wire")),
          heading: document.querySelector(".band h1").textContent,
          initial: document.querySelector(".link .tile .initial")?.textContent,
          tag: document.querySelector(".tag").textContent,
          rows: document.querySelectorAll(".grid .cell").length,
          dots: [...document.querySelectorAll(".grid .cell .dot")].map(d => Math.round(d.getBoundingClientRect().left)),
          local: Boolean(document.querySelector(".note.local")),
          approveBg: css(".btn.primary").backgroundImage,
          cardBg: css(".card").backgroundColor,
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert.equal(layout.tiles, 2, "the app and Spidra tiles");
      assert.ok(layout.wire, "the wire between them");
      assert.equal(layout.heading, "Claude wants to use your Spidra account");
      // A self-registered app called "Claude" isn't verified, so it gets its initial, not Claude's logo.
      assert.equal(layout.initial, "C");
      assert.equal(layout.tag, "Name not verified");
      assert.equal(layout.rows, 3);
      assert.equal(new Set(layout.dots).size, 1, "the blue dots line up");
      assert.ok(layout.local, "the loopback note shows for a localhost callback");
      assert.match(layout.approveBg, /radial-gradient/);
      assert.equal(layout.cardBg, shot.colorScheme === "dark" ? "rgb(15, 17, 21)" : "rgb(255, 255, 255)");
      assert.equal(layout.overflowX, false, "no sideways scrolling");
      const file = path.join(SHOTS, shot.file);
      await page.screenshot({ path: file, fullPage: true });
      assert.ok(statSync(file).size > 20_000, `${shot.file} was written`);
      await page.close();
    }

    // The error page, in the same look.
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/oauth/authorize?client_id=smc_nonsense&redirect_uri=x`);
    assert.equal(await page.locator(".band h1").textContent(), "This sign-in link isn't valid");
    assert.equal(await page.locator(".link .tile").count(), 1, "Spidra alone");
    await page.screenshot({ path: path.join(SHOTS, "error_light.png"), fullPage: true });
  } finally {
    await browser.close();
  }
});

test("screenshots: a verified client (Claude Code's real metadata document) shows its real logo", async t => {
  if (!playwright || !(await launchable("chromium"))) return t.skip("chromium isn't installed");
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");
  const url = new URL(`${base}/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: "http://localhost:53682/callback", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
  const probe = await fetch(url);
  if (probe.status !== 200) return t.skip(`Claude Code's metadata document couldn't be fetched (HTTP ${probe.status}); no network?`);
  const browser = await playwright.chromium.launch();
  try {
    for (const colorScheme of ["light", "dark"]) {
      const page = await browser.newPage({ colorScheme, deviceScaleFactor: 2, viewport: { width: 1280, height: 1000 } });
      await page.goto(url.toString());
      await page.waitForLoadState("networkidle").catch(() => {});
      assert.match(await page.locator(".tag").textContent(), /Verified · claude\.ai/);
      const logo = await page.locator(".link .tile img.applogo").getAttribute("src");
      assert.match(logo, /^data:image\/svg\+xml;base64,/, "Claude's built-in logo");
      assert.ok(await page.locator(".link .tile img.applogo").evaluate(img => img.complete && img.naturalWidth > 0), "the logo renders");
      await page.screenshot({ path: path.join(SHOTS, `consent_verified_${colorScheme}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
