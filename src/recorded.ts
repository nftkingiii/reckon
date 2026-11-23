import { fileURLToPath } from "node:url";
import { loadCaptures, replayFetch, type Ctx } from "./net.ts";

export const DEFAULT_FIXTURE = fileURLToPath(new URL("../fixtures/recorded.json.gz", import.meta.url));

/** A Ctx that answers only from a capture file and reports the capture time as "now", so ages and staleness are reproducible. */
export function recordedCtx(path = DEFAULT_FIXTURE): { ctx: Ctx; recordedAt: string; label: string } {
  const file = loadCaptures(path);
  const at = Date.parse(file.recordedAt);
  return { ctx: { fetch: replayFetch(file), now: () => at, sleep: async () => {}, timeoutMs: 20_000 }, recordedAt: file.recordedAt, label: file.label };
}
