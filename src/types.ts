export type Status = "pass" | "flag" | "hold";
export type Mode = "live" | "recorded";

export interface SourceRef {
  name: string;
  url: string;
  fetchedAt: string;
  /** sha256 of the response body when we hold one. */
  sha256?: string;
  note?: string;
}

export interface Receipt {
  receiptHash?: string;
  signalHash?: string;
  rail?: string;
}

export interface TelegraphCall {
  subject: string;
  minerId: string;
  params: Record<string, unknown>;
  costUsd?: number;
  answeredAt?: string;
  receipt?: Receipt;
  answer?: Record<string, unknown>;
  outcome: "answered" | "refused" | "error";
  note?: string;
}

export interface TelegraphLeg {
  intent: string;
  minerId: string;
  minerName: string;
  estCostUsd: number;
  /** "not-bought" is the demo state: the leg is implemented but BUY mode is off. */
  state: "bought" | "not-bought" | "failed";
  reason?: string;
  calls: TelegraphCall[];
}

export type Cell = string | number | boolean | null;

export interface CheckRow {
  id: string;
  group: "chain" | "issuer" | "regulatory" | "entity" | "telegraph";
  title: string;
  status: Status;
  summary: string;
  values: Record<string, Cell>;
  sources: SourceRef[];
  telegraph?: TelegraphLeg;
  /** The check that is missing, when status is hold. */
  missing?: string;
}

export interface Change {
  path: string;
  before: Cell;
  after: Cell;
  severity: "flag" | "info";
}

export interface AssetReport {
  assetId: string;
  name: string;
  symbol: string;
  issuer: string;
  mint: string;
  generatedAt: string;
  mode: Mode;
  buy: { enabled: boolean; spentUsd: number; capUsd: number };
  overall: "flag" | "partial" | "clear";
  counts: { pass: number; flag: number; hold: number };
  established: string[];
  flagged: string[];
  cannotCheck: { what: string; why: string }[];
  checks: CheckRow[];
  snapshotHash: string;
  previousHash: string | null;
  changes: Change[];
}

export interface HistoryEntry {
  at: string;
  hash: string;
  mode: Mode;
  changes: Change[];
  counts: { pass: number; flag: number; hold: number };
}
