import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker/server";
import type { Connection } from "../src/types";

const consentedToken = `omps_${"A".repeat(43)}`;
const unrelatedToken = `omps_${"B".repeat(43)}`;
type Outcome = { kind: "result"; success: boolean } | { kind: "user_error"; cancelled: boolean };

async function fixture(peerCli: boolean) {
  const root = mkdtempSync(join(tmpdir(), "omp-sync-migration-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const local = await AuthStorage.create(join(agentDir, "agent.db"));
  const accepted = await AuthStorage.create(join(root, "accepted.db"));
  const unrelated = await AuthStorage.create(join(root, "unrelated.db"));
  await Promise.all([local.credentials.reload(), accepted.credentials.reload(), unrelated.credentials.reload()]);
  const first = startAuthBroker({ storage: accepted, bind: "127.0.0.1:0", bearerTokens: [consentedToken], disableRefresher: true });
  const second = startAuthBroker({ storage: unrelated, bind: "127.0.0.1:0", bearerTokens: [unrelatedToken], disableRefresher: true });
  await local.credentials.upsert("ci-migration", { type: "api_key", key: "synthetic-migration-key" });
  writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ auth: { broker: { url: second.url, token: unrelatedToken } } }), { mode: 0o600 });

  const hostCli = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/cli"));
  const plugin = join(root, "plugin"); mkdirSync(plugin);
  for (const name of ["broker.ts", "types.ts", "token.ts", "errors.ts"]) {
    copyFileSync(new URL(`../src/${name}`, import.meta.url), join(plugin, name));
  }
  // A real SDK source tree whose plugin-local exports need not publish a CLI.
  const peer = join(plugin, "node_modules/@oh-my-pi/pi-coding-agent"); mkdirSync(peer, { recursive: true });
  symlinkSync(dirname(hostCli), join(peer, "src"), "dir");
  writeFileSync(join(peer, "package.json"), JSON.stringify({
    name: "@oh-my-pi/pi-coding-agent", type: "module",
    exports: { "./config/model-settings": "./src/config/model-settings.ts", ...(peerCli ? { "./cli": "./src/cli.ts" } : {}) },
  }));
  const preload = join(root, "preload.ts");
  // Bun.main is the actual CLI entry even while a preload is running. The child
  // executes real OMP, without inheriting the parent's --preload argument.
  writeFileSync(preload, `
import { migrateCredentials } from "./plugin/broker.ts";
import { UserError } from "./plugin/errors.ts";
const abort = new AbortController();
const watch = new AbortController();
const cancellation = process.env.TEST_ABORT_URL
  ? fetch(process.env.TEST_ABORT_URL, { signal: watch.signal }).then(() => abort.abort()).catch(() => {})
  : undefined;
try {
  const success = await migrateCredentials(JSON.parse(process.env.TEST_CONNECTION!), false, false, abort.signal);
  console.log(JSON.stringify({ kind: "result", success }));
} catch (error) {
  if (!(error instanceof UserError)) throw error;
  console.log(JSON.stringify({ kind: "user_error", cancelled: abort.signal.aborted }));
} finally {
  watch.abort(); await cancellation;
}
process.exit(0);
`);
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  return {
    local, accepted, unrelated, first, second,
    async run(url = first.url, abortUrl?: string): Promise<Outcome> {
      const connection: Connection = { version: 1, url, token: consentedToken, device: { id: "device", name: "Test", profile: "personal" }, previousBroker: {} };
      child = Bun.spawn([process.execPath, "--preload", preload, hostCli], {
        cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000,
        env: {
          HOME: root, PI_CODING_AGENT_DIR: agentDir, PATH: "",
          OMP_AUTH_BROKER_URL: second.url, OMP_AUTH_BROKER_TOKEN: unrelatedToken,
          TEST_CONNECTION: JSON.stringify(connection), ...(abortUrl ? { TEST_ABORT_URL: abortUrl } : {}),
        },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout);
    },
    async close() {
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      await first.close(); await second.close();
      local.close(); accepted.close(); unrelated.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("host CLI migrates without PATH or a plugin-local CLI export, to only the consented vault", async () => {
  const f = await fixture(false);
  try {
    expect(await f.run()).toEqual({ kind: "result", success: true });
    await f.accepted.credentials.reload(); await f.unrelated.credentials.reload();
    expect(await f.accepted.keys.get("ci-migration")).toBe("synthetic-migration-key");
    expect(await f.unrelated.keys.get("ci-migration")).toBeUndefined();
    expect(await f.local.keys.get("ci-migration")).toBe("synthetic-migration-key");
  } finally { await f.close(); }
}, 30_000);

test("aborting an active migration reports cancellation and closes its request without uploading", async () => {
  const f = await fixture(true);
  const entered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const cancel = Promise.withResolvers<Response>();
  const release = Promise.withResolvers<void>();
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/cancel") return cancel.promise;
      request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    },
  });
  try {
    const url = `http://127.0.0.1:${relay.port}`;
    const result = f.run(url, `${url}/cancel`);
    await entered.promise;
    cancel.resolve(new Response(null));
    expect(await result).toEqual({ kind: "user_error", cancelled: true });
    await disconnected.promise;
    await f.accepted.credentials.reload();
    expect(await f.accepted.keys.get("ci-migration")).toBeUndefined();
    expect(await f.local.keys.get("ci-migration")).toBe("synthetic-migration-key");
  } finally {
    cancel.resolve(new Response(null)); release.resolve();
    await relay.stop(true); await f.close();
  }
}, 30_000);
