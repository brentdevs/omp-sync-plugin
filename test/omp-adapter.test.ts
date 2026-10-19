import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { Settings, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { OmpAdapter } from "../src/omp-adapter";
import { captureBroker, configureBroker, restoreBroker } from "../src/broker";
import { identity } from "../src/types";
import type { Connection, Json } from "../src/types";

const roots: string[] = [];
const instances: Settings[] = [];
afterEach(async () => {
  for (const settings of instances.splice(0)) { await settings.flush(); settings.cancelPendingSaves(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(global = "{}\n", project = "{}\n") {
  const root = mkdtempSync(join(tmpdir(), "omp-sync-adapter-")); roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(join(cwd, ".omp"), { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), global);
  writeFileSync(join(cwd, ".omp", "config.yml"), project);
  const settings = await Settings.loadIsolated({ agentDir, cwd }); instances.push(settings);
  // No registry transport is needed for file/validation tests; real registry reload is exercised by the smoke.
  const registry = { refresh: async () => {}, getError: () => undefined } as unknown as ExtensionContext["modelRegistry"];
  return { root, agentDir, cwd, settings, adapter: new OmpAdapter(settings, registry) };
}

test("exports only explicit global values even when project/runtime layers hide them", async () => {
  const { adapter, settings } = await fixture("hideThinkingBlock: true\nreadLineNumbers: true\nshellPath: /bin/device-shell\nauth:\n  broker:\n    token: private-device-token\n", "hideThinkingBlock: false\n");
  lookup("readLineNumbers")!.override(settings, false);
  const values = await adapter.read();
  expect(values[identity("setting", "hideThinkingBlock")]?.value).toBe(true);
  expect(values[identity("setting", "readLineNumbers")]?.value).toBe(true);
  expect(values[identity("setting", "shellPath")]).toBeUndefined();
  expect(values[identity("setting", "auth.broker.token")]).toBeUndefined();
  expect(values[identity("setting", "read.defaultLimit")]).toBeUndefined();
});

test("receives client-decoded provider objects, rejects executable references and malformed custom models", async () => {
  const { adapter, root, agentDir } = await fixture();
  const provider = Object.assign(Object.create(null), { baseUrl: "https://example.invalid/v1" });
  expect(adapter.policy({ kind: "provider", key: "openai", value: provider })).toBe("approval");
  expect(adapter.policy({ kind: "provider", key: "unsafe", value: { apiKey: `!touch ${join(root, "executed")}` } })).toBe("invalid");
  expect(adapter.policy({ kind: "provider", key: "invalid", value: { models: [{ id: "custom" }] } })).toBe("invalid");
  await expect(adapter.apply("provider", "unsafe", { deleted: false, value: { apiKey: "!echo no" } }, { deleted: true })).rejects.toThrow();
  expect(existsSync(join(root, "executed"))).toBe(false);
  expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
});

test("provider changes preserve YAML comments, fallback extension and unrelated entries", async () => {
  const { adapter, agentDir } = await fixture();
  const path = join(agentDir, "models.yaml");
  writeFileSync(path, "# preserve this comment\nproviders:\n  openai:\n    baseUrl: https://old.invalid/v1\n  other:\n    baseUrl: https://unrelated.invalid/v1\n");
  await adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid/v1" } }, { deleted: false, value: { baseUrl: "https://old.invalid/v1" } });
  const source = readFileSync(path, "utf8");
  expect(source).toContain("# preserve this comment");
  expect(parse(source).providers).toEqual({ openai: { baseUrl: "https://new.invalid/v1" }, other: { baseUrl: "https://unrelated.invalid/v1" } });
  expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("does not overwrite an external edit made after reconciliation observed the local value", async () => {
  const { adapter, agentDir } = await fixture("hideThinkingBlock: false\n");
  await adapter.read();
  writeFileSync(join(agentDir, "config.yml"), "hideThinkingBlock: true\n");
  await expect(adapter.apply("setting", "hideThinkingBlock", { deleted: true }, { deleted: false, value: false })).rejects.toThrow("changed");
  expect(parse(readFileSync(join(agentDir, "config.yml"), "utf8")).hideThinkingBlock).toBe(true);
});

test("broker disconnect restores previous config but never overwrites independently edited routing", async () => {
  const { settings, agentDir } = await fixture("auth:\n  broker:\n    url: https://old.invalid\n    token: previous-private-token\n");
  const connection: Connection = { version: 1, url: "https://sync.invalid", token: "private-device-token", device: { id: "device", name: "Laptop", profile: "personal" }, previousBroker: captureBroker(settings) };
  await configureBroker(settings, connection);
  if (process.platform !== "win32") expect(statSync(join(agentDir, "config.yml")).mode & 0o777).toBe(0o600);
  expect(await restoreBroker(settings, connection)).toBe(true);
  expect(captureBroker(settings)).toEqual({ url: "https://old.invalid", token: "previous-private-token" });
  await configureBroker(settings, connection);
  lookup("auth.broker.url")!.set(settings, "https://operator.invalid"); await settings.flush();
  expect(await restoreBroker(settings, connection)).toBe(false);
  expect(captureBroker(settings).url).toBe("https://operator.invalid");
});

test("provider CAS uses the exact document that will be replaced", async () => {
  const { adapter, agentDir } = await fixture();
  const path = join(agentDir, "models.yml");
  writeFileSync(path, "providers:\n  openai:\n    baseUrl: https://old.invalid\n");
  const read = adapter.read.bind(adapter);
  adapter.read = async () => {
    const observed = await read();
    writeFileSync(path, "providers:\n  openai:\n    baseUrl: https://edited.invalid\n");
    return observed;
  };
  await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://remote.invalid" } }, { deleted: false, value: { baseUrl: "https://old.invalid" } })).rejects.toThrow("changed");
  expect(parse(readFileSync(path, "utf8")).providers.openai.baseUrl).toBe("https://edited.invalid");
});

test("provider schema failures are rejected before files are materialized", async () => {
  const { adapter, agentDir } = await fixture();
  const invalid: Json[] = [
    { baseUrl: 42 },
    { baseUrl: "https://example.invalid", api: "unknown-api" },
    { baseUrl: "https://example.invalid", headers: { "X-Custom": 42 } },
    { baseUrl: "https://example.invalid", models: "not-an-array" },
  ];
  for (const value of invalid) {
    expect(adapter.policy({ kind: "provider", key: "invalid", value })).toBe("invalid");
  }
  await expect(adapter.apply("provider", "invalid", { deleted: false, value: { baseUrl: 42 } }, { deleted: true })).rejects.toThrow();
  expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
});
