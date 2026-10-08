# B5 real-CLI acceptance readiness

Reviewed 2026-10-08 against EasySwitch commit `9168f40` and the official sources linked below. This is static preparation, not real-client acceptance. B5 and the five launchers' verification states remain unchanged.

## Result and evidence levels

- **Runtime: blocked.** No supported, enforceable loopback-only egress and account-access boundary has been established in the current cloud execution environment.
- **Package staging: incomplete.** No package archive was downloaded, extracted, installed, imported, or executed. No lifecycle hook, build backend, target CLI, native addon, login, real-model call, or credential read occurred.
- Release tags and pinned source manifests establish candidate versions and source-level facts. They do not establish the contents of published npm tarballs.
- Aider's published PyPI metadata was read through the web tool. Its advertised digest is recorded below; no locally downloaded bytes were hashed against it.
- The dependency closure, all transitive install hooks, platform binaries, and runtime download behavior have **not** been audited.

The approved scope is temporary installation/testing of the five named official CLIs in independent cloud directories against local fake inference. It does not authorize host security/network changes, accounts, real inference, native configuration changes, or another computer.

## Isolation and transport observations

The cloud environment reports Debian 13 x86_64, Node `24.19.0`, and the available primary Python runtime `3.12.14`. These are inventory facts, not compatibility tests of the packages.

Inspection of the installed Node help shows permission controls for filesystem access, child processes, addons, workers, and WASI, but no network allowlist flag. The existing execution sandbox's configured remote-host allowlist is broader than loopback, and its readable filesystem scope is broader than an empty test directory. Neither private `HOME` nor telemetry settings changes those boundaries. Presence checks found `bwrap`, `unshare`, and `strace`; none was invoked for this work. The earlier denied namespace/`NETLINK_ROUTE` path was not retried, and no replacement tunnel, proxy, security-policy change, or sandbox bypass was attempted.

Anonymous direct HTTPS metadata requests from a trusted isolated system Python interpreter, with redirects and proxy use disabled, failed with `Temporary failure in name resolution` for `pypi.org` and `registry.npmjs.org`. No response bytes were staged. This is the observed transport failure, not proof that those services are unavailable everywhere. The web tool separately reported npm metadata URLs as unavailable through that tool. No host-network troubleshooting was performed.

## Candidate distributions and static findings

### Gemini CLI

- Candidate: `@google/gemini-cli@0.63.0`; [official release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.63.0).
- The pinned [CLI manifest](https://raw.githubusercontent.com/google-gemini/gemini-cli/v0.63.0/packages/cli/package.json) requires Node >=20 and has no preinstall/install/postinstall hook. Its core dependency is a source-tree `file:` reference, so this is not a usable published dependency closure.
- The pinned [core manifest](https://raw.githubusercontent.com/google-gemini/gemini-cli/v0.63.0/packages/core/package.json) likewise has no installation lifecycle hook in that manifest, but declares optional native dependencies including `@github/keytar@7.10.6`, `@lydell/node-pty@1.1.0`, platform PTY packages, and `node-pty@1.0.0`. Their artifacts and hooks remain unaudited.
- Published npm version metadata/archive and integrity verification: **not obtained**.

### Qwen Code

- Candidate: `@qwen-code/qwen-code@0.25.0`; [official CLI release](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.0). The repository's generic latest-release URL can point to an SDK release and must not determine the CLI pin.
- [Pinned root metadata](https://raw.githubusercontent.com/QwenLM/qwen-code/v0.25.0/package.json) requires Node >=22.
- The pinned [core source manifest](https://raw.githubusercontent.com/QwenLM/qwen-code/v0.25.0/packages/core/package.json) is marked private and declares `postinstall: node scripts/postinstall.js`, `sharp`, and optional PTY packages. Retrieval of the pinned hook and packaging script returned cache misses. The published CLI's packaging transformation and actual hook behavior remain unknown; do not infer the private core manifest is the published package.
- Published npm version metadata/archive and integrity verification: **not obtained**.

### OpenCode

- Candidate: `opencode-ai@1.18.35`; [official release](https://github.com/anomalyco/opencode/releases/tag/v1.18.35). [Installation documentation](https://opencode.ai/docs/) offers npm and platform binaries.
- The exact published manifest, platform artifact/ABI, install hook, and dynamic provider-package resolution were not obtained or verified.
- Published archive and integrity verification: **not obtained**.

### Copilot CLI

- Candidate: `@github/copilot@1.0.93`; [official release](https://github.com/github/copilot-cli/releases/tag/v1.0.93).
- [Official installation documentation](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) requires Node >=22 for npm and explicitly says installation needs scripts enabled. An inert `--ignore-scripts` staging result must not be described as a functional installation. Exact script and native payload behavior remain unreviewed.
- Published npm version metadata/archive and integrity verification: **not obtained**.

### Aider

- Candidate inspected as data only: `aider-chat==0.86.0`; [official release](https://github.com/Aider-AI/aider/releases/tag/v0.86.0), [PyPI release metadata](https://pypi.org/pypi/aider-chat/0.86.0/json).
- Published wheel: `aider_chat-0.86.0-py3-none-any.whl`, 373,254 bytes, uploaded 2025-08-09. Advertised SHA-256: `386be777c7197494a020337f18c15660fe32a5b4a350123e583bd07ad25365d8`.
- Metadata requires Python >=3.10,<3.13, consistent with [pinned project metadata](https://raw.githubusercontent.com/Aider-AI/aider/v0.86.0/pyproject.toml). Base dependencies include pinned `litellm==1.75.0`, `tiktoken==0.10.0`, analytics libraries, and native-extension packages. Their wheel availability, digests, initialization, and optional downloads remain unverified.
- Wheel bytes, archive contents, `RECORD`, and local hash verification: **not obtained**.
- **Additional execution gate:** GitHub-reviewed [GHSA-hchg-qm84-cj9p / CVE-2026-10177](https://github.com/advisories/GHSA-hchg-qm84-cj9p) and [GHSA-7w7m-v5vp-w699 / CVE-2026-10175](https://github.com/advisories/GHSA-7w7m-v5vp-w699) both list `aider-chat <=0.86.2` as affected and no patched version. Thus 0.86.0 is within the advisory ranges, despite the descriptions mentioning 0.86.3.dev. This is advisory applicability, not a locally reproduced exploit. Do not select this pin for execution until the advisory/version disposition is reviewed.

## Application controls to inspect later, not isolation guarantees

- **Gemini:** explicit API-key authentication, local `GOOGLE_GEMINI_BASE_URL`, private `GEMINI_CLI_HOME`; disable usage statistics, telemetry, and updates. Project/system settings and `.env` search still matter. [Configuration](https://geminicli.com/docs/reference/configuration/)
- **Qwen:** explicit OpenAI authentication and loopback base URL; private `QWEN_HOME`/`QWEN_RUNTIME_DIR`; disable `QWEN_USAGE_STATISTICS_ENABLED`, `QWEN_TELEMETRY_ENABLED`, automatic updates, and models.dev refresh. `QWEN_CODE_MODELS_DEV_REFRESH=off` stops refresh; `QWEN_CODE_MODELS_DEV=off` also disables catalog use. [Settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)
- **OpenCode:** private HOME/XDG state; only the test provider enabled; sharing and updates disabled; inspect documented controls for model fetching, plugins, LSP downloads, and Claude compatibility. Inline configuration merges with other layers rather than replacing them. [Config](https://opencode.ai/docs/config/), [CLI](https://opencode.ai/docs/cli/), [providers](https://opencode.ai/docs/providers/)
- **Copilot:** documented local BYOK plus `COPILOT_OFFLINE=true`, updates disabled, private configuration/cache, and built-in MCPs disabled. Clean environment alone does not disprove system-keychain or `gh` authentication fallback. [BYOK/offline](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models), [authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli), [CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- **Aider:** private HOME and explicit configuration/env files; no analytics, version checks, release notes, git integration, automatic commits, or edits. Dependency startup networking still needs review. [Options](https://aider.chat/docs/config/options.html), [OpenAI-compatible endpoint](https://aider.chat/docs/llms/openai-compat.html)

Do not change production/native-account behavior solely to meet this no-account test harness's constraints. `runHeadless` currently inherits `process.env`; OpenCode/Aider launchers do not themselves provide private HOME, and Copilot does not unset GitHub authentication variables. Acceptance-specific controls need a separate reviewed harness.

## Required gates and acceptance procedure

1. Obtain exact published artifacts using an available authorized transport. Verify publisher/version, registry integrity or official checksums, and downloaded bytes separately from source tags. Stop on access/security denial; do not alter host networking or reuse credentials.
2. Stage as inert data only while runtime isolation is unresolved. Use bounded extraction into a fresh canonical private directory; reject absolute/traversal paths, links, and special entries. No npm lifecycle hooks, sdist/build-backend execution, target imports/entrypoints, or native-module loading. Do not activate staged Python site-packages: `.pth`/`sitecustomize` can execute on interpreter startup. Inspect using a trusted isolated interpreter outside that tree.
3. Review the actual dependency closure, lifecycle scripts, native payloads and automatic-download paths. Reject unreviewed Git/file dependencies and credential-helper routes. Do not call scripts-disabled staging a validated installation. Resolve Aider's additional advisory gate before selecting a runtime version.
4. Establish and independently review an enforceable, supported per-process boundary excluding real credential stores/account services and nonlocal egress, including children and native code. App flags, proxy variables, snapshots, syscall logging, or private directories alone are not such enforcement. This gate is currently unmet; the previously denied namespace route stays closed.
5. After that gate, validate help/version and then a fresh in-memory EasySwitch store with only a loopback fake provider. No MCP attachment, subscriptions, native routing, configuration imports, real API keys or login.
6. Use a **dedicated fixed-text-only fixture**, never the existing generic `mock-relay.ts` unchanged. Its `decide()` can return `get_weather` or MCP calls before the counting branch and shell calls for other prompts. A prompt requesting counting is not a global no-tool guarantee. The fixture must never emit tool/function calls or follow redirects.
7. Record actual binary version, gateway and upstream requests, exact model/protocol, fixed output, exit status, owned-process cleanup, and configuration/file-access evidence. A successful text smoke establishes only that path. Tool execution, model menus and private persistence, subscription/native-account routing, and macOS compatibility remain separate acceptance items.

No full test suite or real-client acceptance was run for this documentation-only preparation.
