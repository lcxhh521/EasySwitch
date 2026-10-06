import { join } from "node:path";
import { GatewayTokenAuthority } from "./gateway-auth.ts";
import { gatewayPort } from "./paths.ts";
import { Ledger } from "./ledger.ts";
import { ensureKeychainHelper } from "./native-keychain.ts";
import { createSecretStore } from "./secrets.ts";
import { createEasySwitchServer, stopClaudeDesktopSessions } from "./server.ts";
import { Store } from "./store.ts";

const port = gatewayPort();
if (process.env.EASYSWITCH_SECRETS !== "memory" && !ensureKeychainHelper()) console.error("[easyswitch] 钥匙串 helper 不可用或稳定签名未通过。请在 Mac 前台使用已有签名身份运行 scripts/build-keychain.sh；后台不会自动编译、签名或请求授权。");
const store = new Store();
const gatewayAuth = new GatewayTokenAuthority({ stateFile: join(store.dir, "gateway-sessions.jsonl") });
const server = createEasySwitchServer({ store, secrets: createSecretStore(), port, ledger: new Ledger(store.dir), gatewayAuth });

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `port ${port} is already in use; is EasySwitch already running?` : error);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`EasySwitch core on http://127.0.0.1:${port}  (console: /, gateway: /v1)`);
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try { await stopClaudeDesktopSessions(server); }
    catch { console.error("独立桌面会话未完全退出，私有目录已保留"); }
    server.close(() => process.exit(0));
  });
}
