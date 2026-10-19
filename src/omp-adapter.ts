import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { Settings, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile, validateProviderConfiguration } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { all, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { ModelsConfig } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { equal, identity, valueOf, type Json, type Kind, type LocalAdapter, type RecordValue, type Value } from "./types";

// Everything else registered requires per-value approval on the receiving device.
export const AUTOMATIC_SETTINGS = new Set([
  "theme.dark", "theme.light", "defaultThinkingLevel", "hideThinkingBlock", "expandThinkingBlocks",
  "readLineNumbers", "read.renderMarkdown", "read.defaultLimit", "symbolPreset", "colorBlindMode",
  "composer.shape", "composer.tokenRate", "modelRoles", "modelProviderOrder", "cycleOrder",
  "enabledModels", "enabledProviders", "disabledProviders",
]);
const LOCAL_SETTINGS = /^(auth\.|setupVersion$|extensions$|disabledExtensions$|shellPath$|shellMinimizer\.|power\.|.*(?:Directory|Directories|Path|Paths)$)/;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Keep executable config and non-JSON/prototype-bearing input off the wire and disk. */
export function assertSafeJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 48) throw new Error("Configuration is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.isWellFormed() && !value.startsWith("!")) return;
  if (Array.isArray(value)) { for (const item of value) assertSafeJson(item, depth + 1); return; }
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key) || !key.isWellFormed()) throw new Error("Unsafe configuration key");
      assertSafeJson(item, depth + 1);
    }
    return;
  }
  throw new Error("Configuration must be JSON without executable command references");
}
function atPath(raw: unknown, segments: readonly string[]): unknown {
  let current = raw;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
function validateModels(raw: unknown): ModelsConfig {
  assertSafeJson(raw);
  let checked: ModelsConfig;
  try { checked = ModelsConfigFile.schema.assert(raw) as ModelsConfig; }
  catch { throw new Error("Provider configuration does not match the installed OMP schema"); }
  for (const [name, provider] of Object.entries(checked.providers ?? {})) {
    try { validateProviderConfiguration(name, { ...provider, models: provider.models ?? [] }, "models-config"); }
    catch { throw new Error("Provider configuration fails OMP semantic validation"); }
  }
  return checked;
}

export class OmpAdapter implements LocalAdapter {
  constructor(readonly settings: Settings, private readonly registry: ExtensionContext["modelRegistry"]) {}
  private modelsPath(): string {
    const base = join(this.settings.getAgentDir(), "models");
    return existsSync(`${base}.yml`) ? `${base}.yml` : existsSync(`${base}.yaml`) ? `${base}.yaml` : `${base}.yml`;
  }
  private models() {
    const path = this.modelsPath();
    const source = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw new Error("Local models configuration has invalid YAML");
    const raw = document.toJS({ maxAliasCount: 50 }) ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Local models configuration must be an object");
    return { path, source, document, raw: raw as Record<string, unknown> };
  }
  async read(): Promise<Record<string, RecordValue>> {
    await this.settings.flush();
    await this.settings.reloadFromDisk();
    const values: Record<string, RecordValue> = {};
    const global = this.settings.getGlobalSettings();
    for (const handle of all()) {
      if (handle.isCredential || LOCAL_SETTINGS.test(handle.id)) continue;
      const value = atPath(global, handle.segments);
      if (value === undefined) continue;
      // Retain invalid local values for an issue instead of treating them as deletion.
      values[identity("setting", handle.id)] = { kind: "setting", key: handle.id, value: value as Json };
    }
    const { raw } = this.models();
    const providers = raw.providers;
    if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers))) throw new Error("Local providers must be an object");
    for (const [key, value] of Object.entries(providers ?? {})) values[identity("provider", key)] = { kind: "provider", key, value: value as Json };
    return values;
  }
  policy(record: RecordValue): "automatic" | "approval" | "excluded" | "invalid" {
    if (forbiddenKeys.has(record.key) || !record.key.isWellFormed()) return "invalid";
    if (record.kind === "setting") {
      const handle = lookup(record.key);
      if (!handle || handle.isCredential || LOCAL_SETTINGS.test(record.key)) return "excluded";
      try {
        assertSafeJson(record.value);
        handle.assertWritable(record.value);
        // These otherwise-generic records control model selection, not arbitrary objects.
        if (record.key === "modelRoles" && (!record.value || typeof record.value !== "object" || Array.isArray(record.value) || !Object.values(record.value).every(value => typeof value === "string"))) return "invalid";
        if (["enabledModels", "enabledProviders", "disabledProviders", "modelProviderOrder", "cycleOrder"].includes(record.key) && (!Array.isArray(record.value) || !record.value.every(value => typeof value === "string"))) return "invalid";
      } catch { return "invalid"; }
      return AUTOMATIC_SETTINGS.has(record.key) ? "automatic" : "approval";
    }
    try {
      if (!record.value || typeof record.value !== "object" || Array.isArray(record.value)) return "invalid";
      validateModels({ providers: { [record.key]: record.value } });
    } catch { return "invalid"; }
    // URL, headers, credentials, transport, and discovery can redirect privileged traffic.
    return "approval";
  }
  async apply(kind: Kind, key: string, value: Value, expected: Value): Promise<void> {
    const current = (await this.read())[identity(kind, key)];
    if (!equal(valueOf(current), expected)) throw new Error("Local configuration changed during synchronization");
    if (!value.deleted && ["invalid", "excluded"].includes(this.policy({ kind, key, value: value.value }))) throw new Error("Configuration cannot be applied safely");
    if (kind === "setting") {
      const handle = lookup(key);
      if (!handle || handle.isCredential || LOCAL_SETTINGS.test(key)) throw new Error("Setting is device-local");
      if (value.deleted) handle.unset(this.settings);
      else handle.set(this.settings, value.value);
      await this.settings.flush();
      return;
    }
    const { path, source, document, raw } = this.models();
    const providers = raw.providers as Record<string, Json> | undefined;
    const fresh: Value = providers && Object.hasOwn(providers, key) ? { deleted: false, value: providers[key] } : { deleted: true };
    if (!equal(fresh, expected)) throw new Error("Local provider changed during synchronization");
    // Validate only changed entries; unrelated command-backed local providers stay local.
    if (!value.deleted) validateModels({ providers: { [key]: value.value } });
    if (value.deleted) document.deleteIn(["providers", key]);
    else document.setIn(["providers", key], value.value);
    const output = document.toString();
    // No await between final disk comparison and replacement; catch concurrent editors.
    if ((existsSync(path) ? readFileSync(path, "utf8") : "{}\n") !== source) throw new Error("Models configuration changed during synchronization");
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, output);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
      if (process.platform !== "win32") {
        const directory = openSync(dirname(path), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await this.registry.refresh("offline");
    if (this.registry.getError()) throw new Error("OMP could not reload the synchronized provider");
  }
}
