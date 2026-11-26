// Captures the live Reckon pages (desktop 1280 wide, DPR 2) plus row boxes. Read-only: GET requests only.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const BASE = 'https://reckon-app.up.railway.app';
const b = await chromium.launch({ channel: 'msedge' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const p = await ctx.newPage();
const meta = { base: BASE, fetchedAt: new Date().toISOString(), pages: {} };
async function go(hash, name, { openAll = false, wait = 'h1' } = {}) {
  await p.goto('about:blank'); await p.goto(BASE + '/#' + hash, { waitUntil: 'load' });
  await p.waitForSelector(wait, { timeout: 90000 }); await p.waitForTimeout(1500);
  if (openAll) await p.evaluate(() => document.querySelectorAll('details.check').forEach(d => d.open = true));
  await p.waitForTimeout(300);
  await p.screenshot({ path: `assets/cap/${name}.png`, fullPage: true });
  const info = await p.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y + scrollY, w: b.width, h: b.height }; };
    return {
      H: document.documentElement.scrollHeight,
      checks: [...document.querySelectorAll('details.check')].map(d => ({ title: d.querySelector('b').textContent, state: d.querySelector('.state').textContent, ...r(d) })),
      groups: [...document.querySelectorAll('section.group h3')].map(h => ({ t: h.textContent, ...r(h) })),
      cards: [...document.querySelectorAll('article.card')].map(r2 => r(r2)),
      mode: document.querySelector('.mode') ? r(document.querySelector('.mode')) : null,
      three: document.querySelector('.three') ? r(document.querySelector('.three')) : null,
      head: document.querySelector('.head') ? r(document.querySelector('.head')) : null,
      h1: r(document.querySelector('h1')),
    };
  });
  meta.pages[name] = info;
  console.log(name, info.H);
}
await go('assets', 'assets', { wait: '.strip' });
for (const a of ['ustb', 'buidl', 'usdy']) { await go('detail/' + a, a, { wait: '.head' }); await go('detail/' + a, a + '-open', { openAll: true, wait: '.head' }); }
await go('how', 'how', { wait: 'h2' });
// frontier tab as it stands live (placeholder), for the record only; not used in the film
await go('frontier', 'frontier', { wait: 'table' });
writeFileSync('assets/cap/meta.json', JSON.stringify(meta, null, 1));
await b.close();
