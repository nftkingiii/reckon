// node src/cli.ts once [--recorded] [--data DIR] [--asset ustb|buidl|usdy]
import { liveCtx } from "./net.ts";
import { runPass } from "./monitor.ts";
import { recordedCtx } from "./recorded.ts";
import { ASSETS } from "./registry.ts";
import { Store } from "./store.ts";
import { buyFromEnv } from "./telegraph.ts";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args[0] !== "once") {
  console.error("usage: node src/cli.ts once [--recorded] [--data DIR] [--asset ustb|buidl|usdy]");
  process.exit(2);
}
const recorded = args.includes("--recorded");
const store = new Store(flag("--data") ?? "data");
const only = flag("--asset");
const assets = only ? ASSETS.filter((a) => a.id === only) : ASSETS;
const buy = await buyFromEnv();
const ctx = recorded ? recordedCtx().ctx : liveCtx();
console.log(`${recorded ? "RECORDED fixtures" : "LIVE public reads"}; Telegraph purchases ${buy.enabled ? "ON" : "OFF"}`);
const { reports, errors } = await runPass({ ctx, store, mode: recorded ? "recorded" : "live", buy, assets, log: (l) => console.log(l) });
for (const r of reports) {
  console.log(`\n== ${r.name} (${r.overall})`);
  for (const c of r.checks) console.log(`  [${c.status.toUpperCase().padEnd(4)}] ${c.id.padEnd(20)} ${c.summary.slice(0, 170)}`);
}
if (errors.length) process.exitCode = 1;
