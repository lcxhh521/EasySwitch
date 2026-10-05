# Agent fact sheet, batch 1: kimi-cli, pi, omp, droid, cline (2026-10-06)

Local reference material only; none installed here. (inferred) = verify with `--help` before shipping. All five can be launched against a private directory, so no global config is touched. Side effect: the private dir has none of the user's own logins/settings.

## kimi-cli
- Executable `kimi`. One-shot `kimi --print -p "{PROMPT}"` (inferred, may need `--yolo`).
- New (TS 2.x) edition reads ONLY config.toml credentials, not env vars: private home `KIMI_CODE_HOME=<dir>` (beats ~/.kimi-code, beats legacy `KIMI_SHARE_DIR`), file `$KIMI_CODE_HOME/config.toml`:
  `default_model="es/{MODEL}"` / `[providers.es] type="openai" base_url="{BASE_URL}/v1" api_key="{API_KEY}"` / `[models."es/{MODEL}"] provider="es" model="{MODEL}" max_context_size=128000 capabilities=["thinking","image_in","tool_use"] support_efforts=["low","medium","high"] default_effort="high"`.
  Unsure whether `type` is "openai" or "kimi" (two sources disagree); legacy edition rejects `tool_use`.
- MCP: legacy `--mcp-config-file <json>` (inferred); new edition unknown. Effort: `support_efforts`/`default_effort` (new), `--thinking` (legacy, inferred). Sub-agent / small: none known.

## pi
- Install `npm i -g @earendil-works/pi-coding-agent`, executable `pi`. One-shot `pi -p "{PROMPT}"` (inferred); flags `--provider es --model {MODEL} --thinking <level>` (inferred).
- Private dir `PI_CODING_AGENT_DIR=<abs dir>` (replaces ~/.pi/agent). `models.json`:
  `{"providers":{"es":{"name":"es","baseUrl":"{BASE_URL}/v1","api":"openai-completions","apiKey":"{API_KEY}","models":[{"id":"{MODEL}","name":"{MODEL}","reasoning":true,"input":["text","image"],"contextWindow":200000,"maxTokens":32000}]}}}`
  `settings.json`: `{"defaultProvider":"es","defaultModel":"{MODEL}","defaultThinkingLevel":"high"}`. `api` may be `openai-responses` (baseUrl /v1) or `anthropic-messages` (gateway root, no /v1); `apiKey` may be `$ENVNAME`.
- MCP: none built in (inferred). Effort: `defaultThinkingLevel` off|minimal|low|medium|high|xhigh|max (model needs `reasoning:true`). Sub-agent: none.

## omp (Oh My Pi)
- Install `bun install -g @oh-my-pi/pi-coding-agent`, executable `omp`. One-shot `omp -p "{PROMPT}"` (inferred).
- Private dir `PI_CODING_AGENT_DIR=<abs dir>` (no ~ expansion) AND `OMP_PROFILE`/`PI_PROFILE` must be unset. `models.yml`:
  `providers: {es: {baseUrl: {BASE_URL}/v1, api: openai-completions, apiKey: {API_KEY}, models: [{id: {MODEL}, name: {MODEL}, reasoning: true, contextWindow: 200000, maxTokens: 32000, input: [text, image], thinking: {mode: effort, efforts: [low, medium, high]}}]}}`
  `config.yml`: `modelRoles: {default: es/{MODEL}}` + `defaultThinkingLevel: high`. `max` needs omp >= 16.4.0 (older versions reject the whole file).
- MCP: own config file in the agent dir (name inferred). Effort: `defaultThinkingLevel` auto|minimal|low|medium|high|xhigh|max. Sub-agent / small: `modelRoles.task`, `modelRoles.smol`, `modelRoles.slow` (reviewer); unset = inherit default.

## droid (Factory)
- Install `curl -fsSL https://app.factory.ai/cli | sh`, executable `droid`. One-shot `droid exec --model custom:es/{MODEL} --output-format json "{PROMPT}"` (documented).
- Private home `FACTORY_HOME_OVERRIDE=<dir>`, `<dir>/.factory/settings.json`:
  `{"customModels":[{"model":"{MODEL}","id":"custom:es/{MODEL}","displayName":"{MODEL}","baseUrl":"{BASE_URL}/v1","apiKey":"{API_KEY}","provider":"generic-chat-completion-api","maxContextLimit":200000,"maxOutputTokens":32000,"noImageSupport":false}],"sessionDefaultSettings":{"model":"custom:es/{MODEL}"}}`
  `provider`: generic-chat-completion-api (Chat, /v1) | openai (Responses, /v1) | anthropic (Messages, gateway root).
- Risk: may still demand a Factory login (`FACTORY_API_KEY`) even for BYOK; test first.
- MCP (inferred): `<home>/.factory/mcp.json` `{"mcpServers":{"n":{"type":"http","url":..,"headers":{..}}}}`. Effort: `droid exec -r/--reasoning-effort`, `sessionDefaultSettings.reasoningEffort` (inferred). Sub-agent: unknown.

## cline
- Install `npm i -g cline` (inferred), executable `cline`. One-shot `cline -y "{PROMPT}"` (inferred); known flags `--provider --model --thinking --config <dir>`.
- Private dir: `CLINE_DIR` or `CLINE_DATA_DIR` or `CLINE_PROVIDER_SETTINGS_PATH` (absolute or ~, must not be named models.json); precedence SETTINGS_PATH > DATA_DIR > CLINE_DIR. Use the built-in slot `openai-compatible` (custom provider ids may error: "Unknown or disabled provider").
  `$DATA/settings/providers.json`: `{"version":1,"lastUsedProvider":"openai-compatible","modes":{},"providers":{"openai-compatible":{"settings":{"provider":"openai-compatible","apiKey":"{API_KEY}","model":"{MODEL}","baseUrl":"{BASE_URL}/v1","headers":{"User-Agent":"cline"},"reasoning":{"enabled":true,"effort":"high"}},"updatedAt":"2026-01-01T00:00:00.000Z","tokenSource":"manual"}}}`
  `$DATA/settings/models.json`: `{"version":1,"providers":{"openai-compatible":{"provider":{"name":"es","baseUrl":"{BASE_URL}/v1","defaultModelId":"{MODEL}"},"models":{"{MODEL}":{"id":"{MODEL}","name":"{MODEL}","capabilities":["streaming","tools","reasoning"],"contextWindow":200000,"maxTokens":32000}}}}}`
- MCP (inferred): `$DATA/settings/cline_mcp_settings.json` `{"mcpServers":{"n":{"url":..,"type":"streamableHttp","headers":{..}}}}`. Effort: `reasoning.effort` low|medium|high|xhigh, `--thinking`. Sub-agent: `modes` (plan/act), keys inferred.
