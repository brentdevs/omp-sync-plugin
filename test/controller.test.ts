import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { Server } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { captureBroker, configureBroker } from "../src/broker";
import { Controller } from "../src/controller";
import { DiskStore, loadConnection, saveConnection } from "../src/storage";
import { identity } from "../src/types";
import type { Connection, Json, SyncRecord } from "../src/types";

const roots: string[] = [], settingsList: Settings[] = [], controllers: Controller[] = [], servers: Server<undefined>[] = [];
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  await Promise.all(controllers.splice(0).map(controller => controller.stop()));
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const settings of settingsList.splice(0)) { await settings.flush(); settings.cancelPendingSaves(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setSystemTime();
});
function gate() { const value = Promise.withResolvers<void>(); gates.push(value.resolve); return value; }
function context() {
  const notices: { message: string; type?: string }[] = [], statuses: (string | undefined)[] = [];
  const waiting = gate(); let tick: (() => void) | undefined;
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    setStatus: (_key: string, status: string | undefined) => { statuses.push(status); if (status?.includes("waiting")) waiting.resolve(); },
    confirm: async (_title: string, _message: string) => true,
    input: async () => "one-use-code",
    select: async (_title: string, options: string[]) => options[0],
    editor: async (_title: string, value: string) => value,
  };
  const ctx = { ui, hasUI: true, agent: { kind: "main" }, modelRegistry: { refresh: async () => {}, getError: () => undefined }, setInterval: (callback: () => void) => { tick = callback; const timer = setInterval(() => {}, 60_000); timer.unref(); return timer; } } as unknown as ExtensionCommandContext;
  return { ctx, ui, notices, statuses, waiting, tick: () => tick?.() };
}
async function fixture(handler?: (request: Request) => Response | Promise<Response>) {
  const root = mkdtempSync(join(tmpdir(), "omp-controller-")); roots.push(root);
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const settings = await Settings.loadIsolated({ agentDir, cwd: root }); settingsList.push(settings);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler ?? (() => Response.json({ epoch: "epoch", profile: "personal", cursor: 0, records: [] })) }); servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const connection: Connection = { version: 1, url, token: `omps_${"A".repeat(43)}`, device: { id: "first", name: "First", profile: "personal" }, previousBroker: {} };
  const directory = join(agentDir, "sync");
  await configureBroker(settings, connection); saveConnection(directory, connection);
  const view = context(); const controller = new Controller(view.ctx, settings); controllers.push(controller);
  return { root, agentDir, settings, url, directory, connection, view, controller };
}
function response(records: SyncRecord[]) { return Response.json({ epoch: "epoch", profile: "personal", cursor: records.at(-1)?.revision ?? 0, records }); }
function changes(records: SyncRecord[]) { return Response.json({ epoch: "epoch", cursor: records.at(-1)?.revision ?? 0, hasMore: false, changes: [] }); }
const preference: SyncRecord = { kind: "setting", key: "hideThinkingBlock", value: true, deleted: false, revision: 1, updatedAt: 1, deviceId: "remote" };

test("disconnect is a barrier against independent controllers' in-flight synchronization", async () => {
  const entered = gate(), release = gate(); let snapshots = 0;
  const f = await fixture(async request => {
    if (new URL(request.url).pathname.endsWith("snapshot")) { snapshots++; entered.resolve(); await release.promise; return response([preference]); }
    return changes([preference]);
  });
  const otherSettings = await Settings.loadIsolated({ agentDir: f.agentDir, cwd: f.root }); settingsList.push(otherSettings);
  const otherView = context(), other = new Controller(otherView.ctx, otherSettings); controllers.push(other);
  const syncing = f.controller.run(); await entered.promise;
  const disconnecting = other.command("disconnect", otherView.ctx);
  await otherView.waiting.promise;
  expect(loadConnection(f.directory)?.device.id).toBe("first");
  release.resolve(); await syncing; await disconnecting;
  expect(loadConnection(f.directory)).toBeUndefined();
  const before = snapshots; await f.controller.run(); expect(snapshots).toBe(before);
  await f.settings.reloadFromDisk();
  expect(f.settings.getGlobalSettings().hideThinkingBlock).toBe(true);
  expect(captureBroker(f.settings)).toEqual({});
}, 10_000);

test("revoked periodic controller discovers replacement enrollment without a manual command", async () => {
  let token = `omps_${"B".repeat(43)}`;
  const f = await fixture(request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    return new URL(request.url).pathname.endsWith("snapshot") ? response([preference]) : changes([preference]);
  });
  await f.controller.run();
  f.controller.start();
  await f.controller.run();
  const replacement: Connection = { ...f.connection, token, device: { ...f.connection.device, id: "replacement" } };
  const control = new DiskStore(f.directory, "control");
  const lock = control.lock()!;
  await configureBroker(f.settings, replacement); saveConnection(f.directory, replacement); lock();
  setSystemTime(Date.now() + 3000);
  f.view.tick();
  // Wait on real asynchronous I/O, not a duration-based success assumption.
  const deadline = Date.now() + 5000;
  while (f.settings.getGlobalSettings().hideThinkingBlock !== true) { if (Date.now() > deadline) throw new Error("Replacement was not discovered"); await Bun.sleep(10); }
  expect(f.settings.getGlobalSettings().hideThinkingBlock).toBe(true);
}, 10_000);

test("failed broker persistence rolls back enrollment and leaves no durable half-pair", async () => {
  const f = await fixture(request => new URL(request.url).pathname.endsWith("pair") ? Response.json({ token: `omps_${"C".repeat(43)}`, device: { id: "failed-enrollment", name: "Device", profile: "personal" } }, { status: 201 }) : response([]));
  await f.controller.command("disconnect", f.view.ctx);
  const original = f.settings.flush.bind(f.settings); let fail = true;
  f.settings.flush = async () => { if (fail && captureBroker(f.settings).url === f.url) { fail = false; throw new Error("private-driver-secret"); } await original(); };
  await f.controller.command(`connect ${f.url}`, f.view.ctx);
  expect(loadConnection(f.directory)).toBeUndefined();
  expect(captureBroker(f.settings)).toEqual({});
  expect(f.view.notices.some(notice => notice.type === "error")).toBe(true);
  expect(f.view.notices.some(notice => notice.message.includes("private-driver-secret"))).toBe(false);
});

test("pause cancellation is not a sync failure and no polling starts during disconnect", async () => {
  const entered = gate(), release = gate();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return response([]); });
  const running = f.controller.run(); await entered.promise;
  const disconnect = f.controller.command("disconnect", f.view.ctx);
  await disconnect; release.resolve(); await running;
  expect(loadConnection(f.directory)).toBeUndefined();
  expect(f.view.notices.filter(notice => notice.type === "error")).toEqual([]);
  expect(f.view.statuses.filter(status => status?.includes("cancelled"))).toEqual([]);
});

test("large provider review requires the complete scrollable comparison before consent", async () => {
  const overrides: Record<string, Json> = {};
  for (let index = 0; index < 400; index++) overrides[`model-${index}`] = { contextWindow: 10000 };
  const local: Json = { modelOverrides: overrides, baseUrl: "https://local.invalid" };
  const remote: Json = { modelOverrides: overrides, baseUrl: "https://changed.invalid" };
  const record: SyncRecord = { ...preference, kind: "provider", key: "openai", value: remote };
  const f = await fixture(request => new URL(request.url).pathname.endsWith("snapshot") ? response([record]) : changes([record]));
  const file = join(f.agentDir, "models.yml"); writeFileSync(file, JSON.stringify({ providers: { openai: local } }));
  await f.controller.run();
  let comparison = ""; let confirmed = false;
  f.view.ui.editor = async (_title, text) => { comparison = text; return undefined as unknown as string; };
  f.view.ui.confirm = async () => { confirmed = true; return true; };
  await f.controller.command("review", f.view.ctx);
  expect(comparison).toContain("https://changed.invalid");
  expect(comparison).toContain("https://local.invalid");
  expect(confirmed).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8")).providers.openai.baseUrl).toBe("https://local.invalid");
  const store = new DiskStore(join(f.directory, "devices", createHash("sha256").update(f.connection.device.id).digest("hex")), f.connection.device.id);
  expect(store.load().decisions[identity("provider", "openai")]).toBeUndefined();
});

test("review retains its exact choice while waiting for another root lease", async () => {
  const record: SyncRecord = { ...preference, kind: "provider", key: "openai", value: { baseUrl: "https://remote.invalid" } };
  const f = await fixture(request => new URL(request.url).pathname.endsWith("snapshot") ? response([record]) : changes([record]));
  await f.controller.run();
  const other = new DiskStore(f.directory, "control"); let release: (() => void) | undefined;
  f.view.ui.confirm = async () => { release = other.lock(); if (release) gates.push(release); return true; };
  const reviewing = f.controller.command("review", f.view.ctx);
  await f.view.waiting.promise; release!(); await reviewing;
  expect(readFileSync(join(f.agentDir, "models.yml"), "utf8")).toContain("https://remote.invalid");
  expect(f.view.notices.filter(notice => notice.type === "error")).toEqual([]);
}, 10_000);

test("crash-staged enrollment is rolled back rather than treated as successfully paired", async () => {
  const f = await fixture();
  saveConnection(f.directory, { ...f.connection, enrollmentPending: true });
  await f.controller.run();
  expect(loadConnection(f.directory)).toBeUndefined();
  expect(captureBroker(f.settings)).toEqual({});
});

test("atomic remnants are removed only under the root or device writer lease", async () => {
  const f = await fixture(request => new URL(request.url).pathname.endsWith("snapshot") ? response([]) : changes([]));
  const orphan = join(f.directory, `.connection.json.${randomUUID()}.tmp`);
  writeFileSync(orphan, "synthetic-token", { mode: 0o600 });
  const untouched = join(f.directory, "editor.tmp"); writeFileSync(untouched, "user content");
  await f.controller.run();
  expect(() => readFileSync(orphan)).toThrow();
  expect(readFileSync(untouched, "utf8")).toBe("user content");
});

test("headless enrollment mutations fail explicitly instead of silently succeeding", async () => {
  const f = await fixture();
  const headless = { ...f.view.ctx, hasUI: false };
  for (const command of ["connect", "disconnect", "review", "migrate"]) {
    await expect(f.controller.command(command, headless)).rejects.toMatchObject({ name: "UserError" });
    expect(loadConnection(f.directory)?.device.id).toBe(f.connection.device.id);
  }
});
