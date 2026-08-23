/* Resolve Playwright whether it's installed locally (npm install) or only
 * globally, which is common on prebuilt CI images. */
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

async function load() {
  try {
    return await import("playwright");
  } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    return await import(pathToFileURL(path.join(root, "playwright", "index.mjs")).href);
  } catch {}
  throw new Error("Playwright not found. Run: npm install");
}

export const { chromium } = await load();
