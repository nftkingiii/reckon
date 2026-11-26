// Balances of USDY held at addresses that Ondo's own docs name (redemption accounts, instant managers, wrapper contracts),
// and at two Stellar accounts the investigation in docs/usdy-investigation.md found. Used to adjust the cross-chain USDY sum.
// Every read says how well it was corroborated; a read that fails is reported as not read and is never counted as zero.
import { CHAINS, pinnedCalls } from "../evm.ts";
import { getText, sourceOf, type Ctx } from "../net.ts";
import { TEMPO_RPC, TEMPO_USDY } from "../others.ts";
import { getTextJson } from "../rpc.ts";
import type { SourceRef } from "../types.ts";
import { errText, iso, unitsToNumber } from "../util.ts";
import type { AddressRow } from "./ondo.ts";

export type HolderRole = "issuer-listed" | "wrapper" | "candidate";

export interface HolderSpec {
  role: HolderRole;
  chain: string;
  label: string;
  address: string;
  /** Why this address is on the list, with the citation. */
  basis: string;
}

export interface HolderReading extends HolderSpec {
  tokens: number | null;
  error: string | null;
  how: string;
  sources: SourceRef[];
}

const ISSUER_STELLAR = "GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6";
const SUI_TYPE = "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY";
const APTOS_ACCOUNT = "0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc";
const NOBLE_BASE = ["https://noble-api.polkachu.com", "https://api.noble.xyz"];
const EVM_KEY: Record<string, { key: string; token: string }> = {
  Ethereum: { key: "ethereum", token: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C" },
  BSC: { key: "bsc", token: "0x608593d17A2decBbc4399e4185bE4922F97eD32E" },
  Mantle: { key: "mantle", token: "0x5bE26527e817998A7206475496fDE1E68957c5A6" },
  Arbitrum: { key: "arbitrum", token: "0x35e050d3C0eC2d29D269a8EcEa763a183bDF9A9D" },
};

/** Two Stellar accounts that hold 96% of the USDY on Stellar. They are candidates, never applied to the headline adjustment. */
export const STELLAR_CANDIDATES: HolderSpec[] = [
  {
    role: "candidate",
    chain: "Stellar",
    label: "Stellar account GC635K...BXSHC",
    address: "GC635K2GGDMIINZBO6WWLQN6QUVDEBODEYCQ74OLEZUOA37K5E2BXSHC",
    basis: "Created and funded by Ondo's listed Stellar redemptions account; received 353,217,182 USDY in two payments on 2026-05-29, issued by the USDY issuer to that account first; has never sent any USDY.",
  },
  {
    role: "candidate",
    chain: "Stellar",
    label: "Stellar account GAY5KW...ANMB2",
    address: "GAY5KWJICHJ5U2QCBRWCPSEF3ARHTNLV4WUOVSCMKSJCET4DBBFANMB2",
    basis: "Received 55,500,873 and 38,571,692 USDY from Ondo's listed Stellar redemptions account on 2026-02-06 and 2026-02-13, issued by the USDY issuer to that account first; has never sent any USDY.",
  },
];

/** The addresses Ondo's docs table names as its own operating addresses or as wrappers of USDY. */
export function listedHolders(rows: AddressRow[]): HolderSpec[] {
  const out: HolderSpec[] = [];
  for (const r of rows) {
    if (r.section !== "USDY") continue;
    if (/Redemptions Account|InstantManager/i.test(r.name)) {
      out.push({ role: "issuer-listed", chain: r.chain, label: `${r.chain} ${r.name.replace(/\\/g, "")}`, address: r.address, basis: `Listed as "${r.name}" in Ondo's address table (docs.ondo.finance/addresses.md).` });
    } else if (r.name === "rUSDY" || /\(mUSD\)/.test(r.name)) {
      out.push({ role: "wrapper", chain: r.chain, label: `${r.chain} ${r.name}`, address: r.address, basis: `Listed as "${r.name}" in Ondo's address table: a wrapper of USDY.` });
    }
  }
  return out;
}

/** Any row in the USDY part of the docs table that looks like a bridge escrow or lockbox. None today. */
export const lockboxRows = (rows: AddressRow[]): AddressRow[] => rows.filter((r) => r.section === "USDY" && /lockbox|escrow|adapter|bridge|vault/i.test(r.name));

async function evmBalance(ctx: Ctx, spec: HolderSpec): Promise<Pick<HolderReading, "tokens" | "how" | "sources">> {
  const tokenAddr = spec.chain === "Tempo" ? TEMPO_USDY : EVM_KEY[spec.chain]?.token;
  if (!tokenAddr) throw new Error(`no USDY contract is known for ${spec.chain}`);
  const data = "0x70a08231" + spec.address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (spec.chain === "Tempo") {
    const j = await getTextJson(ctx, TEMPO_RPC, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddr, data }, "latest"] });
    if (j.error || typeof j.result !== "string") throw new Error(`Tempo RPC: ${j.error?.message ?? "no result"}`);
    return { tokens: unitsToNumber(BigInt(j.result), 6), how: "one RPC (rpc.tempo.xyz)", sources: [{ name: "Tempo RPC", url: TEMPO_RPC, fetchedAt: iso(ctx.now()), note: `balanceOf(${spec.address}) on ${tokenAddr}` }] };
  }
  const chain = CHAINS[EVM_KEY[spec.chain]!.key]!;
  const r = await pinnedCalls(ctx, chain, [{ to: tokenAddr, data }]);
  return { tokens: unitsToNumber(r.results[0]!, 18), how: `${r.rpcs.length} RPCs agree at block ${r.block}`, sources: r.sources.map((s) => ({ ...s, note: `${s.note}; balanceOf(${spec.address}) on ${tokenAddr}` })) };
}

async function read1(ctx: Ctx, spec: HolderSpec): Promise<Pick<HolderReading, "tokens" | "how" | "sources">> {
  switch (spec.chain) {
    case "Ethereum":
    case "BSC":
    case "Mantle":
    case "Arbitrum":
    case "Tempo":
      return evmBalance(ctx, spec);
    case "Stellar": {
      const f = await getText(ctx, `https://horizon.stellar.org/accounts/${spec.address}`, { headers: { accept: "application/json" } });
      const b = (JSON.parse(f.text) as { balances?: { asset_code?: string; asset_issuer?: string; balance: string }[] }).balances?.find((x) => x.asset_code === "USDY" && x.asset_issuer === ISSUER_STELLAR);
      // An account with no USDY trustline holds none; that is a read, not a failure.
      return { tokens: b ? Number(b.balance) : 0, how: "one endpoint (Horizon)", sources: [sourceOf(f, "Stellar Horizon account", `USDY balance of ${spec.address}`)] };
    }
    case "Sui": {
      const url = "https://graphql.mainnet.sui.io/graphql";
      const res = await ctx.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `{ address(address: "${spec.address}") { balance(coinType: "${SUI_TYPE}") { totalBalance } } }` }), signal: AbortSignal.timeout(ctx.timeoutMs) });
      const j = (await res.json()) as { data?: { address?: { balance?: { totalBalance: string } | null } | null } };
      if (!j.data?.address) throw new Error("Sui GraphQL returned no address object");
      return { tokens: unitsToNumber(BigInt(j.data.address.balance?.totalBalance ?? "0"), 6), how: "one endpoint (Sui GraphQL)", sources: [{ name: "Sui GraphQL", url, fetchedAt: iso(ctx.now()), note: `USDY balance of ${spec.address}` }] };
    }
    case "Aptos": {
      const f = await getText(ctx, `https://fullnode.mainnet.aptoslabs.com/v1/accounts/${spec.address}/balance/${APTOS_ACCOUNT}::usdy::USDY`);
      const v = Number(f.text.trim());
      if (!Number.isFinite(v)) throw new Error("Aptos balance is not a number");
      const info = await getText(ctx, `https://fullnode.mainnet.aptoslabs.com/v1/accounts/${APTOS_ACCOUNT}/resource/${encodeURIComponent(`0x1::coin::CoinInfo<${APTOS_ACCOUNT}::usdy::USDY>`)}`);
      const dec = (JSON.parse(info.text) as { data?: { decimals?: number } }).data?.decimals;
      if (typeof dec !== "number") throw new Error("Aptos CoinInfo has no decimals");
      return { tokens: v / 10 ** dec, how: "one endpoint (Aptos fullnode)", sources: [sourceOf(f, "Aptos fullnode balance", `USDY balance of ${spec.address}`)] };
    }
    case "Noble": {
      for (const base of NOBLE_BASE) {
        try {
          const f = await getText(ctx, `${base}/cosmos/bank/v1beta1/balances/${spec.address}`);
          const bal = (JSON.parse(f.text) as { balances?: { denom: string; amount: string }[] }).balances ?? [];
          const a = bal.find((x) => x.denom === "ausdy");
          return { tokens: a ? unitsToNumber(BigInt(a.amount), 18) : 0, how: `one endpoint (${new URL(base).host})`, sources: [sourceOf(f, `Noble REST ${new URL(base).host}`, `ausdy balance of ${spec.address}`)] };
        } catch {
          /* try the next endpoint */
        }
      }
      throw new Error("no Noble endpoint answered");
    }
    default:
      throw new Error(`no reader for ${spec.chain}`);
  }
}

export async function readHolders(ctx: Ctx, specs: HolderSpec[]): Promise<HolderReading[]> {
  const res = await Promise.allSettled(specs.map((s) => read1(ctx, s)));
  return res.map((r, i) => (r.status === "fulfilled" ? { ...specs[i]!, ...r.value, error: null } : { ...specs[i]!, tokens: null, error: errText(r.reason), how: "", sources: [] }));
}
