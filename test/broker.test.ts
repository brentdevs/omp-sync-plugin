import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker/server";
import { migrateCredentials } from "../src/broker";
import type { Connection } from "../src/types";

const consentedToken = `omps_${"A".repeat(43)}`;
const unrelatedToken = `omps_${"B".repeat(43)}`;
// Real HTTP/SQLite/subprocess integration: no simulated credential destination or CLI output.
test("migration uploads only to the consented broker despite changed config and environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-sync-migration-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const local = await AuthStorage.create(join(agentDir, "agent.db"));
  const accepted = await AuthStorage.create(join(root, "accepted.db"));
  const unrelated = await AuthStorage.create(join(root, "unrelated.db"));
  await Promise.all([local.credentials.reload(), accepted.credentials.reload(), unrelated.credentials.reload()]);
  const first = startAuthBroker({ storage: accepted, bind: "127.0.0.1:0", bearerTokens: [consentedToken], disableRefresher: true });
  const second = startAuthBroker({ storage: unrelated, bind: "127.0.0.1:0", bearerTokens: [unrelatedToken], disableRefresher: true });
  try {
    await local.credentials.upsert("ci-migration", { type: "api_key", key: "synthetic-migration-key" });
    writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ auth: { broker: { url: second.url, token: unrelatedToken } } }), { mode: 0o600 });
    const connection: Connection = { version: 1, url: first.url, token: consentedToken, device: { id: "device", name: "Test", profile: "personal" }, previousBroker: {} };
    const keys = ["HOME", "PI_CODING_AGENT_DIR", "PATH", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    let pending: Promise<boolean>;
    try {
      process.env.HOME = root;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PATH = [join(import.meta.dir, "../node_modules/.bin"), dirname(process.execPath), previous.PATH ?? ""].join(delimiter);
      process.env.OMP_AUTH_BROKER_URL = second.url;
      process.env.OMP_AUTH_BROKER_TOKEN = unrelatedToken;
      // Spawn captures its environment synchronously; restore the test process before awaiting it.
      pending = migrateCredentials(connection, false, false, new AbortController().signal);
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
    expect(await pending).toBe(true);
    await accepted.credentials.reload(); await unrelated.credentials.reload();
    expect(await accepted.keys.get("ci-migration")).toBe("synthetic-migration-key");
    expect(await unrelated.keys.get("ci-migration")).toBeUndefined();
    expect(await local.keys.get("ci-migration")).toBe("synthetic-migration-key");
  } finally {
    await first.close(); await second.close();
    local.close(); accepted.close(); unrelated.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
