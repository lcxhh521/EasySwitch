import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

type Json = Record<string, any>;

/**
 * A stand-in for OpenAI's sign-in and Responses API, enough to run the whole "Continue with ChatGPT"
 * flow offline: discovery, JWKS, authorize (redirects straight back), token (code and refresh),
 * revoke, the model list, and POST /v1/responses with the preview's rules enforced.
 */
export interface FakeOpenAI {
  server: Server;
  base: string;
  authorizeParams: URLSearchParams[];
  tokenCalls: Array<Record<string, string>>;
  responsesRequests: Array<{ authorization: string | undefined; body: Json }>;
  revoked: string[];
  /** Makes the next refresh fail like a revoked login. */
  failRefresh: boolean;
  /** Replies for the next /v1/responses call: an HTTP status to return instead of a stream. */
  responsesStatus?: { status: number; body: Json };
  /** Headers every Responses answer carries, such as the plan's usage (`x-codex-primary-used-percent`). */
  responsesHeaders?: Record<string, string>;
  tokenLifetimeSeconds: number;
  /** Codex client: how many device-code polls answer "not yet" before the user has finished. */
  devicePending: number;
  deviceCalls: Array<{ path: string; body: Json }>;
  codexRequests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: Json }>;
  /** The account the Codex access token says it belongs to. */
  codexAccountId: string;
  /** What the stream says; defaults to "Hello from the plan". */
  events: (body: Json) => Array<[string, Json]>;
  close(): void;
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const fake = { authorizeParams: [], tokenCalls: [], responsesRequests: [], revoked: [], failRefresh: false, tokenLifetimeSeconds: 3600, devicePending: 0, deviceCalls: [], codexRequests: [], codexAccountId: "acct-123" } as unknown as FakeOpenAI;
  let codexAccess = "";
  let codexRefresh = "";
  const CODEX_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
  const sessions = new Map<string, { challenge: string; nonce: string; redirect: string; clientId: string }>();
  let counter = 0;
  let refreshToken = "";
  let accessToken = "";

  const sign = (claims: Json) => {
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
    return `${head}.${body}.${sig}`;
  };

  fake.events = () => [
    ["response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "Hello from " }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: "the plan" }],
    ["response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15, input_tokens_details: { cached_tokens: 3 } } } }],
  ];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", fake.base);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      if (url.pathname === "/.well-known/openid-configuration") return send(200, { issuer: fake.base, jwks_uri: `${fake.base}/jwks`, revocation_endpoint: `${fake.base}/revoke` });
      if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
      if (url.pathname === "/api/accounts/authorize") {
        fake.authorizeParams.push(url.searchParams);
        const clientId = url.searchParams.get("client_id") === "dynamic_agent_client" ? "oaiapp_fake123" : String(url.searchParams.get("client_id"));
        const code = `code-${++counter}`;
        sessions.set(code, { challenge: String(url.searchParams.get("code_challenge")), nonce: String(url.searchParams.get("nonce")), redirect: String(url.searchParams.get("redirect_uri")), clientId });
        const back = new URL(String(url.searchParams.get("redirect_uri")));
        back.searchParams.set("code", code);
        back.searchParams.set("state", String(url.searchParams.get("state")));
        if (url.searchParams.get("client_id") === "dynamic_agent_client") back.searchParams.set("client_id", clientId);
        return res.writeHead(302, { location: back.toString() }).end();
      }
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
        fake.tokenCalls.push(form);
        if (form.grant_type === "authorization_code") {
          const s = sessions.get(form.code ?? "");
          const verifierOk = s && createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === s.challenge;
          if (!s || !verifierOk || form.redirect_uri !== s.redirect || form.client_id !== s.clientId) return send(400, { error: "invalid_grant" });
          sessions.delete(form.code!);
          accessToken = `at-${++counter}`;
          refreshToken = `rt-${counter}`;
          return send(200, {
            access_token: accessToken, refresh_token: refreshToken, expires_in: fake.tokenLifetimeSeconds, token_type: "Bearer",
            scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
            id_token: sign({ iss: fake.base, aud: s.clientId, sub: "user-1", email: "person@example.com", exp: Math.floor(Date.now() / 1000) + 600, nonce: s.nonce }),
          });
        }
        if (form.grant_type === "refresh_token") {
          if (fake.failRefresh || form.refresh_token !== refreshToken) return send(400, { error: "invalid_grant" });
          accessToken = `at-${++counter}`;
          refreshToken = `rt-${counter}`;
          return send(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: fake.tokenLifetimeSeconds, token_type: "Bearer" });
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      // --- the Codex client: device code, its token endpoint, and the Codex backend
      if (url.pathname === "/api/accounts/deviceauth/usercode" && req.method === "POST") {
        const body = JSON.parse(raw || "{}") as Json;
        fake.deviceCalls.push({ path: url.pathname, body });
        if (body.client_id !== CODEX_CLIENT) return send(400, { error: "bad client" });
        return send(200, { user_code: "ABCD-1234", device_auth_id: "dev-1", interval: "3" });
      }
      if (url.pathname === "/api/accounts/deviceauth/token" && req.method === "POST") {
        const body = JSON.parse(raw || "{}") as Json;
        fake.deviceCalls.push({ path: url.pathname, body });
        if (fake.devicePending > 0) { fake.devicePending -= 1; return send(404, { error: "authorization_pending" }); }
        return send(200, { authorization_code: "dcode", code_verifier: "dver" });
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
        fake.tokenCalls.push(form);
        const exp = Math.floor(Date.now() / 1000) + fake.tokenLifetimeSeconds;
        const access = () => sign({ exp, "https://api.openai.com/auth": { chatgpt_account_id: fake.codexAccountId } });
        if (form.grant_type === "authorization_code") {
          if (form.client_id !== CODEX_CLIENT || form.code !== "dcode" || form.code_verifier !== "dver" || form.redirect_uri !== `${fake.base}/deviceauth/callback`) return send(400, { error: "invalid_grant" });
          codexAccess = access();
          codexRefresh = `crt-${++counter}`;
          return send(200, { access_token: codexAccess, refresh_token: codexRefresh, expires_in: fake.tokenLifetimeSeconds, id_token: sign({ iss: fake.base, aud: CODEX_CLIENT, sub: "codex-user-1", email: "codex@example.com", exp: Math.floor(Date.now() / 1000) + 600 }) });
        }
        if (form.grant_type === "refresh_token" && form.client_id === CODEX_CLIENT && form.refresh_token === codexRefresh && !fake.failRefresh) {
          codexAccess = access() + "";
          codexRefresh = `crt-${++counter}`;
          return send(200, { access_token: codexAccess, refresh_token: codexRefresh, expires_in: fake.tokenLifetimeSeconds });
        }
        return send(400, { error: "invalid_grant" });
      }
      if (url.pathname.startsWith("/backend-api/codex/")) {
        const headers = { ...req.headers };
        const rest = url.pathname.slice("/backend-api/codex".length);
        const body = raw ? (JSON.parse(raw) as Json) : {};
        fake.codexRequests.push({ path: rest, headers, body });
        if (req.headers.authorization !== `Bearer ${codexAccess}` || req.headers["chatgpt-account-id"] !== fake.codexAccountId) return send(401, { detail: "unauthorized" });
        if (rest === "/models") return send(200, { models: [{ slug: "gpt-codex-fake", display_name: "Codex Fake", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] }] });
        if (rest === "/responses" && req.method === "POST") {
          if (!body.instructions) return send(400, { detail: "Instructions are required" });
          if (body.store !== false || body.stream !== true) return send(400, { detail: "store must be false and stream true" });
          if ("temperature" in body || "max_output_tokens" in body) return send(400, { detail: "Unsupported parameter" });
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const [event, data] of fake.events(body)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return void res.end();
        }
        return send(404, {});
      }
      if (url.pathname === "/revoke") {
        fake.revoked.push(String(new URLSearchParams(raw).get("token")));
        return res.writeHead(200).end();
      }
      if (url.pathname === "/v1/models") {
        if (req.headers.authorization !== `Bearer ${accessToken}`) return send(401, { error: { message: "bad token" } });
        return send(200, { models: [{ slug: "gpt-fake", display_name: "GPT Fake", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] }, { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" }] });
      }
      if (url.pathname === "/v1/responses" && req.method === "POST") {
        const body = JSON.parse(raw || "{}") as Json;
        fake.responsesRequests.push({ authorization: req.headers.authorization, body });
        if (req.headers.authorization !== `Bearer ${accessToken}`) return send(401, { detail: "unauthorized" });
        if (fake.responsesStatus) { const r = fake.responsesStatus; fake.responsesStatus = undefined; return send(r.status, r.body, fake.responsesHeaders ?? {}); }
        // The preview's rules: these are refused, so the fake refuses them too.
        const banned = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"].find(k => k in body);
        if (banned) return send(400, { error: { code: "subscription_sharing_unsupported_capability", param: banned, message: `${banned} is not supported` } });
        if (body.store !== false || body.stream !== true) return send(400, { error: { code: "subscription_sharing_unsupported_capability", param: "store/stream", message: "store must be false and stream true" } });
        if (JSON.stringify(body.input).includes('"role":"system"')) return send(400, { error: { code: "invalid_request", message: "system items are rejected" } });
        res.writeHead(200, { "content-type": "text/event-stream", ...(fake.responsesHeaders ?? {}) });
        for (const [event, data] of fake.events(body)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return void res.end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  fake.server = server;
  fake.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.close = () => { server.closeAllConnections(); server.close(); };
  return fake;
}
