// Small helpers for reading issuer pages that are rendered as HTML.

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };

export const decodeEntities = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/** Visible text of a page as trimmed, non-empty lines. Tag matching respects quoted attributes, which Tailwind class names break otherwise. */
export function htmlLines(html: string): string[] {
  const noScript = html.replace(/<script\b[\s\S]*?<\/script>/gi, "\n").replace(/<style\b[\s\S]*?<\/style>/gi, "\n");
  const text = noScript.replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, "\n");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function money(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)$/.exec(text.trim());
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

export function plainNumber(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^([\d,]+(?:\.\d+)?)$/.exec(text.trim());
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

export function percent(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^([\d.]+)\s*%$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Nov 22, 2026" or "November 20, 2026" to 2026-11-22 (a calendar date, no time zone). */
export function longDate(text: string): string | null {
  const m = /([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})/.exec(text);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** "11/20/2026" (US order) to 2026-11-20. */
export function usDate(text: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
}

/** "$1.97B" style abbreviations to a number. */
export function abbreviated(text: string): number | null {
  const m = /^\$?\s*([\d,.]+)\s*([KMBT])?$/i.exec(text.trim());
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] ?? "").toUpperCase() as "K"] ?? 1;
  return Number(m[1]!.replace(/,/g, "")) * mult;
}
