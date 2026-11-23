// Tests on real responses recorded read-only from the live sources (see fixtures/recorded.json.gz).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAsset } from "../src/checks.ts";
import { runPass } from "../src/monitor.ts";
import { parseAddresses, parseOndoPage } from "../src/readers/ondo.ts";
import { parseSuperstateData, parseSuperstatePage } from "../src/readers/superstate.ts";
import { ASSETS, byId } from "../src/registry.ts";
import { normalizeMint, controls } from "../src/solana.ts";
import { BuySession, buyOff } from "../src/telegraph.ts";
import { toMarkdown } from "../src/report.ts";
import { capture, ctxFor, fixture, runInOrder, tmpStore } from "./helpers.ts";

const fx = fixture();
const row = (rows: { id: string }[], id: string) => rows.find((r) => r.id === id) as any;

test("recorded: the Superstate page parses into networks, AUM and holdings", () => {
  const p = parseSuperstatePage(capture(fx, "superstate.com/assets/ustb").text);
  assert.equal(p.networks.map((n) => n.name).join(","), "Ethereum,Solana,Plume,Book-entry");
  assert.ok(p.aumUsd > 5e8 && p.aumUsd < 9e8);
  assert.match(p.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.navPerShare, null); // the page renders NAV per share client-side and shows a dash
  assert.ok(p.holdings.rows.length > 20);
  assert.equal(p.providers.Custodian, "The Bank of New York Mellon");
  const solana = p.networks.find((n) => n.name === "Solana")!;
  assert.equal(solana.details, "CCz3SG...sVcjo2");
});

test("recorded: the Superstate __data.json decodes the devalue table", () => {
  const d = parseSuperstateData(capture(fx, "__data.json").text);
  assert.equal(d.deployments["900"], "CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2");
  assert.equal(d.solanaContracts.USTBProxy, d.deployments["900"]);
  assert.equal(d.solanaContracts.AllowListProxyV2, "HFkKyweJDUuGer5KaCst5qZSYD5aapKaD7xzdNaoRtfA");
  assert.ok(d.totalSupplyAllVenues! > 1e7);
});

test("recorded: the Ondo page and docs table parse", () => {
  const p = parseOndoPage(capture(fx, "ondo.finance/usdy").text);
  assert.equal(p.collateralizationPct, 156.9);
  assert.ok(p.outstandingUsd > 1e9 && p.underlyingUsd > p.outstandingUsd);
  assert.equal(p.printedAddresses.Solana, "A1KL...Eto6");
  const rows = parseAddresses(capture(fx, "docs.ondo.finance/addresses.md").text).filter((r) => r.section === "USDY" && r.name === "USDY");
  assert.equal(rows.find((r) => r.chain === "Solana")!.address, "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");
  assert.ok(rows.length >= 8);
});

test("recorded: the USTB mint's compliance controls come out of the jsonParsed account", () => {
  const c = fx.captures.find((x) => x.url.includes("api.mainnet-beta.solana.com") && (x.body ?? "").includes("getAccountInfo") && (x.body ?? "").includes("CCz3SG"))!;
  const state = normalizeMint(JSON.parse(c.text).result.value);
  const k = controls(state);
  assert.equal(state.program, "token-2022");
  assert.equal(state.decimals, 6);
  assert.equal(k.defaultAccountState, "frozen");
  assert.ok(k.permanentDelegate);
  assert.equal(k.freezeAuthority, k.permanentDelegate);
  assert.match(String(k.extensions), /permanentDelegate/);
});

test("recorded: a full USTB run reconciles the chain with the issuer and flags nothing", async () => {
  const run = await runAsset(byId("ustb")!, { ctx: ctxFor(fx), buy: new BuySession(buyOff()), prev: null });
  const by = (id: string) => row(run.rows, id);
  assert.equal(by("mint-state").status, "pass");
  assert.equal(by("issuer-supply").status, "pass");
  assert.match(by("issuer-supply").summary, /Solana exact, Ethereum exact, Plume exact/);
  assert.equal(by("issuer-nav-aum").status, "pass");
  assert.equal(by("issuer-mint-listing").status, "pass");
  assert.equal(by("issuer-total").status, "pass");
  assert.equal(by("entity-lei").status, "pass");
  assert.equal(run.rows.filter((r) => r.status === "flag").length, 0);
  // the Solana supply on the row is the same number the issuer table reports, to two decimals
  const p = parseSuperstatePage(capture(fx, "superstate.com/assets/ustb").text);
  const issuerSolana = p.networks.find((n) => n.name === "Solana")!.shares;
  assert.ok(Math.abs(Number(by("mint-state").values.supply) - issuerSolana) < 0.011);
});

test("recorded: BUY mode off marks every Telegraph row not bought and makes no call", async () => {
  const run = await runAsset(byId("ustb")!, { ctx: ctxFor(fx), buy: new BuySession(buyOff()), prev: null });
  const tg = run.rows.filter((r) => r.telegraph);
  assert.deepEqual(tg.map((r) => r.id).sort(), ["filings", "sanctions", "tg-supply"]);
  for (const r of tg) {
    assert.equal(r.status, "hold");
    assert.equal(r.telegraph!.state, "not-bought");
    assert.equal(r.telegraph!.calls.length, 0);
    assert.match(r.summary, /Not bought \(demo\)/);
  }
});

test("recorded: USDY reports the chain sum against both page figures, and the page figures disagree with each other", async () => {
  const run = await runInOrder("usdy");
  const arith = row(run.rows, "issuer-arithmetic");
  assert.equal(arith.status, "flag");
  assert.ok(Math.abs(arith.values["recomputed (%)"] - 122.34) < 0.5);
  const tvl = row(run.rows, "issuer-tvl");
  assert.equal(tvl.status, "pass"); // 12 chains summed land within 3% of the page TVL
  assert.equal(tvl.values["chains read"], 12);
  const out = row(run.rows, "issuer-supply");
  assert.equal(out.status, "flag"); // but not within 3% of the page value outstanding
  assert.ok(out.values["gap vs value outstanding"] > 0.15);
  assert.equal(row(run.rows, "issuer-mint-listing").status, "pass");
  assert.equal(row(run.rows, "issuer-price").status, "pass");
  assert.equal(row(run.rows, "entity-lei").status, "hold");
  assert.equal(row(run.rows, "filings").status, "hold");
});

test("recorded: BUIDL names what it cannot reconcile and does not pretend", async () => {
  const run = await runInOrder("buidl");
  const data = row(run.rows, "issuer-data");
  assert.equal(data.status, "hold");
  assert.match(data.missing, /official issuer data page/);
  assert.equal(row(run.rows, "issuer-metadata").status, "pass");
  assert.equal(controlsOf(run, "transferHookProgram") !== null, true);
});

function controlsOf(run: Awaited<ReturnType<typeof runAsset>>, key: string) {
  return controls(run.facts.mint!)[key];
}

test("recorded: a pass is deterministic and writes a snapshot, history and downloadable report", async () => {
  const store = tmpStore();
  const a = await runPass({ ctx: ctxFor(fx), store, mode: "recorded", buy: buyOff() });
  assert.equal(a.errors.length, 0);
  assert.equal(a.reports.length, ASSETS.length);
  const first = store.latest("ustb")!;
  const b = await runPass({ ctx: ctxFor(fx), store, mode: "recorded", buy: buyOff() });
  assert.equal(b.reports.find((r) => r.assetId === "ustb")!.snapshotHash, first.hash);
  const second = b.reports.find((r) => r.assetId === "ustb")!;
  assert.equal(row(second.checks, "mint-diff").status, "pass");
  assert.equal(second.changes.length, 0);
  assert.equal(store.history("ustb").length, 2);
  const md = toMarkdown(second);
  assert.match(md, /RECORDED fixtures/);
  assert.match(md, /## Cannot be checked, and why/);
  assert.match(md, /Telegraph purchases: OFF/);
});
