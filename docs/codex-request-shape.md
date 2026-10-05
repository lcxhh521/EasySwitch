# What Codex sends to a custom provider (codex-cli 0.160.0)

Captured with `codex exec` pointed at a local capture server through
`-c model_providers.<id>={..., wire_api="responses"}`. No prompt text is
reproduced here.

- `POST /v1/responses`, always streaming (`stream: true`), SSE expected back.
- Headers include `session-id`, `thread-id`, `x-client-request-id`,
  `x-codex-turn-metadata`, `x-codex-window-id`, `originator`.
- Body keys: `model`, `instructions` (~17k chars of base instructions), `input`,
  `tools`, `tool_choice: "auto"`, `parallel_tool_calls: true`,
  `reasoning: { summary: "auto" }`, `store: false`,
  `include: ["reasoning.encrypted_content"]`, `prompt_cache_key` (the thread id),
  `client_metadata`.
- `input` items: `message` with roles `developer` and `user` (content parts of
  type `input_text`), later `function_call`, `function_call_output`,
  `reasoning`, and with freeform tools `custom_tool_call(_output)`.
- `tools` types seen: `function` (`exec_command`, `write_stdin`,
  `request_user_input`, `view_image`, goal tools), `namespace`
  (`multi_agent_v1`, nested functions), `web_search`.
- `wire_api = "chat"` is rejected by this Codex version.

Codex consumes `response.created`, `response.output_item.added/done`,
`response.output_text.delta`, `response.function_call_arguments.delta` and
`response.completed` (or `response.failed`).
