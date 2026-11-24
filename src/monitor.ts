// One monitoring pass over every asset, and the loop around it.
import { runAsset } from "./checks.ts";
import type { Ctx } from "./net.ts";
import { ASSETS, type AssetSpec } from "./registry.ts";
import { buildReport } from "./report.ts";
import { Store } from "./store.ts";
import { BuySession, buyOff, type BuyConfig } from "./telegraph.ts";
import type { AssetReport, CheckRow, Mode } from "./types.ts";
import { errText, iso } from "./util.ts";

export interface MonitorOptions {
  ctx: Ctx;
  store: Store;
  mode: Mode;
  buy: BuyConfig;
  assets?: AssetSpec[];
  log?: (line: string) => void;
}

export interface PassResult {
  reports: AssetReport[];
  errors: { assetId: string; error: string }[];
}

/** Runs every asset once. A failure in one asset is recorded and does not stop the others. */
export async function runPass(o: MonitorOptions): Promise<PassResult> {
  const reports: AssetReport[] = [];
  const errors: PassResult["errors"] = [];
  // One purchase session per pass, so the per-run cap spans every asset. A governor, when present, decides whether this
  // pass may buy at all (interval, daily ceiling, escrow floor) and how much it may spend.
  const gov = o.buy.enabled ? o.buy.governor : undefined;
  let buy: BuySession;
  if (gov) {
    gov.attach(o.store);
    const d = await gov.decide(o.ctx.now());
    buy = d.buy ? new BuySession({ ...o.buy, capUsd: d.capUsd }) : new BuySession(buyOff(), d.note);
  } else {
    buy = new BuySession(o.buy);
  }
  const paidPass = buy.enabled;
  for (const spec of o.assets ?? ASSETS) {
    try {
      const prev = o.store.latest(spec.id);
      const run = await runAsset(spec, { ctx: o.ctx, buy, prev });
      const paid = o.store.paid(spec.id);
      if (paidPass) {
        const rows: Record<string, CheckRow> = {};
        for (const r of run.rows) if (r.telegraph && r.telegraph.calls.length > 0) rows[r.id] = r;
        if (Object.keys(rows).length) o.store.savePaid(spec.id, { at: new Date(o.ctx.now()).toISOString(), rows });
      } else if (paid) {
        // No paid pass this time: show the last purchase again, labelled with when it was bought.
        run.rows = run.rows.map((r) => {
          const old = paid.rows[r.id];
          if (!old || r.telegraph?.state !== "not-bought") return r;
          return { ...old, summary: `Bought ${paid.at}, not asked again this pass. ${old.summary}`, telegraph: { ...old.telegraph!, carriedFrom: paid.at } };
        });
        if (!run.facts.filings && prev?.facts.filings) run.facts.filings = prev.facts.filings;
      }
      const { report, snapshot } = buildReport(spec, run, {
        now: o.ctx.now(),
        mode: o.mode,
        prev,
        buy: { enabled: o.buy.enabled, paidThisPass: paidPass, spentUsd: buy.spentUsd, capUsd: o.buy.capUsd, note: paidPass || !o.buy.enabled ? null : buy.offReason },
      });
      o.store.save(snapshot, report, { at: report.generatedAt, hash: report.snapshotHash, mode: o.mode, changes: report.changes, counts: report.counts });
      reports.push(report);
      o.log?.(`${spec.id}: ${report.counts.pass} established, ${report.counts.flag} flagged, ${report.counts.hold} cannot check; hash ${report.snapshotHash.slice(0, 12)}`);
    } catch (e) {
      errors.push({ assetId: spec.id, error: errText(e) });
      o.log?.(`${spec.id}: run failed: ${errText(e)}`);
    }
  }
  if (gov && paidPass) gov.record(buy.spentUsd, o.ctx.now());
  return { reports, errors };
}

export interface MonitorHandle {
  stop(): void;
  lastRunAt: () => string | null;
  running: () => boolean;
}

/** Repeats runPass on an interval and never overlaps two passes. */
export function startMonitor(o: MonitorOptions, intervalMs: number, onPass?: (r: PassResult) => void): MonitorHandle {
  let busy = false;
  let last: string | null = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runPass(o);
      last = iso(o.ctx.now());
      onPass?.(r);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer), lastRunAt: () => last, running: () => busy };
}
