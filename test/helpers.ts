import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCaptures, replayFetch, type Capture, type CaptureFile, type Ctx } from "../src/net.ts";
import { DEFAULT_FIXTURE } from "../src/recorded.ts";
import { Store } from "../src/store.ts";

export const fixture = (): CaptureFile => loadCaptures(DEFAULT_FIXTURE);

export const ctxFor = (file: CaptureFile): Ctx => ({ fetch: replayFetch(file), now: () => Date.parse(file.recordedAt), sleep: async () => {}, timeoutMs: 5000 });

/** A copy of the recorded captures with some of them rewritten or removed. Used only by tests labelled SYNTHETIC. */
export function mutated(edit: (c: Capture) => Capture | null): CaptureFile {
  const f = fixture();
  return { ...f, captures: f.captures.flatMap((c) => { const r = edit({ ...c }); return r ? [r] : []; }) };
}

export const capture = (file: CaptureFile, urlPart: string, bodyPart?: string): Capture => {
  const c = file.captures.find((x) => x.url.includes(urlPart) && (!bodyPart || (x.body ?? "").includes(bodyPart)));
  if (!c) throw new Error(`no capture for ${urlPart}`);
  return c;
};

export const tmpStore = (): Store => new Store(mkdtempSync(join(tmpdir(), "reckon-test-")));

import { runAsset, type AssetRun } from "../src/checks.ts";
import { ASSETS } from "../src/registry.ts";
import { BuySession, buyOff } from "../src/telegraph.ts";

/**
 * Runs the assets in registry order on one replay, up to and including `id`. The recording was one pass in that order, and a replay
 * hands back repeated requests (block numbers, prices) in the order they were captured, so a later asset must follow the earlier ones.
 */
export async function runInOrder(id: string, file: CaptureFile = fixture()): Promise<AssetRun> {
  const ctx = ctxFor(file);
  let last: AssetRun | null = null;
  for (const spec of ASSETS) {
    last = await runAsset(spec, { ctx, buy: new BuySession(buyOff()), prev: null });
    if (spec.id === id) return last;
  }
  throw new Error(`unknown asset ${id}`);
}
