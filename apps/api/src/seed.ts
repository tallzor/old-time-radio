import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { SqlClient } from "./database.js";
import { LocalMediaStorage } from "./storage.js";

const ASSET_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000099";

type Fixture = {
  id: string;
  title: string;
  era: "1970s" | "1980s" | "1990s" | "2000s";
  category: "news" | "storytelling" | "novel" | "opera";
  sourceKind: "archive_original" | "modern_performance" | "ai_reconstruction";
  status: "published" | "offline";
  starterPool?: boolean;
  note: string;
};

const fixtures: Fixture[] = [
  { id: "10000000-0000-4000-8000-000000000001", title: "开发示例：70年代新闻短讯", era: "1970s", category: "news", sourceKind: "modern_performance", status: "published", starterPool: true, note: "开发用合成测试音，按审核示例年代归类。" },
  { id: "10000000-0000-4000-8000-000000000002", title: "开发示例：80年代评书片段 A", era: "1980s", category: "storytelling", sourceKind: "modern_performance", status: "published", starterPool: true, note: "开发用合成测试音，不对应真实作品。" },
  { id: "10000000-0000-4000-8000-000000000003", title: "开发示例：80年代评书片段 B", era: "1980s", category: "storytelling", sourceKind: "modern_performance", status: "published", note: "开发用合成测试音，不对应真实作品。" },
  { id: "10000000-0000-4000-8000-000000000004", title: "开发示例：80年代 AI 重制标识", era: "1980s", category: "news", sourceKind: "ai_reconstruction", status: "published", note: "开发用合成测试音；界面必须展示 AI 重制标识。" },
  { id: "10000000-0000-4000-8000-000000000005", title: "开发示例：90年代小说片段", era: "1990s", category: "novel", sourceKind: "modern_performance", status: "published", starterPool: true, note: "开发用合成测试音，不对应真实作品。" },
  { id: "10000000-0000-4000-8000-000000000006", title: "开发示例：00年代戏曲片段 A", era: "2000s", category: "opera", sourceKind: "modern_performance", status: "published", note: "开发用合成测试音，不对应真实作品。" },
  { id: "10000000-0000-4000-8000-000000000007", title: "开发示例：00年代戏曲片段 B", era: "2000s", category: "opera", sourceKind: "modern_performance", status: "published", note: "开发用合成测试音，不对应真实作品。" },
  { id: "10000000-0000-4000-8000-000000000008", title: "开发示例：已下架节目", era: "1970s", category: "opera", sourceKind: "modern_performance", status: "offline", note: "开发用下架状态，不能出现在游客选播中。" }
];

export async function seedDevelopmentData(db: SqlClient, config: AppConfig): Promise<{ programs: number; fixture: string }> {
  const storage = new LocalMediaStorage(config.dataDir);
  const fixture = await storage.ensureDevelopmentTone();
  const wave = await storage.inspectWave(fixture.key);
  await db.query(
    `INSERT INTO audio_assets (id, object_key, mime_type, bytes, duration_ms, checksum, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready')
     ON CONFLICT (id) DO UPDATE SET mime_type = EXCLUDED.mime_type, bytes = EXCLUDED.bytes,
       duration_ms = EXCLUDED.duration_ms, checksum = EXCLUDED.checksum, status = 'ready', updated_at = NOW()`,
    [ASSET_ID, fixture.key, wave.mimeType, wave.bytes, wave.durationMs, wave.checksum]
  );
  await db.query(
    `INSERT INTO admin_users (id, login_identity, role) VALUES ($1, 'local-bootstrap-admin', 'admin')
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID]
  );

  for (const fixtureProgram of fixtures) {
    await db.query(
      `INSERT INTO programs (id, title, era, category, audio_asset_id, source_kind, era_basis, source_note, is_excerpt, excerpt_label, status, starter_pool, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'development_fixture', $7, TRUE, '开发测试片段', $8, $9, CASE WHEN $8 = 'published' THEN NOW() ELSE NULL END)
       ON CONFLICT (id) DO NOTHING`,
      [fixtureProgram.id, fixtureProgram.title, fixtureProgram.era, fixtureProgram.category, ASSET_ID, fixtureProgram.sourceKind, fixtureProgram.note, fixtureProgram.status, fixtureProgram.starterPool ?? false]
    );
    await db.query(
      `INSERT INTO program_sources (id, program_id, source_url, source_title, source_type, checked_by)
       VALUES ($1, $2, 'https://example.invalid/development-fixture', '开发 fixture 说明', 'development_fixture', 'local-bootstrap-admin')
       ON CONFLICT (id) DO NOTHING`,
      [`${fixtureProgram.id}:source`, fixtureProgram.id]
    );
    await db.query(
      `INSERT INTO program_clearances (id, program_id, usage_basis, evidence_ref, checked_by)
       VALUES ($1, $2, 'development_fixture_only', '本地生成 WAV；不可用于生产', 'local-bootstrap-admin')
       ON CONFLICT (id) DO NOTHING`,
      [`${fixtureProgram.id}:clearance`, fixtureProgram.id]
    );
    await db.query(
      `INSERT INTO program_reviews (id, program_id, script_version, decision, notes, reviewer_id)
       VALUES ($1, $2, 1, 'approved', '开发 fixture，仅用于本地功能验收。', $3)
       ON CONFLICT (id) DO NOTHING`,
      [`${fixtureProgram.id}:review`, fixtureProgram.id, ADMIN_ID]
    );
  }
  return { programs: fixtures.length, fixture: fixture.key };
}

export const developmentFixtureIds = { asset: ASSET_ID, admin: ADMIN_ID, programs: fixtures.map((fixture) => fixture.id) };
