# Agent fact sheet, batch 3: codebuddy, openclaw, trae-agent, atomcode, amp (2026-10-06)

Survey from local reference material only (no network, none of these CLIs installed here). "inferred" = not in any local source, must be checked before shipping.

## codebuddy (Tencent CodeBuddy Code CLI; WorkBuddy is the separate desktop app)
- Install `npm install -g @tencent-ai/codebuddy-code`, executable `codebuddy`.
- One-shot: `codebuddy -p "task" --output-format text|json|stream-json --model {MODEL} [--effort X] [--max-turns N] [--system-prompt-file F] [--tools ""] [-y]`.
- Pointing at a gateway: the CLI has NO known base-URL override (only CODEBUDDY_API_KEY, CODEBUDDY_INTERNET_ENVIRONMENT=public|internal) -> probably impossible. WorkBuddy (desktop) honours `WORKBUDDY_CONFIG_DIR=<private dir>` with `models.json`:
  `[{"id":"{MODEL}","name":"{MODEL}","vendor":"easyswitch","apiKey":"{API_KEY}","url":"{BASE_URL}/v1/chat/completions","maxInputTokens":200000,"maxOutputTokens":32000,"supportsToolCall":true,"supportsImages":false,"supportsReasoning":true,"reasoning":{"supportedEfforts":["low","medium","high"],"canDisableThinking":false,"defaultEffort":"medium"}}]`
  The model is picked in the WorkBuddy window per task, so "which model for this launch" cannot be set from the file. Unverified: whether the CLI also reads that directory.
- MCP: `--mcp-config <json>` + `--strict-mcp-config` (flags exist; HTTP+headers schema inferred = Claude Code's `{"mcpServers":{"n":{"type":"http","url":..,"headers":{..}}}}`).
- Effort: `--effort minimal|low|medium|high|xhigh|max` (subset per model). Sub-agent / small model: unknown.

## openclaw
- Install `npm i -g openclaw@latest` (inferred). One-shot `openclaw agent --message "task" [--local]` (inferred); interactive `openclaw tui`.
- Private config: `OPENCLAW_CONFIG_PATH=<file>` (highest priority) or `OPENCLAW_STATE_DIR=<dir>` (reads `<dir>/openclaw.json`); JSON5:
  `{models:{mode:"merge",providers:{easyswitch:{baseUrl:"{BASE_URL}/v1",apiKey:"${EASYSWITCH_OPENCLAW_KEY}",api:"openai-completions",models:[{id:"{MODEL}",name:"{MODEL}",contextWindow:200000,input:["text","image"]}]}}}}`
  `apiKey` supports `${UPPERCASE_VAR}` (unset var fails closed), so pass the key by env. Default model (inferred): `agents:{defaults:{model:{primary:"easyswitch/{MODEL}"}}}`.
- MCP (inferred): `mcp.servers.<name> = {url, headers, transport:"streamable-http"}` in the same private file.
- Effort (inferred): `--thinking off|minimal|low|medium|high|xhigh`, `agents.defaults.thinkingDefault`. Sub-agent (inferred): `agents.defaults.subagents.model`.

## trae-agent (ByteDance, open source)
- Install: clone + `uv sync --all-extras`, executable `trae-cli` (inferred). One-shot `trae-cli run "task" [--working-dir D] [--max-steps N] [--config-file F]`; interactive `trae-cli interactive`.
- Gateway: flags `--provider openai --model {MODEL} --model-base-url {BASE_URL}/v1 --api-key {API_KEY}` or a private `--config-file` yaml (`agents` / `model_providers` / `models`, inferred). Its openai provider may speak Responses, not chat completions: test.
- MCP: stdio only seen (`mcp_servers: {name:{command,args}}`, `allow_mcp_servers`); HTTP likely unsupported -> bridge with a stdio proxy. Effort: no flag known. Small model: `lakeview.model` (inferred).

## atomcode (AtomGit, Rust)
- Private home: `ATOMCODE_HOME=<absolute dir>` with `config.toml`:
  `default_provider="es/{MODEL}"` `default_model="es/{MODEL}"`; `[provider_accounts."es"] provider="openai-compatible" base_url="{BASE_URL}/v1" api_key="{API_KEY}"`; `[models."es/{MODEL}"] account="es" model="{MODEL}" context_window=128000 max_tokens=8192 supports_vision=false reasoning_effort_levels=["low","medium","high"] reasoning_effort="high"`.
  Chat Completions + Bearer. Unverified: other required files under ATOMCODE_HOME.
- Install, one-shot flag (guess `-p`), MCP, sub-agent model: unknown. Effort: `reasoning_effort` low|medium|high|xhigh|max per model.

## amp (Sourcegraph)
- Bound to its own service/account; no OpenAI-compatible endpoint. Detect and open only. (AMP_URL may exist but points at Amp's own protocol: not worth emulating.)
