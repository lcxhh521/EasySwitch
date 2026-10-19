import { join } from "node:path";
import type { LaunchInput, LaunchSpec } from "./agent-launch.ts";
import { allModels } from "./launchers-extra.ts";

// Protocol/configuration facts only; independently implemented from the official package docs.
// https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai
export const DSH_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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
    "",
  ].join("\n");
}

export function dshLaunch(i: LaunchInput): LaunchSpec {
  return { command: i.bin, args: ["headless", "--patch", join(i.sessionDir, "patch.yml"), i.task ?? ""],
    env: { DSH_HOME: join(i.sessionDir, "dsh-home") }, files: { "patch.yml": dshPatch(i) } };
}
