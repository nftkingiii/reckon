import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/server.ts";
import { buyOff } from "../src/telegraph.ts";
import { ctxFor, fixture, tmpStore } from "./helpers.ts";
import { diffFacts, hashFacts, Store } from "../src/store.ts";
import { canon, fmtUnits, unitsToNumber } from "../src/util.ts";

async function serve() {
  const file = fixture();
  const app = createApp({ mode: "recorded", store: tmpStore(), ctx: ctxFor(file), buy: buyOff(), intervalMs: 60_000, recordedAt: file.recordedAt, recordedLabel: file.label });
  await app.start();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => app.server.close(() => r())) };
}

test("server: state labels the data as recorded and lists three assets", async () => {
  const s = await serve();
  try {
    const st = (await (await fetch(`${s.base}/api/state`)).json()) as any;
    assert.equal(st.mode, "recorded");
    assert.ok(st.recordedAt);
    assert.equal(st.buy.enabled, false);
    assert.deepEqual(st.assets.map((a: any) => a.id), ["ustb", "buidl", "usdy"]);
    assert.ok(st.assets.every((a: any) => a.report && a.report.strip.length >= 8));
    assert.equal(st.buy.plan.find((p: any) => p.assetId === "ustb").asks, 7);
  } finally {
    await s.close();
  }
});

test("server: detail, both downloads, the frontier table and the page itself", async () => {
  const s = await serve();
  try {
    const d = (await (await fetch(`${s.base}/api/assets/ustb`)).json()) as any;
    assert.equal(d.report.assetId, "ustb");
    assert.equal(d.history.length, 1);
    const j = await fetch(`${s.base}/api/assets/ustb/report.json`);
    const disposition = j.headers.get("content-disposition") ?? "";
    assert.ok(disposition.startsWith("attachment; filename=\"reckon-ustb-"));
    const md = await fetch(`${s.base}/api/assets/usdy/report.md`);
    assert.match(await md.text(), /# Ondo USDY: Reckon report/);
    const f = (await (await fetch(`${s.base}/api/frontier`)).json()) as any;
    assert.equal(f.rows.length, 5);
    assert.equal(f.results.status, "run");
    assert.equal(f.results.runDate, "2026-11-26");
    assert.equal(f.results.models.length, 3);
    assert.equal(f.results.answers.q2.opus.outcome, "partly right");
    assert.match(f.rows[0].truth, /USTB/);
    const html = await (await fetch(`${s.base}/`)).text();
    assert.match(html, /Frontier comparison/);
    assert.equal((await fetch(`${s.base}/api/assets/nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2fpackage.json`)).status, 404);
  } finally {
    await s.close();
  }
});

test("server: nothing but GET is accepted", async () => {
  const s = await serve();
  try {
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(`${s.base}/api/state`, { method })).status, 405);
  } finally {
    await s.close();
  }
});

test("store: history keeps order, newest first, and old snapshots are pruned", () => {
  const store = tmpStore();
  const facts = { mint: null, supplies: {}, entities: {}, issuer: {}, filings: null };
  const report = { assetId: "x" } as any;
  for (let i = 0; i < 5; i++) {
    store.save({ assetId: "x", takenAt: `2026-11-2${i}T00:00:00.000Z`, hash: hashFacts({ ...facts, supplies: { a: i } }), facts }, report, { at: `2026-11-2${i}T00:00:00.000Z`, hash: String(i), mode: "live", changes: [], counts: { pass: 0, flag: 0, hold: 0 } }, 3);
  }
  assert.deepEqual(store.history("x").map((h) => h.hash), ["4", "3", "2", "1", "0"]);
  assert.equal(store.latest("x")!.takenAt, "2026-11-24T00:00:00.000Z");
});

test("util: unit formatting and canonical hashing", () => {
  assert.equal(fmtUnits(81654762282n, 6), "81654.762282");
  assert.equal(fmtUnits(5n, 6), "0.000005");
  assert.equal(fmtUnits(1000000n, 6), "1");
  assert.equal(unitsToNumber(81654762282n, 6), 81654.762282);
  assert.equal(canon({ b: 1, a: { d: 1, c: 2 } }), canon({ a: { c: 2, d: 1 }, b: 1 }));
  assert.deepEqual(diffFacts({ mint: null, supplies: { a: 1 }, entities: {}, issuer: {}, filings: null }, { mint: null, supplies: { a: 2 }, entities: {}, issuer: {}, filings: null }).map((c) => c.path), ["supply.a"]);
});
