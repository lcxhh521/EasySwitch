import { createServer, type Server } from "node:http";

/** A stand-in for Kimi: the device-code login on one host, the coding endpoint (models and chat) on another path. */
export interface FakeKimi {
  base: string; auth: string; api: string;
  calls: Array<{ path: string; headers: Record<string, string | string[] | undefined>; form: Record<string, string>; json?: any }>;
  /** How many polls answer "pending" before the login completes. */
  pending: number; refreshToken: string; accessExp: number; chatStatus: number;
  close(): void;
}

const jwt = (claims: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

export async function startFakeKimi(): Promise<FakeKimi> {
  const fake: FakeKimi = { base: "", auth: "", api: "", calls: [], pending: 1, refreshToken: "kimi-refresh-1", accessExp: Math.floor(Date.now() / 1000) + 3600, chatStatus: 200, close() { server.closeAllConnections(); server.close(); } };
  let n = 0;
  const access = () => jwt({ user_id: "u-123", email: "Member@Example.com", exp: fake.accessExp, n: ++n });
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const isJson = String(req.headers["content-type"]).includes("json");
      const form = isJson ? {} : Object.fromEntries(new URLSearchParams(raw));
      fake.calls.push({ path, headers: req.headers, form, ...(isJson && raw ? { json: JSON.parse(raw) } : {}) });
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (path === "/api/oauth/device_authorization") return send(200, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: `${fake.base}/device`, verification_uri_complete: `${fake.base}/device?code=ABCD-1234`, expires_in: 600, interval: 1 });
      if (path === "/api/oauth/token") {
        if (form.grant_type === "refresh_token") return form.refresh_token === fake.refreshToken ? send(200, { access_token: access(), token_type: "Bearer" }) : send(400, { error: "invalid_grant" });
        if (fake.pending-- > 0) return send(400, { error: "authorization_pending" });
        return send(200, { access_token: access(), refresh_token: fake.refreshToken, token_type: "Bearer" });
      }
      const bearer = String(req.headers.authorization ?? "");
      if (path === "/coding/v1/models") return /^Bearer .+/.test(bearer) ? send(200, { data: [{ id: "kimi-for-coding" }, { id: "k3" }] }) : send(401, {});
      if (path === "/coding/v1/chat/completions") {
        if (!/^Bearer .+/.test(bearer)) return send(401, { error: { message: "no token" } });
        if (fake.chatStatus !== 200) return send(fake.chatStatus, { error: { message: "no" } });
        return send(200, { id: "c1", object: "chat.completion", model: "kimi-for-coding", choices: [{ index: 0, message: { role: "assistant", content: "Kimi says hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
      }
      send(404, {});
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  fake.base = `http://127.0.0.1:${port}`; fake.auth = fake.base; fake.api = `${fake.base}/coding/v1`;
  return fake;
}
