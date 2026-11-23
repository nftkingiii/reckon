// Solana reads. Every state read is made on two independent public RPCs and refused if they disagree.
import { getTextJson, type Ctx } from "./rpc.ts";
import { canon, errText, fmtUnits, iso, unitsToNumber } from "./util.ts";
import type { Cell, SourceRef } from "./types.ts";

export const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface MintExtension {
  name: string;
  state: Record<string, unknown>;
}

/** The part of a mint that Reckon watches. Equal states hash equally. */
export interface MintState {
  program: "spl-token" | "token-2022";
  supplyRaw: string;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: MintExtension[];
}

export class SolanaReadError extends Error {
  kind: "unavailable" | "disagree" | "not-a-mint";
  constructor(kind: SolanaReadError["kind"], message: string) {
    super(message);
    this.name = "SolanaReadError";
    this.kind = kind;
  }
}

export function normalizeMint(value: unknown): MintState {
  const v = value as { owner?: string; data?: { parsed?: { type?: string; info?: Record<string, any> } } } | null;
  const info = v?.data?.parsed?.info;
  if (!v || v.data?.parsed?.type !== "mint" || !info) throw new SolanaReadError("not-a-mint", "account is not a parsed token mint");
  const program = v.owner === TOKEN_2022_PROGRAM ? "token-2022" : v.owner === TOKEN_PROGRAM ? "spl-token" : null;
  if (!program) throw new SolanaReadError("not-a-mint", `owner ${v.owner} is not a token program`);
  const extensions: MintExtension[] = Array.isArray(info.extensions)
    ? info.extensions
        .map((e: { extension: string; state?: Record<string, unknown> }) => ({ name: String(e.extension), state: e.state ?? {} }))
        .sort((a: MintExtension, b: MintExtension) => (a.name < b.name ? -1 : 1))
    : [];
  return {
    program,
    supplyRaw: String(info.supply),
    decimals: Number(info.decimals),
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    extensions,
  };
}

export const extension = (s: MintState, name: string): MintExtension | undefined => s.extensions.find((e) => e.name === name);

/** The compliance-relevant controls, flattened for display and diffing. */
export function controls(s: MintState): Record<string, Cell> {
  const out: Record<string, Cell> = {
    program: s.program,
    mintAuthority: s.mintAuthority,
    freezeAuthority: s.freezeAuthority,
  };
  const pd = extension(s, "permanentDelegate");
  out.permanentDelegate = (pd?.state.delegate as string | undefined) ?? null;
  const das = extension(s, "defaultAccountState");
  out.defaultAccountState = (das?.state.accountState as string | undefined) ?? null;
  const th = extension(s, "transferHook");
  out.transferHookProgram = (th?.state.programId as string | undefined) ?? null;
  out.transferHookAuthority = (th?.state.authority as string | undefined) ?? null;
  const ca = extension(s, "mintCloseAuthority");
  out.closeAuthority = (ca?.state.closeAuthority as string | undefined) ?? null;
  const pa = extension(s, "pausableConfig");
  out.pausable = pa ? ((pa.state.paused as boolean | undefined) ?? true) : null;
  out.extensions = s.extensions.map((e) => e.name).join(", ") || "none";
  return out;
}

export interface MintRead {
  state: MintState;
  rpcs: { url: string; slot: number }[];
  slotGap: number;
  readAt: string;
  sources: SourceRef[];
}

async function rpc(ctx: Ctx, url: string, method: string, params: unknown[]): Promise<{ result: any; contextSlot?: number }> {
  const j = await getTextJson(ctx, url, { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${new URL(url).host}: ${String(j.error.message ?? j.error.code).slice(0, 120)}`);
  return { result: j.result, contextSlot: j.result?.context?.slot };
}

/**
 * Reads the mint on every RPC at finalized commitment, pinned to the lowest finalized slot the nodes report.
 * Solana has no "read at slot N" for account state, so the two reads can land a slot or two apart; they must still
 * be identical in content, and the slots are kept in the evidence. On a mismatch the read is retried (a mint or burn
 * may have landed between the reads) and then refused.
 */
export async function readMint(ctx: Ctx, mint: string, rpcs: string[] = SOLANA_RPCS, attempts = 3): Promise<MintRead> {
  let lastProblem = "no attempt made";
  let disagreed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await ctx.sleep(600);
    const slots = await Promise.allSettled(rpcs.map((u) => rpc(ctx, u, "getSlot", [{ commitment: "finalized" }])));
    const live = slots.flatMap((s, i) => (s.status === "fulfilled" ? [{ url: rpcs[i]!, slot: Number(s.value.result) }] : []));
    if (live.length < 2) {
      lastProblem = `only ${live.length} of ${rpcs.length} RPCs answered getSlot`;
      continue;
    }
    const pin = Math.min(...live.map((l) => l.slot));
    const reads = await Promise.allSettled(
      live.map(async (l) => {
        const { result } = await rpc(ctx, l.url, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized", minContextSlot: pin }]);
        if (!result?.value) throw new Error("account not found");
        return { url: l.url, slot: Number(result.context.slot), state: normalizeMint(result.value) };
      }),
    );
    const ok = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const notMint = reads.find((r) => r.status === "rejected" && r.reason instanceof SolanaReadError && r.reason.kind === "not-a-mint");
    if (notMint) throw (notMint as PromiseRejectedResult).reason;
    if (ok.length < 2) {
      lastProblem = reads.flatMap((r) => (r.status === "rejected" ? [errText(r.reason)] : [])).join("; ") || "fewer than two RPCs answered";
      continue;
    }
    if (canon(ok[0]!.state) !== canon(ok[1]!.state)) {
      disagreed = true;
      const a = ok[0]!.state;
      const b = ok[1]!.state;
      const fields = (Object.keys(a) as (keyof MintState)[]).filter((k) => canon(a[k]) !== canon(b[k]));
      lastProblem = `RPCs disagree on ${fields.join(", ")} (slots ${ok[0]!.slot} and ${ok[1]!.slot})`;
      continue;
    }
    const readAt = iso(ctx.now());
    return {
      state: ok[0]!.state,
      rpcs: ok.map((o) => ({ url: o.url, slot: o.slot })),
      slotGap: Math.abs(ok[0]!.slot - ok[1]!.slot),
      readAt,
      sources: ok.map((o) => ({
        name: `Solana RPC ${new URL(o.url).host}`,
        url: o.url,
        fetchedAt: readAt,
        note: `getAccountInfo ${mint}, finalized, slot ${o.slot}`,
      })),
    };
  }
  throw new SolanaReadError(disagreed ? "disagree" : "unavailable", lastProblem);
}

export const supplyOf = (s: MintState): number => unitsToNumber(BigInt(s.supplyRaw), s.decimals);
export const supplyText = (s: MintState): string => fmtUnits(BigInt(s.supplyRaw), s.decimals);

// ---------------------------------------------------------------- activity

export type EventKind = "mint" | "burn" | "set-authority" | "freeze" | "thaw" | "transfer" | "extension-change" | "other";

export interface ChainEvent {
  signature: string;
  slot: number;
  blockTime: number | null;
  kind: EventKind;
  /** whole tokens, for mint, burn and transfer */
  amount?: number;
  authority?: string;
  authorityType?: string;
  newAuthority?: string | null;
  byPermanentDelegate?: boolean;
  detail?: string;
}

interface ParsedIx {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, any> };
}

const EXTENSION_ADMIN = new Set([
  "initializePermanentDelegate",
  "updateDefaultAccountState",
  "initializeDefaultAccountState",
  "initializeTransferHook",
  "updateTransferHook",
  "initializeMintCloseAuthority",
  "initializeMetadataPointer",
  "updateMetadataPointer",
  "pause",
  "resume",
  "updateMultiplierData",
  "updateScaledUiAmountMultiplier",
]);

export function classifyInstruction(ix: ParsedIx, mint: string, decimals: number, permanentDelegate: string | null): Omit<ChainEvent, "signature" | "slot" | "blockTime"> | null {
  const p = ix.parsed;
  if (!p?.type || !p.info) return null;
  const info = p.info;
  const amountOf = (): number | undefined => {
    const raw = info.tokenAmount?.amount ?? info.amount;
    return raw === undefined ? undefined : unitsToNumber(BigInt(String(raw)), decimals);
  };
  const delegateFlag = (): { byPermanentDelegate?: boolean } => {
    const a = info.authority ?? info.multisigAuthority;
    return permanentDelegate && a === permanentDelegate ? { byPermanentDelegate: true } : {};
  };
  switch (p.type) {
    case "mintTo":
    case "mintToChecked":
      return info.mint === mint ? { kind: "mint", ...(amountOf() !== undefined ? { amount: amountOf()! } : {}), authority: info.mintAuthority ?? info.authority } : null;
    case "burn":
    case "burnChecked":
      return info.mint === mint ? { kind: "burn", ...(amountOf() !== undefined ? { amount: amountOf()! } : {}), authority: info.authority, ...delegateFlag() } : null;
    case "setAuthority":
    case "setAuthorityChecked":
      return info.account === mint || info.mint === mint
        ? { kind: "set-authority", authority: info.authority, authorityType: info.authorityType, newAuthority: info.newAuthority ?? null }
        : null;
    case "freezeAccount":
      return info.mint === mint ? { kind: "freeze", authority: info.freezeAuthority } : null;
    case "thawAccount":
      return info.mint === mint ? { kind: "thaw", authority: info.freezeAuthority } : null;
    case "transferChecked":
      return info.mint === mint ? { kind: "transfer", ...(amountOf() !== undefined ? { amount: amountOf()! } : {}), ...delegateFlag() } : null;
    default:
      if (EXTENSION_ADMIN.has(p.type) && (info.mint === mint || info.account === mint)) return { kind: "extension-change", detail: p.type };
      return null;
  }
}

export interface ActivityRead {
  signaturesSeen: number;
  failedSkipped: number;
  inspected: number;
  /** Transactions that could not be fetched, with the first reason. */
  inspectFailures: { count: number; first: string | null };
  events: ChainEvent[];
  newestSignature: string | null;
  oldestInspectedAt: number | null;
  newestAt: number | null;
  rpc: string;
  readAt: string;
  sources: SourceRef[];
}

/**
 * Lists recent signatures that touched the mint and classifies the transactions it can inspect. It reads from the first
 * RPC that answers; this is an event log, and the state it implies is checked by readMint on two RPCs.
 */
export async function readActivity(
  ctx: Ctx,
  mint: string,
  decimals: number,
  permanentDelegate: string | null,
  opts: { limit?: number; inspect?: number; until?: string; rpcs?: string[] } = {},
): Promise<ActivityRead> {
  const limit = opts.limit ?? 40;
  const inspect = opts.inspect ?? 12;
  const rpcs = opts.rpcs ?? SOLANA_RPCS;
  let lastError = "no RPC tried";
  for (const url of rpcs) {
    try {
      const cfg: Record<string, unknown> = { limit, commitment: "finalized" };
      if (opts.until) cfg.until = opts.until;
      const { result: sigs } = await rpc(ctx, url, "getSignaturesForAddress", [mint, cfg]);
      if (!Array.isArray(sigs)) throw new Error("signature list missing");
      const okSigs = (sigs as { signature: string; slot: number; blockTime: number | null; err: unknown }[]).filter((s) => !s.err);
      const events: ChainEvent[] = [];
      let inspected = 0;
      const failures = { count: 0, first: null as string | null };
      const order = [url, ...rpcs.filter((u) => u !== url)];
      for (const s of okSigs.slice(0, inspect)) {
        let tx: any;
        let lastErr = "";
        // The public endpoints rate-limit getTransaction; try each RPC once, then pause briefly before the next signature.
        for (const u of order) {
          try {
            tx = (await rpc(ctx, u, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }])).result;
            if (tx) break;
          } catch (e) {
            lastErr = errText(e);
          }
        }
        await ctx.sleep(200);
        if (!tx && lastErr) {
          failures.count++;
          failures.first ??= lastErr;
          continue;
        }
        if (!tx) {
          failures.count++;
          failures.first ??= "transaction not returned";
          continue;
        }
        inspected++;
        const ixs: ParsedIx[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i: { instructions: ParsedIx[] }) => i.instructions)];
        for (const ix of ixs) {
          const ev = classifyInstruction(ix, mint, decimals, permanentDelegate);
          if (ev) events.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, ...ev });
        }
      }
      const readAt = iso(ctx.now());
      return {
        signaturesSeen: sigs.length,
        failedSkipped: sigs.length - okSigs.length,
        inspected,
        inspectFailures: failures,
        events,
        newestSignature: sigs[0]?.signature ?? null,
        oldestInspectedAt: okSigs.slice(0, inspect).at(-1)?.blockTime ?? null,
        newestAt: sigs[0]?.blockTime ?? null,
        rpc: url,
        readAt,
        sources: [{ name: `Solana RPC ${new URL(url).host}`, url, fetchedAt: readAt, note: `getSignaturesForAddress ${mint} (limit ${limit}), getTransaction x${inspected}` }],
      };
    } catch (e) {
      lastError = `${new URL(url).host}: ${errText(e)}`;
    }
  }
  throw new SolanaReadError("unavailable", lastError);
}
