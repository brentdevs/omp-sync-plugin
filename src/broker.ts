import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgAuthBrokerToken, cfgAuthBrokerUrl } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { equal, type Connection, type Json } from "./types";

export function brokerOverridesPresent(): boolean {
  return !!(process.env.OMP_AUTH_BROKER_URL?.trim() || process.env.OMP_AUTH_BROKER_TOKEN?.trim());
}
function rawBroker(settings: Settings): { url?: Json; token?: Json } {
  const raw = settings.getGlobalSettings() as { auth?: { broker?: { url?: Json; token?: Json } } };
  const broker = raw.auth?.broker;
  return { ...(broker?.url !== undefined ? { url: broker.url } : {}), ...(broker?.token !== undefined ? { token: broker.token } : {}) };
}
export function captureBroker(settings: Settings): Connection["previousBroker"] { return rawBroker(settings); }
export function brokerMatches(settings: Settings, connection: Connection): boolean {
  const current = rawBroker(settings);
  return !brokerOverridesPresent() && current.url === connection.url && current.token === connection.token;
}
/** OMP's built-in settings listener swaps AuthStorage live, including its encrypted cache. */
export async function configureBroker(settings: Settings, connection: Connection): Promise<void> {
  if (brokerOverridesPresent()) throw new Error("Unset OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN before pairing");
  cfgAuthBrokerToken.set(settings, connection.token);
  cfgAuthBrokerUrl.set(settings, connection.url);
  await settings.flush();
}
/** Never overwrite broker settings that the operator changed after enrollment. */
export async function restoreBroker(settings: Settings, connection: Connection): Promise<boolean> {
  const current = rawBroker(settings);
  if (!equal(current, { url: connection.url, token: connection.token })) return false;
  const old = connection.previousBroker;
  if (typeof old.token === "string") cfgAuthBrokerToken.set(settings, old.token);
  else cfgAuthBrokerToken.unset(settings);
  if (typeof old.url === "string") cfgAuthBrokerUrl.set(settings, old.url);
  else cfgAuthBrokerUrl.unset(settings);
  await settings.flush();
  return true;
}

/** Pin the consented destination in the child's environment, never its argv or output. */
export async function migrateCredentials(connection: Connection, oauth: boolean, environment: boolean, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const child = Bun.spawn(["omp", "auth-broker", "migrate", "--from-local", "--json", ...(oauth ? ["--include-oauth"] : []), ...(environment ? ["--include-env"] : [])], {
    env: { ...process.env, OMP_AUTH_BROKER_URL: connection.url, OMP_AUTH_BROKER_TOKEN: connection.token },
    stdout: "ignore", stderr: "ignore", signal, timeout: 120_000,
  });
  return await child.exited === 0;
}
