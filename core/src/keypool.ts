import type { Provider, ProviderKey } from "./types.ts";
import type { SecretStore } from "./secrets.ts";
import type { Store } from "./store.ts";

/**
 * A provider's key pool: several of the user's own keys (their subscriptions,
 * their relay tokens) under one provider, tried in order so one exhausted key
 * never stops the work. Everything is local: secrets live in this Mac's
 * Keychain and requests go straight to the provider — this is one person
 * managing their own subscriptions, not account sharing.
 *
 * Policies, kept deliberately boring:
 *  - rotation is round-robin (an in-memory cursor; restart resets it, which is fine);
 *  - a key that just failed auth (401/403) or hit a rate limit (429) rests for
 *    a while and the others go first — never automatically in a way that hides
 *    the failure: the rest and the reason are shown in the console;
 *  - when every key rests, the least-recently-rested one is tried anyway;
 *    a working request beats a polite refusal.
 * Secrets live in the Keychain under `<provider id>#<key id>`. Providers saved
 * before pools keep their single key under the bare provider id.
 */

/** Keychain account for one pool key. */
export function keySecretId(providerId: string, keyId: string): string {
  return `${providerId}#${keyId}`;
}

/** A fresh key id; only used to pair the secret with its metadata. */
export function newKeyId(): string {
  return `k-${crypto.randomUUID().slice(0, 8)}`;
}

export const REST_AFTER_AUTH_FAILURE_MS = 10 * 60_000;
export const REST_AFTER_RATE_LIMIT_MS = 60_000;

/** Failures that are the key's own, not the request's. */
export function isKeyFailure(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

const cursor = new Map<string, string>();

/** The key to try: enabled, not resting (unless all are), rotating round-robin. */
export function pick(provider: Provider): ProviderKey | undefined {
  const keys = (provider.keys ?? []).filter(k => k.enabled);
  if (!keys.length) return undefined;
  const now = Date.now();
  const usable = keys.filter(k => !k.restUntil || new Date(k.restUntil).getTime() <= now);
  // Start after the key used last time; with no cursor yet, the first key.
  const last = cursor.get(provider.id);
  if (usable.length) {
    const start = last ? Math.max(0, usable.findIndex(k => k.id === last)) : usable.length - 1;
    for (let n = 1; n <= usable.length; n += 1) {
      const key = usable[(start + n) % usable.length]!;
      cursor.set(provider.id, key.id);
      return key;
    }
  }
  // Everything rests: serve the key that rested longest ago instead of refusing.
  const rested = [...keys].sort((a, b) => (a.restUntil ?? "").localeCompare(b.restUntil ?? ""))[0];
  if (rested) cursor.set(provider.id, rested.id);
  return rested;
}

/** Reads the secret for the key a request will use (legacy single key when there is no pool). */
/** Supplies the token for a provider that is a ChatGPT plan; the server sets it (see siwc.ts). */
let planToken: ((provider: Provider) => Promise<string>) | undefined;
export function setPlanToken(fn: ((provider: Provider) => Promise<string>) | undefined): void {
  planToken = fn;
}

/** Supplies the access token for a provider that is a Google Antigravity account; the server sets it (see antigravity.ts). */
let antigravityToken: ((provider: Provider) => Promise<string>) | undefined;
export function setAntigravityToken(fn: ((provider: Provider) => Promise<string>) | undefined): void {
  antigravityToken = fn;
}

/** Supplies the access token for a provider that is a Kimi Code account; the server sets it (see kimi.ts). */
let kimiToken: ((provider: Provider) => Promise<string>) | undefined;
export function setKimiToken(fn: ((provider: Provider) => Promise<string>) | undefined): void {
  kimiToken = fn;
}

/** Supplies the access token for a provider that is a Cursor account; the server sets it (see cursor/auth.ts). */
let cursorToken: ((provider: Provider) => Promise<string>) | undefined;
export function setCursorToken(fn: ((provider: Provider) => Promise<string>) | undefined): void {
  cursorToken = fn;
}

/** Supplies the access token for a provider that is a Google Vertex AI project; the server sets it (see vertex.ts). */
let vertexToken: ((provider: Provider) => Promise<string>) | undefined;
export function setVertexToken(fn: ((provider: Provider) => Promise<string>) | undefined): void {
  vertexToken = fn;
}

export async function pickKey(secrets: SecretStore, provider: Provider): Promise<{ keyId?: string; apiKey: string | undefined }> {
  if (provider.plan && planToken) return { apiKey: await planToken(provider) };
  if (provider.antigravity && antigravityToken) return { apiKey: await antigravityToken(provider) };
  if (provider.kimi && kimiToken) return { apiKey: await kimiToken(provider) };
  if (provider.cursor && cursorToken) return { apiKey: await cursorToken(provider) };
  if (provider.vertex && vertexToken) return { apiKey: await vertexToken(provider) };
  const key = pick(provider);
  if (!key) return { apiKey: await secrets.get(provider.id) };
  return { keyId: key.id, apiKey: await secrets.get(keySecretId(provider.id, key.id)) };
}

/** Record how a key did. Only failures touch the disk; successes just move the cursor. */
export async function markResult(store: Store, provider: Provider, keyId: string | undefined, status: number): Promise<Provider> {
  const key = keyId && provider.keys?.find(k => k.id === keyId);
  if (!key) return provider;
  if (isKeyFailure(status)) {
    const reason = status === 401 ? "Key 被拒（无效或过期）" : status === 403 ? "Key 没有权限" : "限流";
    const restMs = status === 429 ? REST_AFTER_RATE_LIMIT_MS : REST_AFTER_AUTH_FAILURE_MS;
    key.restUntil = new Date(Date.now() + restMs).toISOString();
    key.lastError = { at: new Date().toISOString(), status, reason };
  } else {
    key.restUntil = undefined;
    key.lastError = undefined;
  }
  store.upsertProvider(provider);
  return provider;
}

/**
 * Runs a request against the pool: try a key; if the failure is the key's own
 * and another key is available, rest this one and try the next. Network errors
 * are passed through untouched — they are not a key's fault.
 */
export async function withKey(
  store: Store, secrets: SecretStore, provider: Provider,
  run: (apiKey?: string) => Promise<Response | Error>,
): Promise<{ response: Response | Error; keyId?: string }> {
  const first = await pickKey(secrets, provider);
  const response = await run(first.apiKey);
  if (response instanceof Error || !isKeyFailure(response.status)) return { response, keyId: first.keyId };
  const updated = await markResult(store, provider, first.keyId, response.status);
  const next = await pickKey(secrets, updated);
  if (!next.apiKey || next.keyId === first.keyId) return { response, keyId: first.keyId };
  await response.body?.cancel();
  const retry = await run(next.apiKey);
  return { response: retry, keyId: next.keyId };
}
