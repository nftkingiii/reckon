// All network access goes through a Ctx, so tests and the recorded mode can swap the fetch for a replay of real captures.
import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { canon, errText, iso, sha256 } from "./util.ts";
import type { SourceRef } from "./types.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Ctx {
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}

export class FetchError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FetchError";
    this.status = status;
  }
}

export interface Fetched {
  url: string;
  status: number;
  text: string;
  fetchedAt: string;
  sha256: string;
}

export async function getText(ctx: Ctx, url: string, init: RequestInit = {}): Promise<Fetched> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) });
  } catch (e) {
    throw new FetchError(`${new URL(url).host} unreachable: ${errText(e)}`);
  }
  const text = await res.text();
  if (res.status !== 200) throw new FetchError(`${new URL(url).host} answered HTTP ${res.status}`, res.status);
  return { url, status: res.status, text, fetchedAt: iso(ctx.now()), sha256: sha256(text) };
}

export const sourceOf = (f: Fetched, name: string, note?: string): SourceRef => ({
  name,
  url: f.url,
  fetchedAt: f.fetchedAt,
  sha256: f.sha256,
  ...(note ? { note } : {}),
});

// ---------------------------------------------------------------- recording and replay

export interface Capture {
  key: string;
  url: string;
  method: string;
  body?: string;
  status: number;
  contentType: string;
  text: string;
}

export interface CaptureFile {
  recordedAt: string;
  label: string;
  captures: Capture[];
}

/** A request's identity. Solana reads carry a slot hint that changes every run, so it is left out of the key. */
export function requestKey(url: string, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  let body = typeof init?.body === "string" ? init.body : "";
  if (body) {
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      if (Array.isArray(j.params)) {
        j.params = j.params.map((p) => {
          if (p && typeof p === "object" && !Array.isArray(p)) {
            const copy = { ...(p as Record<string, unknown>) };
            delete copy.minContextSlot;
            return copy;
          }
          return p;
        });
      }
      delete j.id;
      body = canon(j);
    } catch {
      /* not JSON: use as is */
    }
  }
  return `${method} ${url} ${sha256(body).slice(0, 16)}`;
}

export function loadCaptures(path: string): CaptureFile {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text) as CaptureFile;
}

export function saveCaptures(path: string, file: CaptureFile): void {
  const text = JSON.stringify(file);
  writeFileSync(path, path.endsWith(".gz") ? gzipSync(text) : text);
}

/**
 * Serves captures back in the order they were recorded. The same request can legitimately be made twice in a pass at
 * different times (a block number, a price read), and must return what it returned each time; once a request's
 * recorded answers run out, the last one repeats.
 */
export function replayFetch(file: CaptureFile): Fetch {
  const byKey = new Map<string, { list: Capture[]; next: number }>();
  for (const c of file.captures) {
    const e = byKey.get(c.key) ?? { list: [], next: 0 };
    e.list.push(c);
    byKey.set(c.key, e);
  }
  return async (url, init) => {
    const e = byKey.get(requestKey(url, init));
    if (!e) {
      // A request that was never recorded is an error, not an empty answer.
      throw new Error(`no recorded response for ${(init?.method ?? "GET").toUpperCase()} ${url}`);
    }
    const hit = e.list[Math.min(e.next, e.list.length - 1)]!;
    e.next++;
    return new Response(hit.text, { status: hit.status, headers: { "content-type": hit.contentType } });
  };
}

/** Wraps a real fetch and keeps every response, for turning a live read-only run into a fixture file. */
export function recordingFetch(real: Fetch, sink: Capture[]): Fetch {
  return async (url, init) => {
    const res = await real(url, init);
    const text = await res.text();
    sink.push({
      key: requestKey(url, init),
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
    });
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" } });
  };
}

/**
 * Plain GET over node:https with a larger header limit. Some issuer sites (superstate.com) send response headers bigger
 * than the 16 KiB that the built-in fetch accepts, so the built-in fetch fails with UND_ERR_HEADERS_OVERFLOW on them.
 */
function bigHeaderGet(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req = httpsRequest(url, { method: "GET", headers, maxHeaderSize: 512 * 1024, signal: init?.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: { "content-type": String(res.headers["content-type"] ?? "") } })));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export const liveFetch: Fetch = async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    if (code === "UND_ERR_HEADERS_OVERFLOW" && (init?.method ?? "GET").toUpperCase() === "GET") return bigHeaderGet(url, init);
    throw e;
  }
};

export function liveCtx(): Ctx {
  return { fetch: liveFetch, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs: 20_000 };
}
