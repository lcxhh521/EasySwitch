/** Synchronous local identity check after async validation. Contains no credential values; never exported by an API. */
import { automaticProviderConfiguration } from "./automatic-approval.ts";
import type { Store } from "./store.ts";
export function automaticLocalStamp(store: Store, members: readonly string[], poolId?: string): string {
  return JSON.stringify({ pool: poolId ? store.pool(poolId) : undefined, sources: members.map(member => {
    const providerId = member.slice(0, member.indexOf("/")), provider = store.provider(providerId);
    const keyId = provider?.keys?.find(k => k.enabled)?.id;
    const account = keyId === undefined ? providerId : `${providerId}#${keyId}`;
    return [providerId, provider && automaticProviderConfiguration(provider), store.providerConfigurationRevision(providerId), store.credentialRevision(account)];
  }) });
}
