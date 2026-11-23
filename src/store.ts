// Snapshots, their hashes, the diff between two of them, and the on-disk history.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { controls, extension, supplyText, type MintState } from "./solana.ts";
import type { AssetReport, Cell, Change, HistoryEntry } from "./types.ts";
import { canon, sha256 } from "./util.ts";

export interface EntityFact {
  legalName: string;
  entityStatus: string;
  registrationStatus: string;
}

/** What a snapshot remembers. Everything here is a reading, never a verdict. */
export interface Facts {
  mint: MintState | null;
  supplies: Record<string, number | null>;
  entities: Record<string, EntityFact>;
  issuer: Record<string, Cell>;
  filings: { latestDate: string | null; count: number | null } | null;
}

export interface Snapshot {
  assetId: string;
  takenAt: string;
  hash: string;
  facts: Facts;
}

export const hashFacts = (facts: Facts): string => sha256(canon(facts));

const FLAG_KEYS = new Set(["program", "mintAuthority", "freezeAuthority", "permanentDelegate", "defaultAccountState", "transferHookProgram", "transferHookAuthority", "closeAuthority", "pausable", "extensions"]);

export function diffFacts(prev: Facts, cur: Facts): Change[] {
  const out: Change[] = [];
  if (prev.mint && cur.mint) {
    const a = controls(prev.mint);
    const b = controls(cur.mint);
    for (const k of Object.keys(b)) {
      if (a[k] !== b[k]) out.push({ path: `mint.${k}`, before: a[k] ?? null, after: b[k] ?? null, severity: FLAG_KEYS.has(k) ? "flag" : "info" });
    }
    if (prev.mint.decimals !== cur.mint.decimals) out.push({ path: "mint.decimals", before: prev.mint.decimals, after: cur.mint.decimals, severity: "flag" });
    // Same extension present on both sides but with different parameters (for example a changed delegate or multiplier).
    for (const e of cur.mint.extensions) {
      const before = extension(prev.mint, e.name);
      if (before && canon(before.state) !== canon(e.state)) {
        out.push({ path: `mint.extension.${e.name}`, before: canon(before.state), after: canon(e.state), severity: e.name === "scaledUiAmountConfig" ? "info" : "flag" });
      }
    }
    if (prev.mint.supplyRaw !== cur.mint.supplyRaw) {
      out.push({ path: "mint.supply", before: supplyText(prev.mint), after: supplyText(cur.mint), severity: "info" });
    }
  }
  for (const [k, v] of Object.entries(cur.supplies)) {
    const before = prev.supplies[k];
    if (before !== undefined && before !== null && v !== null && before !== v) out.push({ path: `supply.${k}`, before, after: v, severity: "info" });
  }
  for (const [k, v] of Object.entries(cur.entities)) {
    const before = prev.entities[k];
    if (!before) continue;
    for (const f of ["legalName", "entityStatus", "registrationStatus"] as const) {
      if (before[f] !== v[f]) out.push({ path: `entity.${k}.${f}`, before: before[f], after: v[f], severity: "flag" });
    }
  }
  if (prev.filings?.latestDate && cur.filings?.latestDate && cur.filings.latestDate > prev.filings.latestDate) {
    out.push({ path: "filings.latestDate", before: prev.filings.latestDate, after: cur.filings.latestDate, severity: "flag" });
  }
  return out;
}

export class Store {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(assetId: string, ...rest: string[]): string {
    return join(this.dir, assetId, ...rest);
  }
  latest(assetId: string): Snapshot | null {
    const p = this.path(assetId, "latest.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Snapshot) : null;
  }
  report(assetId: string): AssetReport | null {
    const p = this.path(assetId, "report.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as AssetReport) : null;
  }
  history(assetId: string, limit = 200): HistoryEntry[] {
    const p = this.path(assetId, "history.jsonl");
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as HistoryEntry).reverse();
  }
  save(snapshot: Snapshot, report: AssetReport, entry: HistoryEntry, keep = 30): void {
    const id = snapshot.assetId;
    mkdirSync(this.path(id, "snaps"), { recursive: true });
    writeFileSync(this.path(id, "latest.json"), JSON.stringify(snapshot));
    writeFileSync(this.path(id, "report.json"), JSON.stringify(report));
    writeFileSync(this.path(id, "snaps", `${snapshot.takenAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(snapshot));
    appendFileSync(this.path(id, "history.jsonl"), JSON.stringify(entry) + "\n");
    const snaps = readdirSync(this.path(id, "snaps")).sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - keep))) rmSync(this.path(id, "snaps", old));
  }
}
