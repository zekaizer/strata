// Screenshots the webview playground in every captured theme with Playwright.
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let chromium;
try {
  // CommonJS resolution so a globally installed playwright (NODE_PATH) is found.
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error(
    'playwright is not installed. Install it globally: npm i -g playwright && npx playwright install chromium',
  );
  process.exit(1);
}

// Usage: node scripts/playground-shot.mjs [outDir] [WxH] [query] [hover]
//   e.g. query "repo=octopus&select=1", hover ".expansion .file" (a selector) or "@30,394" (a point)
//   query "page=components": the design system gallery, as a full-page screenshot
const outDir = process.argv[2] ?? 'artifacts/playground';
const [width, height] = (process.argv[3] ?? '1200x800').split('x').map(Number);
const query = process.argv[4] ?? 'repo=branchy&select=1';
/** Optional CSS selector, or "@x,y" in CSS px, to hover before the screenshot (e.g. to show row actions). */
const hover = process.argv[5];
const gallery = /(^|&)page=components(&|$)/.test(query);
const root = 'out/playground';
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

execFileSync('node', ['scripts/build.mjs', '--playground', '--once'], { stdio: 'inherit' });

const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
let failed = false;
for (const theme of ['dark', 'light', 'high-contrast', 'high-contrast-light']) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => {
    failed = true;
    console.error(`[${theme}] ${e.message}`);
  });
  await page.goto(`http://127.0.0.1:${port}/index.html?theme=${theme}&${query}`);
  if (gallery) await page.waitForFunction(() => window.document.documentElement.dataset.galleryReady === '1');
  else await page.waitForFunction(() => window.__strataSent.some((m) => m.type === 'ready'));
  // Let pages, layout and any requested selection settle.
  await page.waitForTimeout(400);
  if (hover?.startsWith('@')) {
    const [x, y] = hover.slice(1).split(',').map(Number);
    await page.mouse.move(x - 20, y);
    await page.mouse.move(x, y, { steps: 4 });
    // Past the ref card's show delay.
    await page.waitForTimeout(600);
  } else if (hover) {
    await page.hover(hover);
    await page.waitForTimeout(100);
  }
  const file = join(outDir, `${theme}.png`);
  await page.screenshot({ path: file, fullPage: gallery });
  console.log(file);
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
