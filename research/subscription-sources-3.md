# Can the subscription be a model source? (batch: Gemini CLI, Qoder, Grok Build, MiniMax, Kimi) — 2026-10-06

From the two reference trees only (opencodex and the Magpie clone); (inferred) marks my reading. Nothing on the user's machine was read.

## Gemini CLI — personal Google login not possible; enterprise medium; API key easy
- Two logins: Google OAuth (installed-app PKCE, client shipped with the CLI, callback 127.0.0.1 /oauth2callback) and `GEMINI_API_KEY`.
- Google login talks to the private Code Assist envelope `https://cloudcode-pa.googleapis.com/v1internal:{method}` (`loadCodeAssist`, `onboardUser`, `retrieveUserQuota`, generate wraps Gemini's native body as `{model, project, request}`), needs the account's Cloud project. Quota: `retrieveUserQuota` -> `buckets[{modelId, remainingFraction, resetTime}]`.
- Local login the CLI keeps: `~/.gemini/oauth_creds.json` (access/refresh/expiry_date/id_token); the references read it only, and check the id_token's azp is Gemini's own client since Google refreshes only for the client that issued it.
- Since then Google no longer provides the Code Assist service to personal accounts for Gemini CLI login (only Standard/Enterprise with own Cloud project). The free tier path is therefore effectively gone. The API-key path is pay-per-use and already covered by the Google preset.

## Qoder — hard (private protocol); official route is a CLI bridge
- Device PKCE login at qoder.com (client id in the references), tokens `dt-` (device) and `jt-` (job, refreshed with a one-time refresh token).
- Chat is a private SSE endpoint with a custom base64 table, an AES+RSA signed `COSY.` bearer and a set of `Cosy-*` headers, reverse-engineered by a community project.
- Official, safe route (opencodex): the user creates a personal access token on the Qoder account page; start `qodercli --output-format stream-json --input-format stream-json --tools "" --strict-mcp-config --max-turns 1 --model <id>` with `QODER_PERSONAL_ACCESS_TOKEN`; text and reasoning only. The references do not read Qoder Desktop sessions or cookies.
- Usage: `GET {OpenAPI}/sash/api/v2/me/usage`.

## Grok Build — medium
- PKCE login with auth.x.ai (client id in the references; callback 127.0.0.1:56121). The CLI keeps its login in `~/.grok/auth.json`; the references read it only and, when it has expired, run `grok models` so the CLI refreshes itself (refresh tokens rotate; refreshing ourselves could log the CLI out).
- Subscription traffic goes through `https://cli-chat-proxy.grok.com/v1` (Responses-style; `GET /models`), with CLI-lookalike headers (`x-xai-token-auth: xai-grok-cli`, client identifier/version/mode, conv/session ids). Tools allowed: function, web_search, x_search; namespace/custom types are rejected.
- Usage: `GET /v1/billing?format=credits`.
- No terms text in the references; posing as the Grok CLI is the risk (inferred).

## MiniMax — Token Plan key easy (already a preset); account login unknown
- Keys from platform.minimax.io / minimaxi.com; OpenAI-compatible `https://api.minimax.io/v1` and Anthropic-compatible `/anthropic`. M3 thinks always (effort none -> 400 code 2013); replay needs `reasoning_details` passed back. `MiniMax-M3.1-Flash-Preview` is Token Plan only and not listed by `/v1/models`.
- Usage: `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains` -> `model_remains` row `general`, remaining percent for the 5h window and the weekly window.
- MiniMax Code account login: no usable facts in the references.

## Kimi — key easy (already a preset), login medium
- Device-authorization login: `POST https://auth.kimi.com/api/oauth/device_authorization` and `/api/oauth/token`, with `User-Agent: KimiCLI/<ver>` and `X-Msh-*` device headers. Chat endpoints: OpenAI `https://api.kimi.com/coding/v1`, Anthropic `https://api.kimi.com/coding`; Kimi lets members use these from third-party tools (the clearest permission among the five). Models: `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k`.
- Usage: `GET https://api.kimi.com/coding/v1/usages` (weekly `usage`, `limits[]` for 5h/7d windows, `totalQuota`).
- A stable `prompt_cache_key` helps cache hits.

## What this means for EasySwitch
- Already covered by presets (the user fills in a key): Doubao/Ark coding plan, Kimi coding plan, MiniMax coding plan.
- Quota display is cheap for these three (and Grok): see the usage endpoints above. Worth doing as part of B48.
- Worth building next: Kimi sign-in by device code (low risk, explicit permission), Grok reading its local login (medium risk).

## Open question for Grok (B68)
The references disagree on the wire format of `https://cli-chat-proxy.grok.com/v1`: Magpie treats it as OpenAI Responses (and its tool-type whitelist and `prompt_cache_key` handling are Responses fields); opencodex's preset says chat. Settle it with one real request before building on it; use the existing Responses translation (`responses-upstream.ts`) if it is Responses.
