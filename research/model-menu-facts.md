# Model menus: Gemini, Qwen and Copilot

Checked 2026-10-06 against current official documentation and source. No agent was executed, installed or signed in. These facts justify generated configuration and capability labels, not real-client acceptance. Minimum supporting release versions have not been established.

## Gemini CLI

The current dynamic menu reads `modelConfigs.modelDefinitions` when `experimental.dynamicModelConfiguration` is enabled. Each exposed EasySwitch model is a visible, non-preview entry with the supported `custom` tier and family. Direct model IDs need no alias. No unsupported thinking, vision or context-size capabilities are inferred.

- [Official schema](https://github.com/google-gemini/gemini-cli/blob/main/schemas/settings.schema.json)
- [Menu implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/components/ModelDialog.tsx)
- [Model metadata service](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/modelConfigService.ts)

Current system-settings loading checks administrator ownership of the file and its ancestors. A normal user-owned temporary system file is skipped. The launcher therefore writes `<session>/gemini-home/.gemini/settings.json` and sets `GEMINI_CLI_HOME`. Existing effort overrides and MCP configuration remain in that private user file.

- [Settings loading and model persistence](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts)
- [System-file ownership checks](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/security.ts)
- [Configuration variables](https://geminicli.com/docs/reference/configuration/#environment-variables)

Custom definitions augment the built-in menu. Built-ins are not evidence of working native-account routing through EasySwitch. Trusted project settings can override user settings and may be migrated by the client. The private home protects the original user settings; it is not a project filesystem sandbox. The model command's persistence targets user settings, which now resolve inside the session.

## Qwen Code

`modelProviders.openai` is the documented multi-model catalog. Entries use an ID, display name, gateway `/v1` base URL and an `envKey` variable name. The launcher sets `EASYSWITCH_GATEWAY_TOKEN`, selects `openai` authentication, and uses `QWEN_HOME`/`QWEN_RUNTIME_DIR` under the session. Its private system overlay uses the documented `QWEN_CODE_SYSTEM_SETTINGS_PATH`, separately from Gemini. A main-model effort, if supplied, lives in that model's provider entry because provider generation settings do not inherit lower-level generation settings.

- [Model provider format and resolution](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
- [Configuration paths and variables](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)
- [QWEN_HOME storage implementation](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts)

Both the private user file and overlay contain the catalog. `/model --global` persists to the private user scope. Bare `/model` can choose workspace persistence when a trusted project's settings own `modelProviders`; users should use the global option for the isolated user scope. This does not claim project configuration is unreadable or immutable.

- [Persistence scope selection](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/config/modelProvidersScope.ts)
- [Model command scope flags](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/ui/commands/modelCommand.ts)

## Copilot CLI

Official documentation describes a `providers.json` registry, top-level `providers` and `models`, and `COPILOT_PROVIDERS_CONFIG`. A populated registry supersedes legacy provider environment variables. The inner provider/model/authentication schema was not established from the available official material. `/models` is a slash-command alias, not evidence of automatic HTTP model discovery. The launcher therefore does not emit guessed registry entries; full catalog support remains incomplete.

- [Registry and private home documentation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [Official BYOK configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
- [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

The supported single-model BYOK path remains. `COPILOT_HOME` is now private even without an effort selection. Inherited registry, API-key command, bearer/header and model-identity overrides are cleared so they cannot supersede the intended gateway configuration. The official `--additional-mcp-config @file` form keeps its MCP credential out of argv. No real model menu, authentication, tools or program lifecycle was exercised.

## Verification boundary

Pure tests inspect configuration keys, default ordering, all supplied models, private paths, token references, MCP file arguments, preserved effort settings and 0600 materialization. Capability states remain `documented` for Gemini/Qwen and `todo` for Copilot's complete catalog. Real application menus, supported installed versions and project-level behavior remain separate acceptance work.
