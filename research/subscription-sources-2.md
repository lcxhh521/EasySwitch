# Can the subscription be a model source? (batch: CodeBuddy/WorkBuddy, Trae, Amp, Doubao/Ark, Droid) — 2026-10-06

Read from the two reference trees only (their source, docs and devlogs); items not marked (inferred) are from there.
NOTE (process): the research agent that produced this also looked at whether a WorkBuddy login file exists on the user's
machine and saw that its tokens are encrypted; nothing was read out or used. It was outside the brief; the other research
agents were told not to touch anything under the user's home that belongs to an app or login.

## CodeBuddy CLI / WorkBuddy (Tencent) — medium
- Own OAuth through an external link: `POST {api}/v2/plugin/auth/state?platform=workbuddy` (`workbuddy-ai` for the international edition) -> `authUrl`; poll `/v2/plugin/auth/token?state=` and `/v2/plugin/login/account?state=`; refresh `POST /v2/plugin/auth/token/refresh`.
- Chat: `{api}/v2/chat/completions` (OpenAI chat), `https://copilot.tencent.com` (CN) / `https://www.workbuddy.ai` (intl). Headers: `Authorization: Bearer <JWT>`, `X-User-Id`, `X-Domain`, `X-Product: SaaS`, `X-IDE-Type: WorkBuddy`; the User-Agent must be `CLI/<ver> WorkBuddy/<ver>` or the gateway answers 10085. Models: `GET {api}/v3/config`.
- Official API-key route: `CODEBUDDY_API_KEY` (keys page on codebuddy.ai / copilot.tencent.com); inference is done by starting the `@tencent-ai/codebuddy-code` CLI (`--tools ""`, `--strict-mcp-config`), not by direct HTTP.
- Both reject Codex's and Claude Code's system prompts with `Illegal API invocation from an unapproved channel` (code 11101): use another harness (Hermes, OpenCode, Pi).
- Usage: `POST {api}/billing/meter/get-user-resource-summary` `{}`.
- Terms: whether proxying third-party agents fits the vendor's acceptable-use policy is marked unreviewed.
- Local login file (macOS): under `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`; its tokens are encrypted when credential protection is on.

## Trae (ByteDance) — CN hard (reverse-engineered community route only), intl not possible
- No documented inference API; the only route is a community plugin that reuses the IDE's `Cloud-IDE-JWT`. The international CLI page says "coming soon"; `bytedance/trae-agent` needs the user's own model key, not the Trae subscription.

## Amp (Sourcegraph) — hard / effectively not possible
- No public OpenAI/Anthropic-compatible inference endpoint; credits are internal; the only door is `amp -x` (execute mode). Nothing in the references uses Amp as an upstream.

## Doubao / Volcengine Ark coding plan — easy, and already a preset
- Key from the console; Coding Plan: chat/responses `https://ark.cn-beijing.volces.com/api/coding/v3`, Anthropic `https://ark.cn-beijing.volces.com/api/coding`; Agent Plan `.../api/plan/v3`; pay-as-you-go `.../api/v3` (does NOT use the plan's quota). Static model list (`ark-code-latest`, `doubao-seed-2.0-code`, ...). No usage endpoint.
- Terms (explicit): the plan's quota is for the listed AI coding tools only; using the base URL/key elsewhere may get the subscription disabled.

## Factory Droid — medium (direct) or medium-easy (official bridge, text only)
- Login: WorkOS device flow, or an API key `fk-…`. Hosted models at `https://api.factory.ai/api/llm/a` (Claude/Messages), `/api/llm/o/v1` (GPT/Responses), etc., with `X-Factory-Client: cli` and more headers; the endpoints are not documented as public and answer 403 without the right client shape. The supported route is `droid exec --model <id> --output-format json` (text only, no tools).
- Usage: `GET /api/billing/limits` (5h / weekly / monthly windows).
- Droid's own login is encrypted by a Keychain key, so it cannot be read; a separate sign-in would be needed.
