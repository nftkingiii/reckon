// Supply readers for non-EVM chains and for chains where only one public endpoint is known. Each result says how well it
// is corroborated, because a single endpoint cannot be refused on disagreement.
import { getText, sourceOf, type Ctx } from "./net.ts";
import { getTextJson } from "./rpc.ts";
import type { SourceRef } from "./types.ts";
import { errText, iso, relDiff, unitsToNumber } from "./util.ts";

export interface OtherSupply {
  label: string;
  supply: number;
  corroboration: string;
  sources: SourceRef[];
}

const SUI_TYPE = "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY";
const APTOS_ACCOUNT = "0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc";
const STELLAR = { code: "USDY", issuer: "GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6" };
const NOBLE_ENDPOINTS = ["https://noble-api.polkachu.com", "https://api.noble.xyz"];
export const TEMPO_RPC = "https://rpc.tempo.xyz";
export const TEMPO_USDY = "0x20c000000000000000000000D479B9f6eC0ceFf9";

export async function readSui(ctx: Ctx): Promise<OtherSupply> {
  const url = "https://graphql.mainnet.sui.io/graphql";
  const res = await ctx.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ coinMetadata(coinType: "${SUI_TYPE}") { decimals supply symbol } }` }),
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  const j = (await res.json()) as { data?: { coinMetadata?: { decimals: number; supply: string } | null } };
  const m = j.data?.coinMetadata;
  if (!m?.supply) throw new Error("Sui GraphQL returned no supply for the USDY coin type");
  return {
    label: "Sui",
    supply: unitsToNumber(BigInt(m.supply), m.decimals),
    corroboration: "one endpoint (Sui GraphQL)",
    sources: [{ name: "Sui GraphQL", url, fetchedAt: iso(ctx.now()), note: `coinMetadata supply of ${SUI_TYPE}` }],
  };
}

export async function readAptos(ctx: Ctx): Promise<OtherSupply> {
  const type = `0x1::coin::CoinInfo<${APTOS_ACCOUNT}::usdy::USDY>`;
  const url = `https://fullnode.mainnet.aptoslabs.com/v1/accounts/${APTOS_ACCOUNT}/resource/${encodeURIComponent(type)}`;
  const f = await getText(ctx, url);
  const d = (JSON.parse(f.text) as { data?: { decimals: number; supply?: { vec?: { integer?: { vec?: { value: string }[] } }[] } } }).data;
  const v = d?.supply?.vec?.[0]?.integer?.vec?.[0]?.value;
  if (v === undefined || d === undefined) throw new Error("Aptos CoinInfo has no readable supply");
  return { label: "Aptos", supply: unitsToNumber(BigInt(v), d.decimals), corroboration: "one endpoint (Aptos fullnode)", sources: [sourceOf(f, "Aptos fullnode CoinInfo")] };
}

export async function readNoble(ctx: Ctx): Promise<OtherSupply> {
  const reads = await Promise.allSettled(
    NOBLE_ENDPOINTS.map(async (base) => {
      const f = await getText(ctx, `${base}/cosmos/bank/v1beta1/supply/by_denom?denom=ausdy`);
      const raw = (JSON.parse(f.text) as { amount?: { amount?: string } }).amount?.amount;
      if (!raw) throw new Error("no supply in answer");
      return { f, raw: BigInt(raw) };
    }),
  );
  const ok = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (ok.length === 0) throw new Error(`no Noble endpoint answered (${reads.map((r) => (r.status === "rejected" ? errText(r.reason) : "")).join("; ")})`);
  const supply = unitsToNumber(ok[0]!.raw, 18);
  if (ok.length > 1 && relDiff(supply, unitsToNumber(ok[1]!.raw, 18)) > 1e-6) throw new Error("Noble endpoints disagree");
  return {
    label: "Noble",
    supply,
    corroboration: ok.length > 1 ? "two endpoints agree" : "one endpoint",
    sources: ok.map((o) => sourceOf(o.f, `Noble REST ${new URL(o.f.url).host}`, "bank supply of ausdy, 18 decimals")),
  };
}

export async function readStellar(ctx: Ctx): Promise<OtherSupply> {
  const f = await getText(ctx, `https://horizon.stellar.org/assets?asset_code=${STELLAR.code}&asset_issuer=${STELLAR.issuer}`, { headers: { accept: "application/json" } });
  const rec = (JSON.parse(f.text) as { _embedded?: { records?: Record<string, any>[] } })._embedded?.records?.[0];
  if (!rec) throw new Error("Horizon has no record for the USDY asset");
  const parts = [rec.balances?.authorized, rec.contracts_amount, rec.liquidity_pools_amount, rec.claimable_balances_amount].map((x) => Number(x ?? 0));
  if (parts.some((p) => !Number.isFinite(p))) throw new Error("Horizon amounts are not numbers");
  return {
    label: "Stellar",
    supply: parts.reduce((a, b) => a + b, 0),
    corroboration: "one endpoint (Horizon); trustlines + contracts + liquidity pools + claimable balances",
    sources: [sourceOf(f, "Stellar Horizon asset stats")],
  };
}

export async function readTempo(ctx: Ctx): Promise<OtherSupply> {
  const call = async (data: string): Promise<bigint> => {
    const j = await getTextJson(ctx, TEMPO_RPC, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TEMPO_USDY, data }, "latest"] });
    if (j.error || typeof j.result !== "string") throw new Error(`Tempo RPC: ${j.error?.message ?? "no result"}`);
    return BigInt(j.result);
  };
  const [raw, dec] = [await call("0x18160ddd"), await call("0x313ce567")];
  return { label: "Tempo", supply: unitsToNumber(raw, Number(dec)), corroboration: "one RPC (rpc.tempo.xyz)", sources: [{ name: "Tempo RPC", url: TEMPO_RPC, fetchedAt: iso(ctx.now()), note: `eth_call totalSupply of ${TEMPO_USDY}` }] };
}

export const OTHER_READERS: Record<string, (ctx: Ctx) => Promise<OtherSupply>> = { Sui: readSui, Aptos: readAptos, Noble: readNoble, Stellar: readStellar, Tempo: readTempo };
