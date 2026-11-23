// GLEIF is keyless. A pinned LEI is read directly; a name lookup lists candidates and never pins one.
import { getText, sourceOf, type Ctx } from "../net.ts";
import type { SourceRef } from "../types.ts";

export const GLEIF = "https://api.gleif.org/api/v1/lei-records";

export interface LeiRecord {
  lei: string;
  legalName: string;
  entityStatus: string;
  registrationStatus: string;
  nextRenewal: string | null;
  jurisdiction: string | null;
  lastUpdate: string | null;
}

function toRecord(item: any): LeiRecord {
  const a = item?.attributes ?? {};
  return {
    lei: String(a.lei ?? item?.id ?? ""),
    legalName: String(a.entity?.legalName?.name ?? ""),
    entityStatus: String(a.entity?.status ?? ""),
    registrationStatus: String(a.registration?.status ?? ""),
    nextRenewal: a.registration?.nextRenewalDate ?? null,
    jurisdiction: a.entity?.jurisdiction ?? null,
    lastUpdate: a.registration?.lastUpdateDate ?? null,
  };
}

export async function readLei(ctx: Ctx, lei: string): Promise<{ record: LeiRecord; source: SourceRef }> {
  const f = await getText(ctx, `${GLEIF}/${encodeURIComponent(lei)}`, { headers: { accept: "application/vnd.api+json" } });
  const record = toRecord((JSON.parse(f.text) as { data?: unknown }).data);
  if (!record.lei) throw new Error("GLEIF record has no LEI");
  return { record, source: sourceOf(f, `GLEIF record ${lei}`) };
}

export async function searchLeiByName(ctx: Ctx, name: string): Promise<{ records: LeiRecord[]; source: SourceRef }> {
  const url = `${GLEIF}?filter%5Bentity.legalName%5D=${encodeURIComponent(name)}&page%5Bsize%5D=5`;
  const f = await getText(ctx, url, { headers: { accept: "application/vnd.api+json" } });
  const data = (JSON.parse(f.text) as { data?: unknown[] }).data ?? [];
  return { records: data.map(toRecord), source: sourceOf(f, `GLEIF exact legal-name search "${name}"`) };
}
