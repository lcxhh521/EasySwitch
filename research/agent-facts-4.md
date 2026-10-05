# Agent fact sheet, batch 4: what is missing for agents that already have a launcher (2026-10-06)

hermes and dsh were checked against the installed programs (`--help`, `--dump-config`, `--dump-config-schema`); the other five are from memory/docs and need a `--help` run before shipping.

## hermes (checked)
- MCP: append to the private `$HERMES_HOME/config.yaml`: `mcp_servers: {easyswitch: {url: "{MCP_URL}", headers: {Authorization: "Bearer ${EASYSWITCH_MCP_TOKEN}"}, enabled: true}}`; `${VAR}` expands in config.yaml, so put the token in the spawn env (file stays stable between runs). Do not pass `-t` (narrows the toolset).
- Effort: `--reasoning none|minimal|low|medium|high|xhigh|max|ultra` (matches existing). Config key `agent.reasoning_effort`; per side task `auxiliary.<task>.reasoning_effort`.
- Sub-agent: `delegation: {model, provider, base_url, api_key, max_concurrent_children}`; base_url beats provider, so `delegation: {model: "<m>", base_url: "{gateway}/v1", api_key: "es-session-hermes-private"}`. Extra auxiliary tasks: review, session_search, curator.
- Headless `hermes chat -Q -q "task"` is right; risk: dangerous commands may still wait for approval (`--yolo`); `--source tool` hides the session from the user's list.

## dsh (checked)
- MCP: not possible (no MCP client or mcpServers key in the shipped plugins; adding one means `dsh plugin add`, i.e. changing a profile).
- Effort: patch `agent-default-model` `config.reasoningEffort` off|minimal|low|medium|high|xhigh|max, but the model in `llm-pi-ai` must carry `reasoningEfforts: {off: none, low: low, ..., max: max}` or dsh offers no levels (our patch writes neither today).
- Sub-agent: patch id `tool-subagent`, `config.agentOptions: {provider: easyswitch, model, reasoningEffort, maxTokens}` and the patch REPLACES the config, so carry back `provider: spawn, toolName: subagent, backgroundMode: continuable`. Title model: id `session-title-llm` (+ provider, model; carry back targetWords 5, targetCjkCharacters 10, maxInputBytes 4096, maxOutputTokens 64, timeoutMs 60000). Compaction: id `compaction-basic`, keys `summarizationProvider`/`summarizationModel`. All models must be listed in the easyswitch route's `models`.
- Headless `dsh headless --patch p.yml "task"` right; validate with `--dump-config`; permissions via `DSH_PERMISSION_MODE`.

## opencode
- MCP: merge into `OPENCODE_CONFIG_CONTENT`: `"mcp":{"easyswitch":{"type":"remote","url":"{MCP_URL}","headers":{"Authorization":"Bearer {TOKEN}"},"enabled":true}}` (shape inferred). We write only the V1 `provider` key; OpenCode 2 may want `providers`.
- Effort: `--variant <name>`; variants must be written in the model entry: `models.<m>.variants.<level> = {"reasoningEffort": "<level>"}`. Sub-agent: `"agent":{"general":{"model":..},"explore":{"model":..}}` (inferred). Headless `opencode run --model easyswitch/<m> "task"` right; maybe `--format json`; non-interactive permission prompts may block (a `permission` key, name inferred).

## copilot-cli
- MCP (inferred): `--additional-mcp-config '<json>'` or `@file`: `{"mcpServers":{"easyswitch":{"type":"http","url":"{MCP_URL}","headers":{"Authorization":"Bearer {TOKEN}"},"tools":["*"]}}}`; alternative private `COPILOT_HOME` with `mcp-config.json`.
- Effort: settings key `effortLevel` low|medium|high|xhigh; a `--effort` flag may exist (name unsure). Sub-agent: none per launch.
- Headless needs `--allow-all-tools` (and optionally `-s`); BYOK extras `COPILOT_PROVIDER_WIRE_API`, `COPILOT_OFFLINE=true`.

## gemini-cli
- MCP: settings.json `mcpServers` only; per launch point `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at a private file (highest layer, merged): `{"mcpServers":{"easyswitch":{"httpUrl":"{MCP_URL}","headers":{..},"trust":true}}}`.
- Effort: no flag; only `modelConfigs.overrides[].modelConfig.generateContentConfig.thinkingConfig` ({thinkingBudget:N} / {thinkingLevel:"HIGH"}) (low confidence). Small/sub-agent: `agents.overrides.<name>.modelConfig.model` (experimental), internal aliases remap via `modelConfigs.overrides`; risk: background requests go out with native model names (gemini-2.5-flash-lite) and the gateway must handle them.
- Headless `gemini -p "task"` needs `--yolo`; if the user's settings select oauth, GEMINI_API_KEY may be ignored: write `{"security":{"auth":{"selectedType":"gemini-api-key"}}}` in the system settings file.

## qwen-code
- Least certain. MCP as gemini (`httpUrl` + `headers`), system-settings env var probably `QWEN_CODE_SYSTEM_SETTINGS_PATH` (unverified); `qwen mcp add` writes global config, unusable. Effort: none known. Small model: `fastModel` (inferred). Headless `qwen -p "task"` right, needs `--yolo`; add `--auth-type openai` (+ `--openai-base-url --openai-api-key -m`).

## aider
- MCP: not possible. Effort: `--reasoning-effort low|medium|high` (`AIDER_REASONING_EFFORT`); unknown custom model names may ignore it, safest a private `--model-settings-file` with `extra_params: {reasoning_effort: ..}`. Small: `--weak-model` (done), `--editor-model`. Headless right; add `--no-check-update --no-analytics --no-show-model-warnings`; env var for the base is OPENAI_API_BASE.

## CORRECTION (same day): dsh MCP is possible
Add to the `--patch` file an insert of the plugin `@deepseek-ai/dsh-mcp-client`, one instance per server: `- insert: [{id: mcp-easyswitch, name: '@deepseek-ai/dsh-mcp-client', config: {serverName: easyswitch, transport: streamable-http, url: "{MCP_URL}", headers: {Authorization: "Bearer {TOKEN}"}}}]` (serverName `[A-Za-z0-9_-]{1,32}`, unique). The model sees tools as `mcp__easyswitch__<tool>`; only tools are bridged. PREREQUISITE: the plugin is not in the default profile; it resolves here only through the symlink `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-client` (into the npx cache), so a private `DSH_HOME` must get that symlink/copy pre-seeded. Never `dsh plugin add` (writes the global profile). Not run end to end: validate with `dsh headless --patch p.yml --dump-config`, then run once.

## Claude desktop (checked in opencodex's ported app-bundle code)
Claude Desktop has an official third-party gateway mode: profile `{inferenceProvider:"gateway", inferenceCredentialKind:"static", inferenceGatewayBaseUrl, inferenceGatewayApiKey, modelDiscoveryEnabled, inferenceModels}` in `<userData>/configLibrary/<id>.json` plus `_meta.json` `{appliedId, entries:[{id,name}]}`. userData defaults to `.../Application Support/Claude-3p`; the env var `CLAUDE_USER_DATA_DIR` overrides it verbatim (no `-3p` suffix). Gateway mode switches the whole app to the gateway: no claude.ai features. The separate "first-party" mode intercepts claude.ai traffic with a local CA (account-ban risk): we do not do that.
