// Row/region crops of the live pages (DPR 2). Read-only. Names = assets/cap/<asset>-<what>.png ; css-px sizes go to assets/cap/crops.json
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const BASE = 'https://reckon-app.up.railway.app';
const b = await chromium.launch({ channel: 'msedge' });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const p = await ctx.newPage();
const crops = {};
async function open(hash, wait) { await p.goto('about:blank'); await p.goto(BASE + '/#' + hash); await p.waitForSelector(wait, { timeout: 90000 }); await p.waitForTimeout(1500); }
async function clip(name, x, y, w, h) { await p.screenshot({ path: `assets/cap/${name}.png`, fullPage: true, clip: { x, y, width: w, height: h } }); crops[name] = { w, h }; console.log(name, w, h); }
async function row(asset, title, name, maxH = 760, nth = 0) {
  const r = await p.evaluate(([t, n]) => { const d = [...document.querySelectorAll('details.check')].filter(d => d.querySelector('b').textContent.startsWith(t))[n]; d.open = true; const b = d.getBoundingClientRect(); return { y: b.y + scrollY, h: b.height }; }, [title, nth]);
  await p.waitForTimeout(200);
  const r2 = await p.evaluate(([t, n]) => { const d = [...document.querySelectorAll('details.check')].filter(d => d.querySelector('b').textContent.startsWith(t))[n]; const b = d.getBoundingClientRect(); return { y: b.y + scrollY, h: b.height }; }, [title, nth]);
  await clip(`${asset}-${name}`, 96, Math.floor(r2.y) - 6, 1088, Math.min(Math.ceil(r2.h) + 12, maxH));
}
await open('detail/ustb', '.head');
await clip('ustb-top', 0, 0, 1280, 1420);
await row('ustb', 'On-chain supply against', 'supply', 520);
await row('ustb', 'Shares times NAV', 'nav', 420);
await row('ustb', 'SEC filing trail', 'filings', 560);
await row('ustb', 'Sanctions screening', 'sanctions', 720);
await row('ustb', 'Supply through Telegraph', 'tg', 460);
await open('detail/buidl', '.head');
await clip('buidl-top', 0, 0, 1280, 1420);
await row('buidl', 'Issuer figures', 'issuer', 360);
await open('detail/usdy', '.head');
await clip('usdy-top', 0, 0, 1280, 1420);
await row('usdy', 'Supply across chains against the issuer', 'flag1', 760);
await row('usdy', "The issuer page's own", 'flag2', 640);
await open('how', 'h2');
await clip('how-top', 0, 0, 1280, 1400);
writeFileSync('assets/cap/crops.json', JSON.stringify(crops, null, 1));
await b.close();
