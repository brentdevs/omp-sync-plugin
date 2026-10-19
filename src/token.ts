import { UserError } from "./errors";

/** Exact server format: 32 random bytes encoded base64url after omps_. */
export function isDeviceToken(value: unknown): value is string {
  return typeof value === "string" && /^omps_[A-Za-z0-9_-]{43}$/.test(value);
}
export function requireDeviceToken(value: unknown): string {
  if (!isDeviceToken(value)) throw new UserError("The server returned an unsupported device token; no broker configuration was changed");
  return value;
}
/** OMP resolves configured token strings as commands or environment references, not literals.
 * A fixed printf of a strictly validated alphabet produces the literal bearer, without
 * evaluating token bytes as code or allowing environment-name substitution.
 */
export function brokerTokenValue(token: string): string {
  return `!printf '%s' '${requireDeviceToken(token)}'`;
}
