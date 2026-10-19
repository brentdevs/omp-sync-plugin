import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { OmpAdapter } from "../src/omp-adapter";
import { captureBroker, configureBroker, restoreBroker } from "../src/broker";
import { identity } from "../src/types";
import type { Connection, Json } from "../src/types";
import { UserError } from "../src/errors";

const roots: string[] = [];
const instances: Settings[] = [];
afterEach(async () => {
  mock.restore();
  for (const settings of instances.splice(0)) { await settings.flush(); settings.cancelPendingSaves(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
interface TestRegistry { refresh(strategy?: string): Promise<void>; getError(): unknown }
async function fixture(global = "{}\n", project = "{}\n", hooks?: TestRegistry) {
  const root = mkdtempSync(join(tmpdir(), "omp-sync-adapter-")); roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(join(cwd, ".omp"), { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), global);
  writeFileSync(join(cwd, ".omp", "config.yml"), project);
  const settings = await Settings.loadIsolated({ agentDir, cwd }); instances.push(settings);
  // No registry transport is needed for file/validation tests; real registry reload is exercised by the smoke.
  const registry = (hooks ?? { refresh: async () => {}, getError: () => undefined }) as unknown as ExtensionContext["modelRegistry"];
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
  const connection: Connection = { version: 1, url: "https://sync.invalid", token: `omps_${"A".repeat(43)}`, device: { id: "device", name: "Laptop", profile: "personal" }, previousBroker: captureBroker(settings) };
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

for (const extension of ["yml", "yaml"]) {
  test(`provider replacement preserves a relative models.${extension} symlink and updates its target`, async () => {
    const { adapter, root, agentDir } = await fixture();
    const path = join(agentDir, `models.${extension}`), target = join(root, "shared-models.yml");
    writeFileSync(target, "providers:\n  openai:\n    baseUrl: https://old.invalid\n");
    symlinkSync("../shared-models.yml", path);
    await adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: false, value: { baseUrl: "https://old.invalid" } });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe("../shared-models.yml");
    expect(parse(readFileSync(target, "utf8")).providers.openai.baseUrl).toBe("https://new.invalid");
  });

  test(`dangling models.${extension} links are reported without severing them`, async () => {
    const { adapter, agentDir } = await fixture();
    const path = join(agentDir, `models.${extension}`);
    symlinkSync("../missing-models.yml", path);
    await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: true })).rejects.toThrow("symlink has no target");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe("../missing-models.yml");
    if (extension === "yaml") expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
  });
}

const anchoredSources = [
  {
    name: "provider map",
    source: "# document comment\nproviders:\n  openai: &shared\n    baseUrl: https://old.invalid\n  # keep unrelated comment\n  other: *shared # alias comment\n",
  },
  {
    name: "provider scalar",
    source: "# document comment\nproviders:\n  openai:\n    baseUrl: &shared https://old.invalid\n  # keep unrelated comment\n  other:\n    baseUrl: *shared # alias comment\n",
  },
  {
    name: "aliased provider map",
    source: "# document comment\nproviders:\n  # keep unrelated comment\n  other: &shared\n    baseUrl: https://old.invalid\n  openai: *shared # alias comment\n",
  },
];
for (const { name, source } of anchoredSources) {
  for (const deleted of [false, true]) {
    test(`${deleted ? "deleting" : "updating"} a ${name} preserves all unrelated YAML provider values`, async () => {
      const { adapter, agentDir } = await fixture();
      const path = join(agentDir, "models.yml");
      writeFileSync(path, source);
      const original = parse(source);
      await adapter.apply("provider", "openai", deleted ? { deleted: true } : { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: false, value: original.providers.openai });
      const output = readFileSync(path, "utf8"), document = parseDocument(output, { uniqueKeys: true });
      expect(document.errors).toHaveLength(0);
      const result = document.toJS({ maxAliasCount: 50 });
      expect(result.providers.other).toEqual(original.providers.other);
      expect(result.providers.openai).toEqual(deleted ? undefined : { baseUrl: "https://new.invalid" });
      expect(output).toContain("# document comment");
      expect(output).toContain("# keep unrelated comment");
      if (name !== "aliased provider map") expect(output).toContain("# alias comment");
    });
  }
}

test("alias materialization also preserves scalar credentials and non-provider aliases", async () => {
  const { adapter, agentDir } = await fixture();
  const path = join(agentDir, "models.yml");
  const source = "providers:\n  openai: &provider\n    baseUrl: https://old.invalid\n    apiKey: &key private-literal\n  other:\n    baseUrl: https://other.invalid\n    apiKey: *key\nlocalCopy: *provider\n";
  writeFileSync(path, source);
  await adapter.apply("provider", "openai", { deleted: true }, { deleted: false, value: parse(source).providers.openai });
  const result = parseDocument(readFileSync(path, "utf8")).toJS({ maxAliasCount: 50 });
  expect(result.providers.other).toEqual(parse(source).providers.other);
  expect(result.localCopy).toEqual(parse(source).localCopy);
});

/** Inject a real filesystem edit in the staging window, after the real fsync. */
function duringStaging(action: () => void) {
  const sync = fs.fsyncSync;
  const intercepted = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    sync(fd);
    intercepted.mockRestore();
    action();
  });
  return intercepted;
}
test("an external process save during temporary-file staging wins over synchronization", async () => {
  const { adapter, agentDir } = await fixture();
  const path = join(agentDir, "models.yml"), source = "providers:\n  openai:\n    baseUrl: https://old.invalid\n";
  const edited = "# editor save\nproviders:\n  openai:\n    baseUrl: https://editor.invalid\n";
  writeFileSync(path, source);
  duringStaging(() => {
    const editor = spawnSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(edited)})`]);
    expect(editor.status).toBe(0);
  });
  await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: false, value: { baseUrl: "https://old.invalid" } })).rejects.toThrow("changed");
  expect(readFileSync(path, "utf8")).toBe(edited);
  expect(readdirSync(agentDir).filter(name => name.startsWith(".omp-sync-models-"))).toEqual([]);
});

test("a symlink repointed during staging preserves both targets and the new link", async () => {
  const { adapter, root, agentDir } = await fixture();
  const path = join(agentDir, "models.yml"), original = join(root, "original.yml"), edited = join(root, "edited.yml");
  const source = "providers:\n  openai:\n    baseUrl: https://old.invalid\n";
  writeFileSync(original, source); writeFileSync(edited, "# editor target\n" + source);
  symlinkSync(original, path);
  duringStaging(() => { unlinkSync(path); symlinkSync(edited, path); });
  await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: false, value: { baseUrl: "https://old.invalid" } })).rejects.toThrow("symlink changed");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(edited);
  expect(readFileSync(original, "utf8")).toBe(source);
  expect(readFileSync(edited, "utf8")).toBe("# editor target\n" + source);
  expect(readdirSync(root).filter(name => name.startsWith(".omp-sync-models-"))).toEqual([]);
});

test("new registry diagnostics roll back bytes and reload the original symlink target offline", async () => {
  const strategies: (string | undefined)[] = [];
  let error: Error | undefined;
  let path = "";
  const seen: string[] = [];
  const { adapter, agentDir, root } = await fixture("{}", "{}", {
    refresh: async strategy => { strategies.push(strategy); seen.push(readFileSync(path, "utf8")); error = strategies.length === 1 ? new Error("private-validator-payload") : undefined; },
    getError: () => error,
  });
  path = join(agentDir, "models.yml");
  const target = join(root, "shared.yml"), source = "# original bytes\nproviders:\n  openai:\n    baseUrl: https://old.invalid\n";
  writeFileSync(target, source); symlinkSync(target, path);
  let failure: unknown;
  try { await adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: false, value: { baseUrl: "https://old.invalid" } }); }
  catch (caught) { failure = caught; }
  expect(failure).toBeInstanceOf(UserError);
  expect((failure as Error).message).toContain("original configuration was restored");
  expect((failure as Error).message).not.toContain("private-validator-payload");
  expect(strategies).toEqual(["offline", "offline"]);
  expect(parse(seen[0]!).providers.openai.baseUrl).toBe("https://new.invalid");
  expect(seen[1]).toBe(source);
  expect(readFileSync(target, "utf8")).toBe(source);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(target);
});

test("unchanged pre-existing semantic registry errors do not reject a provider change", async () => {
  let refreshes = 0;
  const { adapter, agentDir } = await fixture("{}", "{}", {
    refresh: async strategy => { expect(strategy).toBe("offline"); refreshes++; },
    getError: () => Object.assign(new Error("pre-existing unrelated error"), { id: "models-config", schemaErrors: refreshes ? [{ instancePath: "providers.other.headers", message: "invalid" }, { instancePath: "providers.third.api", message: "unsupported" }] : [{ instancePath: "providers.third.api", message: "unsupported" }, { instancePath: "providers.other.headers", message: "invalid" }] }),
  });
  await adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: true });
  expect(refreshes).toBe(1);
  expect(parse(readFileSync(join(agentDir, "models.yml"), "utf8")).providers.openai.baseUrl).toBe("https://new.invalid");
});

test("refresh rejection removes a newly created models file and reloads the absent configuration", async () => {
  let calls = 0, path = "";
  const { adapter, agentDir } = await fixture("{}", "{}", {
    refresh: async () => { calls++; if (calls === 1) throw new Error("private rejected value"); expect(existsSync(path)).toBe(false); },
    getError: () => undefined,
  });
  path = join(agentDir, "models.yml");
  await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: true })).rejects.toThrow("original configuration was restored");
  expect(calls).toBe(2);
  expect(existsSync(path)).toBe(false);
});

test("a concurrent user save during a rejected refresh is never rolled back", async () => {
  let calls = 0, path = "";
  const edited = "# saved while refreshing\nproviders:\n  openai:\n    baseUrl: https://editor.invalid\n";
  const { adapter, agentDir } = await fixture("{}", "{}", {
    refresh: async () => { calls++; writeFileSync(path, edited); throw new Error("private refresh details"); },
    getError: () => undefined,
  });
  path = join(agentDir, "models.yml");
  writeFileSync(path, "providers:\n  openai:\n    baseUrl: https://old.invalid\n");
  await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: false, value: { baseUrl: "https://old.invalid" } })).rejects.toThrow("current local file was left untouched");
  expect(readFileSync(path, "utf8")).toBe(edited);
  expect(calls).toBe(1);
  expect(readdirSync(agentDir).filter(name => name.startsWith(".omp-sync-models-"))).toEqual([]);
});

test("provider deletion reloads offline and retains unrelated command-backed local configuration", async () => {
  const refreshes: (string | undefined)[] = [];
  const { adapter, agentDir } = await fixture("{}", "{}", { refresh: async strategy => { refreshes.push(strategy); }, getError: () => undefined });
  const path = join(agentDir, "models.yml");
  writeFileSync(path, "# keep this\nproviders:\n  openai:\n    baseUrl: https://old.invalid\n  other:\n    apiKey: '!device-local-command'\n");
  await adapter.apply("provider", "openai", { deleted: true }, { deleted: false, value: { baseUrl: "https://old.invalid" } });
  expect(parse(readFileSync(path, "utf8")).providers).toEqual({ other: { apiKey: "!device-local-command" } });
  expect(readFileSync(path, "utf8")).toContain("# keep this");
  expect(refreshes).toEqual(["offline"]);
});

test("corrupt YAML is an authored error and is never overwritten", async () => {
  const { adapter, agentDir } = await fixture();
  const path = join(agentDir, "models.yml"), source = "providers:\n  openai: [private-secret\n";
  writeFileSync(path, source);
  let failure: unknown;
  try { await adapter.apply("provider", "openai", { deleted: true }, { deleted: true }); }
  catch (caught) { failure = caught; }
  expect(failure).toBeInstanceOf(UserError);
  expect((failure as Error).message).toContain("invalid YAML");
  expect((failure as Error).message).not.toContain("private-secret");
  expect(readFileSync(path, "utf8")).toBe(source);
});

test("new model files use readable block YAML", async () => {
  const { adapter, agentDir } = await fixture();
  await adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid", headers: { "X-Custom": "literal" } } }, { deleted: true });
  const source = readFileSync(join(agentDir, "models.yml"), "utf8");
  expect(source).toMatch(/^providers:\n  openai:\n    baseUrl: /);
  expect(source).toContain("\n    headers:\n      X-Custom: literal");
});

test("a close failure still removes the secret temporary file", async () => {
  const { adapter, agentDir } = await fixture();
  const realClose = closeSync;
  let injected = false;
  spyOn(fs, "closeSync").mockImplementation(fd => {
    if (!injected && readdirSync(agentDir).some(name => name.startsWith(".omp-sync-models-"))) {
      injected = true;
      throw Object.assign(new Error("injected close failure"), { code: "EIO" });
    }
    realClose(fd);
  });
  await expect(adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid", apiKey: "private-literal" } }, { deleted: true })).rejects.toThrow("injected close failure");
  expect(injected).toBe(true);
  expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
  expect(readdirSync(agentDir).filter(name => name.startsWith(".omp-sync-models-"))).toEqual([]);
});

test("crash cleanup removes only exact private owned temp names from dead processes", async () => {
  const { adapter, agentDir } = await fixture();
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(exited.status).toBe(0);
  const stale = join(agentDir, `.omp-sync-models-${exited.pid}-00000000-0000-4000-8000-000000000001.tmp`);
  const live = join(agentDir, `.omp-sync-models-${process.pid}-00000000-0000-4000-8000-000000000002.tmp`);
  const editor = join(agentDir, "models.yml.editor.tmp"), unrelated = join(agentDir, ".omp-sync-models-not-owned.tmp");
  const linked = join(agentDir, `.omp-sync-models-${exited.pid}-00000000-0000-4000-8000-000000000003.tmp`);
  for (const path of [stale, live, editor, unrelated]) writeFileSync(path, "private content", { mode: 0o600 });
  symlinkSync(editor, linked);
  await adapter.apply("provider", "openai", { deleted: false, value: { baseUrl: "https://new.invalid" } }, { deleted: true });
  expect(existsSync(stale)).toBe(false);
  expect(readFileSync(live, "utf8")).toBe("private content");
  expect(readFileSync(editor, "utf8")).toBe("private content");
  expect(readFileSync(unrelated, "utf8")).toBe("private content");
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
});

test("failed rollback reload reports restoration without exposing upstream secrets", async () => {
  let refreshes = 0;
  const { adapter, agentDir } = await fixture("{}", "{}", {
    refresh: async () => { refreshes++; throw new Error("private-upstream-secret"); },
    getError: () => undefined,
  });
  const path = join(agentDir, "models.yml"), source = "providers:\n  openai:\n    baseUrl: https://old.invalid\n";
  writeFileSync(path, source);
  let failure: unknown;
  try { await adapter.apply("provider", "openai", { deleted: true }, { deleted: false, value: { baseUrl: "https://old.invalid" } }); }
  catch (caught) { failure = caught; }
  expect(failure).toBeInstanceOf(UserError);
  expect((failure as Error).message).toContain("original configuration was restored");
  expect((failure as Error).message).toContain("Reload OMP");
  expect((failure as Error).message).not.toContain("private-upstream-secret");
  expect(readFileSync(path, "utf8")).toBe(source);
  expect(refreshes).toBe(2);
});
