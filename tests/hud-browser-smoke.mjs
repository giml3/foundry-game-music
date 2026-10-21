// Headless-browser smoke for the corner HUD + sidebar panel.
//   npm run smoke:hud
// Discovers a Chromium binary (CHROME_PATH, system Chrome, Playwright
// cache, PATH), serves the module over a local port, renders a harness
// page in headless Chrome and writes /tmp/hud-shot.png. No installs.
// Not a node --test file: it needs a real browser, so it runs on demand.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function findChrome() {
  const candidates = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  try {
    const cache = join(homedir(), "Library", "Caches", "ms-playwright");
    const builds = readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const b of builds) candidates.push(join(cache, b, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
  } catch { /* no playwright cache */ }
  for (const name of ["chromium", "google-chrome", "chromium-browser"]) candidates.push(name);
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes("/")) { if (existsSync(c)) return c; continue; }
    const w = spawnSync("command", ["-v", c], { shell: true, encoding: "utf8" });
    if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  }
  return null;
}

const HARNESS = `<!doctype html><meta charset="utf-8"><title>HUD harness</title>
<link rel="stylesheet" href="/styles/bardic-dice.css">
<style>body{margin:0;background:#191410;height:100vh}#sidebar{position:fixed;right:0;top:0;width:330px;height:100vh;background:#211a13}</style>
<aside id="sidebar"></aside>
<script type="module">
import { renderBardicHud } from "/scripts/hud.js";
import { renderBardicSidebar } from "/scripts/sidebar.js";
const status = { state: "playing", mode: "combat", nowPlaying: "Combat Jig", remainSec: 125, nextTrack: "War Song", queued: 2,
  why: "combat → faster (140 BPM, A minor); LYRIC parody (skeleton #7)",
  activity: [{ actor: "bard", text: "combat called — switching within 12s" }, { actor: "lyric-llm", text: "fresh verses written" }, { actor: "memory", text: "saga memory: 40 rolls all-time" }],
  work: [{ ts: Date.now(), actor: "parody", text: "lyric LLM picked skeleton for Bram vs Skaven (track #7)", detail: "Screened against source · Party: Bram the Rat Catcher · Enemy: Skaven" }] };
renderBardicHud(status); renderBardicSidebar(status);
</script>`;

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.error("No Chromium found. Install Chrome, or set CHROME_PATH, or run: npx playwright install chromium"); process.exit(1); }
  console.log(`browser: ${chrome}`);
  const server = createServer((req, res) => {
    try {
      if (req.url === "/hud-harness.html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(HARNESS); return; }
      const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(readFileSync(path));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const out = "/tmp/hud-shot.png";
    const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--window-size=1280,800", "--virtual-time-budget=5000", `--screenshot=${out}`, `http://127.0.0.1:${port}/hud-harness.html`], { encoding: "utf8", timeout: 60000 });
    if (r.status !== 0 || !existsSync(out)) { console.error(r.stderr?.slice(-800)); process.exit(1); }
    console.log(`ok: screenshot written to ${out} (${statSync(out).size} bytes) — open it to see the bottom-left HUD and right-sidebar panel`);
  } finally { server.close(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
