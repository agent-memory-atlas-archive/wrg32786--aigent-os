#!/usr/bin/env node
/**
 * Deterministic frame capture + GIF encode for assets/demo-auto-refresh/index.html
 * (an ILLUSTRATION of one Managed Auto-Refresh cycle rendered as a Claude Code terminal).
 *
 * Product strings used verbatim by the scene (source at the pinned SHA):
 *   /context-capsule request                      daemons/pty-runner.mjs:89   CAPSULE_REQUEST_TEXT
 *   /clear submit                                 daemons/pty-runner.mjs:66   CLEAR_CONTROL_TEXT
 *   "Capsule Complete, Ready For Clear"           daemons/auto-clear-transport.mjs:40   CAPSULE_ACK_LITERAL
 *   post-clear wake prompt the runner types       daemons/pty-runner.mjs:117  WAKE_MESSAGE
 *   [RESUME VERB] first line of the resume block  daemons/resume-verb.mjs:315
 *   capsule path + frontmatter fields             skills/context-capsule/SKILL.md:32-33
 *   statusline "<name> | ctx N%" fallback         daemons/statusline-ctx.sh:74-80
 *
 * Playwright resolution: `playwright`, then `playwright-core`, then PLAYWRIGHT_MODULE (a path to either).
 * Browser: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome (same convention as tools/capture-arch.mjs).
 * ffmpeg: FFMPEG=/path/to/ffmpeg (default: ffmpeg on PATH).
 *
 * Usage: node tools/capture-demo-gif.mjs [--fps 15] [--out frames-demo] [--keep]
 * Output: assets/demo-auto-refresh.gif and assets/demo-auto-refresh-ack.png (the ack moment).
 */
import { mkdirSync, rmSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : d; };
const FPS = parseInt(arg('fps', '15'), 10);
const OUT_DIR = path.resolve(repoRoot, arg('out', 'frames-demo'));
const HTML = path.resolve(repoRoot, 'assets/demo-auto-refresh/index.html');
const GIF = path.resolve(repoRoot, 'assets/demo-auto-refresh.gif');
const STILL = path.resolve(repoRoot, 'assets/demo-auto-refresh-ack.png');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

async function loadPlaywright() {
  for (const spec of ['playwright', 'playwright-core']) {
    try { return await import(spec); } catch { /* try next */ }
  }
  if (process.env.PLAYWRIGHT_MODULE) return createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
  throw new Error('Playwright not found: install it via npx or set PLAYWRIGHT_MODULE');
}
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};

async function main() {
  const pw = await loadPlaywright();
  const chromium = pw.chromium || pw.default?.chromium;
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 2 })).newPage();
  await page.goto(pathToFileURL(HTML).href);
  const total = await page.evaluate(() => window.__totalFrames);
  const pageFps = await page.evaluate(() => window.__fps);
  if (pageFps !== FPS) throw new Error(`scene is authored at ${pageFps} fps; pass --fps ${pageFps}`);
  const marks = await page.evaluate(() => window.__marks);
  for (let n = 0; n < total; n++) {
    await page.evaluate(k => window.__setFrame(k), n);
    await page.waitForFunction(() => window.__frameReady === true);
    await page.screenshot({ path: path.join(OUT_DIR, `frame_${String(n).padStart(4, '0')}.png`) });
  }
  await browser.close();
  copyFileSync(path.join(OUT_DIR, `frame_${String(marks.ack).padStart(4, '0')}.png`), STILL);
  const pal = path.join(OUT_DIR, 'palette.png');
  const scale = 'scale=1200:-1:flags=lanczos';
  const inp = ['-y', '-framerate', String(FPS), '-i', path.join(OUT_DIR, 'frame_%04d.png')];
  run(FFMPEG, [...inp, '-vf', `${scale},palettegen=max_colors=64:stats_mode=full`, pal]);
  run(FFMPEG, [...inp, '-i', pal, '-lavfi', `${scale} [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', GIF]);
  console.log(`frames=${total} fps=${FPS} duration=${(total / FPS).toFixed(1)}s marks=${JSON.stringify(marks)}`);
  console.log(`gif=${GIF} ${(statSync(GIF).size / 1048576).toFixed(2)} MB`);
  if (!process.argv.includes('--keep')) rmSync(OUT_DIR, { recursive: true, force: true });
  else console.log(`kept frames in ${OUT_DIR}`);
}
main().catch(e => { console.error(e); process.exit(1); });
