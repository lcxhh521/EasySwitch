import { execFile } from "node:child_process";
import { modelEfforts } from "./model-efforts.ts";
import { contextTokens, providerContext, type ModelContext } from "./model-context.ts";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Provider } from "./types.ts";

const run = promisify(execFile);

/**
 * Model lists in each harness's own format, so an augmented session's own
 * `/model` menu offers every EasySwitch model and switching mid-session works.
 *
 * Nothing here touches the harness's config: the Codex catalog is a file in
 * EasySwitch's data dir handed over with `-c model_catalog_json=…` for one
 * launch, and Claude Code reads the list from the gateway's /v1/models.
 */

type Json = Record<string, unknown>;

export interface CatalogModel {
  providerId: string;
  providerName: string;
  model: string;
  /** The thinking levels this model has (see model-efforts.ts); empty when it has none to set. */
  efforts: string[];
  context?: ModelContext;
}

export function catalogModels(providers: readonly Provider[]): CatalogModel[] {
  // A subscription the user switched off is used nowhere.
  return providers.filter(p => !p.off && p.cliTextBridge?.kind !== "droid").flatMap(p => {
    const models = p.models.length ? p.models : p.defaultModel ? [p.defaultModel] : [];
    return models.map(model => {
      const context = providerContext(p, model);
      return { providerId: p.id, providerName: p.name, model, efforts: modelEfforts(p, model), ...(context ? { context } : {}) };
    });
  });
}

// ---------------------------------------------------------------- Claude Code ids

/**
 * Claude Code's picker keeps gateway models whose id contains "claude", but an
 * id that starts with "claude-" is taken for one of its own models (wrong
 * context window), hence the "es-claude-" prefix. Mechanism learned from
 * opencodex (MIT), src/claude/alias.ts; the encoding here is our own:
 * `es-claude-<provider>--<model>`, with "~" written "~t" and "/" written "~s"
 * so any model id survives. Provider ids never contain "--" (see slugify).
 */
const CLAUDE_ID_PREFIX = "es-claude-";

export function claudeModelId(providerId: string, model: string): string {
  return `${CLAUDE_ID_PREFIX}${providerId}--${model.replaceAll("~", "~t").replaceAll("/", "~s")}`;
}

/** The `<provider>/<model>` an es-claude id stands for, or undefined for any other id. */
export function fromClaudeModelId(id: string): string | undefined {
  if (!id.startsWith(CLAUDE_ID_PREFIX)) return undefined;
  const rest = id.slice(CLAUDE_ID_PREFIX.length);
  const split = rest.indexOf("--");
  if (split <= 0 || split === rest.length - 2) return undefined;
  const model = rest.slice(split + 2).replace(/~[st]/g, m => (m === "~s" ? "/" : "~"));
  return `${rest.slice(0, split)}/${model}`;
}

/** Anthropic's ModelInfo list shape, which Claude Code's gateway model discovery reads. */
export function anthropicModelList(models: readonly CatalogModel[]): Json {
  const data = models.map(m => ({
    type: "model",
    id: claudeModelId(m.providerId, m.model),
    display_name: m.model,
    description: `${m.providerName} · 经 EasySwitch`,
    created_at: "2026-01-01T00:00:00Z",
  }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

// ---------------------------------------------------------------- Codex catalog

/**
 * Codex refuses a catalog entry unless it carries a long list of fields
 * (reasoning levels, shell type, truncation policy, base instructions…), and
 * those change between Codex releases. So entries are not written from
 * scratch: they start from a model in the catalog of the Codex that will
 * actually run (`codex debug models`), and only identity and capability
 * fields are replaced. Nothing from Codex is stored in this repository.
 */
export async function codexTemplate(codexPath: string, dataDir: string): Promise<Json | undefined> {
  const models = await nativeCatalog(codexPath, dataDir);
  return models ? pickTemplate(models) : undefined;
}

/** The model catalog the installed Codex ships with (read from a clean home, cached per binary). */
export async function nativeCatalog(codexPath: string, dataDir: string): Promise<Json[] | undefined> {
  const cacheDir = join(dataDir, "codex-template");
  const cacheFile = join(cacheDir, "native-models.json");
  const stamp = (() => {
    try {
      const s = statSync(codexPath);
      return `${codexPath}:${s.size}:${s.mtimeMs}`;
    } catch {
      return codexPath;
    }
  })();
  let catalog: Json | undefined;
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { stamp: string; catalog: Json };
    if (cached.stamp === stamp) catalog = cached.catalog;
  } catch {
    // No cache yet.
  }
  if (!catalog) {
    // An empty CODEX_HOME of our own: the user's config (which may point at
    // another tool's catalog) must not leak into the template.
    const home = join(cacheDir, "home");
    mkdirSync(home, { recursive: true });
    try {
      const { stdout } = await run(codexPath, ["debug", "models"], {
        cwd: home,
        env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "" },
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      catalog = JSON.parse(stdout) as Json;
    } catch {
      return undefined;
    }
    writeAtomic(cacheFile, JSON.stringify({ stamp, catalog }));
  }
  return Array.isArray(catalog.models) ? (catalog.models as Json[]) : [];
}

/**
 * Prefer a model on classic function tools: its base instructions describe the
 * tools our entries will get (see codexCatalog).
 */
export function pickTemplate(models: readonly Json[]): Json | undefined {
  const listed = models.filter(m => m.visibility === "list");
  return listed.find(m => m.tool_mode == null && m.use_responses_lite !== true) ?? listed[0] ?? models[0];
}

const DEFAULT_CONTEXT = 128_000;
const LEVEL_TEXT: Record<string, string> = {
  none: "不思考", minimal: "几乎不思考", low: "快，思考少", medium: "均衡", high: "多想一会儿", xhigh: "想得更深", max: "尽力想", ultra: "极限",
};

/** What Codex shows for a model's levels. A model with none still gets one entry, since Codex wants a default to point at. */
function codexLevels(levels: readonly string[]): { levels: Array<{ effort: string; description: string }>; fallback: string } {
  const list = levels.length ? levels : ["medium"];
  return {
    levels: list.map(effort => ({ effort, description: LEVEL_TEXT[effort] ?? effort })),
    fallback: list.includes("medium") ? "medium" : list.includes("high") ? "high" : list[0]!,
  };
}

export function codexCatalog(template: Json, models: readonly CatalogModel[]): Json {
  return {
    models: models.map((m, i) => ({
      ...template,
      slug: `${m.providerId}/${m.model}`,
      display_name: m.model,
      description: `${m.providerName} · 经 EasySwitch · ${m.context ? m.context.source === "partial-pool" ? "部分成员窗口未知，使用兼容上限" : "上下文来自手动配置" : "上下文未知，暂用128K兼容值"}`,
      visibility: "list",
      priority: i + 1,
      context_window: contextTokens(m.context, DEFAULT_CONTEXT),
      max_context_window: contextTokens(m.context, DEFAULT_CONTEXT),
      auto_compact_token_limit: Math.round(contextTokens(m.context, DEFAULT_CONTEXT) * 0.9),
      // Classic function tools. Newer GPT entries wrap every tool in a JS
      // "code mode" tool and use a trimmed Responses dialect; both are built
      // for OpenAI's own models, and other models then never call a tool.
      tool_mode: null,
      use_responses_lite: false,
      multi_agent_version: null,
      experimental_supported_tools: [],
      supported_reasoning_levels: codexLevels(m.efforts).levels,
      default_reasoning_level: codexLevels(m.efforts).fallback,
      // What the gateway can actually carry: plain HTTP streaming, no hosted
      // search, no reasoning summaries; text in, text out.
      supports_websockets: false,
      supports_search_tool: false,
      supports_reasoning_summaries: false,
      input_modalities: ["text"],
      upgrade: null,
      availability_nux: null,
    })),
  };
}

/** Writes the catalog for the next Codex launch; undefined when no template could be made. */
export async function writeCodexCatalog(
  codexPath: string, dataDir: string, providers: readonly Provider[], opts: { includeNative?: boolean; models?: readonly CatalogModel[]; outputDir?: string; loadNative?: typeof nativeCatalog } = {},
): Promise<string | undefined> {
  const models = opts.models ?? catalogModels(providers);
  if (!models.length) return undefined;
  const native = await (opts.loadNative ?? nativeCatalog)(codexPath, dataDir);
  const template = native ? pickTemplate(native) : undefined;
  if (!native || !template) return undefined;
  const ours = codexCatalog(template, models).models as Json[];
  const file = join(opts.outputDir ?? dataDir, "codex-catalog.json");
  // For the desktop app the native entries are kept, so one picker holds both.
  writeAtomic(file, JSON.stringify(opts.includeNative ? { models: [...native, ...ours] } : { models: ours }));
  return file;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}
