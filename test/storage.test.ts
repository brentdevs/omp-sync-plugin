import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiskStore, loadConnection, removeConnection, saveConnection } from "../src/storage";
import { emptyState, identity, type Connection } from "../src/types";
import { UserError } from "../src/errors";

const directories: string[] = [];
function temporary(): string { const dir = mkdtempSync(join(tmpdir(), "omp-sync-storage-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const connection: Connection = { version: 1, url: "https://sync.example.com", token: `omps_${"a".repeat(43)}`, device: { id: "device", name: "Laptop", profile: "default" }, previousBroker: { url: "https://previous.example.com", token: "previous-token" } };

describe("DiskStore durable boundary", () => {
  test("persists isolated snapshots across restart with private permissions", () => {
    const dir = temporary();
    const store = new DiskStore(dir, "device");
    expect(store.load()).toEqual(emptyState("device"));
    const state = emptyState("device");
    state.epoch = "epoch"; state.cursor = 1;
    state.remote[identity("setting", "theme")] = { kind: "setting", key: "theme", revision: 1, deleted: false, value: "dark", deviceId: "device", updatedAt: 1 };
    state.base[identity("setting", "theme")] = { deleted: false, value: "dark" };
    state.pending = { epoch: "epoch", operationId: "immutable-operation", mutations: [{ kind: "setting", key: "other", expectedRevision: 0, value: false }] };
    store.save(state);
    saveConnection(dir, connection);
    const restarted = new DiskStore(dir, "device");
    expect(restarted.load()).toEqual(state);
    expect(loadConnection(dir)).toEqual(connection);
    const snapshot = restarted.load(); snapshot.cursor = 99;
    expect(restarted.load().cursor).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of ["state.json", "connection.json"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    removeConnection(dir); removeConnection(dir);
    expect(loadConnection(dir)).toBeUndefined();
    expect(restarted.load()).toEqual(state);
  });
  test("refuses newer, malformed and mismatched state rather than resetting", () => {
    const dir = temporary(); const store = new DiskStore(dir, "device");
    for (const raw of [JSON.stringify({ ...emptyState("device"), version: 2 }), JSON.stringify(emptyState("other-device")), "{invalid", JSON.stringify({ ...emptyState("device"), cursor: -1 }), JSON.stringify({ ...emptyState("device"), decisions: [] })]) {
      writeFileSync(join(dir, "state.json"), raw, { mode: 0o600 });
      expect(() => store.load()).toThrow();
      expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(raw);
    }
  });
  test("refuses symlinked persisted files without modifying their targets", () => {
    if (process.platform === "win32") return;
    const dir = temporary(); const target = join(temporary(), "untouched");
    writeFileSync(target, "do not modify");
    symlinkSync(target, join(dir, "state.json"));
    const store = new DiskStore(dir, "device");
    expect(() => store.load()).toThrow();
    expect(() => store.save(emptyState("device"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("do not modify");
  });
  test("holds a nonblocking lease across instances and releases idempotently", () => {
    const dir = temporary(); const first = new DiskStore(dir, "device"); const second = new DiskStore(dir, "device");
    const release = first.lock(); expect(release).toBeDefined();
    try {
      expect(first.lock()).toBeUndefined(); expect(second.lock()).toBeUndefined();
      if (process.platform !== "win32") expect(statSync(join(dir, "lock.sqlite")).mode & 0o777).toBe(0o600);
    } finally { release?.(); }
    const next = second.lock(); expect(next).toBeDefined();
    release?.();
    try { expect(first.lock()).toBeUndefined(); } finally { next?.(); }
  });
  test("never steals a live child lock and recovers automatically after process death", async () => {
    const dir = temporary();
    const modulePath = fileURLToPath(new URL("../src/storage.ts", import.meta.url));
    const source = `import { DiskStore } from ${JSON.stringify(modulePath)}; const release = new DiskStore(${JSON.stringify(dir)}, "device").lock(); if (!release) process.exit(2); console.log("locked"); await Bun.stdin.stream().getReader().read();`;
    const child = Bun.spawn([process.execPath, "--eval", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      try {
        const result = await reader.read();
        expect(new TextDecoder().decode(result.value)).toContain("locked");
      } finally { reader.releaseLock(); }
      const store = new DiskStore(dir, "device");
      expect(store.lock()).toBeUndefined();
      expect(store.lock()).toBeUndefined();
      child.kill("SIGKILL"); await child.exited;
      const release = store.lock(); expect(release).toBeDefined();
      try { expect(new DiskStore(dir, "device").lock()).toBeUndefined(); }
      finally { release?.(); }
      const recovered = new DiskStore(dir, "device").lock(); expect(recovered).toBeDefined(); recovered?.();
    } finally { child.kill(); await child.exited; }
  }, 10_000);
  test("persists inert reserved keys in remote values and sanitized diagnostics", () => {
    const store = new DiskStore(temporary(), "device");
    const state = emptyState("device");
    const raw = JSON.parse('{"__proto__":{"polluted":true},"constructor":{},"prototype":1}');
    state.remote[identity("setting", "theme")] = { kind: "setting", key: "theme", revision: 1, deleted: false, value: raw, deviceId: "other", updatedAt: 1 };
    state.issues = [{ kind: "setting", key: "theme", reason: "invalid", message: "Invalid remote value", local: { deleted: false, value: "[invalid sync value]" }, remote: { deleted: false, value: raw } }];
    store.save(state);
    expect(store.load()).toEqual(state);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test("oversized save and decision preserve the previous readable snapshot", () => {
    const store = new DiskStore(temporary(), "device");
    const before = emptyState("device"); store.save(before);
    const oversized = emptyState("device");
    const huge = { deleted: false as const, value: "x".repeat(64 * 1024 * 1024) };
    oversized.base[identity("setting", "large")] = huge;
    expect(() => store.save(oversized)).toThrow(UserError);
    expect(store.load()).toEqual(before);
    const decision = emptyState("device");
    decision.decisions[identity("setting", "large")] = { side: "local", local: huge, remote: { deleted: true } };
    expect(() => store.save(decision)).toThrow(UserError);
    expect(store.load()).toEqual(before);
  }, 20_000); // Two real 64 MiB serializations need headroom on shared Intel macOS runners.
  test("rejects oversized sparse corrupt files before parsing and leaves them intact", () => {
    const dir = temporary(); const path = join(dir, "state.json");
    const fd = openSync(path, "w", 0o600);
    try { ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { closeSync(fd); }
    expect(() => new DiskStore(dir, "device").load()).toThrow();
    expect(statSync(path).size).toBe(64 * 1024 * 1024 + 1);
  });
  test("rejects malformed persisted device tokens on save and load", () => {
    const dir = temporary();
    for (const token of ["plain", `omps_${"a".repeat(42)}`, `omps_${"!".repeat(43)}`]) {
      expect(() => saveConnection(dir, { ...connection, token })).toThrow();
      writeFileSync(join(dir, "connection.json"), JSON.stringify({ ...connection, token }));
      expect(() => loadConnection(dir)).toThrow();
    }
  });
  test("validates durable rejected-write suppression and syncable base values", () => {
    const store = new DiskStore(temporary(), "device");
    const state = emptyState("device");
    state.rejected = { [identity("setting", "theme")]: { local: { deleted: false, value: "dark" }, code: "invalid_request" } };
    store.save(state);
    expect(store.load()).toEqual(state);
    state.rejected[identity("setting", "theme")]!.code = "upstream secret\n";
    expect(() => store.save(state)).toThrow();
    const unsafe = emptyState("device");
    unsafe.base[identity("setting", "theme")] = { deleted: false, value: JSON.parse('{"__proto__":{}}') };
    expect(() => store.save(unsafe)).toThrow();
  });
  test("preserves enrollment recovery marker and rejects other marker values", () => {
    const dir = temporary();
    const pending = { ...connection, enrollmentPending: true as const };
    saveConnection(dir, pending);
    expect(loadConnection(dir)).toEqual(pending);
    for (const enrollmentPending of [false, "true", 1, null]) {
      writeFileSync(join(dir, "connection.json"), JSON.stringify({ ...connection, enrollmentPending }));
      expect(() => loadConnection(dir)).toThrow();
    }
  });
});
