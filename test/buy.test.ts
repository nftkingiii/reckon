// SYNTHETIC tests of Telegraph purchase mode. The node, the 402 challenge, the signer and every miner answer are invented
// here. They test Reckon's handling of the protocol and of answers; they say nothing about the real miners.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAsset } from "../src/checks.ts";
import { byId } from "../src/registry.ts";
import { Budget, BuySession, buyFromEnv, createEngineTransport, ENGINE_ASK_USD, MINERS, TransportError, type Transport } from "../src/telegraph.ts";
import { ctxFor, fixture } from "./helpers.ts";

const ustb = byId("ustb")!;
const row = (rows: { id: string }[], id: string) => rows.find((r) => r.id === id) as any;

/** Answers by miner and intent, and records every ask. */
function fakeTransport(answers: Record<string, (params: Record<string, unknown>) => Record<string, unknown> | Error>): { t: Transport; asks: { minerId: string; params: Record<string, unknown> }[] } {
  const asks: { minerId: string; params: Record<string, unknown> }[] = [];
  return {
    asks,
    t: {
      async ask(req) {
        asks.push({ minerId: req.minerId, params: req.params });
        const r = answers[req.minerId]?.(req.params);
        if (!r) throw new TransportError(`no fake answer for ${req.minerId}`);
        if (r instanceof Error) throw r;
        return { minerId: req.minerId, result: r, costUsd: 0.01, answeredAt: "2026-11-23T18:00:00.000Z", receipt: { receiptHash: `fake-${req.minerId}-${asks.length}`, rail: "synthetic" } };
      },
    },
  };
}

const runBuy = (t: Transport, capUsd = 1) => runAsset(ustb, { ctx: ctxFor(fixture()), buy: new BuySession({ enabled: true, capUsd, transport: t }), prev: null });

test("SYNTHETIC BUY: matching supply, an unchanged filing date and clear sanctions all pass, with receipts kept", async () => {
  const supplyNow = (await runAsset(ustb, { ctx: ctxFor(fixture()), buy: new BuySession({ enabled: false, capUsd: 0 }), prev: null })).facts.supplies.Solana!;
  const { t, asks } = fakeTransport({
    [MINERS.supply.id]: () => ({ total_supply: supplyNow }),
    [MINERS.filings.id]: () => ({ filing_count: 7, filings: ["D/A 2026-07-14", "D/A 2026-07-07"], urls: ["https://www.sec.gov/Archives/x"] }),
    [MINERS.sanctions.id]: () => ({ matched: false, matches: [] }),
  });
  const r = await runBuy(t);
  assert.equal(row(r.rows, "tg-supply").status, "pass");
  assert.equal(row(r.rows, "filings").status, "pass");
  assert.equal(row(r.rows, "sanctions").status, "pass");
  assert.equal(row(r.rows, "sanctions").telegraph.calls.length, ustb.sanctionsNames.length);
  assert.ok(row(r.rows, "tg-supply").telegraph.calls[0].receipt.receiptHash.startsWith("fake-"));
  assert.equal(asks.length, 1 + 1 + ustb.sanctionsNames.length);
  assert.equal(asks.find((a) => a.minerId === MINERS.supply.id)!.params.token, `${ustb.solanaMint} solana`);
  assert.equal(r.facts.filings!.latestDate, "2026-07-14");
});

test("SYNTHETIC BUY: a newer filing than the baseline is a flag, and an older-only answer is a hold", async () => {
  const mk = (title: string) =>
    fakeTransport({ [MINERS.supply.id]: () => ({ total_supply: 1 }), [MINERS.filings.id]: () => ({ filing_count: 1, filings: [title], urls: [] }), [MINERS.sanctions.id]: () => ({ matched: false }) }).t;
  const newer = await runBuy(mk("D/A 2026-11-20"));
  assert.equal(row(newer.rows, "filings").status, "flag");
  assert.match(row(newer.rows, "filings").summary, /newer than the latest known/);
  const older = await runBuy(mk("D 2024-01-02"));
  assert.equal(row(older.rows, "filings").status, "hold");
});

test("SYNTHETIC BUY: a sanctions match is flagged for a person to review", async () => {
  const { t } = fakeTransport({
    [MINERS.supply.id]: () => ({ total_supply: 1 }),
    [MINERS.filings.id]: () => ({ filing_count: 0, filings: [], urls: [] }),
    [MINERS.sanctions.id]: (p) => ({ matched: p.name === "NAV Fund Services" }),
  });
  const r = await runBuy(t);
  assert.equal(row(r.rows, "sanctions").status, "flag");
  assert.match(row(r.rows, "sanctions").summary, /NAV Fund Services/);
});

test("SYNTHETIC BUY: a supply that differs from Reckon's own read is a flag", async () => {
  const { t } = fakeTransport({ [MINERS.supply.id]: () => ({ total_supply: 90000 }), [MINERS.filings.id]: () => ({ filing_count: 0, filings: [], urls: [] }), [MINERS.sanctions.id]: () => ({ matched: false }) });
  const r = await runBuy(t);
  assert.equal(row(r.rows, "tg-supply").status, "flag");
});

test("SYNTHETIC BUY: a miner error becomes a hold with the reason, not a pass", async () => {
  const { t } = fakeTransport({ [MINERS.supply.id]: () => new TransportError("paid ask answered 402: insufficient escrow"), [MINERS.filings.id]: () => ({ filing_count: 0, filings: [], urls: [] }), [MINERS.sanctions.id]: () => ({ matched: false }) });
  const r = await runBuy(t);
  assert.equal(row(r.rows, "tg-supply").status, "hold");
  assert.match(row(r.rows, "tg-supply").summary, /insufficient escrow/);
  assert.equal(row(r.rows, "tg-supply").telegraph.state, "failed");
});

test("SYNTHETIC BUY: the per-run cap stops buying once it would be exceeded", async () => {
  const { t, asks } = fakeTransport({ [MINERS.supply.id]: () => ({ total_supply: 1 }), [MINERS.filings.id]: () => ({ filing_count: 0, filings: [], urls: [] }), [MINERS.sanctions.id]: () => ({ matched: false }) });
  const r = await runBuy(t, 0.03); // three asks of $0.01
  assert.equal(asks.length, 3);
  assert.match(JSON.stringify(row(r.rows, "sanctions").telegraph.calls), /run cap/);
  const b = new Budget(0.02);
  assert.ok(b.reserve(0.01));
  b.record(0.01);
  assert.ok(b.reserve(0.01));
  b.record(0.01);
  assert.ok(!b.reserve(0.01));
  assert.ok(!b.reserve(0.0001), "once breached it stays breached");
});

test("SYNTHETIC BUY: the escrow ask follows the 402 flow with string-valued bounds and never sees a key", async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const message = "Telegraph escrow\nFrom: {from}\nAmount: 10000 uUSDC\nNonce: {nonce}\nValidAfter: {validAfter}\nValidBefore: {validBefore}";
  const challenge = Buffer.from(JSON.stringify({ accepts: [{ scheme: "escrow", network: "synthetic-net", payTo: "0xpayto", extra: { message } }] })).toString("base64");
  const http = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers, body: String(init?.body) });
    if (!headers["x-payment"]) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    const receipt = Buffer.from(JSON.stringify({ receipt_hash: "rcpt-123", rail: "escrow", amount_uusdc: 10000 })).toString("base64");
    return new Response(JSON.stringify({ result: { total_supply: 5 }, signal_hash: "sig-1" }), { status: 200, headers: { "x-payment-response": receipt } });
  };
  let signed = "";
  const signer = { address: "0xABCDEF0000000000000000000000000000000001", personalSign: async (m: string) => ((signed = m), "0xsig") };
  const t = createEngineTransport(signer, http as typeof fetch, () => Date.UTC(2026, 10, 23, 18, 0, 0), "https://node.invalid");
  const a = await t.ask({ intent: MINERS.supply.intent, minerId: MINERS.supply.id, params: { token: "x" }, maxCostUsd: 0.02 });
  assert.equal(a.receipt.receiptHash, "rcpt-123");
  assert.equal(a.costUsd, 0.01);
  assert.equal(seen[0]!.url, `https://node.invalid/engine/v1/ask/${MINERS.supply.id}`);
  const payload = JSON.parse(Buffer.from(seen[1]!.headers["x-payment"]!, "base64").toString("utf8"));
  assert.equal(typeof payload.payload.authorization.validAfter, "string");
  assert.equal(typeof payload.payload.authorization.validBefore, "string");
  assert.equal(payload.payload.authorization.value, "10000");
  assert.equal(payload.payload.authorization.from, signer.address.toLowerCase());
  assert.ok(Number(payload.payload.authorization.validBefore) - Number(payload.payload.authorization.validAfter) <= 120);
  assert.ok(!signed.includes("{from}") && signed.includes(payload.payload.authorization.nonce));
  // a quote above the limit is refused before anything is signed
  const dear = createEngineTransport({ address: signer.address, personalSign: async () => assert.fail("must not sign") }, http as typeof fetch);
  await assert.rejects(() => dear.ask({ intent: "X", minerId: "1", params: {}, maxCostUsd: 0.001 }), /above the \$0.001 limit/);
});

test("BUY mode will not start half-armed", async () => {
  assert.equal((await buyFromEnv({})).enabled, false);
  await assert.rejects(() => buyFromEnv({ RECKON_BUY: "1" } as NodeJS.ProcessEnv), /RECKON_SIGNER_MODULE/);
  await assert.rejects(() => buyFromEnv({ RECKON_BUY: "1", RECKON_BUY_CAP_USD: "0" } as NodeJS.ProcessEnv), /above zero/);
  assert.ok(ENGINE_ASK_USD > 0);
});
