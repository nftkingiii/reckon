// Holdings: given public wallet addresses, report what they hold of each watched asset. Read-only. No wallet connection,
// no signing, nothing stored. Every read names its source; a read that fails is shown as not read, never as zero.
import { keccak_256 } from "@noble/hashes/sha3";
import { CHAINS, pinnedCalls } from "./evm.ts";
import { type Ctx } from "./net.ts";
import { ASSETS, type AssetSpec } from "./registry.ts";
import { getTextJson } from "./rpc.ts";
import { SOLANA_RPCS } from "./solana.ts";
import type { AssetReport, Cell, SourceRef } from "./types.ts";
import { errText, iso, unitsToNumber } from "./util.ts";

export const MAX_ADDRESSES = 5;
export const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Public addresses a visitor can try. Each is the owner of one of the largest token accounts, or a large holder, read from public chain data. They are labelled as examples and say nothing about who controls them. */
export interface Example {
  address: string;
  label: string;
  note: string;
}
export const EXAMPLES: Example[] = [
  { address: "HYP6YSsagbnNtENSXbvNE95a6SUM83fLXiFYQMqLM9sz", label: "Large BUIDL holder (Solana)", note: "An owner with one of the largest BUIDL balances in the mint's recent transactions, read from public chain data on 2026-11-26. Example only; who controls it is not known." },
  { address: "Dmp5cuefdJwfryvg9NK7FB17oSw3FnoUAq2JXmUj2dmH", label: "Large USTB holder (Solana)", note: "An owner with the largest USTB balance in the mint's recent transactions, read from public chain data on 2026-11-26. Example only; who controls it is not known." },
  { address: "AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD", label: "Large USDY holder (Solana)", note: "An owner with the largest USDY balance on Solana in the mint's recent transactions, read from public chain data on 2026-11-26. Example only; who controls it is not known." },
  { address: "0xa5b614026dcb1ef6e0e39aa53351b4f4bd225302", label: "Large USDY holder (Ethereum)", note: "The largest USDY holder on Ethereum, a 3-of-5 Safe, from Ethplorer's holder list on 2026-11-26 and the chain. Example only; who controls it is not known." },
];

export interface Transfer {
  signature: string;
  time: string | null;
  direction: "in" | "out" | "none";
  amount: number;
}

export interface Position {
  assetId: string;
  symbol: string;
  chain: string;
  tokenAccount: string | null;
  balance: number;
  valueUsd: number | null;
  priceUsd: number | null;
  priceBasis: string;
  supply: number | null;
  shareOfSupplyPct: number | null;
  accountState: string;
  frozen: boolean | null;
  allowlist: string;
  recent: Transfer[] | null;
  recentNote: string;
  sources: SourceRef[];
}

export interface Risk {
  assetId: string;
  status: "flag" | "info";
  title: string;
  detail: string;
}

export interface AddressResult {
  address: string;
  kind: "solana" | "evm" | "invalid";
  error: string | null;
  positions: Position[];
  /** Assets and chains that were read and held nothing, and those that could not be read. */
  empty: string[];
  notRead: { what: string; why: string }[];
  risks: Risk[];
}

export interface HoldingsView {
  generatedAt: string;
  results: AddressResult[];
}

interface Price {
  usd: number | null;
  basis: string;
}

/** The latest price or NAV for an asset, taken from the report Reckon already holds. Never invented: BUIDL's par is labelled as an assumption. */
function priceOf(spec: AssetSpec, r: AssetReport | null): Price {
  const val = (id: string, key: string): unknown => r?.checks.find((c) => c.id === id)?.values[key];
  if (spec.id === "ustb") {
    const v = val("issuer-nav-aum", "implied NAV per share");
    return typeof v === "number" ? { usd: v, basis: `implied NAV per share from Superstate's AUM and shares, read ${r!.generatedAt.slice(0, 10)}` } : { usd: null, basis: "NAV not available" };
  }
  if (spec.id === "usdy") {
    const v = val("issuer-price", "oracle price");
    return typeof v === "number" ? { usd: v, basis: `Ondo oracle wrapper price on Ethereum, read ${r!.generatedAt.slice(0, 10)}` } : { usd: null, basis: "oracle price not available" };
  }
  return { usd: 1, basis: "assumed $1.00 par: BlackRock publishes no NAV feed Reckon can read, so this value is an assumption" };
}

const supplyOfReport = (r: AssetReport | null): number | null => {
  const s = Number(r?.checks.find((c) => c.id === "mint-state")?.values.supply);
  return Number.isFinite(s) ? s : null;
};

/** Asset-level findings that affect anyone holding the asset: flagged checks, authority controls that can freeze or move tokens, and checks that could not run. */
function risksFor(spec: AssetSpec, r: AssetReport | null): Risk[] {
  if (!r) return [{ assetId: spec.id, status: "info", title: "No report yet", detail: "Reckon has not finished a pass for this asset, so no asset-level checks are available." }];
  const out: Risk[] = r.checks.filter((c) => c.status === "flag").map((c) => ({ assetId: spec.id, status: "flag" as const, title: c.title, detail: c.summary }));
  for (const c of r.changes.filter((x) => x.severity === "flag")) out.push({ assetId: spec.id, status: "flag", title: `Control changed: ${c.path}`, detail: `${c.before} to ${c.after}` });
  const m = r.checks.find((c) => c.id === "mint-state")?.values ?? {};
  const ctl: string[] = [];
  if (m.permanentDelegate) ctl.push(`a permanent delegate (${String(m.permanentDelegate).slice(0, 8)}...) that can move or burn tokens in any account`);
  if (m.freezeAuthority) ctl.push(`a freeze authority (${String(m.freezeAuthority).slice(0, 8)}...)`);
  if (m.transferHookProgram) ctl.push(`a transfer hook program (${String(m.transferHookProgram).slice(0, 8)}...) that can refuse transfers`);
  if (m.mintAuthority) ctl.push(`a mint authority (${String(m.mintAuthority).slice(0, 8)}...)`);
  if (ctl.length) out.push({ assetId: spec.id, status: "info", title: "Issuer controls over the token", detail: `The mint has ${ctl.join(", ")}. A holder depends on the issuer not using them.` });
  const held = r.checks.filter((c) => c.status === "hold").map((c) => c.title);
  if (held.length) out.push({ assetId: spec.id, status: "info", title: `${held.length} check${held.length === 1 ? "" : "s"} could not run`, detail: held.join("; ") });
  const fresh = r.checks.find((c) => c.id === "issuer-freshness");
  if (fresh && fresh.status === "pass") out.push({ assetId: spec.id, status: "info", title: "Issuer figures are current", detail: fresh.summary });
  return out;
}

// ---------------------------------------------------------------- Solana

async function solRpc(ctx: Ctx, url: string, method: string, params: unknown[]): Promise<any> {
  const j = await getTextJson(ctx, url, { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${new URL(url).host}: ${String(j.error.message ?? j.error.code).slice(0, 120)}`);
  return j.result;
}

interface TokenAcct {
  pubkey: string;
  state: string;
  amountRaw: string;
  decimals: number;
}

/**
 * The list of a wallet's token accounts comes from one RPC (the second public RPC does not serve owner lookups). Each account
 * found is then read again on the second RPC and must match in balance and state, or nothing is shown.
 */
async function tokenAccounts(ctx: Ctx, owner: string, mint: string, attempt = 0): Promise<{ accts: TokenAcct[]; sources: SourceRef[] }> {
  const [listUrl, checkUrl] = [SOLANA_RPCS[0]!, SOLANA_RPCS[1]!];
  const res = await solRpc(ctx, listUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
  const accts: TokenAcct[] = (res.value as any[])
    .map((v) => ({ pubkey: String(v.pubkey), state: String(v.account.data.parsed.info.state), amountRaw: String(v.account.data.parsed.info.tokenAmount.amount), decimals: Number(v.account.data.parsed.info.tokenAmount.decimals) }))
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
  let agree = true;
  for (const a of accts) {
    const v = (await solRpc(ctx, checkUrl, "getAccountInfo", [a.pubkey, { encoding: "jsonParsed", commitment: "finalized" }]))?.value?.data?.parsed?.info;
    if (!v || String(v.tokenAmount?.amount) !== a.amountRaw || String(v.state) !== a.state) agree = false;
  }
  if (!agree) {
    if (attempt < 1) {
      await ctx.sleep(700);
      return tokenAccounts(ctx, owner, mint, attempt + 1);
    }
    throw new Error("the two Solana RPCs disagree about this wallet's token account, so nothing is shown");
  }
  const at = iso(ctx.now());
  return {
    accts,
    sources: [
      { name: `Solana RPC ${new URL(listUrl).host}`, url: listUrl, fetchedAt: at, note: `getTokenAccountsByOwner ${owner} for mint ${mint}, finalized (the account list is from this one RPC)` },
      ...(accts.length ? [{ name: `Solana RPC ${new URL(checkUrl).host}`, url: checkUrl, fetchedAt: at, note: "getAccountInfo of each token account found, finalized; balance and state matched" }] : []),
    ],
  };
}

async function solanaTransfers(ctx: Ctx, tokenAccount: string, mint: string, decimals: number): Promise<{ list: Transfer[]; skipped: number }> {
  const url = SOLANA_RPCS[0]!;
  const sigs = (await solRpc(ctx, url, "getSignaturesForAddress", [tokenAccount, { limit: 5 }])) as { signature: string; blockTime: number | null; err: unknown }[];
  const out: Transfer[] = [];
  let skipped = 0;
  for (const s of sigs.filter((x) => !x.err)) {
    let tx: any = null;
    for (const u of SOLANA_RPCS) {
      try {
        tx = await solRpc(ctx, u, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
        if (tx) break;
      } catch {
        /* try the next RPC */
      }
    }
    if (!tx) {
      skipped++;
      continue;
    }
    const keys: string[] = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k.pubkey));
    const idx = keys.indexOf(tokenAccount);
    const amt = (list: any[] | undefined): bigint => {
      const e = (list ?? []).find((b) => b.accountIndex === idx && b.mint === mint);
      return e ? BigInt(e.uiTokenAmount.amount) : 0n;
    };
    const delta = idx < 0 ? 0n : amt(tx.meta?.postTokenBalances) - amt(tx.meta?.preTokenBalances);
    out.push({ signature: s.signature, time: s.blockTime ? iso(s.blockTime * 1000) : null, direction: delta > 0n ? "in" : delta < 0n ? "out" : "none", amount: unitsToNumber(delta < 0n ? -delta : delta, decimals) });
  }
  return { list: out, skipped };
}

// ---------------------------------------------------------------- EVM

const sel = (sig: string): string => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).subarray(0, 4).toString("hex");
const pad = (a: string): string => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Ondo's published Blocklist contracts for USDY (docs.ondo.finance/addresses.md). */
const USDY_BLOCKLIST: Record<string, string> = {
  ethereum: "0xd8c8174691d936E2C80114EC449037b13421B0a8",
  bsc: "0xA8a823584Ac88cb48e7F8F467d1be9c0601E43F8",
  mantle: "0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6",
};

async function evmPosition(ctx: Ctx, spec: AssetSpec, evm: AssetSpec["evm"][number], owner: string, price: Price): Promise<Position | null> {
  const chain = CHAINS[evm.chain]!;
  const r = await pinnedCalls(ctx, chain, [
    { to: evm.address, data: sel("balanceOf(address)") + pad(owner) },
    { to: evm.address, data: "0x18160ddd" },
    { to: evm.address, data: "0x313ce567" },
  ]);
  const dec = Number(r.results[2]!);
  const bal = unitsToNumber(r.results[0]!, dec);
  if (r.results[0] === 0n) return null;
  const supply = unitsToNumber(r.results[1]!, dec);
  let blocked: string = "not checked: no blocklist is published for this token";
  let frozen: boolean | null = null;
  const bl = spec.id === "usdy" ? USDY_BLOCKLIST[evm.chain] : undefined;
  const srcs = [...r.sources];
  if (bl) {
    try {
      const b = await pinnedCalls(ctx, chain, [{ to: bl, data: sel("isBlocked(address)") + pad(owner) }]);
      frozen = b.results[0] !== 0n;
      blocked = frozen ? "on Ondo's blocklist: transfers are refused" : "not on Ondo's blocklist";
      srcs.push(...b.sources.map((s) => ({ ...s, note: `${s.note}; isBlocked(${owner}) on ${bl}` })));
    } catch (e) {
      blocked = `blocklist not read: ${errText(e)}`;
    }
  }
  let recent: Transfer[] | null = null;
  let recentNote = "Recent transfers are read from logs on Ethereum only; not read on this chain.";
  if (evm.chain === "ethereum") {
    try {
      const url = chain.rpcs[0]!;
      const head = Number(BigInt(await solRpc(ctx, url, "eth_blockNumber", [])));
      const from = "0x" + Math.max(0, head - 50_400).toString(16);
      const logs = async (topics: (string | null)[]) => (await solRpc(ctx, url, "eth_getLogs", [{ address: evm.address, fromBlock: from, toBlock: "latest", topics }])) as { data: string; transactionHash: string; blockNumber: string }[];
      const me = "0x" + pad(owner);
      const inn = await logs([TRANSFER_TOPIC, null, me]);
      const out = await logs([TRANSFER_TOPIC, me]);
      const mk = (l: { data: string; transactionHash: string; blockNumber: string }, direction: "in" | "out"): Transfer => ({ signature: l.transactionHash, time: null, direction, amount: unitsToNumber(BigInt(l.data), dec) });
      recent = [...inn.map((l) => ({ l, d: "in" as const })), ...out.map((l) => ({ l, d: "out" as const }))]
        .sort((a, b) => Number(BigInt(b.l.blockNumber) - BigInt(a.l.blockNumber)))
        .slice(0, 5)
        .map((x) => mk(x.l, x.d));
      recentNote = `Transfers in and out over the last 50,400 Ethereum blocks (about 7 days), one RPC (${new URL(url).host}).`;
      srcs.push({ name: `Ethereum RPC ${new URL(url).host}`, url, fetchedAt: iso(ctx.now()), note: `eth_getLogs Transfer in/out for ${owner}` });
    } catch (e) {
      recentNote = `Recent transfers not read: ${errText(e)}`;
    }
  }
  return {
    assetId: spec.id,
    symbol: spec.symbol,
    chain: evm.label,
    tokenAccount: null,
    balance: bal,
    valueUsd: price.usd === null ? null : bal * price.usd,
    priceUsd: price.usd,
    priceBasis: price.basis,
    supply,
    shareOfSupplyPct: supply > 0 ? (bal / supply) * 100 : null,
    accountState: blocked,
    frozen,
    allowlist: spec.id === "ustb" ? "Superstate's allowlist for Ethereum is not readable by Reckon" : "not applicable: USDY is gated by a blocklist, not an allowlist",
    recent,
    recentNote,
    sources: srcs,
  };
}

// ---------------------------------------------------------------- the view

export async function readHoldings(ctx: Ctx, addresses: string[], reports: Record<string, AssetReport | null>): Promise<HoldingsView> {
  const results: AddressResult[] = [];
  for (const raw of addresses.slice(0, MAX_ADDRESSES)) {
    const address = raw.trim();
    const kind = SOLANA_ADDR.test(address) ? "solana" : EVM_ADDR.test(address) ? "evm" : "invalid";
    const res: AddressResult = { address, kind, error: null, positions: [], empty: [], notRead: [], risks: [] };
    if (kind === "invalid") {
      res.error = "Not a Solana or EVM address.";
      results.push(res);
      continue;
    }
    const touched = new Set<string>();
    if (kind === "solana") {
      for (const spec of ASSETS) {
        const price = priceOf(spec, reports[spec.id] ?? null);
        try {
          const { accts, sources } = await tokenAccounts(ctx, address, spec.solanaMint);
          const held = accts.filter((a) => BigInt(a.amountRaw) > 0n || a.state === "frozen");
          if (!held.length) {
            res.empty.push(`${spec.symbol} on Solana: no token account with a balance`);
            continue;
          }
          touched.add(spec.id);
          const supply = supplyOfReport(reports[spec.id] ?? null);
          for (const a of held) {
            const bal = unitsToNumber(BigInt(a.amountRaw), a.decimals);
            let recent: Transfer[] | null = null;
            let recentNote = "";
            try {
              const t = await solanaTransfers(ctx, a.pubkey, spec.solanaMint, a.decimals);
              recent = t.list;
              recentNote = `Newest successful transactions touching this token account, from the Solana RPCs.${t.skipped ? ` ${t.skipped} could not be decoded by the public RPCs (a newer transaction version) and are not shown.` : ""}`;
            } catch (e) {
              recentNote = `Recent transfers not read: ${errText(e)}`;
            }
            res.positions.push({
              assetId: spec.id,
              symbol: spec.symbol,
              chain: "Solana",
              tokenAccount: a.pubkey,
              balance: bal,
              valueUsd: price.usd === null ? null : bal * price.usd,
              priceUsd: price.usd,
              priceBasis: price.basis,
              supply,
              shareOfSupplyPct: supply ? (bal / supply) * 100 : null,
              accountState: a.state === "frozen" ? "frozen: the issuer's freeze authority has frozen this account, so it cannot send or receive" : a.state === "initialized" ? "initialized (not frozen)" : a.state,
              frozen: a.state === "frozen",
              allowlist: spec.id === "ustb" ? "Superstate gates USTB with an allowlist and freezes new accounts by default; a thawed account is consistent with being allowlisted, but Reckon cannot read the allowlist itself" : spec.id === "buidl" ? "BUIDL transfers go through a transfer hook; the allowlist is not public" : "not applicable: USDY on Solana has no allowlist extension",
              recent,
              recentNote,
              sources: sources,
            });
          }
        } catch (e) {
          res.notRead.push({ what: `${spec.symbol} on Solana`, why: errText(e) });
        }
      }
    } else {
      for (const spec of ASSETS.filter((s) => s.evm.length)) {
        const price = priceOf(spec, reports[spec.id] ?? null);
        for (const evm of spec.evm) {
          try {
            const p = await evmPosition(ctx, spec, evm, address, price);
            if (p) {
              res.positions.push(p);
              touched.add(spec.id);
            } else res.empty.push(`${spec.symbol} on ${evm.label}: zero balance`);
          } catch (e) {
            res.notRead.push({ what: `${spec.symbol} on ${evm.label}`, why: errText(e) });
          }
        }
      }
    }
    for (const id of touched) res.risks.push(...risksFor(ASSETS.find((a) => a.id === id)!, reports[id] ?? null));
    results.push(res);
  }
  return { generatedAt: iso(ctx.now()), results };
}

export type { Cell };
