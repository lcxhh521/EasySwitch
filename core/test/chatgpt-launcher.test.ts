import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configHasStaticCatalog, gatewayBase, launcherScript, prepareLauncher, processArgv } from "../src/chatgpt.ts";

test("the launcher adds the gateway address for this launch and fails open when the gateway is down", () => {
  const script = launcherScript("/Apps/ChatGPT.app/codex", 18765, ['model_catalog_json="/tmp/x.json"']);
  assert.match(script, /exec "\$REAL" -c 'openai_base_url="http:\/\/127\.0\.0\.1:18765\/backend-api\/codex"' -c 'model_catalog_json="\/tmp\/x\.json"' "\$@"/);
  assert.match(script, /curl -sf --max-time 1 "http:\/\/127\.0\.0\.1:18765\/health"/);
  assert.match(script, /\nexec "\$REAL" "\$@"\n$/, "without a gateway the real program runs untouched");
  assert.equal(gatewayBase(18765), "http://127.0.0.1:18765/backend-api/codex");
  // The script must be valid shell.
  const dir = mkdtempSync(join(tmpdir(), "es-launcher-"));
  const file = join(dir, "l.sh");
  writeFileSync(file, script);
  execFileSync("bash", ["-n", file]);
});

test("a launcher run with no gateway behaves exactly like the real program", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-launcher-run-"));
  const real = join(dir, "real.sh");
  writeFileSync(real, "#!/bin/bash\nprintf 'ARGS:'; printf ' [%s]' \"$@\"; echo\n", { mode: 0o755 });
  const launcher = join(dir, "launcher.sh");
  writeFileSync(launcher, launcherScript(real, 1 /* nothing listens here */), { mode: 0o755 });
  const out = execFileSync(launcher, ["app-server", "--flag", "a b"], { encoding: "utf8" });
  assert.equal(out.trim(), "ARGS: [app-server] [--flag] [a b]");
});

test("another tool's static model catalog in config.toml is detected, a plain config is not", () => {
  const home = mkdtempSync(join(tmpdir(), "es-codex-cfg-"));
  writeFileSync(join(home, "config.toml"), 'model = "x"\n');
  assert.equal(configHasStaticCatalog(home), false);
  writeFileSync(join(home, "config.toml"), 'model = "x"\nmodel_catalog_json = "/Users/u/.codex/opencodex-catalog.json"\n');
  assert.equal(configHasStaticCatalog(home), true);
  writeFileSync(join(home, "config.toml"), '# model_catalog_json = "/old"\n');
  assert.equal(configHasStaticCatalog(home), false, "a comment is not a setting");
  assert.equal(configHasStaticCatalog(join(home, "nope")), false);
});

test("a process's exact arguments are read, including ones that contain spaces", async () => {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", "--host-resolver-rules=MAP chatgpt.com 127.0.0.1:10300", "plain"], { stdio: "ignore" });
  try {
    await new Promise(r => setTimeout(r, 200));
    const argv = await processArgv(holder.pid!);
    assert.ok(argv, "argv was read");
    assert.ok(argv!.includes("--host-resolver-rules=MAP chatgpt.com 127.0.0.1:10300"), `an argument with spaces stays one argument: ${JSON.stringify(argv)}`);
    assert.equal(argv!.at(-1), "plain");
  } finally {
    holder.kill();
  }
});

test("preparing the launcher writes an executable script and leaves ~/.codex alone", async t => {
  const dir = mkdtempSync(join(tmpdir(), "es-prepare-"));
  const prepared = await prepareLauncher(dir, 18765, []);
  if (!prepared) { t.skip("ChatGPT.app not installed"); return; }
  assert.ok((statSync(prepared.launcher).mode & 0o111) !== 0, "executable");
  assert.ok(prepared.launcher.startsWith(dir), "lives in EasySwitch's own directory");
});
