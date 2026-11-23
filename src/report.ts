// Turns a run's rows into the report: what is established, what is flagged, what cannot be checked and why.
import type { AssetSpec } from "./registry.ts";
import { hashFacts, type Snapshot } from "./store.ts";
import type { AssetRun } from "./checks.ts";
import type { AssetReport, Mode } from "./types.ts";
import { iso } from "./util.ts";

export function buildReport(spec: AssetSpec, run: AssetRun, o: { now: number; mode: Mode; prev: Snapshot | null; buy: { enabled: boolean; spentUsd: number; capUsd: number } }): { report: AssetReport; snapshot: Snapshot } {
  const counts = { pass: 0, flag: 0, hold: 0 };
  for (const r of run.rows) counts[r.status]++;
  const hash = hashFacts(run.facts);
  const generatedAt = iso(o.now);
  const cannotCheck = [
    ...run.rows.filter((r) => r.status === "hold" && r.missing).map((r) => ({ what: r.missing!, why: r.summary })),
    ...spec.cannotCheck,
  ];
  const report: AssetReport = {
    assetId: spec.id,
    name: spec.name,
    symbol: spec.symbol,
    issuer: spec.issuer,
    mint: spec.solanaMint,
    generatedAt,
    mode: o.mode,
    buy: o.buy,
    overall: counts.flag > 0 ? "flag" : counts.hold > 0 ? "partial" : "clear",
    counts,
    established: run.rows.filter((r) => r.status === "pass").map((r) => `${r.title}: ${r.summary}`),
    flagged: run.rows.filter((r) => r.status === "flag").map((r) => `${r.title}: ${r.summary}`),
    cannotCheck,
    checks: run.rows,
    snapshotHash: hash,
    previousHash: o.prev?.hash ?? null,
    changes: run.changes,
  };
  return { report, snapshot: { assetId: spec.id, takenAt: generatedAt, hash, facts: run.facts } };
}

const cell = (v: unknown): string => (v === null || v === undefined ? "n/a" : String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function toMarkdown(r: AssetReport): string {
  const out: string[] = [];
  out.push(`# ${r.name}: Reckon report`, "");
  out.push(`- Generated: ${r.generatedAt}`);
  out.push(`- Data: ${r.mode === "live" ? "live public reads" : "RECORDED fixtures (no network calls were made for this report)"}`);
  out.push(`- Telegraph purchases: ${r.buy.enabled ? `ON, spent $${r.buy.spentUsd.toFixed(2)} of a $${r.buy.capUsd.toFixed(2)} cap` : "OFF (rows marked not bought are not results)"}`);
  out.push(`- Solana mint: \`${r.mint}\``);
  out.push(`- Snapshot hash: \`${r.snapshotHash}\`${r.previousHash ? `, previous \`${r.previousHash}\`` : ", first snapshot"}`);
  out.push(`- Rows: ${r.counts.pass} established, ${r.counts.flag} flagged, ${r.counts.hold} cannot be checked`, "");
  out.push("## Established", "");
  out.push(...(r.established.length ? r.established.map((x) => `- ${x}`) : ["- nothing"]), "");
  out.push("## Flagged", "");
  out.push(...(r.flagged.length ? r.flagged.map((x) => `- ${x}`) : ["- nothing flagged"]), "");
  out.push("## Cannot be checked, and why", "");
  out.push(...(r.cannotCheck.length ? r.cannotCheck.map((x) => `- **${x.what}**: ${x.why}`) : ["- nothing"]), "");
  if (r.changes.length) {
    out.push("## Changes since the previous snapshot", "", "| Path | Before | After | Severity |", "| --- | --- | --- | --- |");
    for (const c of r.changes) out.push(`| ${cell(c.path)} | ${cell(c.before)} | ${cell(c.after)} | ${c.severity} |`);
    out.push("");
  }
  out.push("## Checks", "");
  for (const c of r.checks) {
    out.push(`### ${c.title} [${c.status.toUpperCase()}]`, "", c.summary, "");
    if (c.missing) out.push(`Missing: ${c.missing}`, "");
    const vals = Object.entries(c.values);
    if (vals.length) {
      out.push("| Field | Value |", "| --- | --- |");
      for (const [k, v] of vals) out.push(`| ${cell(k)} | ${cell(v)} |`);
      out.push("");
    }
    if (c.telegraph) {
      const t = c.telegraph;
      out.push(`Telegraph: ${t.intent}, miner ${t.minerId} (${t.minerName}), state ${t.state}${t.reason ? `: ${t.reason}` : ""}`);
      for (const call of t.calls) out.push(`- ${call.subject}: ${call.outcome}${call.receipt?.receiptHash ? `, receipt ${call.receipt.receiptHash}` : ""}${call.costUsd !== undefined ? `, $${call.costUsd}` : ""}${call.note ? `, ${call.note}` : ""}`);
      out.push("");
    }
    if (c.sources.length) {
      out.push("Sources:");
      for (const s of c.sources) out.push(`- ${s.name}: ${s.url} (fetched ${s.fetchedAt}${s.sha256 ? `, sha256 ${s.sha256.slice(0, 16)}` : ""}${s.note ? `; ${s.note}` : ""})`);
      out.push("");
    }
  }
  out.push("Reckon reports readings and cross-checks. It is not an audit and not investment advice.", "");
  return out.join("\n");
}
