import { gatewayPort } from "./paths.ts";
import { Ledger } from "./ledger.ts";
import { createSecretStore } from "./secrets.ts";
import { createEasySwitchServer } from "./server.ts";
import { Store } from "./store.ts";

const port = gatewayPort();
const server = createEasySwitchServer({ store: new Store(), secrets: createSecretStore(), port, ledger: new Ledger(), gatewayAuth: true });

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `port ${port} is already in use; is EasySwitch already running?` : error);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`EasySwitch core on http://127.0.0.1:${port}  (console: /, gateway: /v1)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
