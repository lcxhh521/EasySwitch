/**
 * Paste-import parsing. The scenario: a user just bought a relay or opened a
 * subscription and pastes whatever that vendor handed them — a bare URL, a
 * URL and a key on one line, an `export` snippet, a Claude Code env JSON, a
 * Codex config.toml fragment. Whatever it is, extract the base URL and the
 * API key; anything else stays in their hands.
 */

export interface PastedConfig {
  baseUrl?: string;
  apiKey?: string;
  /** Registration / key page found in a tutorial, when the key itself is not there yet. */
  keyUrl?: string;
  /** What we understood, for the confirmation UI. */
  found: string[];
}

const URL_RE = /https?:\/\/[^\s"'`<>)\]}]+/g;

/** Tokens that look like keys: longish, no spaces, not a URL. */
const KEY_RE = /(?:sk|xai|gsk|ak|tc)[-_][A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,}/g;

const NAMED_KEYS: Array<[RegExp, string]> = [
  [/(?:OPENAI|OPENROUTER|DEEPSEEK|MOONSHOT|KIMI|ZHIPU|GLM|MINIMAX|SILICONFLOW|DASHSCOPE|ARK|GROQ|XAI|GEMINI|GOOGLE|ANTHROPIC)[A-Z0-9_]*_(?:API)?_?KEY/, "api key"],
  [/(?:AUTH|ACCESS)[_A-Z0-9]*(?:TOKEN|KEY)/, "api key"],
];

function cleanUrl(url: string): string {
  // Trailing punctuation people copy along: "，" "。" """), etc. already excluded;
  // a path of just "/v1" or "/v1/" is kept as-is, longer paths too (some relays
  // route by path).
  return url.replace(/[.,;:!?，。；：！？、]+$/, "");
}

function looksLikeKey(token: string): boolean {
  if (URL_RE.test(token)) return false;
  URL_RE.lastIndex = 0;
  return KEY_RE.test(token) && token.length >= 12;
}

/** Extracts a base URL and/or an API key from whatever the user pasted. */
export function parsePaste(text: string): PastedConfig {
  const found: string[] = [];
  let baseUrl: string | undefined;
  let apiKey: string | undefined;

  // 1. Named assignments win: export FOO=… / FOO=… / "FOO": "…" / foo = "…"
  const assignment = /^(?:export\s+)?([A-Za-z0-9_]+)\s*[=:]\s*["']?([^"'\s]+)["']?/gm;
  for (const match of text.matchAll(assignment)) {
    const name = match[1]!;
    const value = match[2]!;
    const upper = name.toUpperCase();
    if (/(?:BASE_URL|ENDPOINT|HOST)/.test(upper) && value.startsWith("http")) {
      baseUrl = cleanUrl(value);
    } else if (NAMED_KEYS.some(([re]) => re.test(upper)) || looksLikeKey(value)) {
      apiKey ??= value;
    }
  }

  // 2. A JSON env block without assignments, e.g. {"env":{"ANTHROPIC_BASE_URL":…}}
  if (!baseUrl && !apiKey && text.trim().startsWith("{")) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const env = (json.env ?? json) as Record<string, unknown>;
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== "string") continue;
        if (/BASE_URL/i.test(k) && v.startsWith("http")) baseUrl = cleanUrl(v);
        else if (/TOKEN|KEY/i.test(k)) apiKey ??= v;
      }
    } catch {
      // Not JSON; keep scanning as free text.
    }
  }

  // 3. Free text: the first URL, then any key-shaped token.
  URL_RE.lastIndex = 0;
  if (!baseUrl) {
    for (const url of text.matchAll(URL_RE)) {
      // A tutorial/docs link is where the user reads how — not an API endpoint.
      if (!/\/(docs|help|guide|start|tutorial|article|post|register|login|buy|pay|pricing|price|shop|recharge)/i.test(new URL(url[0]).pathname + "/")) {
        baseUrl = cleanUrl(url[0]);
        break;
      }
    }
  }
  if (!apiKey) {
    for (const token of text.split(/[\s"'`,;]+/)) {
      if (!token || token === baseUrl || token.startsWith("http")) continue;
      // Chinese prose stuck to the key ("令牌：sk-…"): take the trailing run.
      const tail = /(?:令牌|密钥|Key|key|KEY|token|TOKEN)[：:]\s*([A-Za-z0-9_-]{8,})$/.exec(token);
      if (tail && tail[1]) { apiKey = tail[1]; break; }
      if (looksLikeKey(token)) { apiKey = token; break; }
    }
  }

  // 4. Tutorial mode: a doc full of steps. Even with a key in hand, surface the
  // page that issues keys ("先去 xx 注册/创建令牌") so the user can go get one.
  const urlInText = URL_RE.exec(text)?.[0];
  URL_RE.lastIndex = 0;
  const keyPage = /https?:\/\/[^\s"'`<>)\]}]*\/(?:api[_-]?keys?|token|tokens|keys?)[^\s"'`<>)\]}]*/i.exec(text)?.[0]
    ?? (/(?:注册|获取|创建|申请)[^\n]{0,12}(?:令牌|密钥|Key|充值|购买)/i.test(text) ? baseUrl ?? urlInText : undefined)
    ?? (!baseUrl && urlInText ? urlInText : undefined);
  URL_RE.lastIndex = 0;
  KEY_RE.lastIndex = 0;
  if (baseUrl) found.push("地址");
  if (apiKey) found.push("Key");
  else if (keyPage) found.push("Key 的获取页面");
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(!apiKey && keyPage ? { keyUrl: keyPage } : {}),
    found,
  };
}

/** A display name from a base URL: api.example.com → example 中转站. */
export function nameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) return "本地中转站";
    const parts = host.replace(/^api\d?\./, "").split(".");
    const label = parts.length > 1 ? parts[0] : host;
    return `${label} 中转站`;
  } catch {
    return "新模型来源";
  }
}
