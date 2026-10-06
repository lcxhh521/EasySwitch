/** Explicit client for historical loopback fixtures. Production never imports this module. */
import { gatewayTokens, sessionToken } from "../src/gateway-auth.ts";
import { agentOfHeaders } from "../src/gateway-chat.ts";

const guardedFetch = globalThis.fetch;
export const fixtureToken = sessionToken;

function client(allowNativeClaude: boolean): typeof fetch {
  return (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    const gateway = /^\/(?:v1(?:\/|$)|v1beta(?:\/|$)|responses(?:\/|$)|chat\/completions|messages(?:\/|$)|models(?:\/|$)|mcp(?:\/|$)|backend-api\/codex)/.test(url.pathname);
    const values = [headers.get("x-easyswitch-session"), headers.get("authorization"), headers.get("x-api-key"), headers.get("x-goog-api-key"), url.searchParams.get("key")];
    // Explicit local credentials are never repaired: forged/revoked/expired tokens must fail.
    const suppliedLocal = values.some(value => value && /^(?:Bearer\s+)?es-session-/i.test(value));
    if (gateway && !suppliedLocal) {
      const identity = agentOfHeaders(Object.fromEntries(headers), allowNativeClaude ? "claude" : "chat");
      headers.set("x-easyswitch-session", gatewayTokens.issue(identity, { allowNativeClaude }).token);
    }
    return guardedFetch(input, { ...init, headers });
  };
}

export const fixtureFetch = client(false);
/** Only fake-Anthropic fixtures opt into the native permission, with synthetic vendor headers. */
export const nativeFixtureFetch = client(true);
