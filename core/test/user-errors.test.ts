import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { humanError, registeredErrors, requireRegisteredError, type UserErrorsApi } from "../src/user-errors.ts";

const mainText = (value: ReturnType<typeof humanError>) => [value.title, value.reason, value.action.label, value.message].join("\n");

test("every registered error matches the private wording standard; new categories require a table row", t => {
  const standard = new URL("../../research/error-wording-standard.md", import.meta.url);
  if (!existsSync(standard)) {
    assert.equal(existsSync(new URL("../../BACKLOG.md", import.meta.url)), false, "private checkout must include its error wording standard");
    t.skip("Internal wording governance is excluded from public snapshots; all dictionary safety tests still run"); return;
  }
  const document = readFileSync(standard, "utf8");
  const table = document.split("\n").filter(line => /^\| [a-z]+_[a-z_]+ \|/.test(line)).map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
  assert.deepEqual(table.map(row => row.slice(0, 5)), registeredErrors().map(e => [e.code, e.title, e.reason, e.action.label, e.action.target]));
});

test("every dictionary entry contains plain-language explanation and a fixed corrective destination", () => {
  const entries = registeredErrors(); assert.ok(entries.length >= 15);
  assert.equal(new Set(entries.map(e => e.code)).size, entries.length);
  for (const entry of entries) {
    const error = requireRegisteredError(entry.code);
    assert.ok(error.title.length > 4 && error.reason.length > 8 && error.action.label.length > 3);
    assert.equal(error.message, `${entry.title}。${entry.reason}。请点击「${entry.action.label}」`);
    assert.doesNotMatch(mainText(error), /[a-z]|\b[45]\d\d\b|状态码|内部错误|OSStatus/i);
    assert.deepEqual(error.details, { code: entry.code, technicalCode: entry.code });
  }
  assert.throws(() => requireRegisteredError("new_undocumented_error"), RangeError);
});

test("fifteen existing error paths map to useful fixed categories", () => {
  const cases: Array<[unknown, string]> = [
    [new TypeError("Failed to fetch"), "service_unavailable"],
    [{ status: 504, message: "Qoder 请求超时。" }, "request_timeout"],
    [{ status: 400, error: "请填写至少一个有效的 Vertex 模型 ID。" }, "invalid_input"],
    [{ status: 404, error: { type: "not_found_error", code: "model_not_found", message: "private model" } }, "model_unavailable"],
    [{ message: 'The subscription "private source" is switched off in EasySwitch.' }, "source_disabled"],
    [{ status: 401, context: "source", error: "opaque private upstream text" }, "source_auth_required"],
    [{ code: "EACCES", message: "private path" }, "permission_denied"],
    [{ status: 429, error: "upstream quota or rate limit reached" }, "quota_limited"],
    [{ status: 429, code: "budget_exceeded" }, "budget_blocked"],
    [{ message: "没有检测到这个 agent 的命令" }, "client_not_installed"],
    [{ status: 409, code: "desktop_isolation_unverified" }, "capability_unavailable"],
    [{ code: "keychain_access_required", osStatus: -25308, message: "OSStatus -25308" }, "keychain_unavailable"],
    [{ status: 503, code: "gateway_session_storage_unavailable" }, "storage_unavailable"],
    [{ status: 401, code: "invalid_gateway_session" }, "session_invalid"],
    [{ status: 429, message: "已有 3 个文字桥请求运行，请稍后再试。" }, "request_busy"],
  ];
  assert.deepEqual(new Set(cases.map(([, code]) => code)), new Set(registeredErrors().map(e => e.code)));
  for (const [input, code] of cases) assert.equal(humanError(input).code, code);
});

test("explicit codes take priority and status/technical codes stay in details only", () => {
  const error = humanError({ code: "keychain_access_required", status: 503, osStatus: -25308, message: "quota exceeded" });
  assert.equal(error.code, "keychain_unavailable");
  assert.deepEqual(error.details, { code: "keychain_unavailable", status: 503, technicalCode: "keychain_access_required", osStatus: -25308 });
  assert.doesNotMatch(mainText(error), /503|-25308|quota|keychain_access_required/);
  assert.equal(humanError({ code: "probe_budget_unmetered", status: 409 }).code, "budget_blocked");
  assert.equal(humanError({ code: "key_rejected", status: 401 }).code, "source_auth_required");
  assert.equal(humanError({ code: "provider_unavailable", status: 503 }).code, "service_unavailable");
});

test("ambiguous filesystem and authentication failures use only explicit bounded context", () => {
  assert.equal(humanError({ code: "ENOENT" }, { context: "launch" }).code, "client_not_installed");
  assert.equal(humanError({ code: "ENOENT" }, { context: "storage" }).code, "storage_unavailable");
  assert.equal(humanError({ code: "ENOENT" }).code, "unknown_error");
  assert.equal(humanError({ status: 401 }, { context: "source" }).code, "source_auth_required");
  assert.equal(humanError({ status: 401 }, { context: "session" }).code, "session_invalid");
  assert.equal(humanError({ status: 429 }, { context: "launch" }).code, "request_busy");
});

test("unknown messages, upstream bodies and hostile presentation fields never leak through either output surface", () => {
  const privateText = "Bearer opaque-private-value sk-fixture-secret https://private.invalid/path <img onerror=alert(1)> /Users/private/home";
  for (const input of [privateText, new Error(privateText), { code: privateText, status: 500, message: privateText, body: privateText }, { error: { code: privateText, message: privateText } }, { code: "model_unavailable", title: privateText, reason: privateText, action: { label: privateText, target: privateText }, details: { token: privateText } }]) {
    const result = humanError(input);
    assert.doesNotMatch(JSON.stringify(result), /opaque-private|fixture-secret|private\.invalid|onerror|Users\/private/);
    assert.ok(["unknown_error", "model_unavailable"].includes(result.code));
  }
  const result = humanError({ code: "unknown_private_code", status: 500, message: "unclassified" });
  assert.deepEqual(result.details, { code: "unknown_error", status: 500 });
});

test("bounded legacy classification returns constants and never evaluates getters or coercion hooks", () => {
  const hostile = { get message(): never { throw new Error("getter should not run"); }, toString(): never { throw new Error("coercion should not run"); }, toJSON(): never { throw new Error("serialization should not run"); } };
  assert.equal(humanError(hostile).code, "unknown_error");
  assert.equal(humanError({ message: "x".repeat(2048) + "timeout" }).code, "unknown_error");
  assert.equal(humanError({ message: "timeout " + "secret".repeat(10000) }).code, "request_timeout");
  for (const input of [null, undefined, [], 42, false]) assert.equal(humanError(input).code, "unknown_error");
});

test("dictionary and presentation copies cannot modify later callers", () => {
  const rows = registeredErrors(); rows[0]!.title = "changed"; rows[0]!.action.target = "current"; rows.pop();
  const view = humanError({ code: "service_unavailable" }); view.title = "changed"; view.action.target = "current";
  assert.notEqual(registeredErrors()[0]!.title, "changed");
  assert.equal(humanError({ code: "service_unavailable" }).action.target, "doctor");
});

test("the browser and Node use the same dictionary without document, network or runtime dependencies", () => {
  const context = { fetch() { throw new Error("network forbidden"); } } as { fetch(): never; EasySwitchErrors?: UserErrorsApi };
  runInNewContext(readFileSync(new URL("../../web/errors.js", import.meta.url), "utf8"), context);
  assert.ok(context.EasySwitchErrors);
  for (const row of registeredErrors()) assert.deepEqual(JSON.parse(JSON.stringify(context.EasySwitchErrors!.humanError({ code: row.code }))), humanError({ code: row.code }));
});
