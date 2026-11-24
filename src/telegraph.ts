// Telegraph purchase mode. Implemented and OFF by default: with RECKON_BUY unset every Telegraph row says "not bought (demo)".
// The escrow ask follows Ballast's: POST /engine/v1/ask/{minerId}, read the signed 402 challenge, sign its message, retry
// with X-PAYMENT, read the receipt from X-PAYMENT-RESPONSE. Reckon never holds a key; a signer module supplies personalSign.
import { pathToFileURL } from "node:url";
import { signerFromKey } from "./signer.ts";
import type { BuyGovernor } from "./governor.ts";
import type { Fetch } from "./net.ts";
import type { Receipt, TelegraphCall, TelegraphLeg } from "./types.ts";
import { errText, iso } from "./util.ts";

export const DEVNODE = "https://devnode.telegraphprotocol.com";
/** One engine ask has cost $0.01 on the testnet node; used only to reserve budget. The real quote comes from each 402 challenge. */
export const ENGINE_ASK_USD = 0.01;

export interface Miner {
  id: string;
  name: string;
  intent: string;
}

/** Chosen from the live intent listings read on 2026-11-23 (descriptions only; no ask was made). */
export const MINERS = {
  supply: { id: "7310060", name: "Plumb On-Chain and CVE Truth", intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL" },
  filings: { id: "731003", name: "Counterproof SEC Filing Monitor", intent: "REGULATORY_FILING_MONITOR_GENERAL" },
  sanctions: { id: "731149", name: "ZK Official Sanctions Match", intent: "SANCTIONS_SCREENING_MATCH_GENERAL" },
} as const satisfies Record<string, Miner>;

export interface AskRequest {
  intent: string;
  minerId: string;
  params: Record<string, unknown>;
  maxCostUsd: number;
}

export interface Answer {
  minerId: string;
  result: Record<string, unknown>;
  costUsd: number;
  answeredAt: string;
  receipt: Receipt;
}

export interface Transport {
  ask(request: AskRequest): Promise<Answer>;
}

export class TransportError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TransportError";
    this.status = status;
  }
}

/** Stops all further buying once a call would take total spend over the cap. */
export class Budget {
  spentUsd = 0;
  breached = false;
  capUsd: number;
  constructor(capUsd: number) {
    this.capUsd = capUsd;
  }
  reserve(maxUsd: number): boolean {
    if (this.breached || this.spentUsd + maxUsd > this.capUsd + 1e-9) {
      this.breached = true;
      return false;
    }
    return true;
  }
  record(usd: number): void {
    this.spentUsd += usd;
  }
}

export interface EscrowSigner {
  address: string;
  personalSign(message: string): Promise<string>;
}

interface Challenge {
  accepts: { scheme: string; network: string; payTo: string; extra?: { message?: string } }[];
}

const fromBase64Json = (text: string): unknown => JSON.parse(Buffer.from(text, "base64").toString("utf8"));

export function createEngineTransport(signer: EscrowSigner, http: Fetch = fetch, now: () => number = () => Date.now(), base = DEVNODE): Transport {
  return {
    async ask(request) {
      const url = `${base}/engine/v1/ask/${encodeURIComponent(request.minerId)}`;
      const body = JSON.stringify({ intent: request.intent, params: request.params });
      const send = (headers: Record<string, string>) =>
        http(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(65_000) });

      const first = await send({});
      if (first.status !== 402) throw new TransportError(`expected a 402 challenge, got ${first.status}`, first.status);
      const header = first.headers.get("payment-required");
      if (!header) throw new TransportError("402 without a Payment-Required header", 402);
      const challenge = fromBase64Json(header) as Challenge;
      const escrow = challenge.accepts.find((a) => a.scheme === "escrow");
      const template = escrow?.extra?.message;
      if (!escrow || !template) throw new TransportError("the node offered no escrow payment option", 402);

      const value = /Amount:\s*(\d+)\s*uUSDC/.exec(template)?.[1];
      if (!value) throw new TransportError("escrow challenge has no Amount line", 402);
      const costUsd = Number(value) / 1e6;
      if (costUsd > request.maxCostUsd + 1e-9) throw new TransportError(`quote $${costUsd} is above the $${request.maxCostUsd} limit`, 402);

      const validAfter = Math.floor(now() / 1000) - 30;
      const validBefore = validAfter + 90; // the node allows at most a 2 minute window
      const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
      const from = signer.address.toLowerCase();
      const message = template
        .replace("{from}", from)
        .replace("{nonce}", nonce)
        .replace("{validAfter}", String(validAfter))
        .replace("{validBefore}", String(validBefore));
      const signature = await signer.personalSign(message);
      const payload = {
        x402Version: 2,
        scheme: "escrow",
        network: escrow.network,
        // The escrow rail wants value and the validity bounds as strings.
        payload: { signature, authorization: { from, to: escrow.payTo, value, validAfter: String(validAfter), validBefore: String(validBefore), nonce } },
      };
      const paid = await send({ "x-payment": Buffer.from(JSON.stringify(payload)).toString("base64") });
      if (paid.status !== 200) {
        const reason = await paid
          .json()
          .then((b: { reason?: string; error?: string }) => b.reason ?? b.error ?? "")
          .catch(() => "");
        throw new TransportError(`paid ask answered ${paid.status}${reason ? `: ${reason}` : ""}`, paid.status);
      }
      const json = (await paid.json()) as { result?: Record<string, unknown>; signal_hash?: string; cost_usd?: number };
      const raw = paid.headers.get("x-payment-response");
      const receipt = raw ? (fromBase64Json(raw) as { receipt_hash?: string; rail?: string; amount_uusdc?: number }) : {};
      if (!json.result || !receipt.receipt_hash) throw new TransportError("answer came back without a result or a receipt");
      return {
        minerId: request.minerId,
        result: json.result,
        costUsd: receipt.amount_uusdc !== undefined ? receipt.amount_uusdc / 1e6 : (json.cost_usd ?? costUsd),
        answeredAt: iso(now()),
        receipt: { receiptHash: receipt.receipt_hash, ...(json.signal_hash ? { signalHash: json.signal_hash } : {}), ...(receipt.rail ? { rail: receipt.rail } : {}) },
      };
    },
  };
}

/**
 * Available escrow of a wallet in USD, from the node ledger (keyless GET /v1/ledger/account/{address}). Amounts are
 * micro-USDC strings. Anything that is not a non-negative whole number throws, so a caller that needs a floor refuses.
 */
export async function readLedgerAvailableUsd(address: string, http: Fetch = fetch, base = DEVNODE): Promise<number> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TransportError("not a wallet address");
  const res = await http(`${base}/v1/ledger/account/${address}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new TransportError(`ledger read failed with ${res.status}`, res.status);
  const available = ((await res.json()) as { available?: unknown }).available;
  if ((typeof available !== "string" && typeof available !== "number") || !/^[0-9]+$/.test(String(available))) throw new TransportError("ledger response has no readable available amount");
  return Number(available) / 1e6;
}

/** A signer from RECKON_SIGNER_KEY (a hex key in the environment) or from a local module that default-exports { address, personalSign(message) }. */
export async function loadSigner(env: NodeJS.ProcessEnv): Promise<EscrowSigner | undefined> {
  if (env.RECKON_SIGNER_KEY) return signerFromKey(env.RECKON_SIGNER_KEY);
  const path = env.RECKON_SIGNER_MODULE;
  if (!path) return undefined;
  const mod = (await import(pathToFileURL(path).href)) as { default?: EscrowSigner };
  if (!mod.default?.address || typeof mod.default.personalSign !== "function") {
    throw new Error("RECKON_SIGNER_MODULE must default-export { address, personalSign(message) }");
  }
  return mod.default;
}

// ---------------------------------------------------------------- the purchase session used by the checks

export interface BuyConfig {
  enabled: boolean;
  capUsd: number;
  transport?: Transport;
  /** When set, purchases are paced and capped across passes. Without it every pass with a transport buys. */
  governor?: BuyGovernor;
}

export const buyOff = (): BuyConfig => ({ enabled: false, capUsd: 0 });

/** BUY mode needs the explicit flag, a cap above zero and a signer; anything else refuses to start rather than run half-armed. */
export async function buyFromEnv(env: NodeJS.ProcessEnv = process.env, http: Fetch = fetch): Promise<BuyConfig> {
  if (env.RECKON_BUY !== "1") return buyOff();
  const num = (name: string, def: string): number => Number(env[name] ?? def);
  const cap = num("RECKON_BUY_CAP_USD", "0.25");
  if (!(cap > 0)) throw new Error("RECKON_BUY=1 needs RECKON_BUY_CAP_USD above zero");
  const daily = num("RECKON_BUY_DAILY_USD", "3.50");
  const everyMin = num("RECKON_BUY_INTERVAL_MIN", "60");
  const floor = num("RECKON_BUY_MIN_BALANCE_USD", "1");
  if (!(daily > 0) || !(everyMin > 0) || !(floor >= 0)) throw new Error("RECKON_BUY_DAILY_USD and RECKON_BUY_INTERVAL_MIN must be above zero, and RECKON_BUY_MIN_BALANCE_USD cannot be negative");
  const signer = await loadSigner(env);
  if (!signer) throw new Error("RECKON_BUY=1 needs RECKON_SIGNER_KEY or RECKON_SIGNER_MODULE (the escrow signer)");
  const { BuyGovernor } = await import("./governor.ts");
  const governor = new BuyGovernor({ intervalMs: everyMin * 60_000, passCapUsd: cap, dailyUsd: daily, minBalanceUsd: floor, readBalance: () => readLedgerAvailableUsd(signer.address, http) });
  return { enabled: true, capUsd: cap, transport: createEngineTransport(signer, http), governor };
}

export const DEMO_REASON = "BUY mode is off. The ask is implemented but was not made, so this row carries no result.";

export class BuySession {
  cfg: BuyConfig;
  budget: Budget;
  /** Why nothing is bought in this session; shown on every not-bought row. */
  offReason: string;
  constructor(cfg: BuyConfig, offReason = DEMO_REASON) {
    this.cfg = cfg;
    this.budget = new Budget(cfg.capUsd);
    this.offReason = offReason;
  }
  /** Start of the summary of a row that was not bought. "demo" is reserved for BUY mode being off altogether. */
  get notBought(): string {
    return this.offReason === DEMO_REASON ? "Not bought (demo)." : "Not bought this pass.";
  }
  get enabled(): boolean {
    return this.cfg.enabled && !!this.cfg.transport;
  }
  get spentUsd(): number {
    return this.budget.spentUsd;
  }

  async ask(miner: Miner, subject: string, params: Record<string, unknown>): Promise<TelegraphCall> {
    const base = { subject, minerId: miner.id, params };
    if (!this.enabled) return { ...base, outcome: "refused", note: "BUY mode is off" };
    if (!this.budget.reserve(ENGINE_ASK_USD)) return { ...base, outcome: "refused", note: `run cap $${this.budget.capUsd.toFixed(2)} reached` };
    try {
      const a = await this.cfg.transport!.ask({ intent: miner.intent, minerId: miner.id, params, maxCostUsd: ENGINE_ASK_USD * 2 });
      this.budget.record(a.costUsd);
      return { ...base, outcome: "answered", costUsd: a.costUsd, answeredAt: a.answeredAt, receipt: a.receipt, answer: a.result };
    } catch (e) {
      return { ...base, outcome: "error", note: errText(e) };
    }
  }
}

export function demoLeg(miner: Miner, calls: number, reason?: string): TelegraphLeg {
  return {
    intent: miner.intent,
    minerId: miner.id,
    minerName: miner.name,
    estCostUsd: calls * ENGINE_ASK_USD,
    state: "not-bought",
    reason: reason ?? "BUY mode is off. The ask is implemented but was not made, so this is not a result.",
    calls: [],
  };
}
