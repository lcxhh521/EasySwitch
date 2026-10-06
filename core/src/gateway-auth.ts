import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { SecretStore } from "./secrets.ts";

/**
 * Who may use the gateway. Every launch is given a token that EasySwitch signed with a key that exists only on this
 * machine (`es-session-<agent>-<nonce>-<signature>`), and the gateway answers only requests that carry one. A web page
 * open in the browser, or any program that does not hold a token, cannot spend the person's keys and subscriptions
 * just because the gateway listens on this machine's loopback address.
 *
 * The token also still names the agent (for the log and the per-agent settings): that part has not changed.
 * Without a key (unit tests that never start the server) tokens are made unsigned and nothing is enforced.
 */

const KEY_NAME = "gateway-secret";
let key: Buffer | undefined;

export function setGatewayKey(hex: string | undefined): void {
  key = hex ? Buffer.from(hex, "hex") : undefined;
}

/** The key of this install: read from the secret store, or made and kept there the first time. */
export async function loadGatewayKey(secrets: SecretStore): Promise<void> {
  let hex = await secrets.get(KEY_NAME);
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = randomBytes(32).toString("hex");
    await secrets.set(KEY_NAME, hex);
  }
  setGatewayKey(hex);
}

const signature = (payload: string): string => createHmac("sha256", key!).update(payload).digest("hex").slice(0, 20);

/** A token for one launch; `nonce` is random unless a stable one is wanted (a token written into a configuration that lasts). */
export function signToken(agentId: string, nonce: string = randomUUID()): string {
  const agent = agentId.replace(/[^a-z0-9]/g, "");
  const body = `es-session-${agent}-${nonce}`;
  return key ? `${body}-${signature(`${agent}-${nonce}`)}` : body;
}

/** The same token every time, for the apps whose settings the person fills in once. */
export const stableToken = (agentId: string): string => signToken(agentId, "stable");

/** Is this a token this installation signed? */
export function isValidToken(token: string): boolean {
  if (!key) return false;
  const m = /^es-session-([a-z0-9]+)-(.+)-([0-9a-f]{20})$/.exec(token);
  if (!m) return false;
  const expected = Buffer.from(signature(`${m[1]}-${m[2]}`));
  const given = Buffer.from(m[3]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The tokens a request carries, wherever the client puts one: Bearer, x-api-key, our own header, Gemini's key. */
export function tokensOf(headers: IncomingHttpHeaders, search = ""): string[] {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const found = [
    one(headers.authorization).replace(/^Bearer\s+/i, ""),
    one(headers["x-api-key"]), one(headers["x-easyswitch-session"]), one(headers["x-goog-api-key"]),
    new URLSearchParams(search).get("key") ?? "",
  ];
  return found.filter(t => t.startsWith("es-session-"));
}

export function requestHasValidToken(headers: IncomingHttpHeaders, search = ""): boolean {
  return tokensOf(headers, search).some(isValidToken);
}

/** The gateway's own routes: the ones that spend something. The console API has its own guard, and /health is open. */
export function isGatewayPath(path: string): boolean {
  return /^\/(v1|v1beta)(\/|$)/.test(path) || path === "/responses" || path === "/chat/completions" || path === "/mcp";
}
