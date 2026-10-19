import { Database } from "bun:sqlite";
import { closeSync, chmodSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyState, identity, type Connection, type State, type StateStore } from "./types";
import { normalizeServerUrl } from "./client";

function fail(): never { throw new Error("Invalid or incompatible sync data; refusing to overwrite it"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safeJson(value: unknown, depth = 0): void {
  if (depth > 64) fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) safeJson(child, depth + 1); return; }
  for (const [key, child] of Object.entries(object(value))) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") fail();
    safeJson(child, depth + 1);
  }
}
function value(input: unknown): void {
  const item = object(input);
  if (typeof item.deleted !== "boolean" || (item.deleted ? Object.hasOwn(item, "value") : !Object.hasOwn(item, "value"))) fail();
  if (!item.deleted) safeJson(item.value);
}
function record(input: unknown): Record<string, unknown> {
  const item = object(input);
  if ((item.kind !== "setting" && item.kind !== "provider" && item.kind !== "secret") || !text(item.key) || !integer(item.revision) || item.revision === 0 || !text(item.deviceId) || !integer(item.updatedAt)) fail();
  value(item);
  if (item.kind === "provider" && !item.deleted) object(item.value);
  return item;
}
function state(input: unknown, deviceId: string): State {
  const item = object(input);
  safeJson(item);
  if (item.version !== 1 || item.deviceId !== deviceId || !(item.epoch === null || text(item.epoch)) || !integer(item.cursor)) fail();
  for (const [key, raw] of Object.entries(object(item.remote))) {
    const entry = record(raw);
    // Acknowledged own writes may be ahead of the durably consumed feed cursor.
    if (key !== identity(String(entry.kind), String(entry.key))) fail();
  }
  for (const raw of Object.values(object(item.base))) value(raw);
  if (!Array.isArray(item.issues) || !Array.isArray(item.excluded) || !item.excluded.every(text)) fail();
  for (const raw of item.issues) {
    const issue = object(raw);
    if ((issue.kind !== "setting" && issue.kind !== "provider") || typeof issue.key !== "string" || (issue.reason !== "invalid" && !text(issue.key)) || !["conflict", "approval", "invalid"].includes(String(issue.reason)) || typeof issue.message !== "string") fail();
    value(issue.local); value(issue.remote);
  }
  for (const raw of Object.values(object(item.decisions))) {
    const decision = object(raw);
    if (decision.side !== "local" && decision.side !== "remote") fail();
    value(decision.local); value(decision.remote);
  }
  if (item.pending !== undefined) {
    const pending = object(item.pending);
    if (!text(pending.epoch) || !text(pending.operationId) || !Array.isArray(pending.mutations) || !pending.mutations.length || pending.mutations.length > 100) fail();
    const keys = new Set<string>();
    for (const raw of pending.mutations) {
      const mutation = object(raw);
      if ((mutation.kind !== "setting" && mutation.kind !== "provider") || !text(mutation.key) || !integer(mutation.expectedRevision)) fail();
      const key = identity(mutation.kind, mutation.key);
      if (keys.has(key)) fail();
      keys.add(key);
      value({ ...mutation, deleted: mutation.deleted ?? false });
    }
  }
  // All persisted fields are checked above before exposing the shared state shape.
  return item as unknown as State;
}
function connection(input: unknown): Connection {
  const item = object(input);
  safeJson(item);
  const device = object(item.device);
  const previous = object(item.previousBroker);
  if (item.version !== 1 || typeof item.url !== "string" || !text(item.token) || !/^[\x21-\x7e]+$/.test(item.token) || item.token.length > 256 || !text(device.id) || !text(device.name) || !text(device.profile) || Object.keys(previous).some(key => key !== "url" && key !== "token")) fail();
  if (normalizeServerUrl(item.url) !== item.url) fail();
  // Connection fields and JSON broker restoration data are validated before use.
  return item as unknown as Connection;
}
function directory(path: string): string {
  const full = resolve(path);
  mkdirSync(full, { recursive: true, mode: 0o700 });
  const info = lstatSync(full);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Sync directory must be a private directory");
  chmodSync(full, 0o700);
  return full;
}
function regular(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Sync data must be a private regular file");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
function read(path: string): unknown | undefined {
  if (!regular(path)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    chmodSync(path, 0o600);
    const bytes = readFileSync(fd);
    if (bytes.byteLength > 64 * 1024 * 1024) fail();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail(); }
  } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  // Windows does not permit opening directories for fsync; file fsync and atomic rename still apply.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomic(dir: string, name: string, value: unknown): void {
  const target = join(dir, name);
  regular(target);
  const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    regular(target);
    renameSync(temporary, target);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function loadConnection(path: string): Connection | undefined {
  const raw = read(join(directory(path), "connection.json"));
  return raw === undefined ? undefined : connection(raw);
}
export function saveConnection(path: string, input: Connection): void { atomic(directory(path), "connection.json", connection(JSON.parse(JSON.stringify(input)))); }
export function removeConnection(path: string): void {
  const dir = directory(path);
  const target = join(dir, "connection.json");
  if (regular(target)) { unlinkSync(target); syncDirectory(dir); }
}
export class DiskStore implements StateStore {
  private readonly directory: string;
  constructor(path: string, private readonly deviceId: string) {
    if (!text(deviceId)) fail();
    this.directory = directory(path);
  }
  load(): State {
    const raw = read(join(this.directory, "state.json"));
    return raw === undefined ? emptyState(this.deviceId) : state(raw, this.deviceId);
  }
  save(input: State): void { atomic(this.directory, "state.json", state(JSON.parse(JSON.stringify(input)), this.deviceId)); }
  lock(): (() => void) | undefined {
    const path = join(this.directory, "lock.sqlite");
    if (!regular(path)) {
      try { const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); closeSync(fd); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; regular(path); }
    }
    chmodSync(path, 0o600);
    let db: Database | undefined;
    try {
      db = new Database(path);
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
    } catch (error) {
      db?.close();
      if (error && typeof error === "object" && "code" in error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")) return undefined;
      throw new Error("Could not acquire sync process lock");
    }
    const held = db;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { held.exec("ROLLBACK"); } finally { held.close(); }
    };
  }
}
