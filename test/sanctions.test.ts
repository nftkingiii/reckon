// SYNTHETIC tests of the sanctions fallback chain. The miners, their failures and their answers are invented here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAsset } from "../src/checks.ts";
import { byId } from "../src/registry.ts";
import { BuySession, buyOff, MINERS, SANCTIONS_CHAIN, sanctionsVerdict, TransportError, type Transport } from "../src/telegraph.ts";
import { ctxFor, fixture } from "./helpers.ts";

const ustb = byId("ustb")!;
const [M1, M2, M3, M4] = SANCTIONS_CHAIN.map((m) => m.id) as [string, string, string, string];
type Behaviour = (name: string) => Record<string, unknown> | Error;

function node(sanctions: Record<string, Behaviour>): { t: Transport; asks: { miner: string; name?: string }[] } {
  const asks: { miner: string; name?: string }[] = [];
  return {
    asks,
    t: {
      async ask(req) {
        asks.push({ miner: req.minerId, name: req.params.name as string | undefined });
        let result: Record<string, unknown> | Error;
        if (req.minerId === MINERS.supply.id) result = { total_supply: 81654.762282 };
        else if (req.minerId === MINERS.filings.id) result = { filing_count: 1, filings: ["D/A 2026-07-14"], urls: [] };
        else result = (sanctions[req.minerId] ?? (() => new TransportError("no behaviour", 500)))(String(req.params.name));
        if (result instanceof Error) throw result;
        return { minerId: req.minerId, result, costUsd: 0.01, answeredAt: "2026-11-24T10:00:00.000Z", receipt: { receiptHash: `synthetic-${asks.length}` } };
      },
    },
  };
}

const run = (t: Transport, capUsd = 1) => runAsset(ustb, { ctx: ctxFor(fixture()), buy: new BuySession({ enabled: true, capUsd, transport: t }), prev: null });
const sanctionsRow = (r: Awaited<ReturnType<typeof run>>) => r.rows.find((x) => x.id === "sanctions")!;
const circuitOpen = () => new TransportError("paid ask answered 500: upstream call failed: circuit open", 500);

test("SYNTHETIC sanctions: the chain is third-party miners first and 731149 last", () => {
  assert.deepEqual(SANCTIONS_CHAIN.map((m) => m.id), ["710637", "731002", "84392", "64175", "731149"]);
  assert.ok(SANCTIONS_CHAIN.every((m) => !["7310060", "7310099"].includes(m.id)), "none of our own miners");
});

test("SYNTHETIC sanctions: a 500 from the first miner moves to the next, which answers, and the failure is kept in the row", async () => {
  const n = node({ [M1]: circuitOpen, [M2]: () => ({ matched: false }) });
  const row = sanctionsRow(await run(n.t));
  assert.equal(row.status, "pass");
  const call = row.telegraph!.calls[0]!;
  assert.equal(call.minerId, M2);
  assert.deepEqual(call.attempts!.map((a) => [a.minerId, a.outcome]), [[M1, "error"], [M2, "answered"]]);
  assert.match(call.attempts![0]!.note!, /circuit open/);
  assert.match(String(row.values[ustb.sanctionsNames[0]!]), new RegExp(`answered by ${M2}.*failed first: ${M1} error`));
  assert.equal(row.telegraph!.state, "bought");
});

test("SYNTHETIC sanctions: stops at the first proper answer and asks no further miner", async () => {
  const n = node({ [M1]: () => ({ matched: false }), [M2]: () => assert.fail("must not be asked") });
  await run(n.t);
  assert.equal(n.asks.filter((a) => [M2, M3, M4].includes(a.miner)).length, 0);
});

test("SYNTHETIC sanctions: when every miner fails, nothing is called clear, and a failing miner is skipped after two strikes", async () => {
  const n = node({ [M1]: circuitOpen, [M2]: circuitOpen, [M3]: circuitOpen, [M4]: circuitOpen });
  const row = sanctionsRow(await run(n.t));
  assert.equal(row.status, "hold");
  assert.match(row.summary, /not treated as clear/);
  for (const name of ustb.sanctionsNames) assert.match(String(row.values[name]), /^not screened/);
  assert.equal(row.telegraph!.state, "failed");
  assert.equal(row.telegraph!.calls.length, ustb.sanctionsNames.length);
  // 5 names, 5 miners, each miner tried twice and then skipped
  assert.equal(n.asks.filter((a) => a.name).length, 10);
  const last = row.telegraph!.calls.at(-1)!;
  assert.ok(last.attempts!.every((a) => a.outcome === "skipped"));
});

test("SYNTHETIC sanctions: an answer with no readable verdict is not clear; the next miner is tried", async () => {
  const n = node({ [M1]: () => ({ name: "x", note: "ok" }), [M2]: () => ({ matched: false }) });
  const row = sanctionsRow(await run(n.t));
  const call = row.telegraph!.calls[0]!;
  assert.equal(call.minerId, M2);
  assert.equal(call.attempts![0]!.outcome, "error");
  assert.match(call.attempts![0]!.note!, /no readable verdict/);
  assert.equal(row.status, "pass");
});

test("SYNTHETIC sanctions: a BLOCK label from a fallback miner is a flag", async () => {
  const n = node({ [M1]: circuitOpen, [M2]: (name) => ({ label: name === "NAV Fund Services" ? "BLOCK" : "CLEAR" }) });
  const row = sanctionsRow(await run(n.t));
  assert.equal(row.status, "flag");
  assert.match(row.summary, /NAV Fund Services/);
});

test("SYNTHETIC sanctions: the per-pass cap still holds, and a refused ask does not send the name to another miner", async () => {
  const n = node({ [M1]: () => ({ matched: false }) });
  const r = await run(n.t, 0.03); // filings, then two screenings, then the cap
  const row = sanctionsRow(r);
  assert.equal(n.asks.length, 3);
  const refused = row.telegraph!.calls.find((c) => c.outcome === "refused");
  assert.ok(refused);
  assert.equal(refused!.attempts!.length, 1, "no other miner was tried after the cap refused");
  assert.equal(row.status, "hold");
});

test("sanctionsVerdict reads the shapes the miners use and treats the rest as unreadable", () => {
  assert.equal(sanctionsVerdict({ matched: true }), "match");
  assert.equal(sanctionsVerdict({ matched: "no match" }), "clear");
  assert.equal(sanctionsVerdict({ on_list: 1 }), "match");
  assert.equal(sanctionsVerdict({ on_list: 0 }), "clear");
  assert.equal(sanctionsVerdict({ label: "REVIEW" }), "match");
  assert.equal(sanctionsVerdict({ label: "CLEAR" }), "clear");
  assert.equal(sanctionsVerdict({ matched: "maybe" }), null);
  assert.equal(sanctionsVerdict({}), null);
  assert.equal(sanctionsVerdict(undefined), null);
});

test("sanctions with BUY off lists the whole chain and makes no ask", async () => {
  const r = await runAsset(ustb, { ctx: ctxFor(fixture()), buy: new BuySession(buyOff()), prev: null });
  const row = r.rows.find((x) => x.id === "sanctions")!;
  assert.equal(row.telegraph!.state, "not-bought");
  assert.equal(row.telegraph!.chain!.length, 5);
  assert.match(row.summary, /710637 \(Sanctions Name Evidence\), then 731002/);
});
