import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type SqlClient = PGlite;

export async function openDatabase(dataDir: string): Promise<SqlClient> {
  await mkdir(dataDir, { recursive: true });
  return new PGlite(join(dataDir, "postgres"));
}

function migrationDirectories(): string[] {
  return [
    resolve(process.cwd(), "migrations"),
    resolve(process.cwd(), "apps/api/migrations"),
    resolve(dirname(new URL(import.meta.url).pathname), "../migrations")
  ];
}

export async function migrate(db: SqlClient): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const directory = migrationDirectories().find(async () => true) ?? resolve(process.cwd(), "migrations");
  let files: string[] = [];
  for (const candidate of migrationDirectories()) {
    try {
      files = (await readdir(candidate)).filter((file) => file.endsWith(".sql")).sort();
      if (files.length > 0) {
        const applied = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
        const done = new Set(applied.rows.map((row) => row.id));
        const changed: string[] = [];
        for (const file of files) {
          if (done.has(file)) continue;
          const sql = await readFile(join(candidate, file), "utf8");
          await db.exec(sql);
          await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
          changed.push(file);
        }
        return changed;
      }
    } catch {
      // Try the next location. This keeps source and compiled CLI layouts runnable.
    }
  }
  throw new Error(`No SQL migrations found under ${directory}`);
}

export function stableRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function closeDatabase(db: SqlClient): Promise<void> {
  await db.close();
}
