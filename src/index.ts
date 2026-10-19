import { createHash } from "node:crypto";
import { join } from "node:path";
import { Settings, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ApiError, normalizeServerUrl, pairDevice, SyncClient } from "./client";
import { brokerMatches, brokerOverridesPresent, captureBroker, configureBroker, migrateCredentials, restoreBroker } from "./broker";
import { SyncEngine } from "./engine";
import { OmpAdapter } from "./omp-adapter";
import { DiskStore, loadConnection, removeConnection, saveConnection } from "./storage";
import { equal, identity, type Connection, type Issue, type State } from "./types";

const COMMANDS = ["connect", "status", "now", "review", "exclude", "include", "migrate", "disconnect"];
function preview(issue: Issue): string {
  return JSON.stringify({ local: issue.local, server: issue.remote }, (key, value) => /key|token|secret|password|headers|authorization|cookie/i.test(key) ? "[redacted]" : value, 2).slice(0, 6000);
}
function safeError(error: unknown): string {
  return error instanceof ApiError ? `${error.status || "network"}: ${error.code}` : "local configuration or storage error (no data discarded)";
}

class Controller {
  readonly settings = Settings.instance;
  readonly directory = join(this.settings.getAgentDir(), "sync");
  private readonly control = new DiskStore(this.directory, "control");
  private abort = new AbortController();
  private active?: Promise<State | undefined>;
  private connection?: Connection;
  private engine?: SyncEngine;
  private store?: DiskStore;
  private stopped = false;
  private nextAttempt = 0;
  private failures = 0;
  private revoked = false;
  private lastError?: string;
  constructor(private readonly ctx: ExtensionContext) {}
  start(): void {
    void this.run();
    this.ctx.setInterval(() => { if (!this.stopped && !this.revoked && Date.now() >= this.nextAttempt) void this.run(); }, 2000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.active;
    this.ctx.ui.setStatus("omp-sync", undefined);
  }
  private selectConnection(): Connection | undefined {
    const connection = loadConnection(this.directory);
    if (!connection) { this.connection = undefined; this.engine = undefined; this.store = undefined; return; }
    if (connection.device.id !== this.connection?.device.id || connection.url !== this.connection.url || connection.token !== this.connection.token) {
      this.connection = connection;
      this.store = new DiskStore(join(this.directory, "devices", createHash("sha256").update(connection.device.id).digest("hex")), connection.device.id);
      this.engine = new SyncEngine(new SyncClient(connection.url, connection.token), this.store, new OmpAdapter(this.settings, this.ctx.modelRegistry));
      this.revoked = false;
    }
    return connection;
  }
  async run(): Promise<State | undefined> {
    if (this.active) return this.active;
    if (this.stopped) return;
    this.active = (async () => {
      try {
        if (!this.selectConnection()) { this.ctx.ui.setStatus("omp-sync", "Sync: unpaired · /sync connect"); return; }
        if (this.revoked) return;
        const state = await this.engine!.sync(this.abort.signal);
        this.failures = 0; this.lastError = undefined; this.nextAttempt = Date.now() + 2000;
        const brokerWarning = brokerMatches(this.settings, this.connection!) ? "" : " · broker config differs";
        this.ctx.ui.setStatus("omp-sync", state ? `Sync: ${state.issues.length ? `${state.issues.length} need review` : "connected"}${brokerWarning}` : "Sync: another OMP instance is syncing");
        return state;
      } catch (error) {
        if (this.stopped) return;
        this.revoked = error instanceof ApiError && error.status === 401;
        this.lastError = safeError(error);
        this.nextAttempt = Date.now() + Math.min(30_000, 2000 * 2 ** Math.min(++this.failures, 4));
        this.ctx.ui.setStatus("omp-sync", this.revoked ? "Sync: revoked · disconnect and pair again" : `Sync: offline/error · ${this.lastError}`);
      }
    })();
    try { return await this.active; } finally { this.active = undefined; }
  }
  private async pause(): Promise<void> {
    this.abort.abort();
    await this.active;
    this.abort = new AbortController();
  }
  private notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void { ctx.ui.notify(message, type); }
  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    try {
      if (command === "connect") {
        if (!ctx.hasUI) { this.notify(ctx, "Connect requires interactive OMP.", "error"); return; }
        await this.pause();
        const release = this.control.lock();
        if (!release) { this.notify(ctx, "Another OMP instance is changing enrollment; try again.", "warning"); return; }
        try {
          if (loadConnection(this.directory)) { this.notify(ctx, "Already paired. Disconnect before enrolling another device/server.", "warning"); return; }
          if (brokerOverridesPresent()) { this.notify(ctx, "Unset OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN before connecting.", "error"); return; }
          const input = rest[0] ?? await ctx.ui.input("Sync server HTTPS origin", "https://sync.example.com");
          if (!input) return;
          const url = normalizeServerUrl(input);
          if (!await ctx.ui.confirm("Trust this sync server?", `${url}\nEnrolled devices share its broker vault. Settings/provider definitions are stored on this server; some can contain secrets. Existing login credentials are not uploaded without migration. Continue?`)) return;
          const code = await ctx.ui.input("Single-use pairing code", "Generate with the server's pair command");
          if (!code) return;
          const paired = await pairDevice(url, code.trim(), this.abort.signal);
          const connection: Connection = { version: 1, url, ...paired, previousBroker: captureBroker(this.settings) };
          saveConnection(this.directory, connection);
          await configureBroker(this.settings, connection);
          this.revoked = false;
          this.selectConnection();
          this.notify(ctx, "Paired. OMP will use the server's auth broker. Use /sync migrate to explicitly upload existing local logins; provider/config key overrides retain OMP's normal precedence.");
        } finally { release(); }
        await this.run();
      } else if (command === "disconnect") {
        if (!ctx.hasUI || !await ctx.ui.confirm("Disconnect sync?", "Stop this device's synchronization and restore its previous broker configuration if unchanged. Keep current settings/providers and private merge history. This does not revoke the server-side device token.")) return;
        await this.pause();
        const release = this.control.lock();
        if (!release) { this.notify(ctx, "Enrollment is busy; try again.", "warning"); return; }
        try {
          const connection = loadConnection(this.directory);
          if (connection) {
            const restored = await restoreBroker(this.settings, connection);
            removeConnection(this.directory);
            this.notify(ctx, restored ? "Disconnected; previous broker settings restored." : "Disconnected; independently edited broker settings were left unchanged.", restored ? "info" : "warning");
          }
          this.connection = undefined; this.engine = undefined; this.store = undefined; this.revoked = false;
        } finally { release(); }
        await this.run();
      } else if (command === "status") {
        const connection = this.selectConnection();
        if (!connection) { this.notify(ctx, "Not paired. Use /sync connect."); return; }
        const state = this.store!.load();
        this.notify(ctx, `${connection.url}\nDevice: ${connection.device.name} · profile: ${connection.device.profile}\nCached cursor: ${state.cursor}; ${state.issues.length} need review; ${state.pending ? "one uncertain write queued" : "no uncertain write"}; ${state.excluded.length} exclusions.${this.lastError ? `\nLast error: ${this.lastError}` : ""}${this.revoked ? "\nDevice token revoked." : ""}\n${brokerMatches(this.settings, connection) ? "Broker settings match enrollment." : "Broker settings/overrides differ; sync does not overwrite them automatically."}`);
      } else if (command === "now") {
        const state = await this.run();
        this.notify(ctx, state ? `Sync complete; ${state.issues.length} need review.` : this.lastError ? `Sync did not complete: ${this.lastError}` : "Not paired, revoked, or another OMP instance is syncing.", state ? "info" : "warning");
      } else if (command === "review") {
        if (!ctx.hasUI || !this.selectConnection()) return;
        await this.active;
        const issues = this.store!.load().issues;
        if (!issues.length) { this.notify(ctx, "No conflicts or approvals pending."); return; }
        const labels = issues.map((issue, index) => `${index + 1}. ${issue.kind}: ${JSON.stringify(issue.key).slice(0, 160)} (${issue.reason})`);
        const selected = await ctx.ui.select("Review synchronized changes", labels);
        const issue = selected === undefined ? undefined : issues[labels.indexOf(selected)];
        if (!issue) return;
        if (issue.reason === "invalid") { this.notify(ctx, "This record fails local validation. Fix its source or exclude it; invalid values cannot be approved.", "warning"); return; }
        const choice = await ctx.ui.select(`${issue.kind}: ${issue.key}`, ["Use server value", "Keep this device's value", "Exclude this record"]);
        if (!choice) return;
        if (choice === "Exclude this record") this.engine!.exclude(issue.kind, issue.key, true);
        else {
          if (!await ctx.ui.confirm("Apply this exact choice?", `${issue.kind}: ${issue.key}\n${preview(issue)}\n${choice}. Provider changes can redirect credentials; some settings change security behavior. Secret-like fields are redacted. If the values change, this approval expires.`)) return;
          await this.engine!.decide(identity(issue.kind, issue.key), choice === "Use server value" ? "remote" : "local", issue);
        }
        await this.run();
      } else if (command === "exclude" || command === "include") {
        if (!this.selectConnection()) { this.notify(ctx, "Not paired.", "warning"); return; }
        const [kind, ...keyParts] = rest;
        if ((kind !== "setting" && kind !== "provider") || !keyParts.length) { this.notify(ctx, "Usage: /sync exclude|include setting|provider KEY", "warning"); return; }
        await this.active;
        this.engine!.exclude(kind, keyParts.join(" "), command === "exclude");
        await this.run();
      } else if (command === "migrate") {
        const connection = this.selectConnection();
        if (!connection || !brokerMatches(this.settings, connection)) { this.notify(ctx, "Pair first and remove conflicting broker overrides.", "error"); return; }
        if (!ctx.hasUI) return;
        const release = this.control.lock();
        if (!release) { this.notify(ctx, "Enrollment is busy; try again.", "warning"); return; }
        try {
          if (!await ctx.ui.confirm("Upload existing local credentials?", `Upload stored API keys to ${connection.url}? This does not delete local copies. Existing broker accounts are preserved. OAuth/environment keys need separate consent.`)) return;
          const oauth = await ctx.ui.confirm("Include local OAuth accounts?", "Upload refresh tokens to the broker? Stop independently refreshing these accounts on other copies after migration. Choose No to migrate API keys only.");
          const environment = await ctx.ui.confirm("Include environment API keys?", "Upload provider API keys from this process's environment? Choose No to keep environment keys device-local.");
          await this.settings.flush();
          await this.settings.reloadFromDisk();
          if (!equal(loadConnection(this.directory), connection) || !brokerMatches(this.settings, connection)) {
            this.notify(ctx, "Enrollment or broker configuration changed during consent; review it again.", "error");
            return;
          }
          const success = await migrateCredentials(connection, oauth, environment, this.abort.signal);
          this.notify(ctx, success ? "Credential migration completed. Broker snapshots automatically propagate available credentials to your paired devices." : "Migration did not fully complete. Run omp auth-broker migrate --from-local --dry-run to inspect it; no output containing credentials was displayed.", success ? "info" : "error");
        } finally { release(); }
      } else this.notify(ctx, `Usage: /sync ${COMMANDS.join(" | ")}`, "warning");
    } catch (error) { this.notify(ctx, `Sync command failed: ${safeError(error)}. Check configuration and retry; private state was retained.`, "error"); }
  }
}

/** Registration only: OMP executes factories during package validation too. */
export default function ompSync(api: ExtensionAPI): void {
  let controller: Controller | undefined;
  api.registerCommand("sync", {
    description: "Pair, synchronize, review conflicts, and manage the self-hosted sync broker",
    getArgumentCompletions: prefix => COMMANDS.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== "main") return;
      if (!controller) { controller = new Controller(ctx); controller.start(); }
      await controller.command(args, ctx);
    },
  });
  api.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    await controller?.stop();
    controller = new Controller(ctx);
    controller.start();
  });
  api.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    await controller?.stop();
    controller = undefined;
  });
}
