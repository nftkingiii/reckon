// Builds timeline.json / timeline.js from the measured voice clips (out/vo.json). A beat is at least its base length
// and at least LEAD + voice + PAD, so the voice is never rushed. Run on the VM after vo.py.
import { readFileSync, writeFileSync } from 'node:fs';
const LEAD = 0.3, PAD = 0.5;
const BASE = { s01: 4.8, s02: 4.8, s03: 7.2, s04: 7.2, s05: 12, s06: 12, s07: 4.8, s08: 7.2, s09: 9.6, s10: 9.6, s11: 12, s12: 7.2 };
const V = JSON.parse(readFileSync('out/vo.json', 'utf8')).clips;
const r1 = x => Math.round(x * 10) / 10;
const DUR = {}, FROM = {}; let t = 0;
for (const id of Object.keys(BASE)) { DUR[id] = r1(Math.max(BASE[id], Math.ceil((LEAD + V[id].dur + PAD) * 10) / 10)); FROM[id] = r1(t); t += DUR[id]; }
const END = r1(t);
// 9:16: [shot id, voice id, from, base length]
const VB = [['s01', 's01', 0, 4.8], ['s06', 'v06', 0, 7.2], ['s08', 's08', 0, 7.2], ['s11', 'v11', 0, 7.2], ['s12', 'v12', 0, 3.6]];
const VSEG = [], VSTART = []; let vt = 0;
for (const [id, vid, f, len] of VB) { const d = r1(Math.max(len, Math.ceil((LEAD + V[vid].dur + PAD) * 10) / 10)); VSEG.push([id, f, f + d]); VSTART.push({ vid, start: r1(vt) }); vt += d; }
const TL = { LEAD, FROM, DUR, END, VSEG, VSTART, VDUR: r1(vt) };
writeFileSync('timeline.json', JSON.stringify(TL, null, 1)); writeFileSync('timeline.js', 'window.TL = ' + JSON.stringify(TL) + ';\n');
console.log(JSON.stringify({ DUR, END, VDUR: TL.VDUR }));
