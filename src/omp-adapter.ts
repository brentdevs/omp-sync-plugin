import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isAlias, isCollection, isNode, isPair, parseDocument } from "yaml";
import type { Alias, Document, Node } from "yaml";
import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile, validateProviderConfiguration } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { all, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { ModelsConfig } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { equal, identity, valueOf } from "./types";
import type { Json, Kind, LocalAdapter, RecordValue, Value } from "./types";
import { UserError } from "./errors";

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
  if (depth > 128) throw new UserError("Configuration is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.isWellFormed() && !value.startsWith("!")) return;
  if (Array.isArray(value)) { for (const item of value) assertSafeJson(item, depth + 1); return; }
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key) || !key.isWellFormed()) throw new UserError("Unsafe configuration key");
      assertSafeJson(item, depth + 1);
    }
    return;
  }
  throw new UserError("Configuration must be JSON without executable command references");
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
  catch { throw new UserError("Provider configuration does not match the installed OMP schema"); }
  for (const [name, provider] of Object.entries(checked.providers ?? {})) {
    try { validateProviderConfiguration(name, { ...provider, models: provider.models ?? [] }, "models-config"); }
    catch { throw new UserError("Provider configuration fails OMP semantic validation"); }
  }
  return checked;
}

interface ModelsLocation {
  path: string;
  target: string;
  symlink: boolean;
  link?: string | undefined;
  exists: boolean;
}
function entryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function resolveModels(path: string): ModelsLocation {
  if (!entryExists(path)) return { path, target: join(realpathSync(dirname(path)), basename(path)), symlink: false, exists: false };
  const symlink = lstatSync(path).isSymbolicLink();
  const link = symlink ? readlinkSync(path) : undefined;
  let target: string;
  try { target = realpathSync(path); }
  catch (error) {
    if (symlink && (error as NodeJS.ErrnoException).code === "ENOENT") throw new UserError("The models configuration symlink has no target. Repair the link before synchronizing.");
    throw error;
  }
  if (!lstatSync(target).isFile()) throw new UserError("The models configuration must point to a regular file.");
  return { path, target, symlink, link, exists: true };
}
function parseModels(source: string) {
  const document: Document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new UserError("Local models configuration has invalid YAML. Repair it before synchronizing.");
  let raw: unknown;
  try { raw = document.toJS({ maxAliasCount: 50 }) ?? {}; }
  catch { throw new UserError("Local models configuration has unresolved or excessive YAML aliases."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError("Local models configuration must be an object.");
  const providers = (raw as Record<string, unknown>).providers;
  if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers))) throw new UserError("Local providers must be an object.");
  return { document, raw: raw as Record<string, unknown>, providers: providers as Record<string, Json> | undefined };
}
/** JSON-like YAML is comparable without rejecting unrelated local !command strings. */
function assertComparableYaml(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 128) throw new UserError("Local models configuration is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new UserError("Local models configuration must contain finite, non-cyclic JSON values.");
  ancestors.add(value);
  for (const child of Object.values(value)) assertComparableYaml(child, ancestors, depth + 1);
  ancestors.delete(value);
}
/** Expand against the original document, before deleting any anchor definitions. */
function detachAliases(document: Document): void {
  function copy(value: unknown, cloned: unknown): unknown {
    if (isPair(value) && isPair(cloned)) {
      cloned.key = copy(value.key, cloned.key); cloned.value = copy(value.value, cloned.value);
      return cloned;
    }
    if (!isNode(value) || !isNode(cloned)) return cloned;
    if (isAlias(value)) {
      const target = value.resolve(document);
      if (!target) throw new UserError("Local models configuration has an unresolved YAML alias.");
      const node = copy(target, target.clone()) as Node;
      if (value.commentBefore) node.commentBefore = [node.commentBefore, value.commentBefore].filter(Boolean).join("\n");
      if (value.comment) node.comment = [node.comment, value.comment].filter(Boolean).join("\n");
      if (value.spaceBefore) node.spaceBefore = true;
      return node;
    }
    const node = cloned as Exclude<Node, Alias>;
    node.anchor = undefined;
    if (isCollection(value) && isCollection(node)) {
      for (let index = 0; index < value.items.length; index++) node.items[index] = copy(value.items[index], node.items[index]);
    }
    return node;
  }
  if (document.contents) document.contents = copy(document.contents, document.contents.clone()) as Node;
}
interface RegistryError extends Error {
  id?: string;
  schemaErrors?: readonly { instancePath: string; message: string | undefined }[] | null | undefined;
  other?: { err: unknown; stage: string } | undefined;
}
function registryErrors(error: RegistryError | undefined): Set<string> {
  if (!error) return new Set();
  // Compare diagnostics, not Error identities/stacks; never display their possibly secret text.
  if (error.schemaErrors) return new Set(error.schemaErrors.map(issue => JSON.stringify([error.id, "schema", issue.instancePath, issue.message])));
  const cause = error.other?.err;
  return new Set([JSON.stringify([error.id, error.other?.stage, cause instanceof Error ? cause.message : error.message])]);
}
function cleanOrphanTemps(directory: string): void {
  // Callers hold the common enrollment lock. Never touch editor files or a live writer.
  for (const name of readdirSync(directory)) {
    const match = /^\.omp-sync-models-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    try { process.kill(pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) continue;
      if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) continue;
      unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export class OmpAdapter implements LocalAdapter {
  constructor(readonly settings: Settings, private readonly registry: ExtensionContext["modelRegistry"]) {}
  private modelsPath(): string {
    const base = join(this.settings.getAgentDir(), "models");
    return entryExists(`${base}.yml`) ? `${base}.yml` : entryExists(`${base}.yaml`) ? `${base}.yaml` : `${base}.yml`;
  }
  private models() {
    const location = resolveModels(this.modelsPath());
    const source = location.exists ? readFileSync(location.target, "utf8") : "";
    return { location, source, ...parseModels(source) };
  }
  private matches(location: ModelsLocation, source: string | undefined): boolean {
    try {
      if (this.modelsPath() !== location.path) return false;
      const current = resolveModels(location.path);
      if (current.target !== location.target || current.symlink !== location.symlink || current.link !== location.link) return false;
      return source === undefined ? !current.exists : current.exists && readFileSync(current.target, "utf8") === source;
    } catch (error) {
      if (error instanceof UserError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private replace(location: ModelsLocation, expected: string | undefined, output: string): void {
    const directory = dirname(location.target);
    cleanOrphanTemps(directory);
    const temporary = join(directory, `.omp-sync-models-${process.pid}-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, output);
      fsyncSync(fd);
      const closing = fd; fd = undefined; closeSync(closing);
      // This comparison must follow staging. Portable rename is not an atomic editor CAS.
      if (!this.matches(location, expected)) throw new UserError("Models configuration or its symlink changed during synchronization. The local edit was preserved.");
      renameSync(temporary, location.target);
      if (process.platform !== "win32") {
        const parent = openSync(directory, "r");
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
    } finally {
      try { if (fd !== undefined) closeSync(fd); }
      finally {
        try { unlinkSync(temporary); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
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
    const { providers } = this.models();
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
    if (!equal(valueOf(current), expected)) throw new UserError("Local configuration changed during synchronization");
    if (!value.deleted && ["invalid", "excluded"].includes(this.policy({ kind, key, value: value.value }))) throw new UserError("Configuration cannot be applied safely");
    if (kind === "setting") {
      const handle = lookup(key);
      if (!handle || handle.isCredential || LOCAL_SETTINGS.test(key)) throw new UserError("Setting is device-local");
      if (value.deleted) handle.unset(this.settings);
      else handle.set(this.settings, value.value);
      await this.settings.flush();
      return;
    }
    const { location, source, document, raw, providers } = this.models();
    assertComparableYaml(raw);
    const fresh: Value = providers && Object.hasOwn(providers, key) ? { deleted: false, value: providers[key]! } : { deleted: true };
    if (!equal(fresh, expected)) throw new UserError("Local provider changed during synchronization");
    // Validate only changed entries; unrelated command-backed local providers stay local.
    if (!value.deleted) validateModels({ providers: { [key]: value.value } });
    detachAliases(document);
    if (!document.contents) document.contents = document.createNode({}, { flow: false });
    if (value.deleted) document.deleteIn(["providers", key]);
    else document.setIn(["providers", key], value.value);
    const output = document.toString();
    const result = parseModels(output);
    assertComparableYaml(result.raw);
    const finalValue: Value = result.providers && Object.hasOwn(result.providers, key) ? { deleted: false, value: result.providers[key]! } : { deleted: true };
    if (!equal(finalValue, value)) throw new UserError("The synchronized provider could not be represented safely in YAML.");
    const names = new Set([...Object.keys(providers ?? {}), ...Object.keys(result.providers ?? {})]);
    for (const name of names) {
      if (name !== key && !equal(providers?.[name], result.providers?.[name])) throw new UserError("The provider change would modify another local provider. No changes were written.");
    }
    const before = registryErrors(this.registry.getError());
    this.replace(location, location.exists ? source : undefined, output);
    let failed = false;
    try {
      await this.registry.refresh("offline");
      failed = [...registryErrors(this.registry.getError())].some(error => !before.has(error));
    } catch { failed = true; }
    if (!failed) return;
    try {
      if (location.exists) this.replace(location, output, source);
      else {
        if (!this.matches(location, output)) throw new UserError("Models configuration changed after installation.");
        unlinkSync(location.target);
      }
    } catch {
      throw new UserError("OMP could not reload the synchronized provider. The models configuration changed or could not be safely restored; the current local file was left untouched. Review it before synchronizing again.");
    }
    try {
      await this.registry.refresh("offline");
      if ([...registryErrors(this.registry.getError())].some(error => !before.has(error))) throw new UserError("Registry reload failed.");
    } catch {
      throw new UserError("OMP could not reload the synchronized provider. The original configuration was restored, but OMP could not reload it. Reload OMP before synchronizing again.");
    }
    throw new UserError("OMP could not reload the synchronized provider. The original configuration was restored.");
  }
}
