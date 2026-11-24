// The public page and its JSON. Read-only: nothing here can trigger a purchase or a write beyond the monitor's own snapshots.
//   GET /                           the page
//   GET /api/state                  mode, labels, per-asset summaries
//   GET /api/assets/:id             latest report and the history of diffs
//   GET /api/assets/:id/report.json | report.md   downloads
//   GET /api/frontier               the five questions, Reckon's own ground truth, and model results when a separate step fills them
//   GET /health
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { liveCtx, type Ctx } from "./net.ts";
import { startMonitor, runPass, type MonitorHandle } from "./monitor.ts";
import { recordedCtx } from "./recorded.ts";
import { ASSETS, byId } from "./registry.ts";
import { toMarkdown } from "./report.ts";
import { Store } from "./store.ts";
import { buyFromEnv, ENGINE_ASK_USD, MINERS, SANCTIONS_CHAIN, type BuyConfig } from "./telegraph.ts";
import { frontierView } from "./frontier.ts";
import { TESTNET_LABEL } from "./governor.ts";
import type { AssetReport, Mode } from "./types.ts";
import { errText, iso } from "./util.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export interface ServerOptions {
  mode: Mode;
  store: Store;
  ctx: Ctx;
  buy: BuyConfig;
  intervalMs: number;
  recordedAt?: string;
  recordedLabel?: string;
}

export function createApp(o: ServerOptions) {
  let lastRunAt: string | null = null;
  let lastErrors: { assetId: string; error: string }[] = [];
  const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  };

  const summary = (r: AssetReport | null, id: string) => {
    const spec = byId(id)!;
    if (!r) return { id, name: spec.name, symbol: spec.symbol, mint: spec.solanaMint, issuer: spec.issuer, fund: spec.fund, report: null };
    return {
      id,
      name: r.name,
      symbol: r.symbol,
      mint: r.mint,
      issuer: spec.issuer,
      fund: spec.fund,
      report: { generatedAt: r.generatedAt, overall: r.overall, counts: r.counts, strip: r.checks.map((c) => ({ id: c.id, title: c.title, status: c.status })), flagged: r.flagged.slice(0, 3), changes: r.changes.length, snapshotHash: r.snapshotHash },
    };
  };

  const state = () => ({
    mode: o.mode,
    ...(o.mode === "recorded" ? { recordedAt: o.recordedAt, label: o.recordedLabel } : {}),
    buy: {
      enabled: o.buy.enabled,
      capUsd: o.buy.capUsd,
      askUsd: ENGINE_ASK_USD,
      label: o.buy.enabled ? TESTNET_LABEL : null,
      status: o.buy.enabled && o.buy.governor ? o.buy.governor.status(o.ctx.now()) : null,
      miners: [MINERS.supply, MINERS.filings, ...SANCTIONS_CHAIN],
      plan: ASSETS.map((a) => {
        const asks = 1 + (a.filings ? 1 : 0) + a.sanctionsNames.length;
        return { assetId: a.id, asks, estUsd: Number((asks * ENGINE_ASK_USD).toFixed(2)) };
      }),
    },
    intervalMin: o.mode === "live" ? Math.round(o.intervalMs / 60000) : null,
    lastRunAt,
    errors: lastErrors,
    now: iso(o.ctx.now()),
    assets: ASSETS.map((a) => summary(o.store.report(a.id), a.id)),
  });

  const serveStatic = (res: ServerResponse, rel: string) => {
    let decoded = rel;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return json(res, 400, { error: "bad path" });
    }
    const clean = normalize(decoded).replace(/^[\\/]+/, "");
    const file = join(WEB, clean === "" || clean === "." ? "index.html" : clean);
    if (decoded.includes("..") || !file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith(".woff2") ? "public, max-age=86400" : "no-cache" });
    res.end(readFileSync(file));
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read-only" });
      const url = new URL(req.url ?? "/", "http://local");
      const path = url.pathname;
      if (path === "/health") return json(res, 200, { ok: true, mode: o.mode, lastRunAt });
      if (path === "/api/state") return json(res, 200, state());
      if (path === "/api/frontier") return json(res, 200, frontierView(ASSETS.map((a) => o.store.report(a.id)).filter((r): r is AssetReport => !!r)));
      const m = /^\/api\/assets\/([a-z]+)(?:\/report\.(json|md))?$/.exec(path);
      if (m) {
        const id = m[1]!;
        if (!byId(id)) return json(res, 404, { error: "unknown asset" });
        const report = o.store.report(id);
        if (!report) return json(res, 404, { error: "no report yet" });
        if (m[2] === "json") return json(res, 200, report, { "content-disposition": `attachment; filename="reckon-${id}-${report.generatedAt.slice(0, 10)}.json"` });
        if (m[2] === "md") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="reckon-${id}-${report.generatedAt.slice(0, 10)}.md"` });
          return void res.end(toMarkdown(report));
        }
        return json(res, 200, { report, history: o.store.history(id, 60), spec: { fund: byId(id)!.fund, issuer: byId(id)!.issuer, mintListing: byId(id)!.mintListing } });
      }
      if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
      return serveStatic(res, path === "/" ? "" : path);
    } catch (e) {
      json(res, 500, { error: errText(e) });
    }
  };

  let monitor: MonitorHandle | null = null;
  return {
    server: createServer(handler),
    async start(): Promise<void> {
      if (o.mode === "recorded") {
        const r = await runPass({ ctx: o.ctx, store: o.store, mode: "recorded", buy: o.buy });
        lastRunAt = r.reports[0]?.generatedAt ?? null;
        lastErrors = r.errors;
      } else {
        monitor = startMonitor({ ctx: o.ctx, store: o.store, mode: "live", buy: o.buy, log: (l) => console.log(`[${iso(Date.now())}] ${l}`) }, o.intervalMs, (r) => {
          lastRunAt = iso(o.ctx.now());
          lastErrors = r.errors;
        });
      }
    },
    stop(): void {
      monitor?.stop();
    },
  };
}

async function main(): Promise<void> {
  const mode: Mode = process.env.RECKON_MODE === "live" ? "live" : "recorded";
  const dataRoot = process.env.RECKON_DATA ?? "data";
  const store = new Store(join(dataRoot, mode));
  const buy = await buyFromEnv();
  const rec = mode === "recorded" ? recordedCtx() : null;
  const app = createApp({
    mode,
    store,
    ctx: rec ? rec.ctx : liveCtx(),
    buy,
    intervalMs: Math.max(1, Number(process.env.RECKON_INTERVAL_MIN ?? "15")) * 60_000,
    ...(rec ? { recordedAt: rec.recordedAt, recordedLabel: rec.label } : {}),
  });
  const port = Number(process.env.PORT ?? "8791");
  const host = process.env.HOST ?? "127.0.0.1";
  await app.start();
  app.server.listen(port, host, () => console.log(`Reckon ${mode} on http://${host}:${port} (Telegraph purchases ${buy.enabled ? "ON" : "OFF"})`));
  const quit = () => {
    app.stop();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (process.argv[1] && /server\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) await main();
