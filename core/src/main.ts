import { gatewayPort } from "./paths.ts";
import { Ledger } from "./ledger.ts";
import { ensureKeychainHelper } from "./native-keychain.ts";
import { createSecretStore } from "./secrets.ts";
import { createEasySwitchServer, stopClaudeDesktopSessions } from "./server.ts";
import { Store } from "./store.ts";

const port = gatewayPort();
if (process.env.EASYSWITCH_SECRETS !== "memory" && !ensureKeychainHelper()) console.error("[easyswitch] 钥匙串小程序没有编译成功（需要 Xcode 命令行工具）：读不到已保存的 Key。可手动运行 scripts/build-keychain.sh 看原因。");
const server = createEasySwitchServer({ store: new Store(), secrets: createSecretStore(), port, ledger: new Ledger() });

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
