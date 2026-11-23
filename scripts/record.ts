// Captures one real, read-only pass over every asset into fixtures/recorded.json.gz.
// Only public GETs and read-only JSON-RPC calls are made. Telegraph is never contacted.
import { liveCtx, recordingFetch, saveCaptures, type Capture } from "../src/net.ts";
import { runPass } from "../src/monitor.ts";
import { Store } from "../src/store.ts";
import { buyOff } from "../src/telegraph.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "fixtures/recorded.json.gz";
const sink: Capture[] = [];
const real = liveCtx();
const startedAt = new Date();
const ctx = { ...real, fetch: recordingFetch(real.fetch, sink), now: () => startedAt.getTime() };
const store = new Store(mkdtempSync(join(tmpdir(), "reckon-record-")));
const { reports, errors } = await runPass({ ctx, store, mode: "live", buy: buyOff(), log: (l) => console.log(l) });
saveCaptures(out, {
  recordedAt: startedAt.toISOString(),
  label: `Real public responses captured read-only on ${startedAt.toISOString().slice(0, 10)}. No Telegraph call was made.`,
  captures: sink,
});
console.log(`${sink.length} responses saved to ${out}; ${reports.length} assets, ${errors.length} errors`);
if (errors.length) process.exitCode = 1;
