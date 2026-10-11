import { loadConfig } from "./config.js";
import { closeDatabase, migrate, openDatabase } from "./database.js";
import { seedDevelopmentData } from "./seed.js";

const action = process.argv[2];
if (action !== "migrate" && action !== "seed") {
  throw new Error("Usage: tsx src/cli.ts migrate|seed");
}

const config = loadConfig();
const db = await openDatabase(config.dataDir);
try {
  const migrations = await migrate(db);
  if (action === "migrate") {
    console.log(migrations.length ? `Applied migrations: ${migrations.join(", ")}` : "Database already up to date.");
  } else {
    const result = await seedDevelopmentData(db, config);
    console.log(`Seeded ${result.programs} development fixture programs with ${result.fixture}.`);
  }
} finally {
  await closeDatabase(db);
}
