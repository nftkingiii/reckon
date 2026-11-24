// Tests of the paid-pass machinery: the env signer, the cadence, the caps and the escrow floor. The Telegraph node, the
// ledger and every miner answer are SYNTHETIC; the key below is the publicly known Hardhat test key, not a real one.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BuyGovernor } from "../src/governor.ts";
import { runPass } from "../src/monitor.ts";
import { recoverAddress, signerFromKey } from "../src/signer.ts";
import { buyFromEnv, loadSigner, MINERS, readLedgerAvailableUsd, type Transport } from "../src/telegraph.ts";
import { ctxFor, fixture, tmpStore } from "./helpers.ts";

const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MIN = 60_000;
const T0 = Date.parse("2026-11-24T10:00:00Z");

test("signer: the env key gives the known address and signatures that recover to it", async () => {
  const s = signerFromKey(HARDHAT_KEY);
  assert.equal(s.address, HARDHAT_ADDRESS);
  assert.equal(signerFromKey(HARDHAT_KEY.slice(2)).address, HARDHAT_ADDRESS, "0x prefix is optional");
  const msg = "Telegraph escrow\nAmount: 10000 uUSDC\nNonce: 0xabc";
  const sig = await s.personalSign(msg);
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.ok(["1b", "1c"].includes(sig.slice(-2)));
  assert.equal(recoverAddress(msg, sig), HARDHAT_ADDRESS);
  assert.notEqual(recoverAddress(msg + "x", sig), HARDHAT_ADDRESS);
});

test("signer: a malformed key is refused without echoing it", () => {
  const bad = "0xnot-a-real-key-but-pretend-it-is-secret";
  assert.throws(() => signerFromKey(bad), (e: Error) => /32-byte hex key/.test(e.message) && !e.message.includes("pretend"));
  assert.throws(() => signerFromKey("0x" + "00".repeat(32)), /valid secp256k1/);
});

test("signer: RECKON_SIGNER_KEY wins, and RECKON_SIGNER_MODULE still works on its own", async () => {
  assert.equal((await loadSigner({ RECKON_SIGNER_KEY: HARDHAT_KEY }))!.address, HARDHAT_ADDRESS);
  const dir = mkdtempSync(join(tmpdir(), "reckon-signer-"));
  const file = join(dir, "signer.mjs");
  writeFileSync(file, `export default { address: "0xMODULE", personalSign: async () => "0xsig" };`);
  assert.equal((await loadSigner({ RECKON_SIGNER_MODULE: file }))!.address, "0xMODULE");
  assert.equal(await loadSigner({}), undefined);
});

test("BUY env: defaults, and still refused half-armed", async () => {
  assert.equal((await buyFromEnv({})).enabled, false);
  const cfg = await buyFromEnv({ RECKON_BUY: "1", RECKON_SIGNER_KEY: HARDHAT_KEY });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.capUsd, 0.25);
  assert.ok(cfg.governor);
  const st = cfg.governor!.status(T0);
  assert.equal(st.intervalMin, 60);
  assert.equal(st.dailyUsd, 3.5);
  assert.equal(st.minBalanceUsd, 1);
  await assert.rejects(() => buyFromEnv({ RECKON_BUY: "1" } as NodeJS.ProcessEnv), /RECKON_SIGNER_KEY or RECKON_SIGNER_MODULE/);
  await assert.rejects(() => buyFromEnv({ RECKON_BUY: "1", RECKON_SIGNER_KEY: HARDHAT_KEY, RECKON_BUY_CAP_USD: "0" } as NodeJS.ProcessEnv), /above zero/);
  await assert.rejects(() => buyFromEnv({ RECKON_BUY: "1", RECKON_SIGNER_KEY: HARDHAT_KEY, RECKON_BUY_INTERVAL_MIN: "0" } as NodeJS.ProcessEnv), /above zero/);
});

test("ledger: reads available micro-USDC as dollars and fails closed on anything else", async () => {
  const ok = async () => new Response(JSON.stringify({ available: "4700000", balance: "4700000" }), { status: 200 });
  assert.equal(await readLedgerAvailableUsd(HARDHAT_ADDRESS, ok as typeof fetch), 4.7);
  await assert.rejects(() => readLedgerAvailableUsd(HARDHAT_ADDRESS, (async () => new Response("{}", { status: 200 })) as typeof fetch), /no readable available amount/);
  await assert.rejects(() => readLedgerAvailableUsd(HARDHAT_ADDRESS, (async () => new Response(JSON.stringify({ available: "-5" }), { status: 200 })) as typeof fetch), /no readable available amount/);
  await assert.rejects(() => readLedgerAvailableUsd(HARDHAT_ADDRESS, (async () => new Response("no", { status: 503 })) as typeof fetch), /503/);
  await assert.rejects(() => readLedgerAvailableUsd("not-an-address"), /not a wallet address/);
});

const gov = (balance: () => Promise<number>, extra: Partial<ConstructorParameters<typeof BuyGovernor>[0]> = {}) =>
  new BuyGovernor({ intervalMs: 60 * MIN, passCapUsd: 0.25, dailyUsd: 3.5, minBalanceUsd: 1, readBalance: balance, ...extra });

test("cadence: one paid pass an hour, however often free passes run", async () => {
  const g = gov(async () => 10);
  const first = await g.decide(T0);
  assert.equal(first.buy, true);
  assert.equal(first.capUsd, 0.25);
  g.record(0.14, T0);
  const soon = await g.decide(T0 + 15 * MIN);
  assert.equal(soon.buy, false);
  assert.match(soon.note, /at most every 60 minutes/);
  assert.equal((await g.decide(T0 + 59 * MIN)).buy, false);
  assert.equal((await g.decide(T0 + 61 * MIN)).buy, true);
});

test("daily ceiling: the cap shrinks to what is left, then buying pauses with a note until the next UTC day", async () => {
  const g = gov(async () => 10);
  await g.decide(T0);
  g.record(3.4, T0);
  const near = await g.decide(T0 + 61 * MIN);
  assert.equal(near.buy, true);
  assert.ok(Math.abs(near.capUsd - 0.1) < 1e-9, `cap was ${near.capUsd}`);
  g.record(0.1, T0 + 61 * MIN);
  const stop = await g.decide(T0 + 130 * MIN);
  assert.equal(stop.buy, false);
  assert.match(stop.note, /Daily ceiling of \$3\.50 reached/);
  assert.match(g.status(T0 + 130 * MIN).paused ?? "", /Daily ceiling/);
  const nextDay = await g.decide(Date.parse("2026-11-25T00:05:00Z"));
  assert.equal(nextDay.buy, true);
  assert.equal(g.status(Date.parse("2026-11-25T00:05:00Z")).spentTodayUsd, 0);
});

test("balance floor: under $1 or unreadable means no purchase, and the balance is still reported", async () => {
  const low = gov(async () => 0.5);
  const d = await low.decide(T0);
  assert.equal(d.buy, false);
  assert.match(d.note, /\$0\.50, below the \$1\.00 floor/);
  assert.equal(low.status(T0).escrowAvailableUsd, 0.5);
  const broken = gov(async () => {
    throw new Error("ledger read failed with 503");
  });
  const b = await broken.decide(T0);
  assert.equal(b.buy, false);
  assert.match(b.note, /could not be read.*Failing closed/);
  assert.equal(broken.status(T0).escrowAvailableUsd, null);
  assert.equal((await gov(async () => 1).decide(T0)).buy, true, "exactly the floor is allowed");
});

function fakeNode(): { t: Transport; asks: string[] } {
  const asks: string[] = [];
  return {
    asks,
    t: {
      async ask(req) {
        asks.push(req.minerId);
        const result = req.minerId === MINERS.supply.id ? { total_supply: 81654.762282 } : req.minerId === MINERS.filings.id ? { filing_count: 1, filings: ["D/A 2026-07-14"], urls: [] } : { matched: false };
        return { minerId: req.minerId, result, costUsd: 0.01, answeredAt: new Date(T0).toISOString(), receipt: { receiptHash: `synthetic-${asks.length}`, rail: "synthetic" } };
      },
    },
  };
}

test("passes: the first pass buys, the next free pass shows those purchases again, labelled, and spends nothing", async () => {
  const store = tmpStore();
  const node = fakeNode();
  const g = gov(async () => 9.5);
  const buy = { enabled: true, capUsd: 0.25, transport: node.t, governor: g };
  let now = T0;
  const ctx = { ...ctxFor(fixture()), now: () => now };

  const a = await runPass({ ctx, store, mode: "live", buy });
  assert.equal(node.asks.length, 14); // 7 USTB + 4 BUIDL + 3 USDY
  const ustbA = a.reports.find((r) => r.assetId === "ustb")!;
  assert.equal(ustbA.buy.paidThisPass, true);
  assert.equal(ustbA.checks.find((c) => c.id === "tg-supply")!.telegraph!.state, "bought");
  assert.ok(Math.abs(g.status(now).spentTodayUsd - 0.14) < 1e-9);

  now = T0 + 15 * MIN;
  const b = await runPass({ ctx, store, mode: "live", buy });
  assert.equal(node.asks.length, 14, "no new asks inside the hour");
  const ustbB = b.reports.find((r) => r.assetId === "ustb")!;
  assert.equal(ustbB.buy.paidThisPass, false);
  assert.match(ustbB.buy.note ?? "", /at most every 60 minutes/);
  const carried = ustbB.checks.find((c) => c.id === "tg-supply")!;
  assert.equal(carried.telegraph!.state, "bought");
  assert.equal(carried.telegraph!.carriedFrom, new Date(T0).toISOString());
  assert.match(carried.summary, /not asked again this pass/);
  assert.ok(carried.telegraph!.calls[0]!.receipt!.receiptHash!.startsWith("synthetic-"));
  assert.equal(ustbB.checks.find((c) => c.id === "filings")!.status, "pass");

  now = T0 + 61 * MIN;
  await runPass({ ctx, store, mode: "live", buy });
  assert.equal(node.asks.length, 28, "an hour later it buys again");
});

test("passes: the daily total survives a restart", async () => {
  const store = tmpStore();
  const node = fakeNode();
  const buyWith = () => ({ enabled: true, capUsd: 0.25, transport: node.t, governor: gov(async () => 9, { dailyUsd: 0.14 }) });
  let now = T0;
  const ctx = { ...ctxFor(fixture()), now: () => now };
  await runPass({ ctx, store, mode: "live", buy: buyWith() });
  assert.equal(node.asks.length, 14);
  now = T0 + 90 * MIN;
  const r = await runPass({ ctx, store, mode: "live", buy: buyWith() }); // a fresh governor, as after a redeploy
  assert.equal(node.asks.length, 14, "the ceiling was already used up today");
  assert.match(r.reports[0]!.buy.note ?? "", /Daily ceiling/);
  assert.equal(r.reports[0]!.checks.find((c) => c.id === "sanctions")!.telegraph!.carriedFrom, new Date(T0).toISOString());
});

test("passes: a low escrow balance stops the pass before any ask, and the rows say why", async () => {
  const store = tmpStore();
  const node = fakeNode();
  const r = await runPass({ ctx: ctxFor(fixture()), store, mode: "live", buy: { enabled: true, capUsd: 0.25, transport: node.t, governor: gov(async () => 0.4) } });
  assert.equal(node.asks.length, 0);
  const row = r.reports[0]!.checks.find((c) => c.id === "tg-supply")!;
  assert.equal(row.telegraph!.state, "not-bought");
  assert.match(row.summary, /Not bought this pass/);
  assert.match(row.telegraph!.reason ?? "", /below the \$1\.00 floor/);
});
