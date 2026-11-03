import assert from "node:assert/strict";
import { constants } from "node:fs";
import { test } from "node:test";
import { AGENT_DETECTION_ERROR, detectAgents, type AgentDetectionRuntime, type AgentInfo } from "../src/agents.ts";

const file = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const other = { isFile: () => false, isDirectory: () => false };
const fault = (code: string) => Object.assign(new Error("private-local-output /Users/secret .token value"), { code });
const agent = (find: Partial<AgentInfo> = {}): AgentInfo => ({ id: "fixture", name: "Fixture", vendor: "Fixture", kind: "cli", support: "planned", protocols: ["chat"], icon: "letter:F", note: "fixture", bins: ["fixture"], ...find });
function runtime(overrides: Partial<AgentDetectionRuntime> = {}): AgentDetectionRuntime {
  return { platform: "darwin", home: "/fixture/home", path: "/fixture/bin", pathExt: ".EXE;.CMD", timeoutMs: 1_000,
    stat: async () => { throw fault("ENOENT"); }, access: async () => {}, ...overrides };
}

test("detection reports missing only for absent metadata, not an unresolved boolean", async () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const [result] = await detectAgents([agent({ paths: ["/fixture/fallback"], apps: ["Fixture"] })], runtime({ stat: async () => { throw fault(code); } }));
    assert.equal(result?.detection, "not_found"); assert.equal(result?.installed, false);
    assert.equal(result?.where, undefined); assert.equal(result?.detectionError, undefined);
  }
});

test("permission, I/O, broken symlink loop and unexpected probe failures are safely inconclusive", async () => {
  for (const code of ["EACCES", "EPERM", "EIO", "ELOOP", "ETIMEDOUT", "UNKNOWN"]) {
    const [result] = await detectAgents([agent()], runtime({ stat: async () => { throw fault(code); } }));
    assert.equal(result?.detection, "error"); assert.equal(result?.installed, false); assert.equal(result?.where, undefined);
    assert.equal(result?.detectionError, AGENT_DETECTION_ERROR);
    assert.doesNotMatch(JSON.stringify(result), /private-local-output|Users\/secret|\.token|EACCES|EIO|UNKNOWN/);
  }
});

test("PATH found uses only stat and executable access without executing the candidate", async () => {
  const reads: string[] = [], modes: number[] = [];
  const [result] = await detectAgents([agent()], runtime({ stat: async path => { reads.push(path); return file; }, access: async (path, mode) => { reads.push(path); modes.push(mode); } }));
  assert.equal(result?.detection, "found"); assert.equal(result?.installed, true); assert.equal(result?.where, "/fixture/bin/fixture");
  assert.deepEqual(reads, ["/fixture/bin/fixture", "/fixture/bin/fixture"]); assert.deepEqual(modes, [constants.X_OK]);
});

test("an executable access failure stays error but a vanished executable is missing", async () => {
  for (const code of ["EACCES", "EPERM", "EIO", "ENOENT"]) {
    const [result] = await detectAgents([agent()], runtime({ stat: async () => file, access: async () => { throw fault(code); } }));
    assert.equal(result?.detection, code === "ENOENT" ? "not_found" : "error"); assert.equal(result?.installed, false);
  }
});

test("directories and special files cannot become PATH executables", async () => {
  for (const info of [directory, other]) {
    const [result] = await detectAgents([agent()], runtime({ stat: async () => info, access: async () => assert.fail("wrong file type must not reach access") }));
    assert.equal(result?.detection, "not_found"); assert.equal(result?.installed, false);
  }
});

test("a later PATH location wins over an earlier permission failure", async () => {
  const [result] = await detectAgents([agent()], runtime({ path: "/fixture/blocked:/fixture/good", stat: async path => { if (path.startsWith("/fixture/blocked/")) throw fault("EACCES"); return file; } }));
  assert.equal(result?.detection, "found"); assert.equal(result?.where, "/fixture/good/fixture"); assert.equal(result?.detectionError, undefined);
});

test("another command alias and explicit path can recover a failed PATH check", async () => {
  const fixtures = runtime({ stat: async path => { if (path.endsWith("/fixture")) throw fault("EACCES"); return file; } });
  const results = await detectAgents([agent({ bins: ["fixture", "alternate"] }), agent({ id: "fallback", paths: ["/fixture/install/tool"] })], fixtures);
  assert.deepEqual(results.map(a => [a.detection, a.where, a.detectionError]), [["found", "/fixture/bin/alternate", undefined], ["found", "/fixture/install/tool", undefined]]);
});

test("macOS app fallback finds a directory even after unreadable PATH and system Applications", async () => {
  const [result] = await detectAgents([agent({ apps: ["Fixture"] })], runtime({ stat: async path => {
    if (path === "/fixture/home/Applications/Fixture.app") return directory;
    throw fault("EACCES");
  }, access: async () => assert.fail("app lookup is metadata-only") }));
  assert.equal(result?.detection, "found"); assert.equal(result?.where, "/fixture/home/Applications/Fixture.app");
});

test("a regular file with an app suffix is not an installed app bundle", async () => {
  const [result] = await detectAgents([agent({ bins: [], apps: ["Fixture"] })], runtime({ stat: async () => file, access: async () => assert.fail("no app execution") }));
  assert.equal(result?.detection, "not_found");
});

test("non-mac platforms never inspect macOS application directories or app-internal catalog paths", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const [result] = await detectAgents([agent({ bins: [], apps: ["Fixture"], paths: ["/Applications/Fixture.app/Contents/tool"] })], runtime({ platform, stat: async () => assert.fail("no macOS paths on other platforms") }));
    assert.equal(result?.detection, "not_found"); assert.equal(result?.installed, false);
  }
});

test("Windows command metadata uses PATHEXT and never invokes where.exe or a shell", async () => {
  const reads: string[] = [];
  const [result] = await detectAgents([agent()], runtime({ platform: "win32", path: "C:\\fixture\\bin", stat: async path => { reads.push(path); if (path.endsWith(".EXE")) return file; throw fault("ENOENT"); }, access: async (_path, mode) => { assert.equal(mode, constants.F_OK); } }));
  assert.equal(result?.detection, "found"); assert.equal(result?.where, "C:\\fixture\\bin\\fixture.EXE");
  assert.deepEqual(reads, ["C:\\fixture\\bin\\fixture", "C:\\fixture\\bin\\fixture.EXE"]);
});

test("relative, empty and omitted PATH entries are inconclusive instead of searching mutable cwd", async () => {
  for (const path of ["relative", ".", "", ":/fixture/bin", "/fixture/bin:", "/fixture/bin::/fixture/other"]) {
    const reads: string[] = [];
    const [result] = await detectAgents([agent()], runtime({ path, stat: async p => { reads.push(p); throw fault("ENOENT"); } }));
    assert.equal(result?.detection, "error"); assert.ok(reads.every(p => p.startsWith("/")));
  }
});

test("an absolute found path still wins when another PATH entry is unsupported", async () => {
  const [result] = await detectAgents([agent()], runtime({ path: ".:/fixture/bin", stat: async () => file }));
  assert.equal(result?.detection, "found"); assert.equal(result?.where, "/fixture/bin/fixture");
});

test("shared bin names and repeated PATH entries are inspected once per scan", async () => {
  let reads = 0;
  const results = await detectAgents([agent(), agent({ id: "other" })], runtime({ path: "/fixture/bin:/fixture/bin", stat: async () => { reads++; return file; } }));
  assert.equal(reads, 1); assert.deepEqual(results.map(a => a.detection), ["found", "found"]);
});

test("one missing final catalog entry cannot discard a successfully found earlier command", async () => {
  const results = await detectAgents([agent(), agent({ id: "missing", bins: ["missing"] })], runtime({ stat: async path => { if (path.endsWith("/missing")) throw fault("ENOENT"); return file; } }));
  assert.deepEqual(results.map(a => a.detection), ["found", "not_found"]);
});

test("stalled probes have a bounded scan budget and do not become not_found", async () => {
  const [result] = await detectAgents([agent()], runtime({ timeoutMs: 5, stat: async () => new Promise(() => {}) }));
  assert.equal(result?.detection, "error"); assert.equal(result?.installed, false); assert.equal(result?.where, undefined);
});

test("failed explicit paths are not silently swallowed and relative paths are not scanned", async () => {
  for (const path of ["/fixture/tool", "relative/tool"]) {
    const [result] = await detectAgents([agent({ bins: [], paths: [path] })], runtime({ stat: async p => { assert.ok(p.startsWith("/")); throw fault("EPERM"); } }));
    assert.equal(result?.detection, "error");
  }
});
