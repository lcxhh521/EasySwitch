/** Secret-free Vertex routing metadata. Authentication and protocol are chosen together. */
export type VertexKind = "service-account" | "standard" | "express";
export type VertexServiceAccountConfig =
  | { mode: "service-account"; auth: "service-account"; project: string; location: string; clientEmail: string }
  /** Read existing af91f97 configurations without changing their credential source. */
  | { project: string; location: string; clientEmail: string; mode?: never; auth?: never };
export type VertexGeminiConfig =
  | { mode: "standard"; project: string; location: string; auth: "access-token" }
  | { mode: "express"; auth: "api-key" };
export type VertexConfig = VertexServiceAccountConfig | VertexGeminiConfig;

export class VertexConfigError extends Error {
  status: number;
  constructor(message: string) { super(message); this.status = 400; }
}

export function vertexProjectLocationIssue(project: unknown, location: unknown): string | undefined {
  if (typeof project !== "string" || !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/.test(project)) return "请填写有效的 Google Cloud 项目 ID 或项目编号。";
  if (typeof location !== "string" || !/^(?:global|[a-z]{2,20}-[a-z]{2,20}[0-9]{1,2})$/.test(location)) return "请填写有效的 Vertex 区域，例如 global 或 us-central1。";
  return undefined;
}

/** Validates before any secret lookup; error messages never echo metadata or credential values. */
export function vertexConfigIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Vertex 配置无效，请明确选择服务账号、手动令牌或 Express 模式。";
  const v = value as Record<string, unknown>;
  const legacy = !Object.hasOwn(v, "mode") && !Object.hasOwn(v, "auth") && Object.hasOwn(v, "clientEmail");
  const serviceAccount = legacy || (v.mode === "service-account" && v.auth === "service-account");
  const allowed = legacy ? ["project", "location", "clientEmail"] : serviceAccount ? ["mode", "auth", "project", "location", "clientEmail"] : v.mode === "standard" ? ["mode", "auth", "project", "location"] : ["mode", "auth"];
  if (Object.keys(v).some(k => !allowed.includes(k))) return "Vertex 配置不能包含凭据、地址覆盖或混合鉴权字段；请使用对应模式的密钥入口。";
  if (v.mode === "express" && v.auth === "api-key") return undefined;
  if (!serviceAccount && !(v.mode === "standard" && v.auth === "access-token")) return "Vertex 鉴权方式与模式不匹配。";
  const locationIssue = vertexProjectLocationIssue(v.project, v.location);
  if (locationIssue) return locationIssue;
  if (serviceAccount && (typeof v.clientEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.clientEmail))) return "Vertex 服务账号标识无效。";
  return undefined;
}

/** Undefined means absent only. Invalid supplied configurations fail rather than falling back. */
export function vertexKind(value: unknown): VertexKind | undefined {
  if (value === undefined) return undefined;
  const issue = vertexConfigIssue(value);
  if (issue) throw new VertexConfigError(issue);
  return (value as { mode?: VertexKind }).mode ?? "service-account";
}
