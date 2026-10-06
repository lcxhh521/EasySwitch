import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

type Json = Record<string, any>;

/**
 * A stand-in for Google's OAuth endpoints and Cloud Code Assist, enough for the whole Antigravity sign-in and a
 * conversation: it checks the PKCE proof and the client, hands out short-lived tokens, finds a project, lists
 * models and answers `streamGenerateContent` from a script.
 */
export interface FakeGoogle {
  base: string;
  server: Server;
  /** Everything the API endpoints received. */
  api: Array<{ path: string; authorization?: string; userAgent?: string; body: Json }>;
  tokenCalls: Array<Record<string, string>>;
  /** The next streamGenerateContent answer: SSE data objects, or a failing status. */
  script: () => { status?: number; text?: string; events?: Json[] };
  /** Seconds the access tokens live. */
  expiresIn: number;
  /** Whether loadCodeAssist already knows a project (otherwise the account is onboarded). */
  hasProject: boolean;
  accessCounter: number;
  close(): void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => resolve(b)); });
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  let challenge = "";
  const fake: FakeGoogle = {
    base: "", server: undefined as unknown as Server, api: [], tokenCalls: [], expiresIn: 3600, hasProject: true, accessCounter: 0,
    script: () => ({ events: [] }), close() { server.closeAllConnections(); server.close(); },
  };
  const issue = () => `ya29.fake-access-${++fake.accessCounter}`;
  let valid = new Set<string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const raw = await readBody(req);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
      fake.tokenCalls.push(form);
      if (!form.client_id || !form.client_secret) return send(400, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        if (form.code !== "authcode") return send(400, { error: "invalid_grant" });
        if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== challenge) return send(400, { error: "invalid_grant", error_description: "bad verifier" });
      } else if (form.grant_type === "refresh_token") {
        if (form.refresh_token !== "1//fake-refresh") return send(400, { error: "invalid_grant" });
      } else return send(400, { error: "unsupported_grant_type" });
      const access = issue();
      valid = new Set([...valid, access]);
      return send(200, { access_token: access, refresh_token: "1//fake-refresh", expires_in: fake.expiresIn, token_type: "Bearer" });
    }
    if (url.pathname === "/userinfo") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      return valid.has(token) ? send(200, { email: "Person@Example.com", id: "1234" }) : send(401, { error: "bad token" });
    }
    if (url.pathname.startsWith("/v1internal:")) {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const body = raw ? (JSON.parse(raw) as Json) : {};
      fake.api.push({ path: url.pathname + url.search, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(req.headers["user-agent"] ? { userAgent: String(req.headers["user-agent"]) } : {}), body });
      if (!valid.has(token)) return send(401, { error: { code: 401, message: "bad token" } });
      if (url.pathname.endsWith(":loadCodeAssist")) return send(200, fake.hasProject ? { cloudaicompanionProject: "proj-fake" } : {});
      if (url.pathname.endsWith(":onboardUser")) return send(200, { done: true, response: { cloudaicompanionProject: { id: "proj-onboarded" } } });
      if (url.pathname.endsWith(":fetchAvailableModels")) return send(200, { models: { "gemini-fake-pro": { displayName: "Gemini Fake Pro" }, "claude-fake": { displayName: "Claude Fake" }, chat_20706: { displayName: "internal" } } });
      if (url.pathname.endsWith(":streamGenerateContent")) {
        const answer = fake.script();
        if (answer.status) return send(answer.status, answer.text ? { error: { code: answer.status, message: answer.text, status: "RESOURCE_EXHAUSTED" } } : {});
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of answer.events ?? []) res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
        return void res.end();
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  fake.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.server = server;
  /** The browser's step: the sign-in URL carries the PKCE challenge; remember it and return where Google would send the user. */
  (fake as FakeGoogle & { authorize?: (url: string) => string }).authorize = (url: string) => {
    const q = new URL(url).searchParams;
    challenge = q.get("code_challenge") ?? "";
    return `${q.get("redirect_uri")}?code=authcode&state=${q.get("state")}`;
  };
  return fake;
}

export function authorizeUrl(fake: FakeGoogle, url: string): string {
  return (fake as FakeGoogle & { authorize: (u: string) => string }).authorize(url);
}
