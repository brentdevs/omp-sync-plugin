import { createHash } from "node:crypto";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ApiError, normalizeServerUrl, pairDevice, SyncClient } from "./client";
import { brokerMatches, brokerOverridesPresent, captureBroker, configureBroker, migrateCredentials, restoreBroker, upgradeBrokerToken } from "./broker";
import { SyncEngine } from "./engine";
import { UserError } from "./errors";
import { sweepAtomicTemps } from "./maintenance";
import { OmpAdapter } from "./omp-adapter";
import { reviewPreview } from "./review";
import { DiskStore, loadConnection, removeConnection, saveConnection } from "./storage";
import { equal, identity } from "./types";
import type { Connection, Issue, State } from "./types";

export const COMMANDS = ["connect", "status", "now", "review", "exclude", "include", "migrate", "disconnect"];
export function safeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  return error instanceof ApiError ? `${error.status || "network"}: ${error.code}` : "Unexpected local I/O or network failure; private state was retained";
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try { await promise; } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export class Controller {
  readonly directory: string;
  private readonly control: DiskStore;
  private abort = new AbortController();
  private active?: Promise<State | undefined>;
  private connection?: Connection;
  private engine?: SyncEngine;
  private store?: DiskStore;
  private timer?: Timer;
  private stopped = false;
  private suspended = false;
  private commanding = false;
  private nextAttempt = 0;
  private failures = 0;
  private revoked = false;
  private lastError?: string;
  constructor(private readonly ctx: ExtensionContext, readonly settings: Settings = Settings.instance) {
    this.directory = join(settings.getAgentDir(), "sync");
    this.control = new DiskStore(this.directory, "control");
  }
  start(): void {
    void this.run();
    this.timer = this.ctx.setInterval(() => { if (!this.stopped && !this.suspended && Date.now() >= this.nextAttempt) void this.run(); }, 2000);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort(); clearInterval(this.timer);
    await this.active;
    this.ctx.ui.setStatus("omp-sync", undefined);
  }
  private stateDirectory(connection: Connection): string {
    return join(this.directory, "devices", createHash("sha256").update(connection.device.id).digest("hex"));
  }
  private stateStore(connection: Connection): DiskStore { return new DiskStore(this.stateDirectory(connection), connection.device.id); }
  private select(connection: Connection): SyncEngine {
    if (!equal(this.connection, connection)) {
      this.connection = connection;
      this.store = this.stateStore(connection);
      this.engine = new SyncEngine(new SyncClient(connection.url, connection.token), this.store, new OmpAdapter(this.settings, this.ctx.modelRegistry));
      this.revoked = false;
    }
    return this.engine!;
  }
  /** Lock order is ALWAYS root -> device. Enrollment and sync cannot overlap across processes. */
  private async leased<T>(work: () => Promise<T>, wait: boolean): Promise<T | undefined> {
    const signal = this.abort.signal;
    const deadline = Date.now() + 60_000;
    let release = this.control.lock();
    if (!release && wait) this.ctx.ui.setStatus("omp-sync", "Sync: waiting for another OMP instance");
    while (!release && wait) {
      if (Date.now() >= deadline) throw new UserError("Another OMP instance is busy; no choice was applied. Try again when its sync finishes");
      await delay(25, signal); release = this.control.lock();
    }
    if (!release) return;
    try { signal.throwIfAborted(); sweepAtomicTemps(this.directory); return await work(); }
    finally { release(); }
  }
  private requireEnrollment(expected?: Connection): Connection {
    const current = loadConnection(this.directory);
    if (!current) throw new UserError("Not paired; use /sync connect");
    if (current.enrollmentPending) throw new UserError("Enrollment was interrupted; disconnect it before pairing again");
    if (expected && !equal(current, expected)) throw new UserError("Enrollment changed during review; no choice was applied. Review it again");
    return current;
  }
  async run(): Promise<State | undefined> {
    if (this.active) return this.active;
    if (this.stopped || this.suspended) return;
    const signal = this.abort.signal;
    this.active = (async () => {
      try {
        const result = await this.leased(async () => {
          let connection = loadConnection(this.directory);
          if (connection?.enrollmentPending) {
            await this.settings.reloadFromDisk();
            await restoreBroker(this.settings, connection);
            removeConnection(this.directory);
            this.ctx.ui.notify(`Interrupted enrollment for device ${connection.device.id} was rolled back. Revoke that device on the server before pairing again.`, "warning");
            connection = undefined;
          }
          if (!connection) {
            this.connection = undefined; this.engine = undefined; this.store = undefined;
            this.revoked = false; this.lastError = undefined; this.failures = 0;
            this.nextAttempt = Date.now() + 30_000;
            this.ctx.ui.setStatus("omp-sync", "Sync: unpaired · /sync connect");
            return;
          }
          const engine = this.select(connection);
          // Even a revoked controller keeps discovering changes to local enrollment.
          this.nextAttempt = Date.now() + 2000;
          if (this.revoked) return;
          await this.settings.reloadFromDisk();
          await upgradeBrokerToken(this.settings, connection);
          const cleanup = this.store!.lock();
          if (cleanup) { try { sweepAtomicTemps(this.stateDirectory(connection)); } finally { cleanup(); } }
          const state = await engine.sync(signal);
          signal.throwIfAborted();
          this.failures = 0; this.lastError = undefined;
          const brokerWarning = brokerMatches(this.settings, connection) ? "" : " · broker config differs";
          this.ctx.ui.setStatus("omp-sync", state ? `Sync: ${state.issues.length ? `${state.issues.length} need review` : "connected"}${brokerWarning}` : "Sync: another OMP instance is syncing");
          return state;
        }, false);
        return result;
      } catch (error) {
        if (this.stopped || signal.aborted) return;
        this.revoked = error instanceof ApiError && error.status === 401;
        this.lastError = safeError(error);
        this.nextAttempt = this.revoked ? Date.now() + 2000 : Date.now() + Math.min(30_000, 2000 * 2 ** Math.min(++this.failures, 4));
        this.ctx.ui.setStatus("omp-sync", this.revoked ? "Sync: revoked · disconnect and pair again" : `Sync: offline/error · ${this.lastError}`);
      }
    })();
    try { return await this.active; } finally { this.active = undefined; }
  }
  private async paused(work: () => Promise<void>): Promise<void> {
    this.suspended = true;
    this.abort.abort(); await this.active;
    this.abort = new AbortController();
    try { if (!this.stopped) await work(); }
    finally { this.suspended = false; this.nextAttempt = 0; }
  }
  private notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void { ctx.ui.notify(message, type); }
  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (this.commanding) { this.notify(ctx, "Another sync command is active; finish it first.", "warning"); return; }
    this.commanding = true;
    const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    try {
      if (["connect", "disconnect", "review", "migrate"].includes(command) && !ctx.hasUI) throw new UserError(`${command} requires interactive OMP; no changes were made`);
      if (command === "connect") {
        await this.paused(async () => { await this.leased(async () => {
          if (loadConnection(this.directory)) throw new UserError("Already paired or enrollment interrupted; disconnect before pairing again");
          if (brokerOverridesPresent()) throw new UserError("Unset OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN before connecting");
          const input = rest[0] ?? await ctx.ui.input("Sync server HTTPS origin", "https://sync.example.com");
          if (!input) return;
          const url = normalizeServerUrl(input);
          if (!await ctx.ui.confirm("Trust this sync server?", `${url}\nEnrolled devices share its broker vault. Settings/provider definitions can contain secrets. Existing logins require explicit migration. Continue?`)) return;
          const code = await ctx.ui.input("Single-use pairing code", "Generate with the server's pair command");
          if (code === undefined) return;
          const paired = await pairDevice(url, code, this.abort.signal);
          await this.settings.flush(); await this.settings.reloadFromDisk();
          const connection: Connection = { version: 1, url, ...paired, previousBroker: captureBroker(this.settings) };
          try {
            saveConnection(this.directory, { ...connection, enrollmentPending: true });
            await configureBroker(this.settings, connection);
            saveConnection(this.directory, connection);
          } catch (error) {
            let recoveryFailed = false;
            try { await restoreBroker(this.settings, connection); } catch { recoveryFailed = true; }
            try { removeConnection(this.directory); } catch { recoveryFailed = true; }
            if (recoveryFailed) throw new UserError(`Local enrollment could not be restored; reset auth.broker.url/token and fix sync directory permissions. Server device ${paired.device.id} must be revoked before retrying`);
            throw new UserError(`Pairing was rolled back: ${safeError(error)}. Revoke server device ${paired.device.id} and generate a new code`);
          }
          this.select(connection); this.lastError = undefined; this.failures = 0;
          this.notify(ctx, "Paired. OMP uses the server's auth broker. /sync migrate explicitly uploads existing logins; provider/environment key overrides retain normal precedence.");
        }, true); });
        await this.run();
      } else if (command === "disconnect") {
        if (!await ctx.ui.confirm("Disconnect sync?", "Wait for in-flight sync on every OMP process, then stop sync and restore previous broker settings if unchanged. Keep settings/providers and private history. This does not revoke the server token.")) return;
        await this.paused(async () => { await this.leased(async () => {
          const connection = loadConnection(this.directory);
          if (connection) {
            await this.settings.flush(); await this.settings.reloadFromDisk();
            const restored = await restoreBroker(this.settings, connection);
            removeConnection(this.directory);
            this.notify(ctx, restored ? "Disconnected; previous broker settings restored." : "Disconnected; independently edited broker settings were left unchanged.", restored ? "info" : "warning");
          }
          this.connection = undefined; this.engine = undefined; this.store = undefined;
          this.revoked = false; this.lastError = undefined; this.failures = 0;
        }, true); });
        await this.run();
      } else if (command === "status") {
        const connection = loadConnection(this.directory);
        if (!connection) { this.notify(ctx, "Not paired. Use /sync connect."); return; }
        const state = this.stateStore(connection).load();
        this.notify(ctx, `${connection.url}\nDevice: ${connection.device.name} · ID: ${connection.device.id} · profile: ${connection.device.profile}\nCached cursor: ${state.cursor}; ${state.issues.length} need review; ${state.pending ? "one uncertain write queued" : "no uncertain write"}; ${state.excluded.length} exclusions.${connection.enrollmentPending ? "\nEnrollment interrupted; disconnect before re-pairing." : ""}${this.lastError ? `\nLast error: ${this.lastError}` : ""}${this.revoked ? "\nDevice token revoked." : ""}\n${brokerMatches(this.settings, connection) ? "Broker settings match enrollment." : "Broker settings/overrides differ."}`);
      } else if (command === "now") {
        const state = await this.run();
        this.notify(ctx, state ? `Sync complete; ${state.issues.length} need review.` : this.lastError ? `Sync did not complete: ${this.lastError}` : "Not paired, revoked, or another OMP instance is syncing.", state ? "info" : "warning");
      } else if (command === "review") {
        await this.paused(async () => {
          let connection: Connection | undefined;
          let issues: Issue[] = [];
          await this.leased(async () => { connection = this.requireEnrollment(); issues = this.stateStore(connection).load().issues; }, true);
          if (!issues.length) { this.notify(ctx, "No conflicts or approvals pending."); return; }
          const labels = issues.map((issue, index) => `${index + 1}. ${issue.kind}: ${JSON.stringify(issue.key).slice(0, 160)} (${issue.reason})`);
          const selected = await ctx.ui.select("Review synchronized changes", labels);
          const issue = selected === undefined ? undefined : issues[labels.indexOf(selected)];
          if (!issue) return;
          this.notify(ctx, issue.message, "warning");
          const choices = issue.reason === "invalid" ? ["Exclude this record"] : ["Use server value", "Publish this device's value", "Exclude this record"];
          const choice = await ctx.ui.select(`${issue.kind}: ${JSON.stringify(issue.key)}`, choices);
          if (!choice) return;
          if (choice !== "Exclude this record") {
            const preview = reviewPreview(issue);
            if (preview.length > 6000) {
              const reviewed = await ctx.ui.editor("Full redacted comparison — submit unchanged to continue; Esc cancels", preview);
              if (reviewed !== preview) throw new UserError("Review was cancelled or edited; no choice was applied");
            }
            const explanation = `${choice}. Publishing sends the local value (including deletion) to the server and every device on this profile. Provider changes can redirect credentials. Secret fields have fingerprints; approval expires if values change.`;
            if (!await ctx.ui.confirm("Apply this exact choice?", preview.length > 6000 ? explanation : `${issue.kind}: ${issue.key}\n${preview}\n${explanation}`)) return;
          }
          await this.leased(async () => {
            const current = this.requireEnrollment(connection);
            const engine = this.select(current);
            if (choice === "Exclude this record") engine.exclude(issue.kind, issue.key, true);
            else await engine.decide(identity(issue.kind, issue.key), choice === "Use server value" ? "remote" : "local", issue);
          }, true);
        });
        await this.run();
      } else if (command === "exclude" || command === "include") {
        const [kind, ...keyParts] = rest;
        if ((kind !== "setting" && kind !== "provider") || !keyParts.length) throw new UserError("Usage: /sync exclude|include setting|provider KEY");
        await this.paused(async () => { await this.leased(async () => { this.select(this.requireEnrollment()).exclude(kind, keyParts.join(" "), command === "exclude"); }, true); });
        await this.run();
      } else if (command === "migrate") {
        await this.paused(async () => { await this.leased(async () => {
          const connection = this.requireEnrollment();
          await this.settings.reloadFromDisk();
          if (!brokerMatches(this.settings, connection)) throw new UserError("Broker settings differ; remove overrides or reconnect before migration");
          if (!await ctx.ui.confirm("Upload existing local credentials?", `Upload stored API keys to ${connection.url}? Local copies remain. Existing broker accounts are preserved.`)) return;
          const oauth = await ctx.ui.confirm("Include local OAuth accounts?", "Upload refresh tokens? Stop independently refreshing old copies after migration. No migrates API keys only.");
          const environment = await ctx.ui.confirm("Include environment API keys?", "Upload environment provider keys? No keeps them device-local.");
          await this.settings.flush(); await this.settings.reloadFromDisk();
          this.requireEnrollment(connection);
          if (!brokerMatches(this.settings, connection)) throw new UserError("Broker configuration changed during consent; review it again");
          const success = await migrateCredentials(connection, oauth, environment, this.abort.signal);
          this.notify(ctx, success ? "Credential migration completed; broker snapshots propagate available credentials." : "Migration did not fully complete; run auth-broker migrate --from-local --dry-run through your OMP launcher (including nix run). Credential output was not displayed.", success ? "info" : "error");
        }, true); });
        await this.run();
      } else this.notify(ctx, `Usage: /sync ${COMMANDS.join(" | ")}`, "warning");
    } catch (error) {
      const message = `Sync command failed: ${safeError(error)}`;
      if (!ctx.hasUI) throw new UserError(message);
      this.notify(ctx, message, "error");
    }
    finally { this.commanding = false; }
  }
}
