/** Preload only for the explicitly audited local test suite, never for app runtime. */
import childProcess from "node:child_process";
import http2 from "node:http2";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Local-only tests blocked a non-loopback HTTP destination");
  }
  // Redirects must be inspected by a fixture; automatic redirects could leave loopback.
  return realFetch(input, { ...init, redirect: init?.redirect === "manual" ? "manual" : "error" });
};
const realHttp2Connect = http2.connect;
http2.connect = ((authority: string | URL, ...args: unknown[]) => {
  const url = new URL(authority);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Local-only tests blocked non-loopback HTTP2 destination");
  return Reflect.apply(realHttp2Connect, http2, [authority, ...args]);
}) as typeof http2.connect;
const realSpawn = childProcess.spawn;
for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"] as const) {
  childProcess[name] = (() => { throw new Error(`Local-only tests blocked subprocess: ${name}`); }) as never;
}
if (process.env.EASYSWITCH_TEST_DESKTOP_FIXTURES === "1") {
  // Exact content hashes of the five audited fixture scripts in claude-desktop.test.ts.
  // A changed fixture needs review and an updated hash, never a broader command allowance.
  const fixtureHashes = new Set([
    "ee480ed34bc814b4930de67164688a87951ab91b771fa68b6da11ca771b874be", // loopback-only profile request
    "413239372b02cbbdbe8689dbdf2fea3b2ac0165c296e8223d682fc595e50b54e", // exit(7)
    "f711052b4b74b545d1615a64e37b3caef217b2334bddea01deb00a66aaee2a87", // exit(0)
    "ddc572c2f6b90b5d01050c0805f812faa8dadeab7a4d9af83cc4ed065d04b68f", // owned mock ignores SIGTERM
    "3c1ab62b2d434e06af5ed177cae1b42bb47a10bb9a5fe41141110a191b056840", // idle mock
  ]);
  childProcess.spawn = ((...args: unknown[]) => {
    const [command, argv] = args;
    if (command === "/test/Claude") {
      // The missing-executable fixture is simulated, so no arbitrary /test program can run.
      const child = new childProcess.ChildProcess();
      process.nextTick(() => { child.emit("error", Object.assign(new Error("fixture ENOENT"), { code: "ENOENT" })); child.emit("close", -2, null); });
      return child;
    }
    let allowed = command === process.execPath && JSON.stringify(argv) === '["-e","setInterval(() => {}, 100)"]';
    if (typeof command === "string" && basename(command) === "claude-desktop" && /^es-desktop-fixture-[A-Za-z0-9]+$/.test(basename(dirname(command)))) {
      try {
        const script = join(dirname(command), "mock.mjs");
        const expected = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`;
        allowed = realpathSync(command) === command && realpathSync(script) === script
          && readFileSync(command, "utf8") === expected
          && fixtureHashes.has(createHash("sha256").update(readFileSync(script)).digest("hex"));
      } catch { allowed = false; }
    }
    if (!allowed) throw new Error("Local-only tests blocked an unrecognized desktop executable");
    return Reflect.apply(realSpawn, childProcess, args);
  }) as typeof childProcess.spawn;
}
syncBuiltinESMExports();
