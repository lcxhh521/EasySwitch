# CLI configuration: current validation scope

EasySwitch task dispatch, its MCP service/attachment and headless executor were removed under B115 (2026-10-18). No replacement dispatcher is planned. This document covers the surviving interactive client configuration and model preferences only.

## Preserved implementation

- dsh model declarations use model-owned reasoningEfforts, the correct off/none wire mapping and required title settings. Native subagent model preferences retain their provider/tool/background semantics; these are the client's own capabilities, not EasySwitch dispatch.
- Kimi uses its current TypeScript client configuration and secondary-model preferences; model levels come from supplied capabilities, not unconditional claims.
- OMP uses a private one-shot configuration overlay and disables ambient project-MCP discovery and foreign user providers. CodeBuddy retains strict empty MCP configuration to isolate the client, not register an EasySwitch tool.
- AtomCode model levels remain model-owned. Trae configuration retains its explicit Responses provider and optional Lakeview small-model route; no EasySwitch stdio bridge is included.
- Codex and Hermes receive issued per-launch gateway tokens through environment references. Interactive launch, revoke and owned-directory cleanup remain; no dedicated task-process runner remains.
- Gemini and Copilot effort settings keep their documented/runtime-unverified caveats.

## Verification and remaining acceptance

Use agent-config-gaps, capabilities, verify-launchers, server-command and authentication regressions through the audited local runner. They use synthetic configuration and injected runners, not real agents/accounts. LaunchInput.modelEfforts carries main/tier/pool capability lists keyed by exposed model; server computes catalog/pool intersections.

Source validation is not real-client support. Private config and native client tool behavior require version-specific authorized acceptance; an interactive launcher is not a read-only sandbox. Do not install, log in or contact a model as part of metadata inspection. Real execution tests are excluded from the guarded default suite.

## Official sources inspected

- dsh [pi-ai model route and effort configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md), [exact reasoning validation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/catalog.ts), [base patch fields](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml), [subagent options](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md), [title requirements](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-title-llm/README.md), [compaction route](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md), [MCP plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md), [profile resolution](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/profile.ts), [CLI argument grammar](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/args.ts)
- Kimi TS [configuration](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md), [MCP](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md), [CLI](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md), [environment overrides](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md); legacy [Python CLI](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/cli/__init__.py)
- OMP [MCP config](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md), [settings and precedence](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md), [environment](https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md)
- AtomCode [official MCP docs](https://atomcode.atomgit.com/docs/en/mcp.html), [MCP source and private path](https://github.com/atomgit-atomcode/atomcode/blob/main/crates/atomcode-capabilities/src/mcp/config.rs), [distribution home override](https://github.com/atomgit-atomcode/atomcode/blob/main/crates/atomcode-config/src/distribution.rs), [provider model schema](https://github.com/atomgit-atomcode/atomcode/blob/main/crates/atomcode-config/src/config/provider.rs)
- CodeBuddy [environment and third-party Messages endpoint](https://www.codebuddy.ai/docs/cli/env-vars), [private configuration directory](https://www.codebuddy.ai/docs/cli/installation), [one-shot settings and strict MCP flags](https://www.codebuddy.ai/docs/cli/cli-reference), [HTTP MCP shape](https://www.codebuddy.ai/docs/cli/mcp), [subagent model priority](https://www.codebuddy.ai/docs/cli/sub-agents)
- Trae [config parser](https://github.com/bytedance/trae-agent/blob/main/trae_agent/utils/config.py), [CLI](https://github.com/bytedance/trae-agent/blob/main/trae_agent/cli.py), [stdio-only MCP execution](https://github.com/bytedance/trae-agent/blob/main/trae_agent/utils/mcp_client.py), [Responses client](https://github.com/bytedance/trae-agent/blob/main/trae_agent/utils/llm_clients/openai_client.py)
- MCP [2025-03-26 transport specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
