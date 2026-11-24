// The checks. Shared ones run for every asset; the issuer reader of each asset adds its own rows.
import { CHAINS, pinnedCalls, readErc20Supply, SEL } from "./evm.ts";
import { OTHER_READERS } from "./others.ts";
import { getText, sourceOf, type Ctx } from "./net.ts";
import type { AssetSpec } from "./registry.ts";
import { readLei, searchLeiByName, type LeiRecord } from "./readers/gleif.ts";
import { readOndo, type OndoRead } from "./readers/ondo.ts";
import { readSuperstate, type SuperstateRead } from "./readers/superstate.ts";
import { controls, extension, readActivity, readMint, supplyOf, supplyText, type ActivityRead, type MintRead } from "./solana.ts";
import { diffFacts, type Facts, type Snapshot } from "./store.ts";
import { BuySession, demoLeg, ENGINE_ASK_USD, MINERS } from "./telegraph.ts";
import type { Cell, CheckRow, Change, SourceRef, Status, TelegraphCall, TelegraphLeg } from "./types.ts";
import { daysBetween, errText, iso, num, relDiff, unitsToNumber, usd } from "./util.ts";

export interface RunDeps {
  ctx: Ctx;
  buy: BuySession;
  prev: Snapshot | null;
}

export interface AssetRun {
  rows: CheckRow[];
  facts: Facts;
  changes: Change[];
}

const tok = (n: number, d = 6): string => {
  const s = num(n, d);
  return d === 0 ? s : s.replace(/0+$/, "").replace(/\.$/, "");
};
const dayMs = (isoDay: string): number => Date.parse(`${isoDay}T00:00:00Z`);

function row(r: Omit<CheckRow, "values" | "sources"> & { values?: Record<string, Cell>; sources?: SourceRef[] }): CheckRow {
  return { values: {}, sources: [], ...r };
}

const holdRow = (id: string, group: CheckRow["group"], title: string, missing: string, why: string, sources: SourceRef[] = []): CheckRow =>
  row({ id, group, title, status: "hold", summary: why, missing, sources });

// ---------------------------------------------------------------- 1. mint state and 2. activity

function mintRows(spec: AssetSpec, read: MintRead | null, err: string | null, prev: Snapshot | null, changes: Change[]): CheckRow[] {
  if (!read) {
    return [
      holdRow("mint-state", "chain", "Mint state on two RPCs", "a mint read that two public RPCs agree on", `Refused: ${err}. No value from this mint is used until two RPCs agree.`),
      holdRow("mint-diff", "chain", "Controls against the previous snapshot", "the mint state, which was refused", "Not compared, because the current mint state was refused."),
    ];
  }
  const s = read.state;
  const c = controls(s);
  const stateRow = row({
    id: "mint-state",
    group: "chain",
    title: "Mint state on two RPCs",
    status: "pass",
    summary: `Two RPCs return the same mint. Supply ${supplyText(s)} ${spec.symbol}, ${s.program}, mint authority ${c.mintAuthority ?? "none"}, freeze authority ${c.freezeAuthority ?? "none"}.`,
    values: {
      supply: supplyText(s),
      decimals: s.decimals,
      ...c,
      "slots read": read.rpcs.map((r) => r.slot).join(" and "),
      "slot gap": read.slotGap,
    },
    sources: read.sources,
  });
  const mintChanges = changes.filter((x) => x.path.startsWith("mint."));
  let diffRow: CheckRow;
  if (!prev?.facts.mint) {
    diffRow = row({
      id: "mint-diff",
      group: "chain",
      title: "Controls against the previous snapshot",
      status: "hold",
      summary: "This is the first snapshot of this mint, so there is nothing to compare against yet. The next run will diff against it.",
      missing: "an earlier snapshot of the mint",
    });
  } else {
    const flags = mintChanges.filter((x) => x.severity === "flag");
    const supplyChange = mintChanges.find((x) => x.path === "mint.supply");
    diffRow = row({
      id: "mint-diff",
      group: "chain",
      title: "Controls against the previous snapshot",
      status: flags.length ? "flag" : "pass",
      summary: flags.length
        ? `${flags.length} control change${flags.length > 1 ? "s" : ""} since ${prev.takenAt}: ${flags.map((f) => `${f.path} ${f.before} to ${f.after}`).join("; ")}.`
        : `Authorities and extensions are unchanged since ${prev.takenAt}.${supplyChange ? ` Supply moved from ${supplyChange.before} to ${supplyChange.after}.` : " Supply is unchanged."}`,
      values: { "compared with": prev.takenAt, "previous hash": prev.hash.slice(0, 16), "control changes": flags.length, "supply changed": !!supplyChange },
    });
  }
  return [stateRow, diffRow];
}

function activityRow(spec: AssetSpec, act: ActivityRead | null, err: string | null, supply: number | null): CheckRow {
  if (!act) return holdRow("activity", "chain", "Recent mints, burns and authority changes", "a transaction history from a Solana RPC", `Not read: ${err}.`);
  const by = (k: string) => act.events.filter((e) => e.kind === k);
  const sum = (k: string) => by(k).reduce((a, e) => a + (e.amount ?? 0), 0);
  const admin = [...by("set-authority"), ...by("extension-change")];
  const biggest = Math.max(0, ...[...by("mint"), ...by("burn")].map((e) => e.amount ?? 0));
  const wanted = Math.min(act.signaturesSeen - act.failedSkipped, 12);
  const thin = act.inspected < Math.min(3, wanted) || act.inspected < wanted / 2;
  const spike = supply !== null && supply > 0 && biggest / supply > 0.5;
  const status: Status = admin.length || spike ? "flag" : thin ? "hold" : "pass";
  const when = (t: number | null) => (t ? iso(t * 1000) : "n/a");
  const parts = [`${act.inspected} transactions inspected`, `${by("mint").length} mints (${tok(sum("mint"))})`, `${by("burn").length} burns (${tok(sum("burn"))})`];
  if (by("freeze").length || by("thaw").length) parts.push(`${by("freeze").length} freezes, ${by("thaw").length} thaws`);
  return row({
    id: "activity",
    group: "chain",
    title: "Recent mints, burns and authority changes",
    status,
    ...(status === "hold" ? { missing: "transaction details for the recent signatures" } : {}),
    summary: status === "hold" ? `Only ${act.inspected} of ${wanted} transactions could be fetched (${act.inspectFailures.first}), too few to say what happened on the mint.` : admin.length
      ? `Authority or extension instructions appeared on the mint: ${admin.map((e) => `${e.kind} ${e.authorityType ?? e.detail ?? ""} in ${e.signature.slice(0, 12)}...`).join("; ")}.`
      : spike
        ? `One mint or burn moved ${tok(biggest)} tokens, ${num((biggest / (supply ?? 1)) * 100, 0)}% of current supply.`
        : `${parts.join(", ")}. No authority changes. Window ${when(act.oldestInspectedAt)} to ${when(act.newestAt)}.`,
    values: {
      "signatures listed": act.signaturesSeen,
      "failed, skipped": act.failedSkipped,
      "transactions inspected": act.inspected,
      "transactions not fetched": act.inspectFailures.count ? `${act.inspectFailures.count} (${act.inspectFailures.first})` : 0,
      mints: by("mint").length,
      "tokens minted": sum("mint"),
      burns: by("burn").length,
      "tokens burned": sum("burn"),
      "largest single mint or burn": biggest,
      "burns by permanent delegate": by("burn").filter((e) => e.byPermanentDelegate).length,
      "freezes / thaws": `${by("freeze").length} / ${by("thaw").length}`,
      "transfers seen": by("transfer").length,
      "authority changes": by("set-authority").length,
      "extension changes": by("extension-change").length,
      "window start": when(act.oldestInspectedAt),
      "newest transaction": when(act.newestAt),
    },
    sources: act.sources,
  });
}

// ---------------------------------------------------------------- 5. entities

async function entityRow(spec: AssetSpec, ctx: Ctx, facts: Facts): Promise<CheckRow> {
  const values: Record<string, Cell> = {};
  const sources: SourceRef[] = [];
  const problems: string[] = [];
  const unread: string[] = [];
  let ok = 0;
  const pinned = await Promise.allSettled(spec.entities.filter((e) => e.lei).map(async (e) => ({ e, r: await readLei(ctx, e.lei!) })));
  pinned.forEach((p, i) => {
    const e = spec.entities.filter((x) => x.lei)[i]!;
    if (p.status === "rejected") {
      unread.push(e.name);
      values[e.name] = `not read: ${errText(p.reason)}`;
      return;
    }
    const rec: LeiRecord = p.value.r.record;
    sources.push(p.value.r.source);
    facts.entities[e.name] = { legalName: rec.legalName, entityStatus: rec.entityStatus, registrationStatus: rec.registrationStatus };
    const nameOk = !e.expectName || rec.legalName.toUpperCase().includes(e.expectName.toUpperCase());
    const live = rec.entityStatus === "ACTIVE" && rec.registrationStatus === "ISSUED";
    values[`${e.name} (${e.role})`] = `${rec.lei}: ${rec.legalName}, ${rec.entityStatus} / ${rec.registrationStatus}, renewal due ${rec.nextRenewal?.slice(0, 10) ?? "n/a"}`;
    if (!nameOk) problems.push(`${e.name}: LEI ${rec.lei} now names "${rec.legalName}"`);
    else if (!live) problems.push(`${e.name}: ${rec.entityStatus} / ${rec.registrationStatus}`);
    else ok++;
  });
  const lookups = await Promise.allSettled(spec.leiNameLookups.map((n) => searchLeiByName(ctx, n)));
  lookups.forEach((l, i) => {
    const n = spec.leiNameLookups[i]!;
    if (l.status === "rejected") {
      values[`lookup: ${n}`] = `not read: ${errText(l.reason)}`;
      return;
    }
    sources.push(l.value.source);
    const r = l.value.records;
    values[`lookup: ${n}`] = r.length === 0 ? "no record with exactly this legal name (a name search is not proof of absence)" : `${r.length} record(s), not pinned: ${r.map((x) => `${x.lei} ${x.legalName} ${x.entityStatus}`).join("; ")}`;
  });
  if (spec.entities.length === 0) {
    return row({
      id: "entity-lei",
      group: "entity",
      title: "Legal entities in GLEIF",
      status: "hold",
      summary: "No LEI is pinned for this asset's issuer. Name lookups are listed, but a lookup is not a verified link to the issuer.",
      missing: "a verified LEI for the issuing entity",
      values,
      sources,
    });
  }
  const status: Status = problems.length ? "flag" : unread.length ? "hold" : "pass";
  return row({
    id: "entity-lei",
    group: "entity",
    title: "Legal entities in GLEIF",
    status,
    summary: problems.length
      ? `LEI problem: ${problems.join("; ")}.`
      : unread.length
        ? `${ok} of ${ok + unread.length} pinned LEIs read; GLEIF did not answer for ${unread.join(", ")}.`
        : `${ok} pinned LEI record${ok > 1 ? "s are" : " is"} ACTIVE and ISSUED, with the expected legal name.`,
    ...(status === "hold" ? { missing: `GLEIF records for ${unread.join(", ")}` } : {}),
    values,
    sources,
  });
}

// ---------------------------------------------------------------- Telegraph legs (6, 4 and the sanctions half of 5)

function legState(calls: TelegraphCall[]): TelegraphLeg["state"] {
  return calls.length > 0 && calls.every((c) => c.outcome === "answered") ? "bought" : "failed";
}


async function supplyLeg(spec: AssetSpec, buy: BuySession, ours: number | null): Promise<CheckRow> {
  const m = MINERS.supply;
  const title = "Supply through Telegraph";
  if (!buy.enabled) {
    return row({
      id: "tg-supply",
      group: "telegraph",
      title,
      status: "hold",
      summary: `${buy.notBought} In BUY mode Reckon asks miner ${m.id} (${m.name}) for the Solana supply of ${spec.symbol} and compares it with its own two-RPC read. Estimated $${ENGINE_ASK_USD.toFixed(2)}.`,
      missing: "an independent supply read bought through Telegraph",
      telegraph: demoLeg(m, 1, buy.offReason),
    });
  }
  const call = await buy.ask(m, `${spec.symbol} on Solana`, { token: `${spec.solanaMint} solana` });
  const leg: TelegraphLeg = { intent: m.intent, minerId: m.id, minerName: m.name, estCostUsd: ENGINE_ASK_USD, state: legState([call]), calls: [call] };
  if (call.outcome !== "answered") return row({ id: "tg-supply", group: "telegraph", title, status: "hold", summary: `The ask did not complete: ${call.note}.`, missing: "an independent supply read", telegraph: leg });
  const theirs = Number(call.answer?.total_supply);
  if (!Number.isFinite(theirs) || ours === null) {
    return row({ id: "tg-supply", group: "telegraph", title, status: "hold", summary: "The miner answered without a usable total_supply, or Reckon has no supply of its own to compare.", missing: "a comparable supply", telegraph: leg });
  }
  const d = relDiff(theirs, ours);
  return row({
    id: "tg-supply",
    group: "telegraph",
    title,
    status: d <= 0.0001 ? "pass" : "flag",
    summary: d <= 0.0001 ? `Miner ${m.id} reports ${tok(theirs)}, matching Reckon's ${tok(ours)}.` : `Miner ${m.id} reports ${tok(theirs)} against Reckon's ${tok(ours)} (${num(d * 100, 4)}% apart).`,
    values: { "miner supply": theirs, "reckon supply": ours, "relative difference": d },
    telegraph: leg,
  });
}

export function newestDate(texts: string[]): string | null {
  const dates = texts.flatMap((t) => t.match(/\d{4}-\d{2}-\d{2}/g) ?? []).sort();
  return dates.at(-1) ?? null;
}

async function filingsLeg(spec: AssetSpec, buy: BuySession, facts: Facts): Promise<CheckRow> {
  const title = "SEC filing trail";
  const f = spec.filings;
  if (!f) {
    return row({
      id: "filings",
      group: "regulatory",
      title,
      status: "hold",
      summary: "Nothing to monitor: this is a Regulation S offering and no EDGAR filing was found for its issuer.",
      missing: "a regulatory filing trail for this asset",
    });
  }
  const m = MINERS.filings;
  const base: Record<string, Cell> = { cik: f.cik, "known latest (research note)": `${f.latestForm} ${f.latestDate}` };
  if (!buy.enabled) {
    return row({
      id: "filings",
      group: "regulatory",
      title,
      status: "hold",
      summary: `${buy.notBought} EDGAR refuses undeclared clients, so this leg goes through Telegraph: miner ${m.id} (${m.name}) reads the SEC submissions API. The newest filing known on 2026-11-23 was ${f.latestForm} ${f.latestDate}; a later one would be flagged.`,
      missing: "the current SEC filing list for the CIK, bought through Telegraph",
      values: base,
      telegraph: demoLeg(m, 1, buy.offReason),
    });
  }
  const call = await buy.ask(m, f.telegraphEntity, { entity: f.telegraphEntity, period: "last 12 months" });
  const leg: TelegraphLeg = { intent: m.intent, minerId: m.id, minerName: m.name, estCostUsd: ENGINE_ASK_USD, state: legState([call]), calls: [call] };
  if (call.outcome !== "answered") return row({ id: "filings", group: "regulatory", title, status: "hold", summary: `The ask did not complete: ${call.note}.`, missing: "the SEC filing list", values: base, telegraph: leg });
  const titles = Array.isArray(call.answer?.filings) ? (call.answer!.filings as unknown[]).map(String) : [];
  const urls = Array.isArray(call.answer?.urls) ? (call.answer!.urls as unknown[]).map(String) : [];
  const count = Number(call.answer?.filing_count);
  const newest = newestDate([...titles, ...urls]);
  facts.filings = { latestDate: newest, count: Number.isFinite(count) ? count : null };
  const values = { ...base, "filings in window": Number.isFinite(count) ? count : null, "newest date in answer": newest, "newest title": titles[0] ?? null };
  if (!newest) return row({ id: "filings", group: "regulatory", title, status: "hold", summary: "The miner answered, but no filing date could be read from its titles or URLs, so nothing can be compared.", missing: "filing dates", values, telegraph: leg });
  if (newest > f.latestDate) return row({ id: "filings", group: "regulatory", title, status: "flag", summary: `A filing dated ${newest} is newer than the latest known (${f.latestForm} ${f.latestDate}).`, values, telegraph: leg });
  if (newest < f.latestDate) return row({ id: "filings", group: "regulatory", title, status: "hold", summary: `The miner's newest filing (${newest}) is older than ${f.latestDate}, which EDGAR showed on 2026-11-23. The miner may be incomplete.`, missing: "a complete filing list", values, telegraph: leg });
  return row({ id: "filings", group: "regulatory", title, status: "pass", summary: `The newest filing is ${newest}, the same as the latest known. No new filing.`, values, telegraph: leg });
}

async function sanctionsLeg(spec: AssetSpec, buy: BuySession): Promise<CheckRow> {
  const m = MINERS.sanctions;
  const title = "Sanctions screening of the named entities";
  const names = spec.sanctionsNames;
  if (!buy.enabled) {
    return row({
      id: "sanctions",
      group: "entity",
      title,
      status: "hold",
      summary: `${buy.notBought} In BUY mode each of ${names.length} names is screened by miner ${m.id} (${m.name}): ${names.join("; ")}. Estimated $${(names.length * ENGINE_ASK_USD).toFixed(2)}.`,
      missing: "sanctions screening of issuer, adviser, custodian and administrator, bought through Telegraph",
      values: { names: names.join("; ") },
      telegraph: demoLeg(m, names.length, buy.offReason),
    });
  }
  const calls: TelegraphCall[] = [];
  for (const n of names) calls.push(await buy.ask(m, n, { name: n }));
  const leg: TelegraphLeg = { intent: m.intent, minerId: m.id, minerName: m.name, estCostUsd: names.length * ENGINE_ASK_USD, state: legState(calls), calls };
  const values: Record<string, Cell> = {};
  const hits: string[] = [];
  let unanswered = 0;
  for (const c of calls) {
    if (c.outcome !== "answered") {
      unanswered++;
      values[c.subject] = `not screened: ${c.note}`;
      continue;
    }
    const raw = String(c.answer?.matched ?? "").toLowerCase();
    const matched = ["true", "yes", "match", "matched", "1"].includes(raw);
    const clear = ["false", "no", "0", "no match", "not matched", "clear"].includes(raw);
    if (matched) hits.push(c.subject);
    else if (!clear) unanswered++;
    values[c.subject] = matched ? "MATCH" : clear ? "no match" : `unreadable answer: ${raw}`;
  }
  const status: Status = hits.length ? "flag" : unanswered ? "hold" : "pass";
  return row({
    id: "sanctions",
    group: "entity",
    title,
    status,
    summary: hits.length ? `Possible sanctions match for: ${hits.join("; ")}. This is evidence for a person to review.` : unanswered ? `${calls.length - unanswered} of ${calls.length} names screened.` : `${calls.length} names screened, no match.`,
    ...(status === "hold" ? { missing: "screening of every named entity" } : {}),
    values,
    telegraph: leg,
  });
}

// ---------------------------------------------------------------- USTB (issuer reconciliation)

interface ChainSupplyRead {
  label: string;
  supply: number | null;
  corroboration: string;
  sources: SourceRef[];
  error: string | null;
}

/** Supply on every non-Solana chain the asset uses: EVM chains on two or three RPCs, other chains as far as one endpoint allows. */
async function chainSupplies(spec: AssetSpec, ctx: Ctx): Promise<ChainSupplyRead[]> {
  const res = await Promise.allSettled(spec.evm.map((c) => readErc20Supply(ctx, CHAINS[c.chain]!, c.address)));
  const out: ChainSupplyRead[] = res.map((r, i) =>
    r.status === "fulfilled"
      ? { label: spec.evm[i]!.label, supply: r.value.supply, corroboration: `${r.value.rpcs.length} RPCs agree at block ${r.value.block}`, sources: r.value.sources, error: null }
      : { label: spec.evm[i]!.label, supply: null, corroboration: "", sources: [], error: errText(r.reason) },
  );
  if (spec.id === "usdy") {
    const names = Object.keys(OTHER_READERS);
    const others = await Promise.allSettled(names.map((n) => OTHER_READERS[n]!(ctx)));
    others.forEach((r, i) =>
      out.push(
        r.status === "fulfilled"
          ? { label: names[i]!, supply: r.value.supply, corroboration: r.value.corroboration, sources: r.value.sources, error: null }
          : { label: names[i]!, supply: null, corroboration: "", sources: [], error: errText(r.reason) },
      ),
    );
  }
  return out;
}

function ustbRows(spec: AssetSpec, ss: SuperstateRead, sol: MintRead | null, evm: ChainSupplyRead[], nowMs: number, facts: Facts): CheckRow[] {
  const out: CheckRow[] = [];
  const unavailable = (id: string, title: string, what: string): CheckRow =>
    holdRow(id, "issuer", title, what, ss.page.ok ? "Not computed." : `The issuer page could not be read or parsed: ${ss.page.error}. Failing closed.`, ss.sources);
  if (!ss.page.ok) {
    return [
      unavailable("issuer-supply", "On-chain supply against the issuer's tokens per network", "the issuer's per-network token counts"),
      unavailable("issuer-nav-aum", "Shares times NAV against reported AUM", "the issuer's AUM and per-network values"),
      unavailable("issuer-freshness", "As-of dates and staleness", "the issuer's as-of dates"),
      unavailable("issuer-holdings", "Holdings table against AUM", "the issuer's holdings table"),
    ];
  }
  const p = ss.page.value;
  const pageSources = ss.sources;
  const find = (name: string) => p.networks.find((n) => n.name === name);

  // --- supply per network
  const pairs: { label: string; chain: number | null; err: string | null }[] = [
    { label: "Solana", chain: sol ? supplyOf(sol.state) : null, err: sol ? null : "Solana mint read was refused" },
    ...evm.map((e) => ({ label: e.label, chain: e.supply, err: e.error })),
  ];
  const vals: Record<string, Cell> = {};
  let anyFlag = false;
  let unread = 0;
  const lines: string[] = [];
  const supplySources: SourceRef[] = [...pageSources];
  for (const pr of pairs) {
    const net = find(pr.label);
    if (!net) {
      vals[pr.label] = "the issuer page has no row for this network";
      unread++;
      continue;
    }
    if (pr.chain === null) {
      vals[pr.label] = `not compared: ${pr.err}`;
      unread++;
      continue;
    }
    const d = pr.chain - net.shares;
    const verdict = Math.abs(d) <= 0.011 ? "exact" : relDiff(pr.chain, net.shares) <= spec.supplyTolerance ? "within drift" : "FLAG";
    if (verdict === "FLAG") anyFlag = true;
    vals[pr.label] = `chain ${tok(pr.chain)} | issuer ${num(net.shares, 2)} | difference ${num(d, 4)} | ${verdict}`;
    lines.push(`${pr.label} ${verdict}`);
  }
  for (const e of evm) supplySources.push(...e.sources);
  if (sol) supplySources.push(...sol.sources);
  out.push(
    row({
      id: "issuer-supply",
      group: "issuer",
      title: "On-chain supply against the issuer's tokens per network",
      status: anyFlag ? "flag" : unread ? "hold" : "pass",
      summary: anyFlag
        ? "On-chain supply and the issuer's per-network figure differ by more than the drift allowed."
        : unread
          ? `Compared ${lines.length} network${lines.length === 1 ? "" : "s"}; ${unread} could not be compared. Matches so far: ${lines.join(", ")}.`
          : `Every network reconciles: ${lines.join(", ")}. This is the chain against the issuer's own ledger, not an audit.`,
      ...(unread && !anyFlag ? { missing: "an on-chain read for every network row" } : {}),
      values: { ...vals, "issuer figure as of": p.asOf, tolerance: `${num(spec.supplyTolerance * 100, 3)}% of supply, or 0.011 token for an exact match` },
      sources: supplySources,
    }),
  );

  // --- NAV x shares against AUM
  const sumShares = p.networks.reduce((a, n) => a + n.shares, 0);
  const sumValue = p.networks.reduce((a, n) => a + n.valueUsd, 0);
  const navs = p.networks.map((n) => ({ name: n.name, nav: n.valueUsd / n.shares }));
  const navMin = Math.min(...navs.map((n) => n.nav));
  const navMax = Math.max(...navs.map((n) => n.nav));
  const impliedNav = sumValue / sumShares;
  const recomputed = sumShares * impliedNav;
  const aumGap = Math.abs(sumValue - p.aumUsd);
  const aumTol = Math.max(100, p.aumUsd * 0.00002);
  const spread = (navMax - navMin) / impliedNav;
  const solanaRow = find("Solana");
  const solanaPct = solanaRow ? (solanaRow.valueUsd / p.aumUsd) * 100 : null;
  const navOk = spread <= 0.0001 && aumGap <= aumTol;
  out.push(
    row({
      id: "issuer-nav-aum",
      group: "issuer",
      title: "Shares times NAV against reported AUM",
      status: navOk ? "pass" : "flag",
      summary: navOk
        ? `Every network implies the same NAV per share (${impliedNav.toFixed(4)}), and the network values add to ${usd(sumValue)} against the reported ${usd(p.aumUsd, 0)}.`
        : `The network rows imply NAV per share between ${navMin.toFixed(4)} and ${navMax.toFixed(4)}, or their values (${usd(sumValue)}) do not add to the reported AUM (${usd(p.aumUsd, 0)}).`,
      values: {
        "reported AUM": p.aumUsd,
        "sum of network values": Math.round(sumValue * 100) / 100,
        "gap": Math.round(aumGap * 100) / 100,
        "allowed gap": Math.round(aumTol),
        "implied NAV per share": Number(impliedNav.toFixed(6)),
        "NAV spread across networks": spread,
        "shares times NAV": Math.round(recomputed),
        "NAV shown by the page": p.navPerShare,
        "Solana share of AUM (computed)": solanaPct === null ? null : Number(solanaPct.toFixed(3)),
        "30-day yield": p.yield30Pct,
      },
      sources: pageSources,
    }),
  );
  facts.issuer.aumUsd = p.aumUsd;
  facts.issuer.impliedNav = Number(impliedNav.toFixed(6));

  // --- freshness
  const headlineAge = daysBetween(nowMs, dayMs(p.asOf));
  const holdAge = daysBetween(nowMs, dayMs(p.holdings.asOf));
  const skew = daysBetween(dayMs(p.asOf), dayMs(p.holdings.asOf));
  const stale = headlineAge > spec.maxIssuerAgeDays || holdAge > spec.maxHoldingsAgeDays;
  out.push(
    row({
      id: "issuer-freshness",
      group: "issuer",
      title: "As-of dates and staleness",
      status: stale ? "flag" : "pass",
      summary: stale
        ? `The issuer's figures are older than allowed: headline ${num(headlineAge, 1)} days, holdings ${num(holdAge, 1)} days.`
        : `Headline figures are as of ${p.asOf} (${num(headlineAge, 1)} days old). Holdings are as of ${p.holdings.asOf}, ${num(skew, 0)} days before the headline.`,
      values: { "headline as of": p.asOf, "headline age (days)": Number(headlineAge.toFixed(2)), "holdings as of": p.holdings.asOf, "holdings age (days)": Number(holdAge.toFixed(2)), "holdings behind headline (days)": Number(skew.toFixed(1)), "limit, headline (days)": spec.maxIssuerAgeDays, "limit, holdings (days)": spec.maxHoldingsAgeDays },
      sources: pageSources,
    }),
  );

  // --- holdings
  const h = p.holdings.rows;
  const hSum = h.reduce((a, r) => a + r.baseValue, 0);
  const pctSum = h.reduce((a, r) => a + r.pctOfFund, 0);
  const matured = h.filter((r) => /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(r.maturity) && Date.parse(`${r.maturity.replace(/-/g, " ")} UTC`) < dayMs(p.holdings.asOf));
  const ratio = hSum / p.aumUsd;
  const hOk = Math.abs(pctSum - 100) <= 1.5 && ratio > 0.95 && ratio < 1.05 && matured.length === 0;
  const wam =
    h.reduce((a, r) => {
      const t = Date.parse(`${r.maturity.replace(/-/g, " ")} UTC`);
      return Number.isFinite(t) ? a + ((t - dayMs(p.holdings.asOf)) / 86_400_000) * r.baseValue : a;
    }, 0) / hSum;
  out.push(
    row({
      id: "issuer-holdings",
      group: "issuer",
      title: "Holdings table against AUM",
      status: hOk ? "pass" : "flag",
      summary: hOk
        ? `${h.length} Treasury bills total ${usd(hSum, 0)}, ${num(ratio * 100, 1)}% of reported AUM, with weights summing to ${num(pctSum, 2)}%. The issuer marks this table unaudited, so this checks consistency, not existence.`
        : `The holdings table does not hang together: ${num(ratio * 100, 1)}% of AUM, weights sum to ${num(pctSum, 2)}%, ${matured.length} bill(s) already matured.`,
      values: { positions: h.length, "sum of base value": hSum, "share of reported AUM": Number(ratio.toFixed(4)), "weights sum (%)": Number(pctSum.toFixed(2)), "already matured": matured.length, "weighted average maturity (days)": Math.round(wam), "holdings as of": p.holdings.asOf, custodian: p.providers.Custodian ?? null, auditor: p.providers.Auditor ?? null },
      sources: pageSources,
    }),
  );

  // --- data.json based rows
  if (!ss.data.ok) {
    const why = `The undocumented __data.json endpoint failed: ${ss.data.error}. Rows that depend on it fail closed; the HTML-based rows above are unaffected.`;
    out.push(holdRow("issuer-mint-listing", "issuer", "Mint listed by the issuer", "the issuer's full Solana mint address", why, pageSources));
    out.push(holdRow("issuer-total", "issuer", "Issuer total against the sum of networks", "the issuer's all-venue total supply", why, pageSources));
    return out;
  }
  const d = ss.data.value;
  const solPage = find("Solana");
  const printed = solPage?.details ?? "";
  const m = /^(.+?)\.\.\.(.+)$/.exec(printed);
  const printedOk = !!m && spec.solanaMint.startsWith(m[1]!) && spec.solanaMint.endsWith(m[2]!);
  const fullOk = d.deployments["900"] === spec.solanaMint && d.solanaContracts.USTBProxy === spec.solanaMint;
  const ethOk = d.deployments["1"]?.toLowerCase() === spec.evm.find((e) => e.chain === "ethereum")?.address.toLowerCase();
  out.push(
    row({
      id: "issuer-mint-listing",
      group: "issuer",
      title: "Mint listed by the issuer",
      status: printedOk && fullOk && ethOk ? "pass" : "flag",
      summary:
        printedOk && fullOk && ethOk
          ? `Superstate's own page data lists ${spec.solanaMint} as the Solana USTB token and the page prints it as ${printed}. The Ethereum address matches too.`
          : `The issuer's listing does not match the registry: page data Solana ${d.deployments["900"] ?? "missing"}, printed ${printed || "missing"}.`,
      values: { "registry mint": spec.solanaMint, "issuer data, Solana": d.deployments["900"] ?? null, "page prints": printed || null, "issuer allowlist program (Solana)": d.solanaContracts.AllowListProxyV2 ?? null, "issuer data, Ethereum": d.deployments["1"] ?? null, "NAV source": d.navSource },
      sources: pageSources,
    }),
  );
  const total = d.totalSupplyAllVenues;
  if (total === null) {
    out.push(holdRow("issuer-total", "issuer", "Issuer total against the sum of networks", "the issuer's all-venue total supply", "The data file has no total_supply field.", pageSources));
  } else {
    const gap = Math.abs(total - sumShares);
    const okTotal = gap <= Math.max(1, total * 0.0001);
    const book = find("Book-entry");
    out.push(
      row({
        id: "issuer-total",
        group: "issuer",
        title: "Issuer total against the sum of networks",
        status: okTotal ? "pass" : "flag",
        summary: okTotal
          ? `The issuer's all-venue total (${num(total, 2)}) equals the four rows (${num(sumShares, 2)}) within ${num(gap, 2)} tokens. Book-entry is ${book ? num(book.shares, 2) : "n/a"} of it, which only the issuer can vouch for.`
          : `The issuer's all-venue total (${num(total, 2)}) and the sum of its rows (${num(sumShares, 2)}) differ by ${num(gap, 2)} tokens.`,
        values: { "all-venue total (page data)": total, "sum of table rows": Number(sumShares.toFixed(2)), gap: Number(gap.toFixed(4)), "book-entry shares": book?.shares ?? null, "book-entry share of total (%)": book ? Number(((book.shares / total) * 100).toFixed(2)) : null },
        sources: pageSources,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- USDY (issuer reconciliation)

async function usdyRows(spec: AssetSpec, od: OndoRead, ctx: Ctx, sol: MintRead | null, evm: ChainSupplyRead[], nowMs: number): Promise<CheckRow[]> {
  const out: CheckRow[] = [];
  const srcs = od.sources;

  // --- addresses
  if (!od.addresses.ok) {
    out.push(holdRow("issuer-mint-listing", "issuer", "Contracts listed by the issuer", "Ondo's address table", `The docs address table could not be read: ${od.addresses.error}.`, srcs));
  } else {
    const rows = od.addresses.value.filter((r) => r.section === "USDY" && r.name === "USDY");
    const docs = (chain: string) => rows.find((r) => r.chain.toLowerCase() === chain.toLowerCase())?.address;
    const mismatches: string[] = [];
    const vals: Record<string, Cell> = {};
    const solDocs = docs("Solana");
    vals["Solana (docs)"] = solDocs ?? "not listed";
    if (solDocs !== spec.solanaMint) mismatches.push("Solana");
    const chainName: Record<string, string> = { ethereum: "Ethereum", bsc: "BSC", mantle: "Mantle", arbitrum: "Arbitrum", sei: "Sei", plume: "Plume" };
    for (const c of spec.evm) {
      const dd = docs(chainName[c.chain]!);
      vals[`${c.label} (docs)`] = dd ?? "not listed";
      if (dd?.toLowerCase() !== c.address.toLowerCase()) mismatches.push(c.label);
    }
    const printed = od.page.ok ? od.page.value.printedAddresses.Solana : undefined;
    const m = printed ? /^(.+?)\.\.\.(.+)$/.exec(printed) : null;
    const printedOk = !!m && spec.solanaMint.startsWith(m[1]!) && spec.solanaMint.endsWith(m[2]!);
    vals["page prints (Solana)"] = printed ?? "page not read";
    if (od.page.ok && !printedOk) mismatches.push("Solana (page)");
    out.push(
      row({
        id: "issuer-mint-listing",
        group: "issuer",
        title: "Contracts listed by the issuer",
        status: mismatches.length ? "flag" : "pass",
        summary: mismatches.length ? `Ondo's listing differs from the registry for: ${mismatches.join(", ")}.` : `Ondo's docs list the registry's Solana mint and ${spec.evm.length} EVM contracts, and the USDY page prints the same Solana mint.`,
        values: { "registry mint": spec.solanaMint, ...vals },
        sources: srcs,
      }),
    );
  }

  if (!od.page.ok) {
    const why = `The USDY page could not be read or parsed: ${od.page.error}. Failing closed.`;
    for (const [id, title, what] of [
      ["issuer-tvl", "Supply across chains against the page's TVL", "the issuer's TVL figure"],
      ["issuer-supply", "Supply across chains against the issuer's value outstanding", "the issuer's value outstanding"],
      ["issuer-arithmetic", "The issuer page's own arithmetic", "the issuer's published figures"],
      ["issuer-freshness", "As-of date and staleness", "the issuer's as-of date"],
    ] as const) out.push(holdRow(id, "issuer", title, what, why, srcs));
    return out;
  }
  const p = od.page.value;

  // --- price on chain
  let price: number | null = null;
  let priceNote = "";
  let priceSources: SourceRef[] = [];
  const wrapper = od.addresses.ok ? od.addresses.value.find((r) => r.section === "USDY" && r.chain === "Ethereum" && r.name === "USDYOracleWrapper")?.address : undefined;
  if (!wrapper) priceNote = "Ondo's docs list no Ethereum USDYOracleWrapper";
  else {
    try {
      const r = await pinnedCalls(ctx, CHAINS.ethereum!, [{ to: wrapper, data: SEL.getPrice }]);
      price = unitsToNumber(r.results[0]!, 18);
      priceSources = r.sources.map((s) => ({ ...s, note: `${s.note}; getPrice() of ${wrapper}` }));
    } catch (e) {
      priceNote = errText(e);
    }
  }
  if (price === null) {
    out.push(holdRow("issuer-price", "issuer", "USDY price on chain against the page", "the on-chain USDY price", `Not read: ${priceNote}.`, srcs));
  } else {
    const pagePrice = p.priceUsd;
    const diff = pagePrice === null ? null : Math.abs(price - pagePrice);
    out.push(
      row({
        id: "issuer-price",
        group: "issuer",
        title: "USDY price on chain against the page",
        status: diff === null ? "hold" : diff <= 0.0005 ? "pass" : "flag",
        summary: diff === null ? `On-chain price is ${price.toFixed(6)}; the page's price was not readable.` : diff <= 0.0005 ? `The Ethereum oracle wrapper returns ${price.toFixed(6)} and the page shows ${pagePrice!.toFixed(4)}.` : `The oracle returns ${price.toFixed(6)} but the page shows ${pagePrice!.toFixed(4)}.`,
        ...(diff === null ? { missing: "the page's displayed price" } : {}),
        values: { "oracle price": Number(price.toFixed(8)), "page price": pagePrice, oracle: wrapper ?? null },
        sources: [...srcs, ...priceSources],
      }),
    );
  }

  // --- supply across chains x price, against the page's TVL and against its "value outstanding"
  const reads: { label: string; supply: number | null; err: string | null; how: string }[] = [
    { label: "Solana", supply: sol ? supplyOf(sol.state) : null, err: "Solana mint read was refused", how: sol ? "two RPCs agree" : "" },
    ...evm.map((e) => ({ label: e.label, supply: e.supply, err: e.error, how: e.corroboration })),
  ];
  const got = reads.filter((r) => r.supply !== null);
  const missing = reads.filter((r) => r.supply === null);
  const totalTokens = got.reduce((a, r) => a + (r.supply ?? 0), 0);
  const vals: Record<string, Cell> = {};
  for (const r of reads) vals[r.label] = r.supply === null ? `not read: ${r.err}` : `${tok(r.supply, 2)} (${r.how})`;
  const chainSources: SourceRef[] = [...srcs, ...priceSources, ...(sol ? sol.sources : []), ...evm.flatMap((e) => e.sources)];
  const solShare = (() => {
    const r = reads.find((x) => x.label === "Solana");
    return r?.supply != null && totalTokens > 0 ? r.supply / totalTokens : null;
  })();
  const common = {
    "tokens summed": Number(totalTokens.toFixed(2)),
    "chains read": got.length,
    "chains not read": missing.map((m) => m.label).join(", ") || "none",
    "Solana share of tokens read (%)": solShare === null ? null : Number((solShare * 100).toFixed(3)),
  };
  if (price === null) {
    const why = `Supply was read on ${got.length} chains but no price is available.`;
    out.push(holdRow("issuer-tvl", "issuer", "Supply across chains against the page's TVL", "the on-chain USDY price, to turn tokens into dollars", why, chainSources));
    out.push(holdRow("issuer-supply", "issuer", "Supply across chains against the issuer's value outstanding", "the on-chain USDY price, to turn tokens into dollars", why, chainSources));
  } else {
    const valueUsd = totalTokens * price;
    const tvlGap = p.tvlUsd ? (valueUsd - p.tvlUsd) / p.tvlUsd : null;
    const outGap = (valueUsd - p.outstandingUsd) / p.outstandingUsd;
    const caveat = "Summing supply across chains can count a bridged token twice (locked or escrowed on its home chain and issued again on the destination), so a sum that is too high is not proof of over-issuance.";
    const notRead = missing.length ? ` Not read: ${missing.map((m) => m.label).join(", ")}.` : "";
    out.push(
      row({
        id: "issuer-tvl",
        group: "issuer",
        title: "Supply across chains against the page's TVL",
        status: tvlGap === null ? "hold" : Math.abs(tvlGap) <= 0.03 && missing.length === 0 ? "pass" : "flag",
        summary:
          tvlGap === null
            ? "The page's TVL figure was not readable."
            : `${got.length} chains read: ${tok(totalTokens, 0)} tokens at ${price.toFixed(4)} is ${usd(valueUsd, 0)}, ${num(Math.abs(tvlGap) * 100, 1)}% ${tvlGap >= 0 ? "above" : "below"} the page's TVL of ${usd(p.tvlUsd!, 0)}.${notRead}`,
        ...(tvlGap === null ? { missing: "the page's TVL figure" } : {}),
        values: { ...vals, ...common, "price used": Number(price.toFixed(6)), "value of tokens read": Math.round(valueUsd), "page TVL (rounded)": p.tvlUsd, "gap vs TVL": tvlGap === null ? null : Number(tvlGap.toFixed(4)) },
        sources: chainSources,
      }),
    );
    const outOk = Math.abs(outGap) <= 0.03 && missing.length === 0;
    out.push(
      row({
        id: "issuer-supply",
        group: "issuer",
        title: "Supply across chains against the issuer's value outstanding",
        status: outOk ? "pass" : "flag",
        summary: outOk
          ? `${got.length} chains read: ${usd(valueUsd, 0)} is within ${num(Math.abs(outGap) * 100, 1)}% of the issuer's ${usd(p.outstandingUsd, 0)} outstanding.`
          : `Does not reconcile. ${got.length} chains read: ${tok(totalTokens, 0)} tokens at ${price.toFixed(4)} is ${usd(valueUsd, 0)} against the issuer's ${usd(p.outstandingUsd, 0)} outstanding (${outGap >= 0 ? "+" : ""}${num(outGap * 100, 1)}%).${notRead} ${caveat}`,
        values: { ...common, "price used": Number(price.toFixed(6)), "value of tokens read": Math.round(valueUsd), "issuer: value outstanding (rounded)": p.outstandingUsd, "gap vs value outstanding": Number(outGap.toFixed(4)), "issuer figure as of": p.asOf },
        sources: chainSources,
      }),
    );
  }

  // --- the page's own arithmetic
  const posSum = p.positions.reduce((a, x) => a + x.valueUsd, 0);
  const ratio = (p.underlyingUsd / p.outstandingUsd) * 100;
  const ratioGap = ratio - p.collateralizationPct;
  const posGap = Math.abs(posSum - p.underlyingUsd) / p.underlyingUsd;
  const ok = Math.abs(ratioGap) <= 2 && posGap <= 0.005;
  out.push(
    row({
      id: "issuer-arithmetic",
      group: "issuer",
      title: "The issuer page's own arithmetic",
      status: ok ? "pass" : "flag",
      summary: ok
        ? `Underlying assets divided by value outstanding is ${num(ratio, 2)}%, matching the stated ratio.`
        : `The page states a collateralization ratio of ${num(p.collateralizationPct, 2)}%, but its own figures give ${num(ratio, 2)}% (${usd(p.underlyingUsd, 0)} underlying over ${usd(p.outstandingUsd, 0)} outstanding). The footnote that would define the ratio was not readable, so this is a finding to explain, not a proven error.${posGap <= 0.005 ? " The positions table does add up to the underlying figure." : ""}`,
      values: { "stated collateralization (%)": p.collateralizationPct, "recomputed (%)": Number(ratio.toFixed(2)), "value outstanding": p.outstandingUsd, "value of underlying": p.underlyingUsd, "sum of positions": posSum, "positions vs underlying (relative gap)": Number(posGap.toFixed(5)), "page TVL": p.tvlUsd },
      sources: srcs,
    }),
  );

  const age = daysBetween(nowMs, dayMs(p.asOf));
  out.push(
    row({
      id: "issuer-freshness",
      group: "issuer",
      title: "As-of date and staleness",
      status: age > spec.maxIssuerAgeDays ? "flag" : "pass",
      summary: age > spec.maxIssuerAgeDays ? `The portfolio overview is ${num(age, 1)} days old, past the ${spec.maxIssuerAgeDays}-day limit.` : `The portfolio overview is as of ${p.asOfText}, ${num(age, 1)} days old.`,
      values: { "as of": p.asOfText, "age (days)": Number(age.toFixed(2)), "limit (days)": spec.maxIssuerAgeDays },
      sources: srcs,
    }),
  );
  return out;
}

// ---------------------------------------------------------------- BUIDL

async function buidlRows(spec: AssetSpec, ctx: Ctx, mint: MintRead | null): Promise<CheckRow[]> {
  const out: CheckRow[] = [];
  const meta = mint ? extension(mint.state, "tokenMetadata") : undefined;
  const uri = meta?.state.uri as string | undefined;
  if (!uri) {
    out.push(holdRow("issuer-metadata", "issuer", "Token metadata against the issuer's host", "the metadata the mint points to", mint ? "The mint has no readable metadata URI." : "The mint read was refused, so there is no URI to follow."));
  } else {
    try {
      const f = await getText(ctx, uri);
      const j = JSON.parse(f.text) as { name?: string; symbol?: string };
      const ok = j.name === meta!.state.name && j.symbol === meta!.state.symbol;
      out.push(
        row({
          id: "issuer-metadata",
          group: "issuer",
          title: "Token metadata against the issuer's host",
          status: ok ? "pass" : "flag",
          summary: ok ? `The metadata file at ${new URL(uri).host} names "${j.name}" (${j.symbol}), the same as the on-chain metadata. This ties the mint to Securitize's host; it is not an issuer listing of the mint.` : `On-chain metadata says "${String(meta!.state.name)}" (${String(meta!.state.symbol)}); the file says "${j.name}" (${j.symbol}).`,
          values: { uri, "on-chain name": String(meta!.state.name), "file name": j.name ?? null },
          sources: [sourceOf(f, "Securitize token metadata")],
        }),
      );
    } catch (e) {
      out.push(holdRow("issuer-metadata", "issuer", "Token metadata against the issuer's host", "the metadata file the mint points to", `Not read: ${errText(e)}.`));
    }
  }
  out.push(
    row({
      id: "issuer-data",
      group: "issuer",
      title: "Issuer figures to reconcile against",
      status: "hold",
      summary: "No official BlackRock or Securitize page publishing BUIDL's NAV, AUM, holdings or per-chain supply was reached, so the on-chain supply has nothing to be reconciled with. The mint itself is not listed on an issuer page either.",
      missing: "an official issuer data page for BUIDL",
      values: { "mint listing": spec.mintListing.note },
    }),
  );
  return out;
}

// ---------------------------------------------------------------- the run

export async function runAsset(spec: AssetSpec, deps: RunDeps): Promise<AssetRun> {
  const { ctx, buy, prev } = deps;
  const facts: Facts = { mint: null, supplies: {}, entities: {}, issuer: {}, filings: null };
  const rows: CheckRow[] = [];

  let mint: MintRead | null = null;
  let mintErr: string | null = null;
  try {
    mint = await readMint(ctx, spec.solanaMint);
    facts.mint = mint.state;
    facts.supplies.Solana = supplyOf(mint.state);
  } catch (e) {
    mintErr = errText(e);
  }
  const delegate = mint ? (controls(mint.state).permanentDelegate as string | null) : null;

  let act: ActivityRead | null = null;
  let actErr: string | null = null;
  const [actRes, evmRes] = await Promise.allSettled([
    mint ? readActivity(ctx, spec.solanaMint, mint.state.decimals, delegate) : Promise.reject(new Error("mint read was refused")),
    spec.reader === "none" ? Promise.resolve([] as ChainSupplyRead[]) : chainSupplies(spec, ctx),
  ]);
  if (actRes.status === "fulfilled") act = actRes.value;
  else actErr = errText(actRes.reason);
  const evm: ChainSupplyRead[] = evmRes.status === "fulfilled" ? evmRes.value : [];
  for (const e of evm) if (e.supply !== null) facts.supplies[e.label] = e.supply;

  // The diff needs the finished facts, so entities and issuer rows are built first and the mint-diff row is placed first afterwards.
  const issuerRows: CheckRow[] = [];
  if (spec.reader === "superstate") issuerRows.push(...ustbRows(spec, await readSuperstate(ctx), mint, evm, ctx.now(), facts));
  else if (spec.reader === "ondo") issuerRows.push(...(await usdyRows(spec, await readOndo(ctx), ctx, mint, evm, ctx.now())));
  else issuerRows.push(...(await buidlRows(spec, ctx, mint)));

  const entity = await entityRow(spec, ctx, facts);
  const supply = mint ? supplyOf(mint.state) : null;
  const legs = [await filingsLeg(spec, buy, facts), await sanctionsLeg(spec, buy), await supplyLeg(spec, buy, supply)];

  const changes = prev ? diffFacts(prev.facts, facts) : [];
  rows.push(...mintRows(spec, mint, mintErr, prev, changes), activityRow(spec, act, actErr, supply), ...issuerRows, legs[0]!, entity, legs[1]!, legs[2]!);
  return { rows, facts, changes };
}

