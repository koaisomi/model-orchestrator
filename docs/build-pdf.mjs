// Builds docs/Model-Orchestrator-Technical-Guide.pdf from docs/guide.html with Playwright (optional dev tool).
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(here, "guide.html");
const out = path.join(here, "Model-Orchestrator-Technical-Guide.pdf");

function help(msg) {
  console.error(`${msg}\n\nPlaywright is needed only to build the PDF. Install it with: npm i -g @playwright/mcp  (or: npx playwright install chromium)\nThen run: npm run guide:pdf`);
  process.exit(1);
}

let npmRoot;
try { npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim(); }
catch { help("cannot run `npm root -g`"); }

let playwright;
try {
  const req = createRequire(path.join(npmRoot, "@playwright", "mcp") + path.sep);
  playwright = req("playwright");
} catch { help(`playwright not found under ${npmRoot}/@playwright/mcp`); }

const exe = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium_headless_shell-1248", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
const launch = { headless: true };
if (fs.existsSync(exe)) launch.executablePath = exe;

const browser = await playwright.chromium.launch(launch);
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
  await page.pdf({
    path: out, format: "A4", printBackground: true,
    margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: '<div style="width:100%;font-size:8px;color:#5b6372;text-align:center;font-family:sans-serif">Model Orchestrator Technical Guide &nbsp;|&nbsp; page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });
} finally { await browser.close(); }

const pages = (fs.readFileSync(out, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
console.log(`wrote ${out} (${fs.statSync(out).size} bytes, ${pages} pages)`);
