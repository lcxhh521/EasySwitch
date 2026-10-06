import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LaunchInput, LaunchSpec } from "./agent-launch.ts";
import { allModels } from "./launchers-extra.ts";

// Protocol/configuration facts only; independently implemented from the official package docs.
// https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai
// https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client
export const DSH_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PLUGIN = "@deepseek-ai/dsh-mcp-client";
const q = JSON.stringify;

/** Only declare levels supported by this model; an agent-wide list is not a capability claim. */
function modelEfforts(i: LaunchInput, model: string): Record<string, string> | false | undefined {
  const supplied = i.modelEfforts?.[model];
  const selected = model === i.model && i.effort ? [i.effort] : [];
  const levels = supplied ?? selected;
  if (!levels.length) return supplied ? false : undefined;
  const out = Object.fromEntries(levels.flatMap(level => {
    const name = level === "none" ? "off" : level;
    return DSH_EFFORTS.includes(name) ? [[name, name === "off" ? "none" : name]] : [];
  }));
  // The official schema rejects an off-only map: a reasoning model needs at least one active level.
  return Object.keys(out).some(level => level !== "off") ? out : false;
}

export function dshPatch(i: LaunchInput): string {
  const models = allModels(i);
  const effort = i.effort === "none" ? "off" : i.effort;
  if (effort && !DSH_EFFORTS.includes(effort)) throw new Error("dsh 不支持这个推理档位");
  const allowed = modelEfforts(i, i.model);
  if (effort && (!allowed || !(effort in allowed))) throw new Error("这个模型没有所选的 dsh 推理档位");
  const title = i.tiers?.title ?? i.tiers?.small;
  const compaction = i.tiers?.compaction ?? i.tiers?.small;
  return [
    "- id: llm-pi-ai", "  config:", "    providers:", "      easyswitch:",
    "        displayName: EasySwitch", "        api: openai-responses",
    `        baseURL: ${q(`http://127.0.0.1:${i.port}/v1`)}`,
    "        headers:", `          Authorization: ${q(`Bearer ${i.token}`)}`,
    "        models:",
    ...models.flatMap(model => {
      const levels = modelEfforts(i, model);
      return [`          - id: ${q(model)}`, `            name: ${q(model.slice(model.indexOf("/") + 1))}`,
        "            input: [text]", ...(levels === undefined ? [] : [`            reasoningEfforts: ${q(levels)}`])];
    }),
    "- id: agent-default-model", "  config:", "    provider: easyswitch", `    model: ${q(i.model)}`,
    ...(effort ? [`    reasoningEffort: ${q(effort)}`] : []),
    // Patch configs replace the original object. Preserve the shipped policy fields.
    ...(i.tiers?.subagent ? ["- id: tool-subagent", "  config:", "    provider: spawn", "    toolName: subagent",
      "    backgroundMode: continuable", "    agentOptions:", "      provider: easyswitch", `      model: ${q(i.tiers.subagent)}`] : []),
    ...(title ? ["- id: session-title-llm", "  config:", "    targetWords: 5", "    targetCjkCharacters: 10",
      "    maxInputBytes: 4096", "    maxOutputTokens: 64", "    timeoutMs: 60000", "    provider: easyswitch", `    model: ${q(title)}`] : []),
    ...(compaction ? ["- id: compaction-basic", "  config:", "    summarizationProvider: easyswitch", `    summarizationModel: ${q(compaction)}`] : []),
    ...(i.mcp ? ["- insert:", "    - id: mcp-easyswitch", `      name: ${q(PLUGIN)}`, "      config:",
      "        serverName: easyswitch", "        transport: streamable-http", `        url: ${q(i.mcp.url)}`,
      "        headers:", ...Object.entries(i.mcp.headers).map(([k, v]) => `          ${q(k)}: ${q(v)}`)] : []),
    "",
  ].join("\n");
}

export function dshLaunch(i: LaunchInput): LaunchSpec {
  return { command: i.bin, args: ["headless", "--patch", join(i.sessionDir, "patch.yml"), i.task ?? ""],
    env: { DSH_HOME: join(i.sessionDir, "dsh-home") }, files: { "patch.yml": dshPatch(i) },
    ...(i.mcp ? { dshMcpPlugin: { bin: i.bin } } : {}) };
}

/** Read package metadata only. Never runs dsh, installs a plugin, or writes its existing profile. */
export function findDshMcpPlugin(bin?: string): string | undefined {
  const given = process.env.EASYSWITCH_DSH_MCP_PLUGIN;
  // An explicit invalid override must not silently fall back to a different installation.
  if (given !== undefined) return isAbsolute(given) && isDshMcpPlugin(given) ? realpathSync(given) : undefined;
  const anchors = bin ? [resolve(bin)] : [];
  if (bin) try { anchors.unshift(realpathSync(bin)); } catch { /* An absent executable cannot supply a package. */ }
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const candidates = [join(home, "profiles", "node_modules", PLUGIN)];
  for (const anchor of anchors) {
    try { candidates.unshift(dirname(createRequire(anchor).resolve(`${PLUGIN}/package.json`))); } catch { /* Try visible layouts. */ }
    for (let at = dirname(anchor); at !== dirname(at); at = dirname(at)) candidates.push(join(at, "node_modules", PLUGIN));
  }
  return candidates.find(isDshMcpPlugin);
}

function isDshMcpPlugin(path: string): boolean {
  try { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name === PLUGIN; } catch { return false; }
}

export function prepareDshMcpPlugin(bin: string, sessionDir: string, packageDir?: string): void {
  const source = packageDir ?? findDshMcpPlugin(bin);
  if (!source || !isAbsolute(source) || !isDshMcpPlugin(source)) {
    throw new Error("找不到已安装的 dsh MCP 插件；请先关闭此会话的 agent 互调，或准备官方 @deepseek-ai/dsh-mcp-client。EasySwitch 不会运行 plugin add 或修改 ~/.dsh");
  }
  const root = realpathSync(sessionDir);
  const parent = join(root, "dsh-home", "profiles", "node_modules", "@deepseek-ai");
  // Fail before mkdir/write if an existing ancestor is a link into the user's own profile.
  let current = root;
  for (const name of ["dsh-home", "profiles", "node_modules", "@deepseek-ai"]) {
    current = join(current, name);
    if (existsSync(current) && realpathSync(current) !== current) throw new Error("拒绝通过符号链接写入 dsh 的私有目录");
    if (!existsSync(current)) mkdirSync(current);
  }
  symlinkSync(realpathSync(source), join(parent, "dsh-mcp-client"), "dir");
}
