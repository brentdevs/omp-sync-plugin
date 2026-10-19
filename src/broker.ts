import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgAuthBrokerToken, cfgAuthBrokerUrl } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { equal, type Connection, type Json } from "./types";
import { UserError } from "./errors";
import { brokerTokenValue, requireDeviceToken } from "./token";
export function brokerOverridesPresent(): boolean {
  return !!(process.env.OMP_AUTH_BROKER_URL?.length || process.env.OMP_AUTH_BROKER_TOKEN?.length);
}
function rawBroker(settings: Settings): { url?: Json; token?: Json } {
  const raw = settings.getGlobalSettings() as { auth?: { broker?: { url?: Json; token?: Json } } };
  const broker = raw.auth?.broker;
  return { ...(broker?.url !== undefined ? { url: broker.url } : {}), ...(broker?.token !== undefined ? { token: broker.token } : {}) };
}
export function captureBroker(settings: Settings): Connection["previousBroker"] { return rawBroker(settings); }
export function brokerMatches(settings: Settings, connection: Connection): boolean {
  const current = rawBroker(settings);
  return !brokerOverridesPresent() && current.url === connection.url && current.token === brokerTokenValue(connection.token);
}
/** OMP's built-in settings listener swaps AuthStorage live, including its encrypted cache. */
export async function configureBroker(settings: Settings, connection: Connection): Promise<void> {
  const token = brokerTokenValue(connection.token);
  if (brokerOverridesPresent()) throw new UserError("Unset OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN before pairing");
  const previous = captureBroker(settings);
  try {
    cfgAuthBrokerToken.set(settings, token);
    cfgAuthBrokerUrl.set(settings, connection.url);
    await settings.flush();
  } catch {
    try { await writeBroker(settings, previous); }
    catch { throw new UserError("Broker configuration could not be saved or restored; reset auth.broker.url and auth.broker.token before retrying"); }
    throw new UserError("Broker configuration could not be saved; previous settings restored");
  }
}
/** Never overwrite broker settings that the operator changed after enrollment. */
export async function restoreBroker(settings: Settings, connection: Connection): Promise<boolean> {
  const current = rawBroker(settings);
  if (!equal(current, { url: connection.url, token: brokerTokenValue(connection.token) }) &&
      !equal(current, { url: connection.url, token: connection.token })) return false;
  await writeBroker(settings, connection.previousBroker);
  return true;
}

async function writeBroker(settings: Settings, value: Connection["previousBroker"]): Promise<void> {
  if (typeof value.token === "string") cfgAuthBrokerToken.set(settings, value.token);
  else cfgAuthBrokerToken.unset(settings);
  if (typeof value.url === "string") cfgAuthBrokerUrl.set(settings, value.url);
  else cfgAuthBrokerUrl.unset(settings);
  await settings.flush();
}

/** Upgrade only the previous plugin's exact owned literal; never redirect operator edits. */
export async function upgradeBrokerToken(settings: Settings, connection: Connection): Promise<void> {
  if (equal(rawBroker(settings), { url: connection.url, token: connection.token }) && !brokerOverridesPresent()) {
    await configureBroker(settings, connection);
  }
}

const MIGRATION_CANCELLED = "Credential migration was cancelled; some credentials may already be on the broker. Local copies were not removed.";

/** Pin the consented destination in the child's environment, never its argv or output. */
export async function migrateCredentials(connection: Connection, oauth: boolean, environment: boolean, signal: AbortSignal): Promise<boolean> {
  requireDeviceToken(connection.token);
  try {
    signal.throwIfAborted();
    // The host CLI, not this externally loaded extension, lives in Bun's virtual FS.
    const compiled = Bun.main.startsWith("/$bunfs/") || /^[a-z]:[\\/]~BUN[\\/]/i.test(Bun.main);
    const command = compiled ? [process.execPath] : [process.execPath, Bun.main];
    command.push("auth-broker", "migrate", "--from-local", "--json");
    if (oauth) command.push("--include-oauth");
    if (environment) command.push("--include-env");
    const child = Bun.spawn(command, {
      env: { ...process.env, OMP_AUTH_BROKER_URL: connection.url, OMP_AUTH_BROKER_TOKEN: connection.token },
      stdout: "ignore", stderr: "ignore", signal, timeout: 120_000,
    });
    const code = await child.exited;
    if (signal.aborted) throw new UserError(MIGRATION_CANCELLED);
    return code === 0;
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (signal.aborted) throw new UserError(MIGRATION_CANCELLED);
    throw new UserError("Could not execute credential migration with this OMP runtime. Run auth-broker migrate --from-local --dry-run directly through your OMP launcher (including nix run) for details. Local credential copies were not removed.");
  }
}
