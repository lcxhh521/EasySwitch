# What Claude Code sends to a custom gateway (Claude Code 2.1.289)

Captured with `claude -p` in a throwaway HOME, `ANTHROPIC_BASE_URL` pointed at
a local capture server. No prompt text is reproduced here.

- `POST /v1/messages?beta=true`, streaming (`stream: true`); also
  `POST /v1/messages/count_tokens`.
- Auth: `ANTHROPIC_AUTH_TOKEN` arrives as `authorization: Bearer …`. Other
  headers: `anthropic-version`, `anthropic-beta`, `x-app`,
  `x-claude-code-session-id`, `x-stainless-*`.
- Body keys: `model`, `messages`, `system` (array of text blocks, some with
  `cache_control`), `tools` (21, Anthropic shape: `name`, `description`,
  `input_schema`, no `type`), `metadata.user_id` (device id), `max_tokens`
  (32000), `thinking` (`{type: "adaptive"}`), `context_management`,
  `safeguards`, `output_config.effort`, `stream`.
- `messages` can contain `role: "system"` turns, not only user/assistant.
- An unknown model name only produces a warning
  (`[claude-code:unrecognized_model]`); the session continues assuming a
  200k context window.
- The user's `claude` shell command may be a wrapper (for example, one that unsets
  `ANTHROPIC_*`), so sessions must start the real binary.
