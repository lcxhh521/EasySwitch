# Agent fact sheet, batch 2: goose, crush, grok-build, minimax-code, qoder-cli (2026-10-06)

Local reference material only; none of these CLIs is installed here. Items marked (inferred) must be checked with `--help` before shipping.

## goose
- Install `brew install block-goose-cli` (a `goose` on PATH may be the unrelated migration tool). One-shot `goose run -t "task" [--no-session] [-q]` (inferred); interactive `goose session`.
- Env-only route (inferred): `GOOSE_PROVIDER=openai GOOSE_MODEL={MODEL} OPENAI_HOST={BASE_URL} OPENAI_API_KEY={API_KEY}` (path `v1/chat/completions`, `OPENAI_BASE_PATH` overrides).
- Private-dir route: `GOOSE_PATH_ROOT=<tmp>` (inferred) + `GOOSE_PROVIDER=easyswitch`; custom provider file `<root>/config/custom_providers/easyswitch.json`:
  `{"name":"easyswitch","engine":"openai","display_name":"EasySwitch","api_key_env":"","base_url":"{BASE_URL}/v1","headers":{"Authorization":"Bearer {API_KEY}"},"requires_auth":false,"skip_canonical_filtering":true,"dynamic_models":false,"models":[{"name":"{MODEL}","reasoning":true,"context_limit":200000}]}`; also `GOOSE_DISABLE_KEYRING=1` (inferred).
- MCP: `--with-streamable-http-extension "<url>"` (no headers, inferred) or private `config.yaml` `extensions: {es: {enabled: true, name: es, type: streamable_http, uri: {MCP_URL}, headers: {Authorization: ..}, timeout: 300}}`.
- Effort: `GOOSE_THINKING_EFFORT` off|low|medium|high|max, only sent for o* / gpt-5/6 models. Sub-agent / small: `GOOSE_LEAD_MODEL`, `GOOSE_PLANNER_MODEL` (recalled, unverified).

## crush
- Install `npm i -g @charmland/crush` or brew `charmbracelet/tap/crush`. One-shot `crush run "task"` (inferred); interactive `crush`.
- Private dirs (inferred): `CRUSH_GLOBAL_CONFIG=<tmp>/cfg` (crush.json), `CRUSH_GLOBAL_DATA=<tmp>/data` (its saved model choice outranks the config dir, so the data dir must be private too).
  `{"providers":{"easyswitch":{"type":"openai","name":"EasySwitch","base_url":"{BASE_URL}/v1","api_key":"{API_KEY}","models":[{"id":"{MODEL}","name":"{MODEL}","context_window":200000,"default_max_tokens":16384,"can_reason":true}]}},"models":{"large":{"provider":"easyswitch","model":"{MODEL}","reasoning_effort":"medium"},"small":{"provider":"easyswitch","model":"{MODEL}"}}}`
  Maybe `type:"openai-compat"` for upstreams without Responses; `options.disable_provider_auto_update` (inferred).
- MCP: same file, `"mcp":{"es":{"type":"http","url":"{MCP_URL}","headers":{"Authorization":"Bearer .."}}}`. Effort: `models.large.reasoning_effort` low|medium|high. Small model: `models.small`; no sub-agent setting.

## grok-build (`grok`)
- Install unknown (curl script, inferred). One-shot `grok -m <model> -p "task"`; interactive `grok`; `grok inspect` lists loaded config sources.
- Private home `GROK_HOME=<tmp>`, `$GROK_HOME/config.toml`:
  `[models] default="easyswitch/{MODEL}" default_reasoning_effort="medium"` + `[model."easyswitch/{MODEL}"] model="{MODEL}" name="{MODEL}" base_url="{BASE_URL}/v1" api_key="{API_KEY}" api_backend="chat_completions" context_window=200000 reasoning_efforts=["low","medium","high"]` (aliases with dots must be quoted). Another documented shape uses `[model_providers.x]` + `model_provider="x"` and `[[model.<alias>.reasoning_efforts]]` tables: check which one `grok inspect` accepts. Fresh GROK_HOME may trigger login/onboarding (inferred); when logged in a remote "campaign" can override models.default (`[features] campaigns=false`).
- MCP: `[mcp_servers.<name>]` url + headers (http) or command/args/env. Effort: `--effort`, `/effort`, `default_reasoning_effort`: none|minimal|low|medium|high|xhigh|max, only for models declaring `reasoning_efforts`.

## minimax-code (`mcode`; separate text-only `mmx`)
- mcode private dir `MINIMAX_DATA_DIR=<absolute tmp>` (old name MAVIS_DATA_DIR), `config.yaml`; Anthropic Messages only, base URL WITHOUT `/v1`:
  `defaultModel: custom_provider:easyswitch/{MODEL}` / `custom_provider: {easyswitch: {name: easyswitch, kind: custom, enabled: true, api: anthropic-messages, options: {apiKey: .., baseURL: {BASE_URL}, authMode: api-key}, models: {{MODEL}: {name, limit: {context: 200000, output: 16384}, reasoning: true, thinking: {effortOptions: [low, medium, high], defaultEffort: high}}}}}`.
  Headless / interactive flags unknown (needs `mcode --help`). Fresh data dir login/onboarding unknown.
- MCP: no user-level MCP file (plugins only) -> per-launch MCP not possible as far as known. Effort: `thinking.effortOptions` picked in `/model`. Sub-agent: unknown.
- mmx hardcodes `{BASE}/anthropic/v1/messages`; would need a tiny rewrite proxy or a gateway alias route; text only.

## qoder-cli (`qodercli` / `qoder`)
- Install `npm install -g @qoder-ai/qodercli` (CN edition `@qodercn-ai/qoderclicn`).
- One-shot `qodercli -p "task" --model {MODEL} --reasoning-effort <v> --output-format stream-json --no-session-persistence --max-turns N`; also `--list-models`, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`.
- Private dir `QODER_CONFIG_DIR=<tmp>` (CN: `QODERCN_CONFIG_DIR`), `settings.json`:
  `{"providers":{"easyswitch":{"displayName":"EasySwitch","protocol":"openai","baseUrl":"{BASE_URL}/v1","apiKey":"{API_KEY}","model":"{MODEL}","models":[{"model":"{MODEL}","displayName":"{MODEL}","contextWindow":200000,"maxOutputTokens":16384,"capabilities":{"tools":true,"vision":false,"thinking":{"modes":["enabled"],"supportsEffort":true,"supportedEffortLevels":["low","medium","high"],"requiresBudgetForEnabled":false}}}]}},"model":{"name":"easyswitch/{MODEL}","preferences":{"easyswitch/{MODEL}":{"reasoning":{"effort":"medium"}}}}}`
- HARD LIMIT: custom providers are only offered to logged-in accounts whose plan includes BYOK; a fresh private dir has no login, so check first whether it works without one.
- MCP: `mcpServers` in settings.json (type/url/headers); flag `--strict-mcp-config` exists, `--mcp-config` inferred. Effort: `--reasoning-effort` low|medium|high|xhigh|max. Sub-agent: unknown.
