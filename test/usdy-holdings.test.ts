// USDY adjustments and the Holdings reader, on real recorded responses. Tests marked SYNTHETIC edit those responses to
// create a fault and never describe real data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readHoldings, EXAMPLES, SOLANA_ADDR, EVM_ADDR } from "../src/holdings.ts";
import { Limiter, TtlCache } from "../src/ratelimit.ts";
import { parseAddresses, parseOndoPage } from "../src/readers/ondo.ts";
import { listedHolders, lockboxRows } from "../src/readers/usdy-holders.ts";
import { runAsset } from "../src/checks.ts";
import { ASSETS } from "../src/registry.ts";
import { createApp } from "../src/server.ts";
import { BuySession, buyOff } from "../src/telegraph.ts";
import { capture, ctxFor, fixture, mutated, runInOrder, tmpStore } from "./helpers.ts";

const fx = fixture();
const row = (rows: { id: string }[], id: string) => rows.find((r) => r.id === id) as any;

test("recorded: the Ondo page footnotes are read, including the one that defines the ratio", () => {
  const p = parseOndoPage(capture(fx, "ondo.finance/usdy").text);
  assert.match(p.footnotes["3"]!, /redemption request is not subtracted/);
  assert.match(p.footnotes["5"]!, /Opt-Out Lender Underlyings/);
});

test("recorded: the docs table yields Ondo's operating addresses, wrappers, and no bridge escrow", () => {
  const rows = parseAddresses(capture(fx, "docs.ondo.finance/addresses.md").text);
  const h = listedHolders(rows);
  assert.ok(h.filter((x) => x.role === "issuer-listed").length >= 7);
  assert.deepEqual(h.filter((x) => x.role === "wrapper").map((x) => x.chain).sort(), ["Ethereum", "Mantle"]);
  assert.ok(h.some((x) => x.chain === "Stellar" && x.address === "GC5T3RH2VK3G44FIHMOZY5UGN56L52UYFGHKFUX6X2HNIGEZ2PFXMI23"));
  assert.equal(lockboxRows(rows).length, 0);
});

test("recorded: the USDY row subtracts documented holdings, keeps the residual, and shows the Stellar candidates unapplied", async () => {
  const run = await runInOrder("usdy");
  const r = row(run.rows, "issuer-supply");
  assert.equal(r.status, "flag");
  const v = r.values;
  assert.equal(v["less: locked in bridge or escrow (tokens)"], 0);
  assert.equal(v["less: wrapper double counts (tokens)"], 0);
  assert.equal(v["less: held at Ondo-listed addresses (tokens)"], 0);
  assert.equal(v["adjusted circulating (tokens)"], v["tokens summed"]);
  assert.ok(v["residual vs issuer (%)"] > 15);
  assert.ok(Math.abs(v["residual vs issuer (USD)"] - (v["adjusted value"] - v["issuer: value outstanding (rounded)"])) < 2);
  assert.match(r.summary, /unexplained by documented adjustments/);
  assert.ok(Object.keys(v).some((k) => k.startsWith("candidate (not applied): Stellar account GC635K")));
  assert.match(r.summary, /Not applied/);
  assert.ok(r.sources.some((s: any) => s.url === "/docs/usdy-investigation.md"));
  // the Stellar candidate is about the size of the gap, and the row says so
  const gapTokens = v["tokens summed"] - v["issuer: value outstanding (rounded)"] / v["price used"];
  assert.ok(Math.abs(353_217_182 - gapTokens) / gapTokens < 0.03);
  assert.match(row(run.rows, "issuer-arithmetic").summary, /footnote 5/);
});

test("SYNTHETIC: tokens found at an Ondo-listed Stellar account are subtracted and shrink the residual", async () => {
  const file = mutated((c) => {
    if (!c.url.endsWith("/accounts/GC5T3RH2VK3G44FIHMOZY5UGN56L52UYFGHKFUX6X2HNIGEZ2PFXMI23")) return c;
    const j = JSON.parse(c.text);
    for (const b of j.balances) if (b.asset_code === "USDY") b.balance = "300000000.0000000";
    return { ...c, text: JSON.stringify(j) };
  });
  const r = row((await runInOrder("usdy", file)).rows, "issuer-supply");
  assert.equal(r.values["less: held at Ondo-listed addresses (tokens)"], 300000000);
  assert.ok(r.values["residual vs issuer (%)"] < 8 && r.values["residual vs issuer (%)"] > 0);
});

test("SYNTHETIC: an Ondo-listed address that cannot be read is named, never counted as zero", async () => {
  const file = mutated((c) => (c.url.includes("graphql.mainnet.sui.io") && (c.body ?? "").includes("totalBalance") ? null : c));
  const r = row((await runInOrder("usdy", file)).rows, "issuer-supply");
  assert.match(r.summary, /Not read: Sui USDY Redemptions Account/);
  assert.match(String(r.values["Ondo-listed: Sui USDY Redemptions Account"]), /^not read/);
});

test("SYNTHETIC: when the page figure is replaced by the chain figure the row passes", async () => {
  const file = mutated((c) => (c.url === "https://ondo.finance/usdy" ? { ...c, text: c.text.replace("$<!-- -->1.97B", "$<!-- -->2.38B") } : c));
  assert.equal(row((await runInOrder("usdy", file)).rows, "issuer-supply").status, "pass");
});

// ------------------------------------------------------------ holdings

const reports: Record<string, null> = Object.fromEntries(ASSETS.map((a) => [a.id, null]));
const usdySol = (): string => EXAMPLES.find((e) => e.label.includes("USDY") && !e.address.startsWith("0x"))!.address;

test("holdings: address shapes", () => {
  assert.ok(SOLANA_ADDR.test(EXAMPLES[0]!.address));
  assert.ok(EVM_ADDR.test(EXAMPLES.find((e) => e.address.startsWith("0x"))!.address));
  assert.ok(!SOLANA_ADDR.test("0xnotsolana") && !EVM_ADDR.test("0x12"));
});

test("holdings: an invalid address is reported, not read", async () => {
  const v = await readHoldings(ctxFor(fx), ["hello"], reports);
  assert.equal(v.results[0]!.kind, "invalid");
  assert.match(v.results[0]!.error!, /Not a Solana or EVM address/);
});

test("recorded: every Solana example reads and shows a balance, state and sources", async () => {
  const sol = EXAMPLES.filter((e) => !e.address.startsWith("0x"));
  assert.ok(sol.length >= 3);
  for (const e of sol) {
    const r = (await readHoldings(ctxFor(fx), [e.address], reports)).results[0]!;
    assert.equal(r.notRead.length, 0, JSON.stringify(r.notRead));
    assert.ok(r.positions.length >= 1);
    const p = r.positions[0]!;
    assert.ok(p.balance > 0);
    assert.equal(p.frozen, false);
    assert.match(p.accountState, /initialized/);
    assert.ok(p.sources.length >= 2);
    assert.ok(Array.isArray(p.recent));
  }
});

test("recorded: the Ethereum example reads balance and share of supply", async () => {
  const e = EXAMPLES.find((x) => x.address.startsWith("0x"))!;
  // The recording is one sequence: the three assets first, then the examples. A replay must follow the same order.
  const ctx = ctxFor(fx);
  for (const spec of ASSETS) await runAsset(spec, { ctx, buy: new BuySession(buyOff()), prev: null });
  const r = (await readHoldings(ctx, [e.address], reports)).results[0]!;
  const p = r.positions.find((x) => x.chain === "Ethereum" && x.symbol === "USDY")!;
  assert.ok(p.balance > 1e8);
  assert.ok(p.shareOfSupplyPct! > 10 && p.shareOfSupplyPct! < 60);
  assert.equal(r.kind, "evm");
});

test("recorded: with a full report the position carries a value, a price basis and the asset-level findings", async () => {
  const run = await runInOrder("usdy");
  const rep = { usdy: { generatedAt: fx.recordedAt, checks: run.rows, changes: [] } } as any;
  const r = (await readHoldings(ctxFor(fx), [usdySol()], { ...reports, ...rep })).results[0]!;
  const p = r.positions[0]!;
  assert.ok(p.priceUsd! > 1.1 && p.priceUsd! < 1.2);
  assert.ok(Math.abs(p.valueUsd! - p.balance * p.priceUsd!) < 1e-6);
  assert.ok(p.shareOfSupplyPct! > 0 && p.shareOfSupplyPct! < 100);
  assert.ok(r.risks.some((k) => k.status === "flag" && /value outstanding/.test(k.title)));
});

test("SYNTHETIC: a frozen token account on both RPCs is shown as frozen", async () => {
  const file = mutated((c) => ((c.body ?? "").includes("getTokenAccountsByOwner") || (c.body ?? "").includes("getAccountInfo") ? { ...c, text: c.text.replaceAll('"state":"initialized"', '"state":"frozen"') } : c));
  const p = (await readHoldings(ctxFor(file), [usdySol()], reports)).results[0]!.positions[0]!;
  assert.equal(p.frozen, true);
  assert.match(p.accountState, /frozen/);
});

test("SYNTHETIC: two Solana RPCs that disagree on a wallet's balance refuse the read", async () => {
  const file = mutated((c) =>
    (c.body ?? "").includes("getAccountInfo") && c.url.includes("publicnode") && c.text.includes('"tokenAmount"')
      ? { ...c, text: c.text.replace(/"amount":"(\d+)"/, (_m, d) => `"amount":"${BigInt(d) + 1n}"`) }
      : c,
  );
  const r = (await readHoldings(ctxFor(file), [usdySol()], reports)).results[0]!;
  assert.equal(r.positions.filter((p) => p.symbol === "USDY").length, 0);
  assert.ok(r.notRead.some((n) => /disagree/.test(n.why)));
});

test("holdings: an address nobody recorded is reported as not read, never as zero", async () => {
  const r = (await readHoldings(ctxFor(fx), ["11111111111111111111111111111111"], reports)).results[0]!;
  assert.equal(r.positions.length, 0);
  assert.equal(r.notRead.length, 3);
  assert.equal(r.empty.length, 0);
});

test("limiter: the sixth request in a minute waits, and a different client does not", () => {
  let t = 0;
  const l = new Limiter(5, 60_000, 2, () => t);
  for (let i = 0; i < 5; i++) assert.equal(l.take("a"), 0);
  assert.ok(l.take("a") > 0);
  assert.equal(l.take("b"), 0);
  t = 61_000;
  assert.equal(l.take("a"), 0);
});

test("limiter: reads beyond the concurrency cap are turned away", async () => {
  const l = new Limiter(10, 60_000, 1);
  let release!: () => void;
  const first = l.run(() => new Promise<void>((r) => (release = r)));
  assert.equal(await l.run(async () => 1), "busy");
  release();
  await first;
  assert.equal(await l.run(async () => 1), 1);
});

test("cache: an entry expires after its time", () => {
  let t = 0;
  const c = new TtlCache<number>(1000, () => t);
  c.set("k", 1);
  assert.equal(c.get("k"), 1);
  t = 1500;
  assert.equal(c.get("k"), undefined);
});

async function serve(perMinute = 6) {
  const file = fixture();
  const app = createApp({ mode: "recorded", store: tmpStore(), ctx: ctxFor(file), buy: buyOff(), intervalMs: 60_000, recordedAt: file.recordedAt, recordedLabel: file.label, holdingsPerMinute: perMinute });
  await app.start();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => app.server.close(() => r())) };
}

test("server: the holdings endpoint reads an example, validates input, and rate limits", async () => {
  const s = await serve(3);
  try {
    const ex = (await (await fetch(`${s.base}/api/holdings/examples`)).json()) as any;
    assert.ok(ex.examples.length >= 4);
    assert.equal((await fetch(`${s.base}/api/holdings`)).status, 400);
    const six = Array.from({ length: 6 }, (_, i) => `address=a${i}`).join("&");
    assert.equal((await fetch(`${s.base}/api/holdings?${six}`)).status, 400);
    const a = ex.examples[2].address;
    const ok = await fetch(`${s.base}/api/holdings?address=${a}`);
    assert.equal(ok.status, 200);
    const j = (await ok.json()) as any;
    assert.equal(j.mode, "recorded");
    assert.ok(j.results[0].positions.length >= 1);
    assert.equal(((await (await fetch(`${s.base}/api/holdings?address=${a}`)).json()) as any).cached, true);
    assert.equal((await fetch(`${s.base}/api/holdings?address=x1`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/holdings?address=x2`)).status, 200);
    const limited = await fetch(`${s.base}/api/holdings?address=x3`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await fetch(`${s.base}/api/holdings`, { method: "POST" })).status, 405);
    const doc = await fetch(`${s.base}/docs/usdy-investigation.md`);
    assert.equal(doc.status, 200);
    assert.match(await doc.text(), /USDY: why the chains and Ondo's page disagree/);
  } finally {
    await s.close();
  }
});
