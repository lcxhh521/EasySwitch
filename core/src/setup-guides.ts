
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
  sources?: string[];
}

export interface GuideInput {
  port: number;
  /** Issued by the local authority for this explicit setup request, never inferred from the app ID. */
  token: string;
  /** Everything the agent may be offered, the default first. */
  models: string[];
}



const base = (i: GuideInput) => `http://127.0.0.1:${i.port}`;

/** The apps that have a guide, and what each one needs. */
export const GUIDE_IDS = ["trae", "zcode", "workbuddy"] as const;

export function setupGuide(id: string, i: GuideInput): SetupGuide | undefined {
  const token = i.token;
  const models = i.models.slice(0, 80);
  const common = (name: string, steps: string[], fields: GuideField[], caveat: string, file?: GuideFile): SetupGuide => ({ id, name, steps, fields, models, ...(file ? { file } : {}), caveat });

  if (id === "trae") {
    return common("Trae", [
      "打开 Trae 的设置，找到「模型」一栏，选「添加模型」。",
      "选择「自定义模型」，API 格式选 OpenAI Chat Completions，关闭完整 URL 开关以使用下面的基础地址。",
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
      "保存、启用来源，再在对话的模型选择器里选择它；保留原生来源以便随时切回。",
    ], [
      { label: "接口地址（Anthropic 兼容，不带 /v1）", value: base(i) },
      { label: "令牌（API Key）", value: token, secret: true },
    ], "Z Code 的供应商设置在它的全局配置里，没有每次启动单独指定的办法，所以这里只给你要填的内容，不替你改 ~/.zcode；菜单名字我们没有在真实的 Z Code 上核对过，会随版本变。");
  }

  if (id === "workbuddy") {
    const guide = common("WorkBuddy", [
      "打开 Settings → Model，添加 Custom 模型；这是桌面应用，和 CodeBuddy Code 命令行分开。",
      "在高级设置里开启 Custom Protocol，填写下面的完整请求地址。",
      "API Key 填下面的临时令牌，模型 ID 从下面列表选择；保存后在对话菜单里选中。",
      "只把临时令牌交给本地 EasySwitch 网关，不要贴到服务商网站。到期或重启网关后重新生成；用完可撤销。",
    ], [
      { label: "完整请求地址（Custom Protocol）", value: `${base(i)}/v1/chat/completions` },
      { label: "临时令牌（API Key）", value: token, secret: true },
    ], "按当前官方设置页写成，没有在真实的 WorkBuddy 上验收；工具、图片、上下文和思考能力由实际模型决定，不编造能力。我们不会改 WorkBuddy 的任何文件。");
    guide.sources = ["https://www.codebuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model"];
    return guide;
  }

  return undefined;
}
