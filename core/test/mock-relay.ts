/**
 * A strict, chat-only OpenAI-compatible relay for tests and local demos.
 *
 * - /v1/models, /v1/chat/completions (stream and non-stream); no /v1/responses,
 *   like most relays, so the gateway must translate.
 * - Rejects roles and tool types plain Chat providers reject, so a sloppy
 *   translation fails loudly here instead of at a real relay.
 * - Scripted behaviour: probe prompts get canned answers; a coding-agent turn
 *   with a shell tool (Codex's `exec_command`, Claude Code's `Bash`) gets one
 *   shell call, then a final answer that quotes the tool output.
 */
import { createServer, type Server } from "node:http";

type Json = Record<string, unknown>;

const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);
export const MOCK_MODELS = ["mock-coder", "mock-mini"];
export const SHELL_MARKER = "easyswitch-roundtrip-ok";

function lastUserText(messages: Json[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as Json;
    if (m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
}

interface Reply {
  text?: string;
  toolCall?: { name: string; arguments: string };
}

function decide(body: Json): Reply {
  const messages = (body.messages ?? []) as Json[];
  const tools = ((body.tools ?? []) as Json[]).map(t => ((t.function ?? {}) as Json).name);
  const user = lastUserText(messages);
  const last = messages[messages.length - 1] as Json | undefined;
  if (tools.includes("get_weather") && last?.role === "user") return { toolCall: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) } };
  // EasySwitch's own MCP tool as an agent exposes it (the prefix differs between harnesses).
  const listAgents = tools.find(t => typeof t === "string" && /list_agents$/.test(t));
  if (listAgents && last?.role === "user" && /list the agents/i.test(user)) return { toolCall: { name: listAgents as string, arguments: "{}" } };
  if (/pong/.test(user) && !tools.length) return { text: "pong" };
  if (/Count from 1 to 5/.test(user)) return { text: "1 2 3 4 5" };
  if (tools.includes("exec_command") && last?.role === "user") {
    return { toolCall: { name: "exec_command", arguments: JSON.stringify({ cmd: `echo ${SHELL_MARKER}` }) } };
  }
  if (tools.includes("Bash") && last?.role === "user") {
    // Claude Code's shell tool.
    return { toolCall: { name: "Bash", arguments: JSON.stringify({ command: `echo ${SHELL_MARKER}`, description: "Print the marker" }) } };
  }
  if (last?.role === "tool") return { text: `The command printed: ${String(last.content).includes(SHELL_MARKER) ? SHELL_MARKER : String(last.content).slice(0, 80)}` };
  return { text: "Hello from the mock relay." };
}

function validate(body: Json): string | undefined {
  for (const m of (body.messages ?? []) as Json[]) {
    if (!ALLOWED_ROLES.has(String(m.role))) return `unsupported role: ${String(m.role)}`;
    if (m.role === "tool" && typeof m.tool_call_id !== "string") return "tool message without tool_call_id";
  }
  for (const t of (body.tools ?? []) as Json[]) {
    if (t.type !== "function") return `unsupported tool type: ${String(t.type)}`;
  }
  return undefined;
}

export function startMockRelay(port = 0, opts: { apiKey?: string } = {}): Promise<{ server: Server; baseUrl: string; requests: Json[]; headers: Array<Record<string, string | string[] | undefined>> }> {
  const requests: Json[] = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: MOCK_MODELS.map(id => ({ id, object: "model" })) }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const body = JSON.parse(raw) as Json;
      requests.push(body);
      headers.push({ ...req.headers });
      const invalid = validate(body);
      if (invalid) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: invalid } }));
        return;
      }
      const reply = decide(body);
      const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 };
      if (!body.stream) {
        const message: Json = { role: "assistant", content: reply.text ?? null };
        if (reply.toolCall) message.tool_calls = [{ id: "call_mock1", type: "function", function: reply.toolCall }];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: reply.toolCall ? "tool_calls" : "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: Json, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      send({ role: "assistant" });
      if (reply.text) for (const piece of reply.text.match(/.{1,6}/gs) ?? []) send({ content: piece });
      if (reply.toolCall) {
        const args = reply.toolCall.arguments;
        send({ tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: reply.toolCall.name, arguments: "" } }] });
        for (const piece of args.match(/.{1,8}/gs) ?? []) send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
      }
      send({}, reply.toolCall ? "tool_calls" : "stop");
      if ((body.stream_options as Json | undefined)?.include_usage) res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ server, baseUrl: `http://127.0.0.1:${actual}/v1`, requests, headers });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_RELAY_PORT ?? 18790);
  const { baseUrl } = await startMockRelay(port);
  console.log(`mock relay on ${baseUrl}  (models: ${MOCK_MODELS.join(", ")})`);
}
