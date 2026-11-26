// Ondo's USDY page and its published address table.
import { getText, sourceOf, type Ctx } from "../net.ts";
import type { SourceRef } from "../types.ts";
import { errText } from "../util.ts";
import { abbreviated, htmlLines, longDate, ParseError } from "./html.ts";

export const USDY_PAGE = "https://ondo.finance/usdy";
export const ONDO_ADDRESSES = "https://docs.ondo.finance/addresses.md";

export interface OndoPage {
  asOfText: string;
  asOf: string;
  outstandingUsd: number;
  underlyingUsd: number;
  collateralizationPct: number;
  tvlUsd: number | null;
  priceUsd: number | null;
  positions: { name: string; valueUsd: number }[];
  /** The abbreviated addresses the page prints per network, e.g. Solana "A1KL...Eto6". */
  printedAddresses: Record<string, string>;
  /** The page footnotes, keyed by their superscript digit, e.g. "5" for the collateralization ratio. */
  footnotes: Record<string, string>;
}

export function parseOndoPage(html: string): OndoPage {
  const lines = htmlLines(html);
  const at = (pred: (l: string) => boolean, from = 0): number => {
    for (let i = from; i < lines.length; i++) if (pred(lines[i]!)) return i;
    return -1;
  };
  const poAt = at((l) => l === "Portfolio Overview");
  if (poAt < 0) throw new ParseError("no 'Portfolio Overview' block");
  const asOfAt = at((l) => l === "As of", poAt);
  const asOfText = asOfAt >= 0 ? lines[asOfAt + 1] : undefined;
  const asOf = asOfText ? longDate(asOfText) : null;
  if (!asOfText || !asOf) throw new ParseError("portfolio as-of date not found");

  // Label, optional footnote digit, "$", value (e.g. "1.97B").
  const labelled = (label: string): number => {
    const i = at((l) => l === label, poAt);
    if (i < 0) throw new ParseError(`'${label}' not found`);
    const window = lines.slice(i + 1, i + 6);
    const dollar = window.indexOf("$");
    const v = abbreviated(dollar >= 0 ? (window[dollar + 1] ?? "") : (window.find((w) => /^\$?[\d,.]+[KMBT]?$/i.test(w) && w.length > 1) ?? ""));
    if (v === null) throw new ParseError(`value after '${label}' not readable`);
    return v;
  };
  const outstandingUsd = labelled("Value of USDY Outstanding");
  const underlyingUsd = labelled("Value of Underlying Assets");
  const ci = at((l) => l === "Collateralization Ratio", poAt);
  const collateralizationPct = ci >= 0 ? Number(lines.slice(ci + 1, ci + 5).find((l) => /^\d+(\.\d+)?$/.test(l) && l.includes(".")) ?? NaN) : NaN;
  if (!Number.isFinite(collateralizationPct)) throw new ParseError("collateralization ratio not readable");

  const ti = at((l) => l === "Current TVL");
  const tvlUsd = ti >= 0 ? abbreviated((lines.slice(ti + 1, ti + 5).filter((l) => l !== "$")[0] ?? "")) : null;

  // The headline price is an animated digit widget; the readable copy sits in the chart header as "$" then "1.1542".
  const priceAt = lines.findIndex((l, i) => l === "$" && /^\d\.\d{4}$/.test(lines[i + 1] ?? ""));
  const priceUsd = priceAt >= 0 ? Number(lines[priceAt + 1]) : null;

  const positions: { name: string; valueUsd: number }[] = [];
  const posAt = at((l) => l === "Position", poAt);
  const ecoAt = at((l) => l === "Ecosystem", poAt);
  if (posAt >= 0 && ecoAt > posAt) {
    for (let i = posAt; i < ecoAt; i++) {
      if (lines[i] === "$" && /^[\d,]+$/.test(lines[i + 1] ?? "") && /[A-Za-z]/.test(lines[i - 1] ?? "")) {
        positions.push({ name: lines[i - 1]!, valueUsd: Number(lines[i + 1]!.replace(/,/g, "")) });
      }
    }
  }

  const printedAddresses: Record<string, string> = {};
  const ecoStart = at((l) => l === "USDY", ecoAt + 1);
  const rEnd = at((l) => l === "rUSDY", ecoStart + 1);
  if (ecoStart >= 0 && rEnd > ecoStart) for (let i = ecoStart + 1; i + 1 < rEnd; i += 2) printedAddresses[lines[i]!] = lines[i + 1]!;

  const SUP: Record<string, string> = { "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8" };
  const footnotes: Record<string, string> = {};
  for (const l of lines) if (l.length > 2 && SUP[l[0]!] && l[1] === " ") footnotes[SUP[l[0]!]!] = l.slice(2).trim();

  return { footnotes, asOfText, asOf, outstandingUsd, underlyingUsd, collateralizationPct, tvlUsd, priceUsd, positions, printedAddresses };
}

export interface AddressRow {
  section: string;
  chain: string;
  name: string;
  address: string;
}

/** Reads the docs' markdown tables: "## USDY" then "### Chain" then rows "| name | [`address`](url) | ...". */
export function parseAddresses(markdown: string): AddressRow[] {
  const rows: AddressRow[] = [];
  let section = "";
  let chain = "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      chain = "";
    } else if (line.startsWith("### ")) chain = line.slice(4).trim();
    else if (line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim());
      const m = /`([^`]+)`/.exec(cells[2] ?? "");
      const name = (cells[1] ?? "").replace(/\\_/g, "_");
      if (m && name && !/^[-: ]+$/.test(name)) rows.push({ section, chain, name, address: m[1]!.replace(/\s.*$/, "") });
    }
  }
  return rows;
}

export interface OndoRead {
  page: { ok: true; value: OndoPage } | { ok: false; error: string };
  addresses: { ok: true; value: AddressRow[] } | { ok: false; error: string };
  sources: SourceRef[];
}

export async function readOndo(ctx: Ctx): Promise<OndoRead> {
  const sources: SourceRef[] = [];
  let page: OndoRead["page"];
  try {
    const f = await getText(ctx, USDY_PAGE);
    sources.push(sourceOf(f, "Ondo USDY page (HTML)"));
    page = { ok: true, value: parseOndoPage(f.text) };
  } catch (e) {
    page = { ok: false, error: errText(e) };
  }
  let addresses: OndoRead["addresses"];
  try {
    const f = await getText(ctx, ONDO_ADDRESSES);
    sources.push(sourceOf(f, "Ondo docs address table (markdown)"));
    addresses = { ok: true, value: parseAddresses(f.text) };
  } catch (e) {
    addresses = { ok: false, error: errText(e) };
  }
  return { page, addresses, sources };
}
