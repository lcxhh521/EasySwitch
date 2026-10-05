import { createServer, type Server } from "node:http";

type Json = Record<string, any>;

/** A stand-in for GitHub's device sign-in, the Copilot token endpoint and the Copilot chat API. */
export interface FakeGitHub {
  server: Server;
  base: string;
  pending: number;
  /** Whether the GitHub account has a Copilot subscription. */
  subscribed: boolean;
  tokensMinted: number;
  chatRequests: Array<{ headers: Record<string, string | string[] | undefined>; body: Json }>;
  /** Seconds a minted Copilot token lives. */
  lifetime: number;
  close(): void;
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const fake = { pending: 0, subscribed: true, tokensMinted: 0, chatRequests: [], lifetime: 1500 } as unknown as FakeGitHub;
  let current = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", fake.base);
      const body = raw ? (JSON.parse(raw) as Json) : {};
      const send = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      if (url.pathname === "/login/device/code") return send(200, { device_code: "dc-1", user_code: "WXYZ-9876", verification_uri: `${fake.base}/login/device`, interval: 1, expires_in: 900 });
      if (url.pathname === "/login/oauth/access_token") {
        if (body.client_id !== "Iv1.b507a08c87ecfe98" || body.device_code !== "dc-1") return send(200, { error: "bad_verification_code" });
        if (fake.pending > 0) { fake.pending -= 1; return send(200, { error: "authorization_pending" }); }
        return send(200, { access_token: "gho_fakegithubtoken", token_type: "bearer", scope: "read:user" });
      }
      if (url.pathname === "/user") {
        if (req.headers.authorization !== "token gho_fakegithubtoken") return send(401, {});
        return send(200, { id: 4242, login: "octo-user" });
      }
      if (url.pathname === "/copilot_internal/v2/token") {
        if (req.headers.authorization !== "token gho_fakegithubtoken") return send(401, {});
        if (!fake.subscribed) return send(404, { message: "not found" });
        current = `copilot-tok-${++fake.tokensMinted}`;
        return send(200, { token: current, expires_at: Math.floor(Date.now() / 1000) + fake.lifetime, endpoints: { api: `${fake.base}/copilot` } });
      }
      if (url.pathname.startsWith("/copilot/")) {
        const headers = { ...req.headers };
        if (req.headers.authorization !== `Bearer ${current}`) return send(401, { error: { message: "bad token" } });
        if (!headers["copilot-integration-id"] || !headers["editor-version"]) return send(400, { error: { message: "missing client headers" } });
        if (url.pathname === "/copilot/models") {
          return send(200, { data: [
            { id: "gpt-copilot-fake", name: "GPT Copilot Fake", model_picker_enabled: true, capabilities: { type: "chat", supports: { reasoning_effort: ["low", "medium", "high"] } } },
            { id: "embed-fake", name: "Embeddings", model_picker_enabled: true, capabilities: { type: "embeddings" } },
            { id: "hidden-fake", name: "Hidden", model_picker_enabled: false, capabilities: { type: "chat" } },
          ] });
        }
        if (url.pathname === "/copilot/chat/completions") {
          fake.chatRequests.push({ headers, body });
          return send(200, { id: "c1", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Hello from Copilot" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
        }
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
