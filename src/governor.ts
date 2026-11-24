// Decides, before each pass, whether Telegraph purchases may run: an interval between paid passes, a per-pass cap, a daily
// ceiling that survives restarts, and a floor on the signer's escrow balance. Every refusal carries a note for the page.
import type { Store } from "./store.ts";
import { ENGINE_ASK_USD } from "./telegraph.ts";
import { errText, iso } from "./util.ts";

export const TESTNET_LABEL = "live · testnet (Sepolia test USDC)";

export interface GovernorOptions {
  intervalMs: number;
  passCapUsd: number;
  dailyUsd: number;
  minBalanceUsd: number;
  /** Available escrow in USD; must throw when it cannot be read, so the governor fails closed. */
  readBalance: () => Promise<number>;
}

export interface Decision {
  buy: boolean;
  capUsd: number;
  note: string;
}

export interface BuyStatus {
  label: string;
  lastPaidAt: string | null;
  nextPaidAfter: string | null;
  spentTodayUsd: number;
  dailyUsd: number;
  passCapUsd: number;
  intervalMin: number;
  minBalanceUsd: number;
  escrowAvailableUsd: number | null;
  escrowReadAt: string | null;
  paused: string | null;
}

interface Ledger {
  day: string;
  spentUsd: number;
  lastPaidAt: string | null;
}

export class BuyGovernor {
  o: GovernorOptions;
  store: Store | null = null;
  mem: Ledger = { day: "", spentUsd: 0, lastPaidAt: null };
  balance: { usd: number | null; at: string | null } = { usd: null, at: null };
  paused: string | null = null;
  constructor(o: GovernorOptions) {
    this.o = o;
  }
  attach(store: Store): void {
    this.store = store;
  }
  private load(now: number): Ledger {
    const day = iso(now).slice(0, 10);
    const saved = this.store?.readJson<Ledger>("buy-ledger.json") ?? this.mem;
    const l = saved.day === day ? saved : { day, spentUsd: 0, lastPaidAt: saved.lastPaidAt };
    this.mem = l;
    return l;
  }
  private save(l: Ledger): void {
    this.mem = l;
    this.store?.writeJson("buy-ledger.json", l);
  }

  async decide(now: number): Promise<Decision> {
    const l = this.load(now);
    // The balance is read on every pass so the page can show it; only a paid pass is gated on it.
    let balanceNote: string | null = null;
    try {
      const usd = await this.o.readBalance();
      this.balance = { usd, at: iso(now) };
    } catch (e) {
      this.balance = { usd: null, at: iso(now) };
      balanceNote = `the escrow balance could not be read (${errText(e)})`;
    }
    const due = l.lastPaidAt ? Date.parse(l.lastPaidAt) + this.o.intervalMs : 0;
    if (now < due) {
      this.paused = null;
      return { buy: false, capUsd: 0, note: `Paid legs run at most every ${Math.round(this.o.intervalMs / 60000)} minutes. The last paid pass was ${l.lastPaidAt}; the next is after ${iso(due)}.` };
    }
    const remaining = this.o.dailyUsd - l.spentUsd;
    if (remaining < ENGINE_ASK_USD - 1e-9) {
      this.paused = `Daily ceiling of $${this.o.dailyUsd.toFixed(2)} reached for ${l.day} (UTC). Purchases resume at 00:00 UTC.`;
      return { buy: false, capUsd: 0, note: this.paused };
    }
    if (balanceNote) {
      this.paused = `Purchases paused: ${balanceNote}. Failing closed.`;
      return { buy: false, capUsd: 0, note: this.paused };
    }
    if (this.balance.usd! < this.o.minBalanceUsd) {
      this.paused = `Purchases paused: the escrow balance is $${this.balance.usd!.toFixed(2)}, below the $${this.o.minBalanceUsd.toFixed(2)} floor.`;
      return { buy: false, capUsd: 0, note: this.paused };
    }
    this.paused = null;
    // Marked at the start, so a pass that fails halfway still waits a full interval before asking again.
    this.save({ ...l, lastPaidAt: iso(now) });
    return { buy: true, capUsd: Math.min(this.o.passCapUsd, remaining), note: "" };
  }

  record(spentUsd: number, now: number): void {
    const l = this.load(now);
    this.save({ ...l, spentUsd: Number((l.spentUsd + spentUsd).toFixed(6)) });
  }

  status(now: number): BuyStatus {
    const l = this.load(now);
    return {
      label: TESTNET_LABEL,
      lastPaidAt: l.lastPaidAt,
      nextPaidAfter: l.lastPaidAt ? iso(Date.parse(l.lastPaidAt) + this.o.intervalMs) : null,
      spentTodayUsd: l.spentUsd,
      dailyUsd: this.o.dailyUsd,
      passCapUsd: this.o.passCapUsd,
      intervalMin: Math.round(this.o.intervalMs / 60000),
      minBalanceUsd: this.o.minBalanceUsd,
      escrowAvailableUsd: this.balance.usd === null ? null : Math.round(this.balance.usd * 100) / 100,
      escrowReadAt: this.balance.at,
      paused: this.paused,
    };
  }
}
