# Cursor adapter: facts, what is built, what is not — 2026-10-06

Source: reading opencodex (MIT) `src/oauth/cursor.ts` and `src/adapters/cursor/*` (it uses a 15k-line generated protobuf file; we hand-wrote the few messages we need in `core/src/cursor/`). Marked (inferred) = my reading, not in the source.

## Built (core/src/cursor/, tests in core/test/cursor.test.ts with core/test/fake-cursor.ts)
- Login: `GET https://cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli` in the browser; poll `GET https://api2.cursor.sh/auth/poll?uuid&verifier` (404 waiting; 200 `{accessToken, refreshToken}`; 400/401/403/410 end). No client id or secret. Refresh: `POST /auth/exchange_user_api_key` with `Bearer <refresh>` and body `{}`. Account id from the JWT `sub`/`email`.
- Turn: `POST /agent.v1.AgentService/Run` over HTTP/2, `content-type: application/connect+proto`, headers `connect-protocol-version: 1`, `te: trailers`, `x-ghost-mode: true`, `x-cursor-client-version: cli-2026.07.08-0c04a8a`, `x-cursor-client-type: cli`, `x-request-id`, `x-session-id`; no user-agent, no checksum header. First frame = AgentClientMessage{run_request=1}; heartbeat `client_heartbeat=7` every 5 s; Connect frames (flags 0x01 compressed, 0x02 end-of-stream, end frame JSON `{}` or `{"error":{code,message,details}}`).
- Run request fields: `conversation_state=1` (`root_prompt_messages_json=1` repeated blob ids = SHA-256 of JSON blobs: system `{"role":"system","content":...}`, history `{"role":..., "content":[{"type":"text","text":...}]}`), `action=2` (`user_message_action=1` -> `user_message=1{text=1,message_id=2,mode=4}`, `request_context=2{env=4{time_zone=10}}`), `model_details=3{model_id=1,display_model_id=3,display_name=4,display_name_short=5}`, `mcp_tools=4` (empty: otherwise Cursor adds its own native tools, ~10-15k tokens), `conversation_id=5` (`cursor_` + uuid without dashes).
- Server messages: `interaction_update=1` (`text_delta=1`, `thinking_delta=4`, `token_delta=8`, `heartbeat=13`, `turn_ended=14`, tool-related 2/3/7/15), `exec_server_message=2`, `conversation_checkpoint_update=3` (`token_details=5{used_tokens=1,max_tokens=2}`), `kv_server_message=4` (`id=1`, `get_blob_args=2{blob_id=1}`, `set_blob_args=3{blob_id=1,blob_data=2}`), `interaction_query=7`. Replies: `kv_client_message=3{id=1, get_blob_result=2{blob_data=1} | set_blob_result=3{}}`; for `exec` with `request_context_args=10`: `exec_client_message=2{id=1, exec_id=15, request_context_result=10{success=1{request_context=1{}}}}`.
- Usage: no authoritative frame; output = sum of `token_delta`, context = checkpoint `used_tokens`, input = context - output.
- Models: `POST /agent.v1.AgentService/GetUsableModels`, `content-type: application/proto`, EMPTY body (a framed or non-empty body is refused), client version `cli-2026.02.13-41ac335`; answer `models=1` repeated ModelDetails (`model_id=1`). Ids already carry the thinking level (`...-high`).
- Errors (by words): unauthenticated/permission_denied -> sign in again; resource_exhausted -> rate/plan limit; failed_precondition -> plan does not allow the model (not retried); unavailable/overloaded -> busy.

## Not built
- Tool calls (B71): the server's `exec_server_message` has a family of request types (read, write, shell, ls, grep, fetch, mcp...), each with its own result message; the field numbers are in opencodex's `gen/agent_pb.ts` and were not extracted. A request for a tool currently ends the turn with a plain error.
- `interaction_query` answers (`interaction_response=6`): not extracted; we end the turn with an error.
- Checkpoint reuse between turns (opencodex keeps the last checkpoint 15 min to avoid replaying history); we replay the whole history each turn (stateless).
- Thinking-level suffix rules per model, "Max Mode" (`-1m` variants), Grok `requested_model.parameters`.
- Retry before the request is committed (opencodex retries up to 3 times on connection resets).

## Unverified against the real service (needs a real account)
- Whether sending only root blobs without `turns=8` is accepted (opencodex sends both); whether the empty `mcp_tools` really stops native tool requests; whether `mode=1` and the JSON blob shapes are accepted; whether the server compresses frames (we fail on a compressed frame); whether the client-version label needs updating; how a bare HTTP 401 on Run looks.
