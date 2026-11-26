// A small in-memory limiter: a sliding window per client, a cap on reads running at once, and a short cache so the same
// addresses asked twice do not hit the public RPCs twice. Nothing here is written to disk.
export class Limiter {
  private hits = new Map<string, number[]>();
  private inflight = 0;
  private perWindow: number;
  private windowMs: number;
  private maxInflight: number;
  private now: () => number;
  constructor(perWindow: number, windowMs: number, maxInflight: number, now: () => number = Date.now) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
    this.maxInflight = maxInflight;
    this.now = now;
  }

  /** Returns 0 when the call may proceed, or the seconds to wait. */
  take(client: string): number {
    const t = this.now();
    const list = (this.hits.get(client) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.perWindow) {
      this.hits.set(client, list);
      return Math.max(1, Math.ceil((list[0]! + this.windowMs - t) / 1000));
    }
    list.push(t);
    this.hits.set(client, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T | "busy"> {
    if (this.inflight >= this.maxInflight) return "busy";
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
    }
  }
}

export class TtlCache<T> {
  private m = new Map<string, { at: number; v: T }>();
  private ttlMs: number;
  private now: () => number;
  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }
  get(k: string): T | undefined {
    const e = this.m.get(k);
    return e && this.now() - e.at < this.ttlMs ? e.v : undefined;
  }
  set(k: string, v: T): void {
    this.m.set(k, { at: this.now(), v });
    if (this.m.size > 200) for (const [key, e] of this.m) if (this.now() - e.at >= this.ttlMs) this.m.delete(key);
  }
}
