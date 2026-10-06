import { stableToken } from "./gateway-auth.ts";

/**
 * The manual-setup helper: for an app that has no per-launch override but does have a place to type a custom model
 * provider, EasySwitch gives what to type (the address, the token, the models, each ready to copy) and the steps.
 * It never edits the app's own configuration: the person does, once, in the app. Everything here is pure text.
 */

export interface GuideField {
  label: string;
  value: string;
  /** Shown masked until revealed (the token). */
  secret?: boolean;
}

export interface GuideFile {
  /** Where the app looks for it. */
  path: string;
  content: string;
  /** What putting it there means. */
  warning: string;
}

export interface SetupGuide {
  id: string;
  name: string;
  /** In the app's own words where we know them; the app's menus change with its versions. */
  steps: string[];
  fields: GuideField[];
  /** The models to add, `<provider>/<model>` as the gateway names them, the default first. */
  models: string[];
  file?: GuideFile;
  /** What was not checked against the real app. */
  caveat: string;
}

export interface GuideInput {
  port: number;
  /** Everything the agent may be offered, the default first. */
  models: string[];
}

/** A token that stays valid between runs, and still says which app is asking. */
export const manualToken = (id: string): string => stableToken(id);

const base = (i: GuideInput) => `http://127.0.0.1:${i.port}`;

/** The apps that have a guide, and what each one needs. */
export const GUIDE_IDS = ["trae", "zcode", "workbuddy"] as const;

export function setupGuide(id: string, i: GuideInput): SetupGuide | undefined {
  const token = manualToken(id);
  const models = i.models.slice(0, 80);
  const common = (name: string, steps: string[], fields: GuideField[], caveat: string, file?: GuideFile): SetupGuide => ({ id, name, steps, fields, models, ...(file ? { file } : {}), caveat });

  if (id === "trae") {
    return common("Trae", [
      "打开 Trae 的设置，找到「模型」一栏，选「添加模型」。",
      "服务商选「OpenAI 兼容」（或「自定义」）；名称随便填，比如 EasySwitch。",
      "把下面的「接口地址」和「令牌」填进去；「模型 ID」填你要用的一个，要换别的就再添加一次。",
      "回到对话框的模型选择里，选刚加的模型。",
    ], [
      { label: "接口地址（OpenAI 兼容）", value: `${base(i)}/v1` },
      { label: "令牌（API Key）", value: token, secret: true },
    ], "Trae 是闭源的，我们没有在真实的 Trae 上核对过这些菜单的名字，它们会随版本变；填的内容是对的，位置以你看到的为准。我们不会改 Trae 的任何文件。");
  }

  if (id === "zcode") {
    return common("Z Code", [
      "打开 Z Code 的设置，找到模型 / 供应商，选「添加自定义供应商」。",
      "类型选「Anthropic 兼容」；名称随便填，比如 EasySwitch。",
      "把下面的「接口地址」和「令牌」填进去，再把要用的模型 ID 逐个加进它的模型列表。",
      "Z Code 只在启动时读供应商，加完要重启一次 Z Code。",
    ], [
      { label: "接口地址（Anthropic 兼容，不带 /v1）", value: base(i) },
      { label: "令牌（API Key）", value: token, secret: true },
    ], "Z Code 的供应商设置在它的全局配置里，没有每次启动单独指定的办法，所以这里只给你要填的内容，不替你改 ~/.zcode；菜单名字我们没有在真实的 Z Code 上核对过，会随版本变。");
  }

  if (id === "workbuddy") {
    const entries = models.map(m => ({
      id: m, name: m.slice(m.indexOf("/") + 1), vendor: "easyswitch", apiKey: token, url: `${base(i)}/v1/chat/completions`,
      maxInputTokens: 200000, maxOutputTokens: 32000, supportsToolCall: true, supportsImages: false, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high"], canDisableThinking: false, defaultEffort: "medium" },
    }));
    return common("WorkBuddy", [
      "WorkBuddy 的自定义模型放在下面「文件」写的那个位置，内容是一个列表。",
      "如果那里已经有文件，把下面的条目并进它的列表里；没有就新建一个。",
      "WorkBuddy 会自己发现文件的变化，不用重启。在它的窗口里按任务选模型，选名字带「custom-local」的那些。",
    ], [
      { label: "接口地址（OpenAI 兼容）", value: `${base(i)}/v1/chat/completions` },
      { label: "令牌（API Key）", value: token, secret: true },
    ], "格式来自公开的资料，没有在真实的 WorkBuddy 上核对；用哪个模型要在它的窗口里按任务手动选，没法替你选好。我们不会改 ~/.workbuddy。", {
      path: "~/.workbuddy/models.json（如果你设了 WORKBUDDY_CONFIG_DIR，就在那个目录里）",
      content: JSON.stringify(entries, null, 2),
      warning: "放进去之后，这些模型会一直出现在 WorkBuddy 里；EasySwitch 没在运行时它们就连不上，要撤销就把这些条目删掉。",
    });
  }
  return undefined;
}
