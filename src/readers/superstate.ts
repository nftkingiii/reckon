// Superstate's USTB fund page. The HTML is the primary source; the SvelteKit __data.json is an undocumented framework
// endpoint, so everything that depends on it fails closed on its own and never takes the HTML checks down with it.
import { getText, sourceOf, type Ctx } from "../net.ts";
import type { SourceRef } from "../types.ts";
import { errText } from "../util.ts";
import { htmlLines, longDate, money, ParseError, percent, plainNumber, usDate } from "./html.ts";

export const USTB_PAGE = "https://superstate.com/assets/ustb";
export const USTB_DATA = "https://superstate.com/assets/ustb/__data.json";

export interface NetworkRow {
  code: string;
  name: string;
  shares: number;
  valueUsd: number;
  pct: number;
  details: string | null;
}

export interface HoldingRow {
  name: string;
  baseValue: number;
  maturity: string;
  yieldPct: number;
  pctOfFund: number;
}

export interface SuperstatePage {
  aumUsd: number;
  asOf: string;
  navPerShare: number | null;
  yield30Pct: number | null;
  networks: NetworkRow[];
  holdings: { asOf: string; rows: HoldingRow[] };
  providers: Record<string, string>;
}

export function parseSuperstatePage(html: string): SuperstatePage {
  const lines = htmlLines(html);
  const idx = (pred: (l: string) => boolean, from = 0): number => {
    for (let i = from; i < lines.length; i++) if (pred(lines[i]!)) return i;
    return -1;
  };

  const aumAt = idx((l) => l === "Assets under management");
  if (aumAt < 0) throw new ParseError("page has no 'Assets under management' block");
  const aumUsd = money(lines.slice(aumAt + 1, aumAt + 4).find((l) => l.startsWith("$") && money(l) !== null && l.includes(",")));
  if (aumUsd === null) throw new ParseError("AUM figure not found after 'Assets under management'");

  const asOfLine = lines.find((l) => /^As of [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(l));
  const asOf = asOfLine ? longDate(asOfLine) : null;
  if (!asOf) throw new ParseError("headline 'As of <date>' not found");

  const navAt = idx((l) => l === "NAV per share");
  const navLine = navAt >= 0 ? lines[navAt + 1] : undefined;
  const navPerShare = navLine && /^\$\s*[\d.]+$/.test(navLine) ? Number(navLine.replace(/[$\s]/g, "")) : null;

  const yAt = idx((l) => /^30-Day yield$/i.test(l));
  const yield30Pct = yAt >= 0 ? percent(lines.slice(yAt + 1, yAt + 6).find((l) => percent(l) !== null)) : null;

  // Networks table: code, name, shares, token symbol, value, distribution, details.
  const netAt = idx((l) => l === "Networks");
  const endAt = idx((l) => l === "DeFi Integrations", netAt + 1);
  if (netAt < 0 || endAt < 0) throw new ParseError("networks table not found");
  const networks: NetworkRow[] = [];
  for (let i = netAt; i < endAt; i++) {
    if (!/^[A-Z]{2}$/.test(lines[i]!)) continue;
    const name = lines[i + 1];
    const shares = plainNumber(lines[i + 2]);
    const valueUsd = money(lines[i + 4]);
    const pct = percent(lines[i + 5]);
    if (!name || shares === null || valueUsd === null || pct === null || lines[i + 3] !== "USTB") continue;
    const next = lines[i + 6];
    const details = next && i + 6 < endAt && !/^[A-Z]{2}$/.test(next) ? next : null;
    networks.push({ code: lines[i]!, name, shares, valueUsd, pct, details });
  }
  if (networks.length === 0) throw new ParseError("networks table has no readable rows");

  // Holdings: five lines per row, after the column headers.
  const hAt = idx((l) => l === "Holdings");
  const hAsAt = idx((l) => /^As of \d{1,2}\/\d{1,2}\/\d{4}$/.test(l), Math.max(hAt, 0));
  const hasOf = hAsAt >= 0 ? usDate(lines[hAsAt]!) : null;
  if (hAt < 0 || !hasOf) throw new ParseError("holdings table or its as-of date not found");
  const colEnd = idx((l) => l === "% of Fund", hAsAt);
  const holdEnd = idx((l) => l.startsWith("Invest in"), colEnd);
  if (colEnd < 0 || holdEnd < 0) throw new ParseError("holdings table bounds not found");
  const rows: HoldingRow[] = [];
  for (let i = colEnd + 1; i + 4 < holdEnd; i += 5) {
    const base = money(lines[i + 1]);
    const yieldPct = percent(lines[i + 3]);
    const pctOfFund = percent(lines[i + 4]);
    if (base === null || yieldPct === null || pctOfFund === null) break;
    rows.push({ name: lines[i]!, baseValue: base, maturity: lines[i + 2]!, yieldPct, pctOfFund });
  }
  if (rows.length === 0) throw new ParseError("holdings table has no readable rows");

  const spAt = idx((l) => l === "Service providers");
  const spEnd = idx((l) => l === "Resources", spAt + 1);
  const providers: Record<string, string> = {};
  if (spAt >= 0 && spEnd > spAt) for (let i = spAt + 1; i + 1 < spEnd; i += 2) providers[lines[i]!] = lines[i + 1]!;

  return { aumUsd, asOf, navPerShare, yield30Pct, networks, holdings: { asOf: hasOf, rows }, providers };
}

// ---------------------------------------------------------------- __data.json (SvelteKit, devalue-encoded)

export interface SuperstateData {
  totalSupplyAllVenues: number | null;
  deployments: Record<string, string>;
  solanaContracts: Record<string, string>;
  navSource: string | null;
  issuerEntity: string | null;
}

/** Resolves a devalue table (a flat array where objects and arrays hold indices into it). Only what this page needs is supported. */
function resolveDevalue(table: unknown[], root = 0): unknown {
  const memo = new Map<number, unknown>();
  const special = new Set(["Date", "Map", "Set", "BigInt", "RegExp", "Promise", "Reactive", "null", "undefined"]);
  const res = (i: number): unknown => {
    if (i === -1) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = table[i];
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && special.has(v[0])) return v;
      const out: unknown[] = [];
      memo.set(i, out);
      for (const x of v) out.push(typeof x === "number" ? res(x) : x);
      return out;
    }
    const out: Record<string, unknown> = {};
    memo.set(i, out);
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === "number" ? res(x) : x;
    return out;
  };
  return res(root);
}

export function parseSuperstateData(text: string): SuperstateData {
  const lines = text.split("\n").filter(Boolean);
  let first: { nodes?: ({ data?: unknown[] } | null)[] };
  try {
    first = JSON.parse(lines[0]!);
  } catch {
    throw new ParseError("__data.json is not the expected JSON");
  }
  let instrument: Record<string, any> | undefined;
  for (const n of first.nodes ?? []) {
    if (!n?.data) continue;
    const root = resolveDevalue(n.data) as Record<string, any> | undefined;
    if (root && typeof root === "object" && root.instrument?.instrument_symbol === "USTB") instrument = root.instrument;
  }
  if (!instrument) throw new ParseError("__data.json has no USTB instrument record");
  const deployments: Record<string, string> = {};
  for (const [chainId, d] of Object.entries((instrument.deploy_status_by_chain?.by_chain ?? {}) as Record<string, { token_address?: string }>)) {
    if (d?.token_address) deployments[chainId] = d.token_address;
  }
  let solanaContracts: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    try {
      const chunk = JSON.parse(line) as { type?: string; data?: unknown[] };
      if (chunk.type !== "chunk" || !Array.isArray(chunk.data)) continue;
      const chains = resolveDevalue(chunk.data) as { name?: string; contracts?: Record<string, string> }[];
      const sol = Array.isArray(chains) ? chains.find((c) => c?.name === "Solana") : undefined;
      if (sol?.contracts) solanaContracts = sol.contracts;
    } catch {
      /* a chunk that does not parse is skipped; the fields it carried come back empty */
    }
  }
  const total = instrument.total_supply !== undefined ? Number(instrument.total_supply) : NaN;
  return {
    totalSupplyAllVenues: Number.isFinite(total) ? total : null,
    deployments,
    solanaContracts,
    navSource: instrument.fund_configuration?.nav_source ?? null,
    issuerEntity: instrument.issuer_entity_name ?? null,
  };
}

export interface SuperstateRead {
  page: { ok: true; value: SuperstatePage } | { ok: false; error: string };
  data: { ok: true; value: SuperstateData } | { ok: false; error: string };
  sources: SourceRef[];
}

export async function readSuperstate(ctx: Ctx): Promise<SuperstateRead> {
  const sources: SourceRef[] = [];
  let page: SuperstateRead["page"];
  try {
    const f = await getText(ctx, USTB_PAGE);
    sources.push(sourceOf(f, "Superstate fund page (HTML)"));
    page = { ok: true, value: parseSuperstatePage(f.text) };
  } catch (e) {
    page = { ok: false, error: errText(e) };
  }
  let data: SuperstateRead["data"];
  try {
    const f = await getText(ctx, USTB_DATA);
    sources.push(sourceOf(f, "Superstate fund page data (__data.json, undocumented)", "SvelteKit framework endpoint; may change without notice"));
    data = { ok: true, value: parseSuperstateData(f.text) };
  } catch (e) {
    data = { ok: false, error: errText(e) };
  }
  return { page, data, sources };
}
