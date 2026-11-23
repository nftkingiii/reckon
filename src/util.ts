import { createHash } from "node:crypto";

/** JSON with sorted keys, so equal data always hashes equally. */
export function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Raw integer units to a plain decimal string without losing precision. */
export function fmtUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function unitsToNumber(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

export const num = (n: number, digits = 2): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const usd = (n: number, digits = 2): string => `$${num(n, digits)}`;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function relDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? 0 : d / m;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Days between two instants, fractional. */
export const daysBetween = (laterMs: number, earlierMs: number): number => (laterMs - earlierMs) / 86_400_000;
