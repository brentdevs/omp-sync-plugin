export type Kind = "setting" | "provider";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Value = { deleted: true } | { deleted: false; value: Json };
export interface RecordValue { kind: Kind; key: string; value: Json }
export interface SyncRecord {
  kind: "setting" | "provider" | "secret";
  key: string;
  revision: number;
  deleted: boolean;
  value?: Json;
  deviceId: string;
  updatedAt: number;
}
export interface Snapshot { epoch: string; profile: string; cursor: number; records: SyncRecord[] }
export interface Changes { epoch: string; cursor: number; hasMore: boolean; changes: SyncRecord[] }
export interface Mutation { kind: Kind; key: string; expectedRevision: number; deleted?: boolean; value?: Json }
export interface MutationRequest { epoch: string; operationId: string; mutations: Mutation[] }
export interface MutationResult { epoch: string; cursor: number; records: SyncRecord[] }
export interface Connection {
  version: 1;
  url: string;
  token: string;
  device: { id: string; name: string; profile: string };
  previousBroker: { url?: Json; token?: Json };
  enrollmentPending?: true;
}
export interface Issue {
  kind: Kind;
  key: string;
  reason: "conflict" | "approval" | "invalid";
  message: string;
  local: Value;
  remote: Value;
}
export interface Decision { local: Value; remote: Value; side: "local" | "remote" }
export interface State {
  version: 1;
  deviceId: string;
  epoch: string | null;
  cursor: number;
  remote: Record<string, SyncRecord>;
  base: Record<string, Value>;
  pending?: MutationRequest;
  rejected?: Record<string, { local: Value; code: string }>;
  issues: Issue[];
  decisions: Record<string, Decision>;
  excluded: string[];
}
export interface LocalAdapter {
  /** Explicit global values only, never defaults/project/env/runtime layers. */
  read(): Promise<Record<string, RecordValue>>;
  /** Validate against installed OMP; dangerous incoming values require approval. */
  policy(record: RecordValue): "automatic" | "approval" | "excluded" | "invalid";
  /** Recheck the current explicit value equals expected before changing files. */
  apply(kind: Kind, key: string, value: Value, expected: Value): Promise<void>;
}
export interface Transport {
  snapshot(signal?: AbortSignal): Promise<Snapshot>;
  changes(epoch: string, cursor: number, signal?: AbortSignal): Promise<Changes>;
  mutate(request: MutationRequest, signal?: AbortSignal): Promise<MutationResult>;
}
export interface StateStore {
  load(): State;
  save(state: State): void;
  /** Non-blocking process lock; false means another OMP instance owns this cycle. */
  lock(): (() => void) | undefined;
}
export function identity(kind: string, key: string): string { return JSON.stringify([kind, key]); }
export function valueOf(record?: { deleted?: boolean; value?: Json }): Value {
  return !record || record.deleted ? { deleted: true } : { deleted: false, value: record.value! };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
export function emptyState(deviceId: string): State {
  return { version: 1, deviceId, epoch: null, cursor: 0, remote: {}, base: {}, issues: [], decisions: {}, excluded: [] };
}
export function validRecordKey(value: string): boolean {
  return !!value.trim() && value.length <= 256 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);
}
