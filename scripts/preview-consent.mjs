/**
 * Generates the patched consent screen HTML and opens it in your browser.
 * Usage: node scripts/preview-consent.mjs
 */

import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { ConsentManager } from "../node_modules/fastmcp/dist/chunk-OJG4XYXA.js";

const manager = new ConsentManager();

const fakeTransaction = {
  id: "preview-transaction-id",
  scope: ["openid"],
};

const response = manager.createConsentResponse(fakeTransaction, "localhost");
const html = await response.text();

const outPath = join(tmpdir(), "spidra-consent-preview.html");
writeFileSync(outPath, html);
console.log(`Written to: ${outPath}`);

try {
  execSync(`open "${outPath}"`);
} catch {
  try {
    execSync(`xdg-open "${outPath}"`);
  } catch {
    console.log(`Open manually: file://${outPath}`);
  }
}
