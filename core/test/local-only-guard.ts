/** Preload only for the explicitly audited local test suite, never for app runtime. */
import childProcess from "node:child_process";
import http2 from "node:http2";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Normalize the documented overloads plus Node's internally normalized args array. */
export function loopbackConnectArgs(args: readonly unknown[]): { options: Record<string, unknown>; callback?: () => void } {
  const normalized = Array.isArray(args[0]) ? args[0] : undefined;
  const first = normalized ? normalized[0] : args[0];
  if (normalized && (!first || typeof first !== "object" || Array.isArray(first))) throw new Error("Local-only tests blocked invalid normalized socket arguments");
  const callback = normalized ? normalized[1] : args.at(-1);
  let options: Record<string, unknown>;
  if (first && typeof first === "object" && !Array.isArray(first)) options = { ...first as Record<string, unknown> };
  else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    options = { port: first, ...(typeof args[1] === "string" ? { host: args[1] } : {}) };
  } else throw new Error("Local-only tests blocked a socket path or invalid connection target");
  if (options.path != null || options.socketPath != null) throw new Error("Local-only tests blocked a Unix/socket path");
  const port = typeof options.port === "string" && /^\d+$/.test(options.port) ? Number(options.port) : options.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Local-only tests blocked an invalid TCP port");
  const rawHost = options.host ?? options.hostname ?? "localhost";
  if (typeof rawHost !== "string") throw new Error("Local-only tests blocked a non-loopback socket destination");
  const host = rawHost.toLowerCase();
  const v4 = net.isIP(host) === 4 && host.split(".")[0] === "127";
  const v6 = net.isIP(host) === 6 && new URL(`http://[${host}]/`).hostname === "[::1]";
  if (!v4 && !v6 && host !== "localhost") throw new Error("Local-only tests blocked a non-loopback socket destination");
  options.port = port;
  options.host = v6 ? "::1" : host;
  // Never consult DNS or a caller-supplied lookup for localhost. Both choices
  // are literal loopback; Node may try IPv6 after IPv4 when the server uses it.
  if (host === "localhost") options.lookup = (_hostname: string, lookupOptions: { all?: boolean; family?: number }, done: (...args: unknown[]) => void) => {
    const family = lookupOptions?.family;
    const addresses = family === 6 ? [{ address: "::1", family: 6 }] : family === 4 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }];
    process.nextTick(() => lookupOptions?.all ? done(null, addresses) : done(null, addresses[0]!.address, addresses[0]!.family));
  };
  return { options, ...(typeof callback === "function" ? { callback: callback as () => void } : {}) };
}

/** Injection is for rejection tests: they never invoke a real external connect. */
export function makeLoopbackConnect(connect: typeof net.Socket.prototype.connect): typeof net.Socket.prototype.connect {
  return function localOnlyConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const { options, callback } = loopbackConnectArgs(args);
    return Reflect.apply(connect, this, callback ? [options, callback] : [options]);
  } as typeof net.Socket.prototype.connect;
}

// http.request, https.request, tls.connect and net.createConnection all reach
// this method when opening a TCP socket. Keep fetch/http2 URL checks as well.
export const guardedConnect = makeLoopbackConnect(net.Socket.prototype.connect);
net.Socket.prototype.connect = guardedConnect;

/** Check the intended HTTP destination before an environment proxy can rewrite it to loopback. */
export function assertLoopbackHttpArgs(args: readonly unknown[]): void {
  const first = args[0];
  let options: Record<string, unknown>;
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(first);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Local-only tests blocked a non-HTTP destination");
    options = { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: `${url.pathname}${url.search}`, ...(args[1] && typeof args[1] === "object" ? args[1] as Record<string, unknown> : {}) };
  } else if (first && typeof first === "object") options = { ...first as Record<string, unknown> };
  else throw new Error("Local-only tests blocked an invalid HTTP destination");
  if (options.socketPath != null) throw new Error("Local-only tests blocked a Unix/socket path");
  const host = options.hostname ?? options.host ?? "localhost";
  const unbracketed = typeof host === "string" ? host.replace(/^\[([^\]]+)\]$/, "$1") : host;
  loopbackConnectArgs([{ host: unbracketed, port: options.port ?? (options.protocol === "https:" ? 443 : 80) }]);
  if (typeof options.path === "string" && /^https?:\/\//i.test(options.path)) assertLoopbackHttpArgs([options.path]);
  if (String(options.method ?? "").toUpperCase() === "CONNECT") {
    if (typeof options.path !== "string") throw new Error("Local-only tests blocked an invalid CONNECT destination");
    assertLoopbackHttpArgs([`http://${options.path}/`]);
  }
}

for (const module of [http, https]) {
  const request = module.request, get = module.get;
  module.request = ((...args: unknown[]) => { assertLoopbackHttpArgs(args); return Reflect.apply(request, module, args); }) as typeof module.request;
  module.get = ((...args: unknown[]) => { assertLoopbackHttpArgs(args); return Reflect.apply(get, module, args); }) as typeof module.get;
}
// ClientRequest is public too: constructing it directly skips request()/get().
// A Proxy preserves the original prototype and subclass/new.target behavior.
http.ClientRequest = new Proxy(http.ClientRequest, {
  construct(target, args, newTarget) { assertLoopbackHttpArgs(args); return Reflect.construct(target, args, newTarget); },
  apply(target, receiver, args) { assertLoopbackHttpArgs(args); return Reflect.apply(target, receiver, args); },
});

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
