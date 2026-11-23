// The frontier comparison tab. This module only prepares the table: questions, Reckon's own timestamped ground truth, and
// whatever a separate step has written into frontier/results.json. No model is called here or anywhere in Reckon.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { byId } from "./registry.ts";
import type { AssetReport, Cell } from "./types.ts";
import { num, usd } from "./util.ts";

const dir = (f: string) => fileURLToPath(new URL(`../frontier/${f}`, import.meta.url));

interface Question {
  id: string;
  text: string;
  needs: string[];
}

export interface Truth {
  id: string;
  text: string;
  needs: string[];
  truth: string | null;
  basis: string;
  asOf: string | null;
  rows: string[];
}

export function groundTruth(questions: Question[], reports: AssetReport[]): Truth[] {
  const r = reports.find((x) => x.assetId === "ustb");
  const spec = byId("ustb")!;
  const row = (id: string) => r?.checks.find((c) => c.id === id);
  const val = (id: string, key: string): Cell | undefined => row(id)?.values[key];
  const when = r?.generatedAt ?? null;
  const live = r ? `Reckon ${r.mode === "live" ? "live reading" : "recorded reading"}` : "no reading yet";
  const out: Record<string, Omit<Truth, "id" | "text" | "needs">> = {};

  const supply = val("mint-state", "supply");
  out.q1 = { truth: supply !== undefined && row("mint-state")?.status === "pass" ? `${supply} USTB (decimals ${val("mint-state", "decimals")})` : null, basis: `${live}, two Solana RPCs agreeing`, asOf: when, rows: ["mint-state"] };

  const fa = val("mint-state", "freezeAuthority");
  const pd = val("mint-state", "permanentDelegate");
  const das = val("mint-state", "defaultAccountState");
  out.q2 = {
    truth: row("mint-state")?.status === "pass" ? `Freeze authority ${fa ?? "none"}${fa && fa === pd ? " (also the permanent delegate)" : ""}. Default account state: ${das ?? "not set"}.` : null,
    basis: `${live}, Token-2022 extensions read on two RPCs`,
    asOf: when,
    rows: ["mint-state"],
  };

  const f = row("filings");
  const newest = f && f.status !== "hold" ? val("filings", "newest date in answer") : null;
  out.q3 = newest
    ? { truth: `${newest}, CIK ${spec.filings!.cik}`, basis: "Bought through Telegraph (SEC filing miner), receipt on the row", asOf: when, rows: ["filings"] }
    : { truth: `${spec.filings!.latestForm} ${spec.filings!.latestDate}, CIK ${spec.filings!.cik} (baseline, not re-checked by Reckon)`, basis: spec.filings!.knownFromNote, asOf: "2026-11-23", rows: ["filings"] };

  const aum = val("issuer-nav-aum", "reported AUM");
  const solPct = val("issuer-nav-aum", "Solana share of AUM (computed)");
  out.q4 = {
    truth: typeof aum === "number" && typeof solPct === "number" ? `AUM ${usd(aum, 0)}; Solana holds ${num(solPct, 2)}% of it` : null,
    basis: `Issuer page read by ${live.toLowerCase()}; the Solana share is computed from the page's own rows`,
    asOf: when,
    rows: ["issuer-nav-aum"],
  };

  const nav = val("issuer-nav-aum", "implied NAV per share");
  const sup = row("issuer-supply");
  out.q5 = {
    truth: typeof nav === "number" && sup ? `Implied NAV per share ${nav.toFixed(4)} (the page shows a dash). Supply reconciliation: ${sup.status === "pass" ? "chain matches the issuer's tokens on every network read" : sup.summary}` : null,
    basis: `${live}; NAV is value divided by shares from the issuer's table, not a published figure, and "yesterday" is not separately captured`,
    asOf: when,
    rows: ["issuer-nav-aum", "issuer-supply"],
  };
  return questions.map((q) => ({ ...q, ...(out[q.id] ?? { truth: null, basis: "no ground truth rule", asOf: null, rows: [] }) }));
}

export function frontierView(reports: AssetReport[]) {
  const q = JSON.parse(readFileSync(dir("questions.json"), "utf8")) as { about: string; grading: unknown; questions: Question[] };
  const results = JSON.parse(readFileSync(dir("results.json"), "utf8")) as { status: string; note: string; models: string[]; runs: unknown[] };
  return { about: q.about, grading: q.grading, results, rows: groundTruth(q.questions, reports) };
}
