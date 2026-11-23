// One monitoring pass over every asset, and the loop around it.
import { runAsset } from "./checks.ts";
import type { Ctx } from "./net.ts";
import { ASSETS, type AssetSpec } from "./registry.ts";
import { buildReport } from "./report.ts";
import { Store } from "./store.ts";
import { BuySession, type BuyConfig } from "./telegraph.ts";
import type { AssetReport, Mode } from "./types.ts";
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
  // One purchase session per pass, so the per-run cap spans every asset.
  const buy = new BuySession(o.buy);
  for (const spec of o.assets ?? ASSETS) {
    try {
      const prev = o.store.latest(spec.id);
      const run = await runAsset(spec, { ctx: o.ctx, buy, prev });
      const { report, snapshot } = buildReport(spec, run, { now: o.ctx.now(), mode: o.mode, prev, buy: { enabled: buy.enabled, spentUsd: buy.spentUsd, capUsd: o.buy.capUsd } });
      o.store.save(snapshot, report, { at: report.generatedAt, hash: report.snapshotHash, mode: o.mode, changes: report.changes, counts: report.counts });
      reports.push(report);
      o.log?.(`${spec.id}: ${report.counts.pass} established, ${report.counts.flag} flagged, ${report.counts.hold} cannot check; hash ${report.snapshotHash.slice(0, 12)}`);
    } catch (e) {
      errors.push({ assetId: spec.id, error: errText(e) });
      o.log?.(`${spec.id}: run failed: ${errText(e)}`);
    }
  }
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
