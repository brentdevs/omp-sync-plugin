import { describe, expect, test } from "bun:test";
import { SyncEngine } from "../src/engine";
import {
  emptyState, equal, identity, valueOf,
  type Changes, type Json, type Kind, type LocalAdapter, type MutationRequest, type MutationResult,
  type RecordValue, type Snapshot, type State, type StateStore, type SyncRecord, type Transport, type Value,
} from "../src/types";

const clone = <T>(value: T): T => structuredClone(value);
const id = (key: string, kind: Kind = "setting"): string => identity(kind, key);
const present = (value: Json): Value => ({ deleted: false, value });
function apiError(code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(code), { status: 409, code });
}

type Policy = "automatic" | "approval" | "excluded" | "invalid";

class MemoryStore implements StateStore {
  state: State;
  held = false;
  failSave = false;
  constructor(device: string) { this.state = emptyState(device); }
  load(): State { return clone(this.state); }
  save(state: State): void {
    if (this.failSave) {
      this.failSave = false;
      throw new Error("disk unavailable");
    }
    this.state = clone(state);
  }
  lock(): (() => void) | undefined {
    if (this.held) return undefined;
    this.held = true;
    return () => { this.held = false; };
  }
}

class MemoryLocal implements LocalAdapter {
  records: Record<string, RecordValue> = {};
  modes: Record<string, Policy> = {};
  beforeApply?: () => void;
  afterApply?: () => void;
  applications = 0;
  set(key: string, value: Json, kind: Kind = "setting"): void { this.records[id(key, kind)] = { kind, key, value: clone(value) }; }
  delete(key: string, kind: Kind = "setting"): void { delete this.records[id(key, kind)]; }
  value(key: string, kind: Kind = "setting"): Value { return clone(valueOf(this.records[id(key, kind)])); }
  async read(): Promise<Record<string, RecordValue>> { return clone(this.records); }
  policy(record: RecordValue): Policy { return this.modes[id(record.key, record.kind)] ?? "automatic"; }
  async apply(kind: Kind, key: string, value: Value, expected: Value): Promise<void> {
    const hook = this.beforeApply;
    this.beforeApply = undefined;
    hook?.();
    if (!equal(this.value(key, kind), expected)) throw new Error("local changed");
    if (value.deleted) this.delete(key, kind);
    else this.set(key, value.value, kind);
    this.applications++;
    this.afterApply?.();
  }
}

/** An in-memory revisioned server, including atomic CAS and operation deduplication. */
class MemoryServer {
  epoch = "epoch-one";
  revision = 0;
  pageSize = 2;
  records: Record<string, SyncRecord> = {};
  log: SyncRecord[] = [];
  operations = new Map<string, { request: MutationRequest; result: MutationResult }>();
  put(key: string, value: Value, kind: SyncRecord["kind"] = "setting", deviceId = "other-device"): SyncRecord {
    const record: SyncRecord = { kind, key, revision: ++this.revision, deleted: value.deleted,
      ...(!value.deleted ? { value: clone(value.value) } : {}), deviceId, updatedAt: this.revision };
    this.records[identity(kind, key)] = record;
    this.log.push(record);
    return clone(record);
  }
  value(key: string, kind: Kind = "setting"): Value { return clone(valueOf(this.records[id(key, kind)])); }
  snapshot(): Snapshot { return clone({ epoch: this.epoch, profile: "default", cursor: this.revision, records: Object.values(this.records) }); }
  changes(epoch: string, cursor: number): Changes {
    if (epoch !== this.epoch || cursor > this.revision) throw apiError("resync_required");
    const remaining = this.log.filter(record => record.revision > cursor);
    const changes = remaining.slice(0, this.pageSize);
    return clone({ epoch: this.epoch, cursor: changes.at(-1)?.revision ?? cursor, hasMore: remaining.length > changes.length, changes });
  }
  mutate(device: string, request: MutationRequest): MutationResult {
    if (request.epoch !== this.epoch) throw apiError("resync_required");
    const operation = `${device}/${request.operationId}`;
    const previous = this.operations.get(operation);
    if (previous) {
      if (!equal(previous.request, request)) throw apiError("operation_reused");
      return clone(previous.result);
    }
    if (request.mutations.some(item => (this.records[identity(item.kind, item.key)]?.revision ?? 0) !== item.expectedRevision)) {
      throw apiError("conflict");
    }
    const records = request.mutations.map(item => this.put(item.key, valueOf(item), item.kind, device));
    const result = { epoch: this.epoch, cursor: this.revision, records };
    this.operations.set(operation, { request: clone(request), result: clone(result) });
    return clone(result);
  }
  restore(records: { key: string; value: Value }[]): void {
    this.epoch = "epoch-restored";
    this.revision = 0;
    this.records = {};
    this.log = [];
    this.operations.clear();
    for (const record of records) this.put(record.key, record.value);
  }
}

class MemoryTransport implements Transport {
  requests: MutationRequest[] = [];
  offline = false;
  loseNextReply = false;
  beforeMutate?: () => void;
  constructor(readonly server: MemoryServer, readonly device: string) {}
  async snapshot(): Promise<Snapshot> { this.online(); return this.server.snapshot(); }
  async changes(epoch: string, cursor: number): Promise<Changes> { this.online(); return this.server.changes(epoch, cursor); }
  async mutate(request: MutationRequest): Promise<MutationResult> {
    this.requests.push(clone(request));
    this.online();
    const hook = this.beforeMutate;
    this.beforeMutate = undefined;
    hook?.();
    const result = this.server.mutate(this.device, request);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new Error("response lost after commit");
    }
    return result;
  }
  private online(): void { if (this.offline) throw new Error("offline"); }
}

function device(server: MemoryServer, name: string) {
  const store = new MemoryStore(name);
  const local = new MemoryLocal();
  const transport = new MemoryTransport(server, name);
  const engine = new SyncEngine(transport, store, local);
  return { store, local, transport, engine };
}

async function paired() {
  const server = new MemoryServer();
  const first = device(server, "first");
  const second = device(server, "second");
  first.local.set("theme", "base");
  await first.engine.sync();
  await second.engine.sync();
  return { server, first, second };
}

describe("SyncEngine", () => {
  test("the first device seeds explicit values and the second receives settings and providers", async () => {
    const server = new MemoryServer();
    const first = device(server, "first");
    first.local.set("theme", "dark");
    first.local.set("portable", { baseUrl: "https://provider.example/v1", models: ["model"] }, "provider");
    await first.engine.sync();
    const second = device(server, "second");
    await second.engine.sync();
    expect(second.local.value("theme")).toEqual(present("dark"));
    expect(second.local.value("portable", "provider")).toEqual(first.local.value("portable", "provider"));
    expect(second.store.state.issues).toEqual([]);
    expect(server.operations.size).toBe(1);
    await second.engine.sync();
    expect(server.operations.size).toBe(1);
  });

  test("deletions propagate as tombstones and a stale new device cannot resurrect them", async () => {
    const { server, first, second } = await paired();
    first.local.delete("theme");
    await first.engine.sync();
    await second.engine.sync();
    expect(second.local.value("theme")).toEqual({ deleted: true });
    expect(server.records[id("theme")]?.deleted).toBe(true);
    await second.engine.sync();
    expect(server.value("theme")).toEqual({ deleted: true });
    const stale = device(server, "stale");
    stale.local.set("theme", "base");
    await stale.engine.sync();
    expect(stale.store.state.issues.map(issue => issue.reason)).toEqual(["conflict"]);
    expect(stale.local.value("theme")).toEqual(present("base"));
    expect(server.value("theme")).toEqual({ deleted: true });
  });

  test("divergent edits require a bound decision instead of last-writer-wins", async () => {
    const { server, first, second } = await paired();
    first.local.set("theme", "first-edit");
    second.local.set("theme", "second-edit");
    await first.engine.sync();
    await second.engine.sync();
    expect(second.store.state.issues.map(issue => issue.reason)).toEqual(["conflict"]);
    expect(second.local.value("theme")).toEqual(present("second-edit"));
    expect(server.value("theme")).toEqual(present("first-edit"));
    await second.engine.decide(id("theme"), "local", second.store.load().issues[0]!);
    await second.engine.sync();
    await first.engine.sync();
    expect(first.local.value("theme")).toEqual(present("second-edit"));
    expect(server.value("theme")).toEqual(present("second-edit"));
    expect(second.store.state.issues).toEqual([]);
    first.local.set("theme", "identical-concurrent-edit");
    second.local.set("theme", "identical-concurrent-edit");
    await first.engine.sync();
    const committed = server.operations.size;
    await second.engine.sync();
    expect(second.store.state.issues).toEqual([]);
    expect(server.operations.size).toBe(committed);
    expect(second.store.state.base[id("theme")]).toEqual(present("identical-concurrent-edit"));
  });

  test("a remote race after an offline mutation preserves both edits and the common base", async () => {
    const { server, first, second } = await paired();
    second.local.set("theme", "offline-edit");
    // Go offline after the feed was read, so the operation is durably pending.
    second.transport.beforeMutate = () => { throw new Error("offline during post"); };
    await expect(second.engine.sync()).rejects.toThrow("offline during post");
    const pending = clone(second.store.state.pending!);
    first.local.set("theme", "remote-edit");
    await first.engine.sync();
    await second.engine.sync();
    expect(second.transport.requests.at(-1)).toEqual(pending);
    expect(second.store.state.pending).toBeUndefined();
    expect(second.store.state.base[id("theme")]).toEqual(present("base"));
    expect(second.store.state.issues[0]).toMatchObject({ reason: "conflict", local: present("offline-edit"), remote: present("remote-edit") });
    expect(second.local.value("theme")).toEqual(present("offline-edit"));
    expect(server.value("theme")).toEqual(present("remote-edit"));
    expect(second.store.held).toBe(false);
  });

  test("an uncertain successful write retries exactly the same operation before publishing a newer edit", async () => {
    const server = new MemoryServer();
    const first = device(server, "first");
    first.local.set("theme", "committed-before-disconnect");
    first.transport.loseNextReply = true;
    await expect(first.engine.sync()).rejects.toThrow("response lost");
    const pending = clone(first.store.state.pending!);
    expect(server.value("theme")).toEqual(present("committed-before-disconnect"));
    first.local.set("theme", "new-local-edit");
    const restarted = new SyncEngine(first.transport, first.store, first.local);
    await restarted.sync();
    expect(first.transport.requests[0]).toEqual(pending);
    expect(first.transport.requests[1]).toEqual(pending);
    expect(first.transport.requests[2]?.operationId).not.toBe(pending.operationId);
    expect(server.operations.size).toBe(2);
    expect(server.value("theme")).toEqual(present("new-local-edit"));
    expect(first.store.state.base[id("theme")]).toEqual(present("new-local-edit"));
    expect(first.store.state.pending).toBeUndefined();
  });

  test("an epoch restore retains the baseline and conflicts with a missing restored record", async () => {
    const { server, second } = await paired();
    second.local.set("theme", "offline-edit");
    server.restore([]);
    await second.engine.sync();
    expect(second.store.state.epoch).toBe("epoch-restored");
    expect(second.store.state.remote[id("theme")]).toBeUndefined();
    expect(second.store.state.base[id("theme")]).toEqual(present("base"));
    expect(second.store.state.issues[0]).toMatchObject({ reason: "conflict", local: present("offline-edit"), remote: { deleted: true } });
    await second.engine.decide(id("theme"), "remote", second.store.load().issues[0]!);
    await second.engine.sync();
    expect(second.local.value("theme")).toEqual({ deleted: true });
    expect(second.store.state.issues).toEqual([]);
  });

  test("an epoch change settles an old pending operation before fetching the new snapshot", async () => {
    const { server, second } = await paired();
    second.local.set("theme", "offline-edit");
    second.transport.beforeMutate = () => { throw new Error("disconnected"); };
    await expect(second.engine.sync()).rejects.toThrow("disconnected");
    const pending = clone(second.store.state.pending!);
    server.restore([{ key: "theme", value: present("restored-edit") }]);
    await second.engine.sync();
    expect(second.transport.requests.at(-1)).toEqual(pending);
    expect(second.store.state.pending).toBeUndefined();
    expect(second.store.state.issues[0]).toMatchObject({ reason: "conflict", remote: present("restored-edit") });
    expect(second.store.state.base[id("theme")]).toEqual(present("base"));
  });

  test("a mutation response cursor never skips unrelated concurrent writes and every feed page drains", async () => {
    const server = new MemoryServer();
    server.pageSize = 1;
    const first = device(server, "first");
    first.local.set("theme", "local");
    first.transport.beforeMutate = () => {
      server.put("unrelated-one", present("remote-one"));
      server.put("unrelated-two", present("remote-two"));
    };
    await first.engine.sync();
    expect(first.store.state.cursor).toBe(0);
    expect(server.revision).toBe(3);
    await first.engine.sync();
    expect(first.local.value("unrelated-one")).toEqual(present("remote-one"));
    expect(first.local.value("unrelated-two")).toEqual(present("remote-two"));
    expect(first.local.value("theme")).toEqual(present("local"));
    expect(first.store.state.cursor).toBe(3);
    expect(first.store.state.remote[id("theme")]?.revision).toBe(3);
  });

  test("incoming approval is checkpointed, bound to both exact values, and never required for outgoing values", async () => {
    const server = new MemoryServer();
    server.put("command", present("command-a"));
    const first = device(server, "first");
    first.local.modes[id("command")] = "approval";
    await first.engine.sync();
    expect(first.local.value("command")).toEqual({ deleted: true });
    expect(first.store.state.cursor).toBe(server.revision);
    expect(first.store.state.issues[0]?.reason).toBe("approval");
    await first.engine.decide(id("command"), "remote", first.store.load().issues[0]!);
    server.put("command", present("command-b"));
    await first.engine.sync();
    expect(first.local.value("command")).toEqual({ deleted: true });
    expect(first.store.state.decisions[id("command")]).toBeUndefined();
    expect(first.store.state.issues[0]).toMatchObject({ reason: "approval", remote: present("command-b") });
    await first.engine.decide(id("command"), "remote", first.store.load().issues[0]!);
    first.local.set("command", "changed-after-approval");
    await first.engine.sync();
    expect(first.local.value("command")).toEqual(present("changed-after-approval"));
    expect(first.store.state.decisions[id("command")]).toBeUndefined();
    await first.engine.decide(id("command"), "remote", first.store.load().issues[0]!);
    await first.engine.sync();
    expect(first.local.value("command")).toEqual(present("command-b"));
    expect(first.store.state.issues).toEqual([]);
    // A local-only edit of an approval-classified key is safe to publish.
    first.local.set("command", "outgoing-command");
    await first.engine.sync();
    expect(server.value("command")).toEqual(present("outgoing-command"));
    expect(first.store.state.issues).toEqual([]);
  });

  test("a local edit during a POST is retained while the baseline records what actually committed", async () => {
    const server = new MemoryServer();
    const first = device(server, "first");
    first.local.set("theme", "observed");
    first.transport.beforeMutate = () => first.local.set("theme", "edited-during-post");
    await first.engine.sync();
    expect(server.value("theme")).toEqual(present("observed"));
    expect(first.store.state.base[id("theme")]).toEqual(present("observed"));
    expect(first.local.value("theme")).toEqual(present("edited-during-post"));
    await first.engine.sync();
    expect(server.value("theme")).toEqual(present("edited-during-post"));
  });

  test("a compare-before-apply failure retains the baseline and the checkpointed remote value", async () => {
    const { server, first, second } = await paired();
    first.local.set("theme", "remote-edit");
    await first.engine.sync();
    second.local.beforeApply = () => second.local.set("theme", "racing-local-edit");
    await expect(second.engine.sync()).rejects.toThrow("local changed");
    expect(second.store.state.base[id("theme")]).toEqual(present("base"));
    expect(second.store.state.cursor).toBe(server.revision);
    expect(valueOf(second.store.state.remote[id("theme")])).toEqual(present("remote-edit"));
    await second.engine.sync();
    expect(second.local.value("theme")).toEqual(present("racing-local-edit"));
    expect(second.store.state.issues[0]?.reason).toBe("conflict");
  });

  test("a crash after applying but before saving converges by adopting equal local and remote values", async () => {
    const { first, second } = await paired();
    first.local.set("theme", "remote-edit");
    await first.engine.sync();
    second.local.afterApply = () => { second.store.failSave = true; };
    await expect(second.engine.sync()).rejects.toThrow("disk unavailable");
    second.local.afterApply = undefined;
    expect(second.local.value("theme")).toEqual(present("remote-edit"));
    expect(second.store.state.base[id("theme")]).toEqual(present("base"));
    await second.engine.sync();
    expect(second.store.state.base[id("theme")]).toEqual(present("remote-edit"));
    expect(second.store.state.issues).toEqual([]);
    expect(second.local.applications).toBe(2); // Initial receive and one remote update, not a replayed apply.
  });

  test("secrets and exclusions never materialize or upload, and invalid records cannot be approved", async () => {
    const server = new MemoryServer();
    server.put("auth", present({ token: "never-cache" }), "secret");
    server.put("machine", present("remote-machine"));
    server.put("invalid", present("invalid-schema"));
    const first = device(server, "first");
    first.local.set("machine", "local-machine");
    first.local.set("user-excluded", "local-only");
    first.local.modes[id("machine")] = "excluded";
    first.local.modes[id("invalid")] = "invalid";
    first.engine.exclude("setting", "user-excluded", true);
    await first.engine.sync();
    expect(first.store.state.remote[identity("secret", "auth")]).toBeUndefined();
    expect(first.local.value("machine")).toEqual(present("local-machine"));
    expect(server.value("machine")).toEqual(present("remote-machine"));
    expect(server.value("user-excluded")).toEqual({ deleted: true });
    expect(first.local.value("user-excluded")).toEqual(present("local-only"));
    expect(first.store.state.issues.map(issue => issue.reason)).toEqual(["invalid"]);
    await first.engine.decide(id("invalid"), "remote", first.store.load().issues[0]!);
    await first.engine.sync();
    expect(first.local.value("invalid")).toEqual({ deleted: true });
    expect(first.store.state.issues[0]?.reason).toBe("invalid");
    first.engine.exclude("setting", "user-excluded", false);
    await first.engine.sync();
    expect(server.value("user-excluded")).toEqual(present("local-only"));
  });

  test("mutation batches obey count and UTF-8 byte limits and oversized individual values become issues", async () => {
    const server = new MemoryServer();
    const first = device(server, "first");
    for (let index = 0; index < 105; index++) first.local.set(`small-${index}`, index);
    for (let index = 0; index < 3; index++) first.local.set(`large-${index}`, "é".repeat(200_000));
    first.local.set("too-large", "é".repeat(530_000));
    await first.engine.sync();
    expect(Object.keys(server.records)).toHaveLength(108);
    expect(first.transport.requests.length).toBeGreaterThan(2);
    for (const request of first.transport.requests) {
      expect(request.mutations.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(first.store.state.pending).toBeUndefined();
    expect(first.store.state.issues).toHaveLength(1);
    expect(first.store.state.issues[0]).toMatchObject({ key: "too-large", reason: "invalid" });
    expect(first.local.value("too-large")).toEqual(present("é".repeat(530_000)));
  });

  test("approval cannot authorize new values while the review dialog is open", async () => {
    const server = new MemoryServer();
    server.put("command", present("reviewed-value"));
    const first = device(server, "first");
    first.local.modes[id("command")] = "approval";
    await first.engine.sync();
    const displayed = first.store.load().issues[0]!;
    server.put("command", present("unseen-replacement"));
    await first.engine.sync();
    await expect(first.engine.decide(id("command"), "remote", displayed)).rejects.toThrow("changed");
    await first.engine.sync();
    expect(first.local.value("command")).toEqual({ deleted: true });
    expect(first.store.state.issues[0]?.remote).toEqual(present("unseen-replacement"));
  });

  test("unsupported local identifiers cannot poison the durable pending queue", async () => {
    const server = new MemoryServer();
    const first = device(server, "first");
    const invalid = ["a".repeat(257), "bad\u0000key", " ", "\ud800"];
    for (const key of invalid) first.local.set(key, { baseUrl: "https://example.invalid" }, "provider");
    first.local.set("valid", "keep-syncing");
    await first.engine.sync();
    expect(first.store.state.pending).toBeUndefined();
    expect(first.store.state.issues.map(issue => issue.reason)).toEqual(invalid.map(() => "invalid"));
    for (const key of invalid) expect(server.value(key, "provider")).toEqual({ deleted: true });
    expect(server.value("valid")).toEqual(present("keep-syncing"));
  });

  test("locks are nonblocking and released on errors, with decisions rejected when no issue exists", async () => {
    const server = new MemoryServer();
    const first = device(server, "first");
    const release = first.store.lock()!;
    expect(await first.engine.sync()).toBeUndefined();
    await expect(first.engine.decide(id("theme"), "remote", { local: present("base"), remote: present("remote") })).rejects.toThrow("running");
    expect(() => first.engine.exclude("setting", "theme", true)).toThrow("running");
    release();
    await expect(first.engine.decide(id("theme"), "remote", { local: present("base"), remote: present("remote") })).rejects.toThrow("No unresolved issue");
    expect(first.store.held).toBe(false);
    first.transport.offline = true;
    await expect(first.engine.sync()).rejects.toThrow("offline");
    expect(first.store.held).toBe(false);
  });
});
