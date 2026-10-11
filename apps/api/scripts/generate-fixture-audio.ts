import { resolve } from "node:path";
import { LocalMediaStorage } from "../src/storage.js";

const storage = new LocalMediaStorage(resolve(process.env.APP_DATA_DIR ?? ".data"));
const result = await storage.ensureDevelopmentTone();
console.log(`Generated development-only WAV fixture: ${result.key} (${result.durationMs}ms)`);
