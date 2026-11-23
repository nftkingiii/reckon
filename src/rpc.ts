import { FetchError, type Ctx } from "./net.ts";
import { errText } from "./util.ts";

export type { Ctx };

export interface JsonRpcReply {
  result?: any;
  error?: { code?: number; message?: string };
}

const rateLimited = (status: number, reply: JsonRpcReply | null): boolean =>
  status === 429 || /too many requests|rate limit/i.test(String(reply?.error?.message ?? ""));

/**
 * POST a JSON-RPC request and return the parsed reply. Transport and parse failures become FetchError. A rate-limit
 * answer is retried once after a short pause, because the free public endpoints are shared and brief limits are normal.
 */
export async function getTextJson(ctx: Ctx, url: string, body: unknown, retried = false): Promise<JsonRpcReply> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (e) {
    throw new FetchError(`${new URL(url).host} unreachable: ${errText(e)}`);
  }
  const text = await res.text();
  let parsed: JsonRpcReply | null = null;
  try {
    parsed = JSON.parse(text) as JsonRpcReply;
  } catch {
    /* handled below */
  }
  if (!retried && rateLimited(res.status, parsed)) {
    await ctx.sleep(900);
    return getTextJson(ctx, url, body, true);
  }
  if (!parsed) throw new FetchError(`${new URL(url).host} answered HTTP ${res.status} with a non-JSON body`, res.status);
  if (res.status !== 200 && !parsed.error) throw new FetchError(`${new URL(url).host} answered HTTP ${res.status}`, res.status);
  return parsed;
}
