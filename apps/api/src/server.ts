import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const application = await createApplication({ ...config, autoMigrate: true, seed: config.environment === "development" });
await application.app.listen({ port: config.port, host: "127.0.0.1" });
console.log(`声音时间机器 API 已启动：http://127.0.0.1:${config.port}`);

const shutdown = async () => { await application.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
