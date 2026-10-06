import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { test } from "node:test";
import { assertLoopbackHttpArgs, guardedConnect, loopbackConnectArgs, makeLoopbackConnect } from "./local-only-guard.ts";

test("the socket guard rejects external hosts and Unix paths before reaching any real connection", () => {
  let calls = 0;
  const fakeConnect = makeLoopbackConnect(function (this: net.Socket) { calls++; return this; } as typeof net.Socket.prototype.connect);
  const socket = new net.Socket();
  const attempts: unknown[][] = [
    [443, "example.com"], [{ port: 443, host: "8.8.8.8" }], [{ port: 80, host: "0.0.0.0" }],
    [{ port: 80, host: "[::]" }], [{ port: 80, host: "127.1" }], [{ port: 80, host: "localhost.example" }],
    [{ port: 80, host: "localhost." }], [{ port: 80, host: "::ffff:8.8.8.8" }], [{ port: 80, hostname: "example.com" }],
    ["/tmp/easyswitch.sock"], [{ path: "/tmp/easyswitch.sock" }], [{ port: 80, host: "127.0.0.1", path: "/tmp/socket" }],
    [{ port: 80, host: "127.0.0.1", socketPath: "/tmp/socket" }], [0, "127.0.0.1"], [{ port: 70000 }], [[80, "example.invalid"]], [],
  ];
  for (const args of attempts) assert.throws(() => Reflect.apply(fakeConnect, socket, args), /Local-only tests blocked/);
  assert.equal(calls, 0, "even a broken expectation would only reach the injected stub, never the network");
  socket.destroy();
});

test("socket guard handles public overloads and Node's normalized-array shape without dropping callback/options", () => {
  const callback = () => {};
  const forms: unknown[][] = [
    [1234, "127.0.0.1", callback], ["1234", "127.0.0.2", callback],
    [{ port: 1234, host: "::1", family: 6 }, callback],
    [{ port: "1234", host: "0:0:0:0:0:0:0:1" }, callback],
    [[{ port: 1234, host: "127.0.0.1", noDelay: true, path: null }, callback]],
  ];
  let calls = 0;
  const guarded = makeLoopbackConnect(function (this: net.Socket, options: unknown, received?: () => void) {
    calls++; assert.equal((options as { port: number }).port, 1234); assert.equal(received, callback); return this;
  } as typeof net.Socket.prototype.connect);
  const socket = new net.Socket();
  for (const args of forms) assert.equal(Reflect.apply(guarded, socket, args), socket);
  assert.equal(calls, forms.length);
  assert.equal(loopbackConnectArgs(forms[3]!).options.host, "::1");
  assert.equal(loopbackConnectArgs(forms[4]!).options.noDelay, true);
  socket.destroy();
});

test("localhost uses a fixed loopback lookup instead of DNS or a caller-provided resolver", async () => {
  let customCalls = 0;
  const { options } = loopbackConnectArgs([{ port: 1234, host: "localhost", lookup: () => { customCalls++; throw new Error("must not run"); } }]);
  const lookup = options.lookup as (host: string, opts: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => void;
  const many = await new Promise<unknown[]>(resolve => lookup("localhost", { all: true }, (...args) => resolve(args)));
  assert.deepEqual(many, [null, [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]]);
  const six = await new Promise<unknown[]>(resolve => lookup("localhost", { family: 6 }, (...args) => resolve(args)));
  assert.deepEqual(six, [null, "::1", 6]);
  assert.equal(customCalls, 0);
});

test("raw HTTP, HTTPS and TLS reject through the socket guard before their injected connector", async t => {
  let underlyingCalls = 0;
  const safeStub = makeLoopbackConnect(function (this: net.Socket) {
    underlyingCalls++;
    throw new Error("unexpected call to the fake underlying connector");
  } as typeof net.Socket.prototype.connect);
  t.mock.method(net.Socket.prototype, "connect", safeStub);
  try {
    for (const makeRequest of [() => http.request("http://example.invalid/"), () => https.request("https://example.invalid/"), () => new http.ClientRequest("http://example.invalid/"), () => Reflect.apply(http.ClientRequest, null, ["http://example.invalid/"]) as http.ClientRequest]) {
      await assert.rejects(new Promise<void>((resolve, reject) => {
        try {
          const request = makeRequest(); request.once("error", reject); request.once("response", () => resolve()); request.end();
        } catch (error) { reject(error); }
      }), /Local-only tests blocked/);
    }
    await assert.rejects(new Promise<void>((resolve, reject) => {
      try {
        const socket = tls.connect({ host: "example.invalid", port: 443 });
        socket.once("error", reject); socket.once("secureConnect", () => { socket.destroy(); resolve(); });
      } catch (error) { reject(error); }
    }), /Local-only tests blocked/);
    assert.equal(underlyingCalls, 0);
  } finally { t.mock.restoreAll(); }
});

test("HTTP target checks reject proxy absolute-form and CONNECT destinations before a local proxy can relay them", () => {
  for (const args of [
    ["http://example.invalid/"], ["https://example.invalid/"],
    [{ host: "127.0.0.1", port: 1234, path: "http://example.invalid/path" }],
    [{ host: "127.0.0.1", port: 1234, method: "CONNECT", path: "example.invalid:443" }],
    [{ socketPath: "/tmp/proxy.sock", path: "/" }],
  ]) assert.throws(() => assertLoopbackHttpArgs(args), /Local-only tests blocked/);
  assert.doesNotThrow(() => assertLoopbackHttpArgs(["http://127.0.0.1:1234/path?x=1"]));
  assert.doesNotThrow(() => assertLoopbackHttpArgs(["http://[::1]:1234/"]));
});

test("the installed guard still permits real loopback TCP and raw HTTP fixtures", async t => {
  assert.equal(net.Socket.prototype.connect, guardedConnect);
  const server = http.createServer((_req, res) => res.end("local fixture"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as net.AddressInfo).port;
  for (const host of ["127.0.0.1", "localhost"]) {
    const answer = await new Promise<string>((resolve, reject) => {
      http.get({ host, port, path: "/fixture" }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body));
      }).on("error", reject);
    });
    assert.equal(answer, "local fixture");
  }
});
