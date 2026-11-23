// SYNTHETIC fault tests. Every case below edits a copy of the recorded real responses to inject one fault, then checks that
// Reckon flags it or refuses. The edited data is invented for the test and never leaves it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAsset } from "../src/checks.ts";
import { replayFetch } from "../src/net.ts";
import { readMint, SolanaReadError } from "../src/solana.ts";
import { diffFacts, type Facts } from "../src/store.ts";
import { BuySession, buyOff } from "../src/telegraph.ts";
import { byId } from "../src/registry.ts";
import { ctxFor, fixture, mutated } from "./helpers.ts";

const SOL_A = "https://api.mainnet-beta.solana.com";
const ustb = byId("ustb")!;
const run = (file = fixture(), prev = null as Parameters<typeof runAsset>[1]["prev"], nowShiftDays = 0) => {
  const ctx = ctxFor(file);
  const base = ctx.now;
  return runAsset(ustb, { ctx: { ...ctx, now: () => base() + nowShiftDays * 86_400_000 }, buy: new BuySession(buyOff()), prev });
};
const row = (rows: { id: string }[], id: string) => rows.find((r) => r.id === id) as any;

test("SYNTHETIC: two RPCs that disagree on the freeze authority are refused", async () => {
  const file = mutated((c) => {
    if (c.url === SOL_A && (c.body ?? "").includes("getAccountInfo") && (c.body ?? "").includes("CCz3SG")) {
      return { ...c, text: c.text.replaceAll("2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x", "11111111111111111111111111111111").replace(/"freezeAuthority":"[^"]+"/, '"freezeAuthority":"11111111111111111111111111111111"') };
    }
    return c;
  });
  await assert.rejects(() => readMint(ctxFor(file), ustb.solanaMint), (e: unknown) => e instanceof SolanaReadError && e.kind === "disagree" && /freezeAuthority|extensions/.test(e.message));
  const r = await run(file);
  assert.equal(row(r.rows, "mint-state").status, "hold");
  assert.match(row(r.rows, "mint-state").summary, /Refused/);
  assert.equal(r.facts.mint, null); // nothing from the refused read reaches the snapshot
});

test("SYNTHETIC: only one Solana RPC answering is refused, not accepted", async () => {
  const file = mutated((c) => (c.url.includes("publicnode") && c.url.includes("solana") ? null : c));
  await assert.rejects(() => readMint(ctxFor(file), ustb.solanaMint), (e: unknown) => e instanceof SolanaReadError && e.kind === "unavailable");
});

test("SYNTHETIC: a changed freeze authority and a swapped permanent delegate are flags in the diff", async () => {
  const base = (await run()).facts;
  const prev: Facts = structuredClone(base);
  prev.mint!.freezeAuthority = "PrevFreeze1111111111111111111111111111111111";
  const pd = prev.mint!.extensions.find((e) => e.name === "permanentDelegate")!;
  pd.state = { delegate: "PrevDelegate111111111111111111111111111111111" };
  const changes = diffFacts(prev, base);
  assert.ok(changes.some((c) => c.path === "mint.freezeAuthority" && c.severity === "flag"));
  assert.ok(changes.some((c) => c.path === "mint.permanentDelegate" && c.severity === "flag"));
  assert.ok(changes.some((c) => c.path === "mint.extension.permanentDelegate" && c.severity === "flag"));
});

test("SYNTHETIC: a removed extension (default account state) is a flag; a supply move alone is information", async () => {
  const base = (await run()).facts;
  const prev: Facts = structuredClone(base);
  prev.mint!.extensions = prev.mint!.extensions.filter((e) => e.name !== "defaultAccountState");
  prev.mint!.supplyRaw = String(BigInt(prev.mint!.supplyRaw) - 5_000_000n);
  const changes = diffFacts(prev, base);
  assert.ok(changes.some((c) => c.path === "mint.defaultAccountState" && c.severity === "flag"));
  assert.equal(changes.find((c) => c.path === "mint.supply")!.severity, "info");
});

test("SYNTHETIC: the mint-diff row flags a control change against a previous snapshot", async () => {
  const base = await run();
  const prev = { assetId: "ustb", takenAt: "2026-11-22T00:00:00.000Z", hash: "0".repeat(64), facts: structuredClone(base.facts) };
  prev.facts.mint!.mintAuthority = "OldMintAuth1111111111111111111111111111111111";
  const r = await run(fixture(), prev);
  assert.equal(row(r.rows, "mint-diff").status, "flag");
  assert.match(row(r.rows, "mint-diff").summary, /mint\.mintAuthority/);
});

test("SYNTHETIC: issuer figures that are ten days old are flagged as stale", async () => {
  const r = await run(fixture(), null, 10);
  assert.equal(row(r.rows, "issuer-freshness").status, "flag");
  assert.match(row(r.rows, "issuer-freshness").summary, /older than allowed/);
});

test("SYNTHETIC: a Solana token count on the issuer page that is 3% off is flagged", async () => {
  const file = mutated((c) => (c.url === "https://superstate.com/assets/ustb" ? { ...c, text: c.text.replace("81,654.76", "84,104.40") } : c));
  const r = await run(file);
  assert.equal(row(r.rows, "issuer-supply").status, "flag");
  assert.match(row(r.rows, "issuer-supply").values.Solana, /FLAG/);
});

test("SYNTHETIC: an AUM that does not match the network values is flagged", async () => {
  const file = mutated((c) => {
    if (c.url !== "https://superstate.com/assets/ustb") return c;
    return { ...c, text: c.text.replace(/\$685,\d{3},\d{3}/g, "$712,000,000") };
  });
  const r = await run(file);
  assert.equal(row(r.rows, "issuer-nav-aum").status, "flag");
});

test("SYNTHETIC: a page whose networks table is gone fails closed with a reason", async () => {
  const file = mutated((c) => (c.url === "https://superstate.com/assets/ustb" ? { ...c, text: c.text.replaceAll(">Networks<", ">Venues<") } : c));
  const r = await run(file);
  for (const id of ["issuer-supply", "issuer-nav-aum", "issuer-freshness", "issuer-holdings"]) {
    assert.equal(row(r.rows, id).status, "hold");
    assert.match(row(r.rows, id).summary, /networks table not found/);
  }
  assert.equal(row(r.rows, "mint-state").status, "pass"); // the on-chain rows are untouched
});

test("SYNTHETIC: a dead __data.json holds only the rows that need it", async () => {
  const file = mutated((c) => (c.url.endsWith("__data.json") ? { ...c, status: 500, text: "oops" } : c));
  const r = await run(file);
  assert.equal(row(r.rows, "issuer-mint-listing").status, "hold");
  assert.equal(row(r.rows, "issuer-total").status, "hold");
  assert.match(row(r.rows, "issuer-mint-listing").summary, /__data\.json/);
  assert.equal(row(r.rows, "issuer-supply").status, "pass");
  assert.equal(row(r.rows, "issuer-nav-aum").status, "pass");
});

test("SYNTHETIC: a lapsed LEI is a flag", async () => {
  const file = mutated((c) => (c.url.includes("gleif.org/api/v1/lei-records/254900RYEZ47C0C0YO93") ? { ...c, text: c.text.replace('"status":"ISSUED"', '"status":"LAPSED"') } : c));
  const r = await run(file);
  assert.equal(row(r.rows, "entity-lei").status, "flag");
  assert.match(row(r.rows, "entity-lei").summary, /LAPSED/);
});

test("SYNTHETIC: a request nobody recorded is an error, not an empty answer", async () => {
  const f = replayFetch({ recordedAt: "2026-01-01T00:00:00Z", label: "empty", captures: [] });
  await assert.rejects(() => f("https://example.invalid/x"), /no recorded response/);
});
