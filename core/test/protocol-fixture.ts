/** Tests exercise the same source preparation and event pipeline as real gateway routes. */
import type { TestContext } from "node:test";
import type { ApiProtocol, Provider } from "../src/types.ts";
import type { Json, Tool } from "../src/protocol.ts";
import { prepareOutbound } from "../src/outbound.ts";
import { readOutput } from "../src/upstream-events.ts";
import { Downstream } from "../src/downstream.ts";

export async function outboundBody(t: TestContext, protocol: ApiProtocol, body: Json, target: ApiProtocol = "chat", extra: Partial<Provider> = {}) {
  const provider: Provider = { id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:1/v1", models: ["mock-coder"], route: "chat-translate", routePinned: true, streamUsage: true, protocols: [target], createdAt: "", ...extra };
  let sent: Json | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return Response.json({}); });
  const prepared = prepareOutbound(provider, { protocol, body, model: "mock-coder", stream: body.stream === true });
  await prepared.send("fixture-key", new AbortController().signal);
  if (!sent) throw new Error("selected outbound adapter did not send its request");
  return { body: sent, dropped: prepared.dropped, tools: prepared.tools };
}

export function sseResponse(events: Json[]): Response {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
export async function convertOutput(upstream: Response, source: ApiProtocol, target: ApiProtocol, tools: Tool[] = []) {
  let wire = "";
  const downstream = new Downstream(target, "mock-coder", "fixture", source, tools, chunk => { wire += chunk; });
  downstream.start();
  for await (const event of readOutput(upstream, source)) downstream.accept(event);
  downstream.finish();
  const events = wire.split(/\r?\n\r?\n/).flatMap(block => { const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n"); return !data || data === "[DONE]" ? [] : [JSON.parse(data) as Json]; });
  return { wire, events, result: downstream.result(), downstream };
}
