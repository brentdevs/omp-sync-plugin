import type { Changes, Connection, Json, MutationRequest, MutationResult, Snapshot, SyncRecord, Transport } from "./types";
import { equal } from "./types";
import { UserError } from "./errors";
import { isDeviceToken, requireDeviceToken } from "./token";

const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_REQUEST = 1024 * 1024;
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Sync request failed (${code})`); this.name = "ApiError"; }
}
const invalid = (): never => { throw new ApiError(0, "invalid_response"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function json(value: unknown, depth = 0): Json {
  if (depth > 128) return invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  const source = object(value);
  const result: Record<string, Json> = Object.create(null);
  for (const key of Object.keys(source)) {
    result[key] = json(source[key], depth + 1);
  }
  return result;
}
function records(input: unknown, cursor: number): SyncRecord[] {
  if (!Array.isArray(input)) return invalid();
  const revisions = new Set<number>();
  return input.map(raw => {
    const item = object(raw);
    if (item.kind !== "setting" && item.kind !== "provider" && item.kind !== "secret") return invalid();
    if (typeof item.deleted !== "boolean") return invalid();
    const revision = integer(item.revision);
    if (!revision || revision > cursor || revisions.has(revision)) return invalid();
    revisions.add(revision);
    if (item.deleted ? Object.hasOwn(item, "value") : !Object.hasOwn(item, "value")) return invalid();
    const result: SyncRecord = { kind: item.kind, key: text(item.key, 256), revision, deleted: item.deleted, deviceId: text(item.deviceId), updatedAt: integer(item.updatedAt) };
    if (!item.deleted) {
      result.value = json(item.value);
      if (item.kind === "provider") object(result.value);
    }
    return result;
  });
}
export function normalizeServerUrl(input: string): string {
  try {
    const url = new URL(input);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || input.includes("?") || input.includes("#")) throw new Error();
    return url.origin;
  } catch { throw new UserError("Sync server must be an HTTPS origin (HTTP is allowed only on loopback)"); }
}
const errorCodes: Record<string, true> = { unauthorized: true, invalid_pairing: true, pairing_rate_limit: true, conflict: true, resync_required: true, invalid_cursor: true, invalid_request: true, operation_reused: true, body_too_large: true, body_unreadable: true, invalid_json: true, unsupported_media_type: true, browser_access_denied: true, method_not_allowed: true, broker_unavailable: true, device_not_found: true, not_found: true, internal_error: true, request_error: true, connection_limit: true };
async function request(url: string, token: string | undefined, path: string, body: unknown, signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<unknown> {
  let encoded: string | undefined;
  if (body !== undefined) {
    try { encoded = JSON.stringify(body); } catch { throw new ApiError(0, "invalid_request"); }
    if (encoded === undefined) throw new ApiError(0, "invalid_request");
    if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST) throw new ApiError(413, "body_too_large");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  let response: Response | undefined;
  try {
    response = await fetcher(url + path, { method: encoded === undefined ? "GET" : "POST", redirect: "manual", signal: controller.signal, headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(encoded === undefined ? {} : { "Content-Type": "application/json" }) }, ...(encoded === undefined ? {} : { body: encoded }) });
    if (response.status >= 300 && response.status < 400) throw new ApiError(response.status, "redirect_refused");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw new ApiError(response.status, "response_too_large");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_RESPONSE) throw new ApiError(response.status, "response_too_large");
          chunks.push(next.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (controller.signal.aborted) throw new ApiError(0, timedOut ? "timeout" : "cancelled");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ApiError(response.ok ? 0 : response.status, response.ok ? "invalid_response" : "http_error"); }
    if (!response.ok) {
      let code = "http_error";
      if (value && typeof value === "object" && "error" in value) {
        const error = value.error;
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && Object.hasOwn(errorCodes, error.code)) code = error.code;
      }
      throw new ApiError(response.status, code);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return invalid();
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(0, timedOut ? "timeout" : "cancelled");
    throw new ApiError(0, "network_error");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
export async function pairDevice(url: string, code: string, signal?: AbortSignal): Promise<Pick<Connection, "device" | "token">> {
  if (typeof code !== "string" || !code.trim() || code.length > 128 || !code.isWellFormed() || /[\u0000-\u001f\u007f]/.test(code)) throw new UserError("Enter a nonempty pairing code from the sync server (at most 128 characters, without control characters).");
  const input = object(await request(normalizeServerUrl(url), undefined, "/sync/v1/pair", { code }, signal, fetch));
  const device = object(input.device);
  const token = text(input.token, 256);
  if (!isDeviceToken(token)) return invalid();
  return { token, device: { id: text(device.id), name: text(device.name), profile: text(device.profile) } };
}
export class SyncClient implements Transport {
  private readonly url: string;
  constructor(url: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.url = normalizeServerUrl(url);
    requireDeviceToken(token);
  }
  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    const input = object(await request(this.url, this.token, "/sync/v1/snapshot", undefined, signal, this.fetcher));
    const cursor = integer(input.cursor);
    const result = { epoch: text(input.epoch), profile: text(input.profile), cursor, records: records(input.records, cursor) };
    const keys = new Set(result.records.map(record => JSON.stringify([record.kind, record.key])));
    if (keys.size !== result.records.length) return invalid();
    return result;
  }
  async changes(epoch: string, cursor: number, signal?: AbortSignal): Promise<Changes> {
    text(epoch); integer(cursor);
    const input = object(await request(this.url, this.token, `/sync/v1/changes?epoch=${encodeURIComponent(epoch)}&cursor=${cursor}`, undefined, signal, this.fetcher));
    const next = integer(input.cursor);
    if (input.epoch !== epoch || next < cursor || typeof input.hasMore !== "boolean") return invalid();
    const changes = records(input.changes, next);
    let previous = cursor;
    for (const record of changes) { if (record.revision <= previous) return invalid(); previous = record.revision; }
    if (previous !== next || (input.hasMore && !changes.length)) return invalid();
    return { epoch, cursor: next, hasMore: input.hasMore, changes };
  }
  async mutate(body: MutationRequest, signal?: AbortSignal): Promise<MutationResult> {
    const input = object(await request(this.url, this.token, "/sync/v1/mutations", body, signal, this.fetcher));
    const cursor = integer(input.cursor);
    if (input.epoch !== body.epoch) return invalid();
    const result = records(input.records, cursor);
    if (result.length !== body.mutations.length) return invalid();
    for (let index = 0; index < result.length; index++) {
      const record = result[index]!;
      const mutation = body.mutations[index]!;
      if (record.kind !== mutation.kind || record.key !== mutation.key || record.deleted !== (mutation.deleted === true) || record.revision <= mutation.expectedRevision || (!record.deleted && !equal(record.value, mutation.value))) return invalid();
    }
    return { epoch: text(input.epoch), cursor, records: result };
  }
}
