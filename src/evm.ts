// EVM reads on two independent public RPCs, pinned to the same block, refused on disagreement or staleness.
import { getTextJson, type Ctx } from "./rpc.ts";
import { errText, iso, unitsToNumber } from "./util.ts";
import type { SourceRef } from "./types.ts";

export interface EvmChain {
  key: string;
  name: string;
  rpcs: string[];
}

export const CHAINS: Record<string, EvmChain> = {
  ethereum: { key: "ethereum", name: "Ethereum", rpcs: ["https://ethereum-rpc.publicnode.com", "https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"] },
  bsc: { key: "bsc", name: "BNB Chain", rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"] },
  arbitrum: { key: "arbitrum", name: "Arbitrum", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"] },
  mantle: { key: "mantle", name: "Mantle", rpcs: ["https://mantle-rpc.publicnode.com", "https://rpc.mantle.xyz"] },
  sei: { key: "sei", name: "Sei", rpcs: ["https://sei-evm-rpc.publicnode.com", "https://evm-rpc.sei-apis.com"] },
  plume: { key: "plume", name: "Plume", rpcs: ["https://rpc.plume.org", "https://plume.drpc.org"] },
};

/** Function selectors (first four bytes of the keccak hash of the signature). */
export const SEL = { totalSupply: "0x18160ddd", decimals: "0x313ce567", getPrice: "0x98d5fdca" } as const;

export class EvmReadError extends Error {
  kind: "unavailable" | "disagree" | "stale";
  constructor(kind: EvmReadError["kind"], message: string) {
    super(message);
    this.name = "EvmReadError";
    this.kind = kind;
  }
}

const MAX_BLOCK_AGE_S = 300;

async function call(ctx: Ctx, url: string, method: string, params: unknown[]): Promise<any> {
  const j = await getTextJson(ctx, url, { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${new URL(url).host}: ${String(j.error.message ?? j.error.code).slice(0, 100)}`);
  return j.result;
}

const hexToBig = (h: unknown): bigint => {
  if (typeof h !== "string" || !/^0x[0-9a-fA-F]*$/.test(h)) throw new Error("bad hex");
  return h === "0x" ? 0n : BigInt(h);
};

export interface PinnedRead {
  block: number;
  blockTime: number;
  results: bigint[];
  rpcs: string[];
  readAt: string;
  sources: SourceRef[];
}

/**
 * Runs the same eth_call list on every RPC at one block: the lowest head the RPCs report, so each node has it.
 * Any difference between nodes refuses the read; a block older than five minutes is refused as stale.
 */
export async function pinnedCalls(ctx: Ctx, chain: EvmChain, calls: { to: string; data: string }[]): Promise<PinnedRead> {
  const heads = await Promise.allSettled(chain.rpcs.map(async (u) => ({ url: u, head: hexToBig(await call(ctx, u, "eth_blockNumber", [])) })));
  const live = heads.flatMap((h) => (h.status === "fulfilled" ? [h.value] : []));
  if (live.length < 2) {
    const why = heads.flatMap((h) => (h.status === "rejected" ? [errText(h.reason)] : [])).join("; ");
    throw new EvmReadError("unavailable", `${chain.name}: ${live.length} of ${chain.rpcs.length} RPCs answered${why ? ` (${why})` : ""}`);
  }
  const pin = live.reduce((m, l) => (l.head < m ? l.head : m), live[0]!.head);
  const blockHex = "0x" + pin.toString(16);
  const answers = await Promise.allSettled(
    live.map(async (l) => {
      const out: bigint[] = [];
      for (const c of calls) out.push(hexToBig(await call(ctx, l.url, "eth_call", [{ to: c.to, data: c.data }, blockHex])));
      const block = await call(ctx, l.url, "eth_getBlockByNumber", [blockHex, false]);
      return { url: l.url, out, ts: Number(hexToBig(block?.timestamp)) };
    }),
  );
  const ok = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (ok.length < 2) {
    const why = answers.flatMap((a) => (a.status === "rejected" ? [errText(a.reason)] : [])).join("; ");
    throw new EvmReadError("unavailable", `${chain.name}: fewer than two RPCs returned the calls (${why})`);
  }
  for (const a of ok.slice(1)) {
    if (a.out.some((v, i) => v !== ok[0]!.out[i])) throw new EvmReadError("disagree", `${chain.name}: RPCs disagree at block ${pin}`);
  }
  const ts = ok[0]!.ts;
  if (!ts) throw new EvmReadError("unavailable", `${chain.name}: no block time`);
  const age = ctx.now() / 1000 - ts;
  if (age > MAX_BLOCK_AGE_S) throw new EvmReadError("stale", `${chain.name}: block ${pin} is ${Math.round(age)} s old`);
  const readAt = iso(ctx.now());
  return {
    block: Number(pin),
    blockTime: ts,
    results: ok[0]!.out,
    rpcs: ok.map((o) => o.url),
    readAt,
    sources: ok.map((o) => ({ name: `${chain.name} RPC ${new URL(o.url).host}`, url: o.url, fetchedAt: readAt, note: `eth_call at block ${pin}` })),
  };
}

export interface Erc20Supply {
  supply: number;
  supplyRaw: bigint;
  decimals: number;
  block: number;
  blockTime: number;
  rpcs: string[];
  sources: SourceRef[];
}

export async function readErc20Supply(ctx: Ctx, chain: EvmChain, address: string): Promise<Erc20Supply> {
  const r = await pinnedCalls(ctx, chain, [
    { to: address, data: SEL.totalSupply },
    { to: address, data: SEL.decimals },
  ]);
  const decimals = Number(r.results[1]!);
  return {
    supply: unitsToNumber(r.results[0]!, decimals),
    supplyRaw: r.results[0]!,
    decimals,
    block: r.block,
    blockTime: r.blockTime,
    rpcs: r.rpcs,
    sources: r.sources.map((s) => ({ ...s, note: `${s.note}; totalSupply() and decimals() of ${address}` })),
  };
}
