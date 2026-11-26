// Builds cues.json (16:9) and cues-v.json (9:16) from shot-local cue times. Cue time = visual contact - 0.03 s.
import { writeFileSync } from 'node:fs';
const FROM = { s01: 0, s02: 4.8, s03: 9.6, s04: 16.8, s05: 24.0, s06: 36.0, s07: 48.0, s08: 52.8, s09: 60.0, s10: 69.6, s11: 79.2, s12: 91.2 };
const c = (t, type, vol = .4, pitch = 1) => ({ t, type, vol, pitch });
const typeRun = (t0, n, step, base = .9) => Array.from({ length: n }, (_, i) => c(+(t0 + i * step + (i % 3) * .015).toFixed(3), 'type', .28, base + (i % 4) * .1));
const sh = {
  s01: [...typeRun(.3, 9, .11), ...typeRun(1.9, 9, .1, 1), c(3.27, 'pop', .45)],
  s02: [c(.07, 'tick', .3), c(.97, 'tick', .3, 1), c(1.57, 'tick', .3, 1.1), c(2.17, 'tick', .3, 1.2)],
  s03: [c(1.47, 'click', .35), c(3.67, 'click', .35), c(5.67, 'click', .35)],
  s04: [c(1.07, 'click', .35), c(3.47, 'click', .35), c(5.0, 'tick', .25)],
  s05: [c(.27, 'click', .35), c(2.97, 'click', .4), c(4.37, 'tick', .3), c(5.2, 'chime', .35), c(7.57, 'click', .4), c(9.77, 'click', .4), c(11.0, 'tick', .25)],
  s06: [c(.97, 'click', .35), c(2.97, 'click', .4), c(6.17, 'click', .4), c(8.57, 'click', .4)],
  s07: [c(.27, 'tick', .3), c(2.57, 'tick', .3, 1.1)],
  s08: [c(.67, 'click', .35), c(2.37, 'click', .4), c(2.7, 'error', .25), c(4.77, 'click', .4)],
  s11: [c(.27, 'click', .35), c(3.57, 'click', .4), c(7.17, 'click', .4), c(7.35, 'chime', .3), c(9.57, 'click', .4)],
  s12: [c(.47, 'sparkle', .3), c(1.27, 'success', .45)],
};
const END = 98.4;
const bars = []; for (let t = 4.8; t < END - 1; t += 2.4) bars.push(c(+t.toFixed(2), 'thump', .14));
const flat = Object.entries(sh).flatMap(([k, a]) => a.map(x => ({ ...x, t: +(FROM[k] + x.t).toFixed(3) })));
const all = [...flat, ...bars].filter(x => x.t >= 0).sort((a, b) => a.t - b.t);
writeFileSync('cues.json', JSON.stringify(all, null, 1));
const VSEG = [['s01', 0, 4.8], ['s06', 0, 7.2], ['s08', 0, 7.2], ['s11', 0, 7.2], ['s12', 0, 3.6]];
let off = 0; const v = [];
for (const [id, f, to] of VSEG) { for (const x of sh[id] || []) if (x.t >= f && x.t < to) v.push({ ...x, t: +(off + x.t - f).toFixed(3) }); off += to - f; }
for (let t = 4.8; t < off - .5; t += 2.4) v.push(c(+t.toFixed(2), 'thump', .14));
writeFileSync('cues-v.json', JSON.stringify(v.filter(x => x.t >= 0).sort((a, b) => a.t - b.t), null, 1));
console.log(all.length, v.length, 'cues; vertical dur', off);
