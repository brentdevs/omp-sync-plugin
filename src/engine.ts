import { randomUUID } from "node:crypto";
import {
  equal, identity, validRecordKey, valueOf,
  type Decision, type Issue, type Kind, type LocalAdapter, type Mutation, type MutationRequest,
  type RecordValue, type State, type StateStore, type SyncRecord, type Transport, type Value,
} from "./types";

const MAX_BODY_BYTES = 1024 * 1024;

type Upload = { mutation: Mutation; local: Value; remote: Value };
type Apply = { kind: Kind; key: string; value: Value; expected: Value };
type Plan = { uploads: Upload[]; applies: Apply[] };

function terminal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { status?: unknown; code?: unknown };
  return failure.status === 409 && (failure.code === "conflict" || failure.code === "resync_required");
}

function recordIdentity(id: string): { kind: Kind; key: string } | undefined {
  try {
    const pair: unknown = JSON.parse(id);
    if (Array.isArray(pair) && pair.length === 2 && (pair[0] === "setting" || pair[0] === "provider") && typeof pair[1] === "string") {
      return { kind: pair[0], key: pair[1] };
    }
  } catch { /* An unrecognized persisted identity is not a syncable record. */ }
  return undefined;
}

/** Reconciliation is serialized across processes, including uncertain mutation retries. */
export class SyncEngine {
  constructor(private readonly transport: Transport, private readonly store: StateStore, private readonly local: LocalAdapter) {}

  async sync(signal?: AbortSignal): Promise<State | undefined> {
    const release = this.store.lock();
    if (!release) return undefined;
    try {
      signal?.throwIfAborted();
      const state = this.store.load();
      let refreshSnapshot = false;
      let mayPublish = true;
      // Never fetch or rebuild a pending operation before learning its outcome.
      if (state.pending && !await this.sendPending(state, signal)) {
        refreshSnapshot = true;
        mayPublish = false;
      }
      await this.refresh(state, refreshSnapshot, signal);
      const plan = await this.reconcile(state, signal);
      if (mayPublish) {
        const batches = this.batches(state, plan.uploads);
        this.store.save(state);
        for (const request of batches) {
          signal?.throwIfAborted();
          state.pending = request;
          this.store.save(state);
          if (!await this.sendPending(state, signal)) {
            // A failed compare-and-swap is not permission to overwrite the winner.
            await this.refresh(state, true, signal);
            await this.reconcile(state, signal);
            break;
          }
        }
      }
      return state;
    } finally {
      release();
    }
  }

  async decide(id: string, side: "local" | "remote", reviewed: Pick<Issue, "local" | "remote">): Promise<void> {
    const release = this.store.lock();
    if (!release) throw new Error("Another sync operation is running");
    try {
      const state = this.store.load();
      const issue = state.issues.find(item => identity(item.kind, item.key) === id);
      if (!issue) throw new Error("No unresolved issue exists for that record");
      if (!reviewed || !equal(issue.local, reviewed.local) || !equal(issue.remote, reviewed.remote)) {
        throw new Error("Configuration changed while it was being reviewed; review it again");
      }
      state.decisions[id] = structuredClone({ local: issue.local, remote: issue.remote, side } satisfies Decision);
      this.store.save(state);
    } finally {
      release();
    }
  }

  exclude(kind: Kind, key: string, excluded: boolean): void {
    const release = this.store.lock();
    if (!release) throw new Error("Another sync operation is running");
    try {
      const state = this.store.load();
      const id = identity(kind, key);
      const exclusions = new Set(state.excluded);
      if (exclusions.has(id) === excluded) return;
      if (state.pending?.mutations.some(item => identity(item.kind, item.key) === id)) {
        throw new Error("Settle the pending sync operation before changing this exclusion");
      }
      if (excluded) exclusions.add(id);
      else exclusions.delete(id);
      state.excluded = [...exclusions];
      delete state.decisions[id];
      state.issues = state.issues.filter(item => identity(item.kind, item.key) !== id);
      this.store.save(state);
    } finally {
      release();
    }
  }

  private async sendPending(state: State, signal?: AbortSignal): Promise<boolean> {
    const request = state.pending!;
    let result;
    try {
      signal?.throwIfAborted();
      result = await this.transport.mutate(request, signal);
    } catch (error) {
      if (!terminal(error)) throw error;
      delete state.pending;
      this.store.save(state);
      return false;
    }
    const acknowledged = new Map(result.records.map(record => [identity(record.kind, record.key), record]));
    // A malformed success is uncertain, too: retain the original operation for retry.
    if (result.epoch !== request.epoch || request.mutations.some(item => {
      const record = acknowledged.get(identity(item.kind, item.key));
      return !record || record.revision <= item.expectedRevision || !equal(valueOf(record), valueOf(item));
    })) throw new Error("The sync server returned an inconsistent mutation acknowledgment");
    for (const item of request.mutations) {
      const id = identity(item.kind, item.key);
      const record = acknowledged.get(id)!;
      state.base[id] = valueOf(record);
      if (state.epoch === result.epoch) this.cache(state, record);
      delete state.decisions[id];
    }
    // The response cursor can include unrelated writes that we have not consumed.
    delete state.pending;
    this.store.save(state);
    return true;
  }

  private cache(state: State, record: SyncRecord): void {
    if (record.kind === "secret") return;
    const id = identity(record.kind, record.key);
    if (!state.remote[id] || state.remote[id]!.revision < record.revision) state.remote[id] = record;
  }

  private async refresh(state: State, snapshot: boolean, signal?: AbortSignal): Promise<void> {
    if (snapshot || state.epoch === null) await this.snapshot(state, signal);
    for (;;) {
      signal?.throwIfAborted();
      let page;
      try {
        page = await this.transport.changes(state.epoch!, state.cursor, signal);
      } catch (error) {
        if (!terminal(error)) throw error;
        await this.snapshot(state, signal);
        continue;
      }
      if (page.epoch !== state.epoch) {
        await this.snapshot(state, signal);
        continue;
      }
      if (page.cursor < state.cursor || (page.hasMore && page.cursor === state.cursor)) {
        throw new Error("The sync server returned a non-advancing change cursor");
      }
      for (const record of page.changes) this.cache(state, record);
      state.cursor = page.cursor;
      this.store.save(state);
      if (!page.hasMore) return;
    }
  }

  private async snapshot(state: State, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const snapshot = await this.transport.snapshot(signal);
    state.epoch = snapshot.epoch;
    state.cursor = snapshot.cursor;
    state.remote = {};
    for (const record of snapshot.records) this.cache(state, record);
    // Base values survive epoch changes, including records missing from the snapshot.
    this.store.save(state);
  }

  private async reconcile(state: State, signal?: AbortSignal): Promise<Plan> {
    signal?.throwIfAborted();
    const values = await this.local.read();
    const locals: Record<string, RecordValue> = {};
    for (const record of Object.values(values)) {
      if (record.kind === "setting" || record.kind === "provider") locals[identity(record.kind, record.key)] = structuredClone(record);
    }
    const ids = new Set([...Object.keys(state.base), ...Object.keys(state.remote), ...Object.keys(locals)]);
    const excluded = new Set(state.excluded);
    const issues: Issue[] = [];
    const plan: Plan = { uploads: [], applies: [] };
    for (const id of ids) {
      const name = recordIdentity(id);
      if (!name) continue;
      const { kind, key } = name;
      const local = valueOf(locals[id]);
      const cached = state.remote[id];
      const remote = valueOf(cached);
      let decision: Decision | undefined = state.decisions[id];
      if (decision && (!equal(decision.local, local) || !equal(decision.remote, remote))) {
        delete state.decisions[id];
        decision = undefined;
      }
      const policies = [locals[id], remote.deleted ? undefined : { kind, key, value: remote.value }]
        .filter((record): record is RecordValue => record !== undefined)
        .map(record => this.local.policy(record));
      if (excluded.has(id) || policies.includes("excluded")) {
        delete state.decisions[id];
        continue;
      }
      const issue = (reason: Issue["reason"], message: string): void => {
        issues.push({ kind, key, reason, message, local, remote });
      };
      if (!validRecordKey(key)) {
        delete state.decisions[id];
        issue("invalid", "This key cannot be represented by the sync protocol");
        continue;
      }
      if (policies.includes("invalid")) {
        delete state.decisions[id];
        issue("invalid", "This record is not valid for the installed OMP configuration");
        continue;
      }
      if (equal(local, remote)) {
        state.base[id] = remote;
        delete state.decisions[id];
        continue;
      }
      const upload = (): void => {
        const expectedRevision = cached?.revision ?? 0;
        const mutation: Mutation = local.deleted ? { kind, key, expectedRevision, deleted: true }
          : { kind, key, expectedRevision, deleted: false, value: local.value };
        plan.uploads.push({ mutation, local, remote });
      };
      const incoming = (): void => {
        if (policies.includes("approval") && decision?.side !== "remote") {
          issue("approval", "This incoming configuration change requires explicit approval");
        } else {
          plan.applies.push({ kind, key, value: remote, expected: local });
        }
      };
      if (decision) {
        if (decision.side === "local") upload();
        else incoming();
      } else if (!Object.hasOwn(state.base, id)) {
        if (remote.deleted && !cached) upload();
        else if (local.deleted && !remote.deleted) incoming();
        else issue("conflict", "Local and remote configuration differ without a shared baseline");
      } else {
        const base = state.base[id]!;
        if (equal(local, base)) incoming();
        else if (equal(remote, base)) upload();
        else issue("conflict", "Local and remote configuration both changed");
      }
    }
    state.issues = issues;
    for (const id of Object.keys(state.decisions)) if (!ids.has(id)) delete state.decisions[id];
    this.store.save(state);
    for (const apply of plan.applies) {
      signal?.throwIfAborted();
      // The adapter compares against this observation, not a freshly read value.
      await this.local.apply(apply.kind, apply.key, apply.value, apply.expected);
      const id = identity(apply.kind, apply.key);
      state.base[id] = apply.value;
      delete state.decisions[id];
      this.store.save(state);
    }
    return plan;
  }

  private batches(state: State, uploads: Upload[]): MutationRequest[] {
    const batches: MutationRequest[] = [];
    let request: MutationRequest = { epoch: state.epoch!, operationId: randomUUID(), mutations: [] };
    let bytes = Buffer.byteLength(JSON.stringify(request));
    for (const upload of uploads) {
      const size = Buffer.byteLength(JSON.stringify(upload.mutation));
      const emptyBytes = Buffer.byteLength(JSON.stringify({ ...request, mutations: [] }));
      if (emptyBytes + size > MAX_BODY_BYTES) {
        state.issues.push({ kind: upload.mutation.kind, key: upload.mutation.key, reason: "invalid",
          message: "This record exceeds the sync server's one MiB request limit", local: upload.local, remote: upload.remote });
        delete state.decisions[identity(upload.mutation.kind, upload.mutation.key)];
        continue;
      }
      if (request.mutations.length === 100 || bytes + size + (request.mutations.length ? 1 : 0) > MAX_BODY_BYTES) {
        batches.push(request);
        request = { epoch: state.epoch!, operationId: randomUUID(), mutations: [] };
        bytes = Buffer.byteLength(JSON.stringify(request));
      }
      bytes += size + (request.mutations.length ? 1 : 0);
      request.mutations.push(upload.mutation);
    }
    if (request.mutations.length) batches.push(request);
    return batches;
  }
}
