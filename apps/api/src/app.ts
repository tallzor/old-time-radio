import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { filterCategorySchema, filterEraSchema, playbackProgressSchema, preferencesSchema, queueCreateSchema, eventInputSchema, type Category, type Era, type FeatureFlags } from "@sound-time-machine/contracts";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type AppConfig, loadConfig } from "./config.js";
import { closeDatabase, migrate, openDatabase, stableRequestHash, type SqlClient } from "./database.js";
import { seedDevelopmentData } from "./seed.js";
import { LocalMediaStorage } from "./storage.js";

type Principal = { id: string; kind: "guest" | "account"; sessionId: string };
type ProgramRow = {
  id: string; title: string; era: Era; category: Category; duration_ms: number | string;
  source_kind: "archive_original" | "modern_performance" | "ai_reconstruction";
  event_year: number | null; work_year: number | null; recording_year: number | null;
  source_note: string; is_excerpt: boolean; excerpt_label: string | null; object_key: string;
};
type Application = { app: FastifyInstance; db: SqlClient; close: () => Promise<void> };

const COOKIE_NAME = "stm_session";
const SESSION_TTL_DAYS = 30;
const QUEUE_TTL_HOURS = 2;
const API = "/api/v1";

const eraLabels: Record<string, string> = { "1970s": "70年代", "1980s": "80年代", "1990s": "90年代", "2000s": "00年代" };
const categoryLabels: Record<string, string> = { news: "新闻", storytelling: "评书", novel: "小说", opera: "戏曲" };

function asNumber(value: number | string | bigint | null): number {
  return value == null ? 0 : Number(value);
}

function isoNow(): string { return new Date().toISOString(); }
function id(): string { return randomUUID(); }
function requestId(request: FastifyRequest): string { return String(request.headers["x-request-id"] ?? request.id); }
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function json(value: unknown): string { return JSON.stringify(value); }

function result<T>(reply: FastifyReply, request: FastifyRequest, data: T, status = 200) {
  return reply.code(status).send({ data, request_id: requestId(request) });
}

function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string, retryable = false) {
  return reply.code(status).send({ error: { code, message, retryable }, request_id: requestId(request) });
}

function parsed<T extends z.ZodTypeAny>(schema: T, payload: unknown, reply: FastifyReply, request: FastifyRequest): z.infer<T> | undefined {
  const output = schema.safeParse(payload);
  if (!output.success) {
    fail(reply, request, 400, "INVALID_ARGUMENT", "请求内容不正确，请检查后重试。", false);
    return undefined;
  }
  return output.data;
}

function featureFlags(config: AppConfig): FeatureFlags {
  return { wechatEnabled: config.wechatEnabled, wechatSdkEnabled: config.wechatEnabled && config.wechatSdkEnabled, tuningSoundEnabled: false };
}

function toProgram(row: ProgramRow, liked = false) {
  const displayYear = row.event_year ?? row.work_year ?? row.recording_year ?? null;
  return {
    id: row.id,
    title: row.title,
    era: row.era,
    era_label: eraLabels[row.era],
    category: row.category,
    category_label: categoryLabels[row.category],
    duration_ms: asNumber(row.duration_ms),
    source_kind: row.source_kind,
    display_year: displayYear,
    source_note: row.source_note,
    is_excerpt: row.is_excerpt,
    excerpt_label: row.excerpt_label,
    is_liked: liked
  };
}

async function one<T>(db: SqlClient, sql: string, values: unknown[] = []): Promise<T | undefined> {
  const response = await db.query<T>(sql, values);
  return response.rows[0];
}

async function sessionPrincipal(db: SqlClient, request: FastifyRequest): Promise<Principal | undefined> {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return undefined;
  const row = await one<{ principal_id: string; kind: "guest" | "account"; id: string }>(db,
    `SELECT a.principal_id, p.kind, a.id FROM auth_sessions a JOIN principals p ON p.id = a.principal_id
     WHERE a.token_hash = $1 AND a.revoked_at IS NULL AND a.expires_at > NOW() AND p.deleted_at IS NULL`,
    [hashToken(token)]);
  return row ? { id: row.principal_id, kind: row.kind, sessionId: row.id } : undefined;
}

async function requirePrincipal(db: SqlClient, request: FastifyRequest, reply: FastifyReply): Promise<Principal | undefined> {
  const principal = await sessionPrincipal(db, request);
  if (!principal) {
    fail(reply, request, 401, "SESSION_EXPIRED", "收听身份已过期，请重新打开页面。", true);
    return undefined;
  }
  return principal;
}

async function createGuest(db: SqlClient, reply: FastifyReply, config: AppConfig): Promise<Principal> {
  const principalId = id();
  const authSessionId = id();
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO principals (id, kind) VALUES ($1, 'guest')", [principalId]);
  await db.query("INSERT INTO preferences (principal_id, analytics_enabled) VALUES ($1, FALSE)", [principalId]);
  await db.query(
    "INSERT INTO auth_sessions (id, principal_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')",
    [authSessionId, principalId, hashToken(token)]
  );
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.environment === "production",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60
  });
  return { id: principalId, kind: "guest", sessionId: authSessionId };
}

async function preferencesFor(db: SqlClient, principalId: string) {
  const row = await one<{ era: string; category: string; tuning_sound_enabled: boolean; analytics_enabled: boolean }>(db,
    "SELECT era, category, tuning_sound_enabled, analytics_enabled FROM preferences WHERE principal_id = $1", [principalId]);
  return row ?? { era: "all", category: "all", tuning_sound_enabled: false, analytics_enabled: false };
}

async function programById(db: SqlClient, programId: string): Promise<ProgramRow | undefined> {
  return one<ProgramRow>(db,
    `SELECT p.id, p.title, p.era, p.category, a.duration_ms, p.source_kind, p.event_year, p.work_year, p.recording_year,
            p.source_note, p.is_excerpt, p.excerpt_label, a.object_key
       FROM programs p JOIN audio_assets a ON a.id = p.audio_asset_id
      WHERE p.id = $1 AND p.status = 'published' AND a.status = 'ready'`, [programId]);
}

async function candidates(db: SqlClient, era: string, category: string): Promise<ProgramRow[]> {
  const output = await db.query<ProgramRow>(
    `SELECT p.id, p.title, p.era, p.category, a.duration_ms, p.source_kind, p.event_year, p.work_year, p.recording_year,
            p.source_note, p.is_excerpt, p.excerpt_label, a.object_key
       FROM programs p JOIN audio_assets a ON a.id = p.audio_asset_id
      WHERE p.status = 'published' AND a.status = 'ready' AND ($1 = 'all' OR p.era = $1) AND ($2 = 'all' OR p.category = $2)`,
    [era, category]
  );
  return output.rows;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const target = randomInt(index + 1);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

async function likedBy(db: SqlClient, principalId: string | undefined, programId: string): Promise<boolean> {
  if (!principalId) return false;
  return Boolean(await one(db, "SELECT 1 FROM likes WHERE principal_id = $1 AND program_id = $2", [principalId, programId]));
}

async function recordServerEvent(db: SqlClient, principalId: string, sessionId: string, name: string, payload: unknown, analyticsEnabled: boolean, playbackId?: string, attemptId?: string) {
  if (!analyticsEnabled) return;
  await db.query(
    `INSERT INTO analytics_events (event_id, principal_id, session_id, playback_id, attempt_id, name, client_at, environment, payload)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'development', $7)`,
    [id(), principalId, sessionId, playbackId ?? null, attemptId ?? null, name, json(payload)]
  );
}

async function assertOwnSession(db: SqlClient, principalId: string, listeningSessionId: string): Promise<boolean> {
  return Boolean(await one(db, "SELECT 1 FROM listening_sessions WHERE id = $1 AND principal_id = $2", [listeningSessionId, principalId]));
}

async function requireAdmin(db: SqlClient, config: AppConfig, request: FastifyRequest, reply: FastifyReply): Promise<{ id: string; role: string } | undefined> {
  if (!config.adminBootstrapToken) {
    fail(reply, request, 503, "ADMIN_UNAVAILABLE", "运营身份尚未配置。", false);
    return undefined;
  }
  if (request.headers["x-admin-token"] !== config.adminBootstrapToken) {
    fail(reply, request, 403, "FORBIDDEN", "没有运营权限。", false);
    return undefined;
  }
  const admin = await one<{ id: string; role: string }>(db, "SELECT id, role FROM admin_users WHERE login_identity = 'local-bootstrap-admin' AND disabled_at IS NULL");
  if (!admin) {
    fail(reply, request, 503, "ADMIN_UNAVAILABLE", "运营初始数据尚未准备好，请先运行 db:seed。", true);
    return undefined;
  }
  return admin;
}

async function idempotent<T>(db: SqlClient, principalId: string, scope: string, requestIdValue: string, body: unknown, build: () => Promise<T>): Promise<T> {
  const existing = await one<{ request_hash: string; response_payload: string }>(db,
    "SELECT request_hash, response_payload FROM idempotency_keys WHERE principal_id = $1 AND scope = $2 AND request_id = $3",
    [principalId, scope, requestIdValue]);
  const requestHash = stableRequestHash(body);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
    return JSON.parse(existing.response_payload) as T;
  }
  const value = await build();
  await db.query(
    "INSERT INTO idempotency_keys (principal_id, scope, request_id, request_hash, response_payload) VALUES ($1, $2, $3, $4, $5)",
    [principalId, scope, requestIdValue, requestHash, json(value)]
  );
  return value;
}

export async function createApplication(options: Partial<AppConfig> & { seed?: boolean; autoMigrate?: boolean } = {}): Promise<Application> {
  const config = loadConfig(options);
  const db = await openDatabase(config.dataDir);
  if (options.autoMigrate !== false) await migrate(db);
  if (options.seed) await seedDevelopmentData(db, config);
  const storage = new LocalMediaStorage(config.dataDir);
  await storage.ensure();
  const app = Fastify({ logger: false, bodyLimit: 70 * 1024 });
  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") return fail(reply, request, 409, "IDEMPOTENCY_CONFLICT", "这次重复请求的内容不同，请刷新后重试。", false);
    if (error instanceof Error && error.message === "CONTENT_UNAVAILABLE") return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这段声音暂时不能听了。", false);
    if ((error as { code?: string }).code === "23505") return fail(reply, request, 409, "VERSION_CONFLICT", "数据已被其他操作更新，请刷新后重试。", false);
    request.log.error(error);
    return fail(reply, request, 503, "SERVICE_UNAVAILABLE", "服务暂时不可用，请稍后重试。", true);
  });

  app.get("/health", async (_request, reply) => reply.send({ status: "ok", storage: "local-development-adapter" }));

  app.post(`${API}/guest-session`, async (request, reply) => {
    const existing = await sessionPrincipal(db, request);
    const principal = existing ?? await createGuest(db, reply, config);
    return result(reply, request, { principal_kind: principal.kind, preferences: await preferencesFor(db, principal.id), feature_flags: featureFlags(config) });
  });

  app.post(`${API}/listening-sessions`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(z.object({ entry_source: z.string().min(1).max(64), environment: z.string().min(1).max(32).optional(), resume_session_id: z.string().uuid().optional() }), request.body, reply, request); if (!body) return;
    const prefs = await preferencesFor(db, principal.id);
    const sessionId = id();
    await db.query(
      "INSERT INTO listening_sessions (id, principal_id, entry_source, environment, analytics_enabled) VALUES ($1, $2, $3, $4, $5)",
      [sessionId, principal.id, body.entry_source, config.environment, prefs.analytics_enabled]
    );
    await recordServerEvent(db, principal.id, sessionId, "session_open", { entry_source: body.entry_source }, prefs.analytics_enabled);
    return result(reply, request, { session_id: sessionId, analytics_enabled: prefs.analytics_enabled });
  });

  app.get(`${API}/me`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    return result(reply, request, { principal_kind: principal.kind, preferences: await preferencesFor(db, principal.id), feature_flags: featureFlags(config) });
  });

  app.get(`${API}/catalog`, async (request, reply) => {
    const query = parsed(z.object({ era: filterEraSchema.optional() }), request.query, reply, request); if (!query) return;
    const rows = await db.query<{ era: Era; category: Category; count: number | string }>(
      `SELECT p.era, p.category, COUNT(*) AS count FROM programs p JOIN audio_assets a ON a.id = p.audio_asset_id
       WHERE p.status = 'published' AND a.status = 'ready' AND ($1 = 'all' OR p.era = $1) GROUP BY p.era, p.category`, [query.era ?? "all"]
    );
    const eras = [...new Set(rows.rows.map((row) => row.era))].map((era) => ({ value: era, label: eraLabels[era] }));
    const categories = [...new Set(rows.rows.map((row) => row.category))].map((category) => ({ value: category, label: categoryLabels[category] }));
    return result(reply, request, { eras, categories, combinations: rows.rows.map((row) => ({ ...row, count: asNumber(row.count) })) });
  });

  app.get(`${API}/programs/:id`, async (request, reply) => {
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const program = await programById(db, params.id);
    if (!program) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这段声音暂时不能听了。", false);
    const principal = await sessionPrincipal(db, request);
    return result(reply, request, { program: toProgram(program, await likedBy(db, principal?.id, program.id)) });
  });

  app.post(`${API}/queues`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(queueCreateSchema, request.body, reply, request); if (!body) return;
    if (!await assertOwnSession(db, principal.id, body.session_id)) return fail(reply, request, 403, "FORBIDDEN", "不能使用其他收听会话。", false);
    const queueResponse = await idempotent(db, principal.id, "queue-create", body.request_id, body, async () => {
      const available = await candidates(db, body.era, body.category);
      if (!available.length) return { queue_id: null, result: "NO_CONTENT" as const, program: null };
      const queueId = id();
      const arranged = shuffle(available);
      await db.query(
        `INSERT INTO queues (id, principal_id, session_id, era, category, round_no, position, last_program_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, 1, 0, $6, NOW() + INTERVAL '2 hours')`,
        [queueId, principal.id, body.session_id, body.era, body.category, arranged[0].id]
      );
      for (let index = 0; index < arranged.length; index++) {
        await db.query("INSERT INTO queue_items (queue_id, round_no, position, program_id) VALUES ($1, 1, $2, $3)", [queueId, index, arranged[index].id]);
      }
      return { queue_id: queueId, result: "PROGRAM" as const, program: toProgram(arranged[0], await likedBy(db, principal.id, arranged[0].id)) };
    });
    return result(reply, request, queueResponse);
  });

  app.post(`${API}/queues/:id/next`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(z.object({ request_id: z.string().min(8).max(128), reason: z.enum(["manual", "ended"]) }), request.body, reply, request); if (!body) return;
    const queue = await one<{ id: string; era: string; category: string; round_no: number; position: number; last_program_id: string | null; expires_at: string }>(db,
      "SELECT id, era, category, round_no, position, last_program_id, expires_at FROM queues WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    if (!queue) return fail(reply, request, 403, "FORBIDDEN", "不能读取其他人的选播队列。", false);
    if (new Date(queue.expires_at).getTime() < Date.now()) return fail(reply, request, 410, "QUEUE_EXPIRED", "选播已过期，请按原来的选择重新试一次。", true);
    const old = await one<{ response_payload: string }>(db, "SELECT response_payload FROM queue_requests WHERE queue_id = $1 AND request_id = $2", [queue.id, body.request_id]);
    if (old) return result(reply, request, JSON.parse(old.response_payload));
    let next = await one<{ id: string }>(db,
      `SELECT qi.program_id AS id FROM queue_items qi JOIN programs p ON p.id = qi.program_id JOIN audio_assets a ON a.id = p.audio_asset_id
       WHERE qi.queue_id = $1 AND qi.round_no = $2 AND qi.position > $3 AND p.status = 'published' AND a.status = 'ready'
       ORDER BY qi.position LIMIT 1`, [queue.id, queue.round_no, queue.position]);
    let nextRound = queue.round_no;
    let nextPosition = queue.position;
    if (!next) {
      const available = (await candidates(db, queue.era, queue.category)).filter((program) => program.id !== queue.last_program_id);
      if (!available.length) {
        const response = { queue_id: queue.id, result: "NO_ALTERNATIVE" as const, program: null };
        await db.query("INSERT INTO queue_requests (queue_id, request_id, response_payload) VALUES ($1, $2, $3)", [queue.id, body.request_id, json(response)]);
        return result(reply, request, response);
      }
      nextRound += 1;
      const arranged = shuffle(available);
      for (let index = 0; index < arranged.length; index++) await db.query("INSERT INTO queue_items (queue_id, round_no, position, program_id) VALUES ($1, $2, $3, $4)", [queue.id, nextRound, index, arranged[index].id]);
      next = { id: arranged[0].id };
      nextPosition = 0;
    } else {
      const position = await one<{ position: number }>(db, "SELECT position FROM queue_items WHERE queue_id = $1 AND round_no = $2 AND program_id = $3", [queue.id, nextRound, next.id]);
      nextPosition = position?.position ?? nextPosition;
    }
    const nextProgram = await programById(db, next.id);
    if (!nextProgram) return fail(reply, request, 503, "SERVICE_UNAVAILABLE", "节目状态发生变化，请重试。", true);
    await db.query("UPDATE queues SET round_no = $1, position = $2, last_program_id = $3 WHERE id = $4", [nextRound, nextPosition, nextProgram.id, queue.id]);
    const response = { queue_id: queue.id, result: "PROGRAM" as const, program: toProgram(nextProgram, await likedBy(db, principal.id, nextProgram.id)) };
    await db.query("INSERT INTO queue_requests (queue_id, request_id, response_payload) VALUES ($1, $2, $3)", [queue.id, body.request_id, json(response)]);
    return result(reply, request, response);
  });

  app.post(`${API}/playbacks`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(z.object({ program_id: z.string().uuid(), session_id: z.string().uuid(), queue_id: z.string().uuid().optional(), request_id: z.string().min(8).max(128) }), request.body, reply, request); if (!body) return;
    if (!await assertOwnSession(db, principal.id, body.session_id)) return fail(reply, request, 403, "FORBIDDEN", "不能使用其他收听会话。", false);
    if (body.queue_id && !await one(db, "SELECT 1 FROM queues WHERE id = $1 AND principal_id = $2", [body.queue_id, principal.id])) return fail(reply, request, 403, "FORBIDDEN", "不能使用其他人的选播队列。", false);
    const response = await idempotent(db, principal.id, "playback-create", body.request_id, body, async () => {
      const program = await programById(db, body.program_id);
      if (!program) throw new Error("CONTENT_UNAVAILABLE");
      const playbackId = id();
      await db.query(
        `INSERT INTO playbacks (id, principal_id, session_id, queue_id, program_id, era_snapshot, category_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [playbackId, principal.id, body.session_id, body.queue_id ?? null, program.id, program.era, program.category]
      );
      return { playback_id: playbackId, audio_url: `/media/${program.object_key}`, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), duration_ms: asNumber(program.duration_ms), program: toProgram(program, await likedBy(db, principal.id, program.id)) };
    });
    return result(reply, request, response, 201);
  });

  app.post(`${API}/playbacks/:id/attempts`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(z.object({ attempt_id: z.string().uuid(), trigger: z.enum(["user", "autonext", "retry"]) }), request.body, reply, request); if (!body) return;
    const playback = await one<{ session_id: string }>(db, "SELECT session_id FROM playbacks WHERE id = $1 AND principal_id = $2 AND ended_at IS NULL", [params.id, principal.id]);
    if (!playback) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这次收听已不可用。", false);
    await db.query("INSERT INTO play_attempts (id, playback_id, trigger) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [body.attempt_id, params.id, body.trigger]);
    const prefs = await preferencesFor(db, principal.id);
    await recordServerEvent(db, principal.id, playback.session_id, "play_attempt", { trigger: body.trigger }, prefs.analytics_enabled, params.id, body.attempt_id);
    return result(reply, request, { attempt_id: body.attempt_id, status: "pending" }, 201);
  });

  app.post(`${API}/playbacks/:id/progress`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(playbackProgressSchema, request.body, reply, request); if (!body) return;
    const playback = await one<{ max_seq: number; listen_ms: number | string; observed_wall_ms: number | string; started_at: string; session_id: string }>(db,
      "SELECT max_seq, listen_ms, observed_wall_ms, started_at, session_id FROM playbacks WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    if (!playback) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这次收听已不可用。", false);
    if (body.seq <= playback.max_seq) return result(reply, request, { accepted_seq: playback.max_seq, duplicate: true, listen_ms: asNumber(playback.listen_ms) });
    if (body.cumulative_listen_ms < asNumber(playback.listen_ms) || body.observed_wall_ms < asNumber(playback.observed_wall_ms) || body.cumulative_listen_ms > body.observed_wall_ms) {
      return fail(reply, request, 400, "INVALID_ARGUMENT", "收听进度不符合递增规则。", false);
    }
    const elapsed = Math.max(0, Date.now() - new Date(playback.started_at).getTime() + 5_000);
    const acceptedListen = Math.min(body.cumulative_listen_ms, body.observed_wall_ms, elapsed);
    const delta = Math.max(0, acceptedListen - asNumber(playback.listen_ms));
    await db.query(
      `UPDATE playbacks SET max_seq = $1, listen_ms = $2, observed_wall_ms = $3, last_position_ms = $4 WHERE id = $5`,
      [body.seq, acceptedListen, body.observed_wall_ms, body.position_ms, params.id]
    );
    const sampled = new Date(body.sampled_at);
    const reliable = sampled.getTime() >= new Date(playback.started_at).getTime() && sampled.getTime() <= Date.now() + 5 * 60_000 && sampled.getTime() >= Date.now() - 24 * 60 * 60_000;
    if (reliable && delta > 0) {
      const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(sampled);
      await db.query(
        `INSERT INTO playback_day_totals (playback_id, business_date, listen_ms) VALUES ($1, $2, $3)
         ON CONFLICT (playback_id, business_date) DO UPDATE SET listen_ms = playback_day_totals.listen_ms + EXCLUDED.listen_ms`,
        [params.id, businessDate, delta]
      );
    }
    const prefs = await preferencesFor(db, principal.id);
    await recordServerEvent(db, principal.id, playback.session_id, "play_progress", { seq: body.seq, accepted_ms: acceptedListen }, prefs.analytics_enabled, params.id);
    return result(reply, request, { accepted_seq: body.seq, duplicate: false, listen_ms: acceptedListen });
  });

  app.post(`${API}/playbacks/:id/end`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(z.object({ request_id: z.string().min(8).max(128), reason: z.enum(["ended", "manual", "error", "offline"]), progress: playbackProgressSchema.optional() }), request.body, reply, request); if (!body) return;
    const playback = await one<{ id: string; session_id: string; ended_at: string | null }>(db, "SELECT id, session_id, ended_at FROM playbacks WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    if (!playback) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这次收听已不可用。", false);
    const response = await idempotent(db, principal.id, "playback-end", body.request_id, body, async () => {
      if (!playback.ended_at) await db.query("UPDATE playbacks SET ended_at = NOW(), end_reason = $1 WHERE id = $2", [body.reason, params.id]);
      const prefs = await preferencesFor(db, principal.id);
      await recordServerEvent(db, principal.id, playback.session_id, "play_end", { reason: body.reason }, prefs.analytics_enabled, params.id);
      return { playback_id: params.id, ended: true };
    });
    return result(reply, request, response);
  });

  app.post(`${API}/playbacks/:id/media-refresh`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const row = await one<{ object_key: string; duration_ms: number | string }>(db,
      `SELECT a.object_key, a.duration_ms FROM playbacks b JOIN programs p ON p.id = b.program_id JOIN audio_assets a ON a.id = p.audio_asset_id
       WHERE b.id = $1 AND b.principal_id = $2 AND b.ended_at IS NULL AND p.status = 'published' AND a.status = 'ready'`, [params.id, principal.id]);
    if (!row) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这段声音暂时不能听了。", false);
    return result(reply, request, { audio_url: `/media/${row.object_key}`, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), duration_ms: asNumber(row.duration_ms) });
  });

  app.put(`${API}/me/preferences`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(preferencesSchema, request.body, reply, request); if (!body) return;
    await db.query(
      `UPDATE preferences SET era = $1, category = $2, tuning_sound_enabled = $3, analytics_enabled = $4, updated_at = NOW() WHERE principal_id = $5`,
      [body.era, body.category, body.tuning_sound_enabled, body.analytics_enabled, principal.id]
    );
    return result(reply, request, body);
  });

  app.get(`${API}/me/likes`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const query = parsed(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }), request.query, reply, request); if (!query) return;
    const offset = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) return fail(reply, request, 400, "INVALID_ARGUMENT", "分页游标不正确。", false);
    const rows = await db.query<ProgramRow & { liked_at: string; available: boolean }>(
      `SELECT p.id, p.title, p.era, p.category, COALESCE(a.duration_ms, 0) AS duration_ms, p.source_kind, p.event_year, p.work_year, p.recording_year,
              p.source_note, p.is_excerpt, p.excerpt_label, COALESCE(a.object_key, '') AS object_key, l.created_at AS liked_at,
              (p.status = 'published' AND a.status = 'ready') AS available
         FROM likes l JOIN programs p ON p.id = l.program_id LEFT JOIN audio_assets a ON a.id = p.audio_asset_id
        WHERE l.principal_id = $1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`, [principal.id, query.limit + 1, offset]
    );
    const page = rows.rows.slice(0, query.limit).map((row) => ({ ...toProgram(row, true), available: row.available, liked_at: row.liked_at }));
    return result(reply, request, { items: page, next_cursor: rows.rows.length > query.limit ? String(offset + query.limit) : null });
  });

  async function setLike(request: FastifyRequest, reply: FastifyReply, liked: boolean) {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ programId: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const exists = liked ? await programById(db, params.programId) : await one(db, "SELECT 1 FROM programs WHERE id = $1", [params.programId]);
    if (!exists) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "这段声音暂时不能收藏。", false);
    const before = Boolean(await one(db, "SELECT 1 FROM likes WHERE principal_id = $1 AND program_id = $2", [principal.id, params.programId]));
    if (liked) await db.query("INSERT INTO likes (principal_id, program_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [principal.id, params.programId]);
    else await db.query("DELETE FROM likes WHERE principal_id = $1 AND program_id = $2", [principal.id, params.programId]);
    const prefs = await preferencesFor(db, principal.id);
    const session = await one<{ id: string }>(db, "SELECT id FROM listening_sessions WHERE principal_id = $1 ORDER BY started_at DESC LIMIT 1", [principal.id]);
    if (before !== liked && session) await recordServerEvent(db, principal.id, session.id, "like_set", { program_id: params.programId, liked }, prefs.analytics_enabled);
    return result(reply, request, { program_id: params.programId, liked });
  }
  app.put(`${API}/me/likes/:programId`, (request, reply) => setLike(request, reply, true));
  app.delete(`${API}/me/likes/:programId`, (request, reply) => setLike(request, reply, false));

  app.post(`${API}/feedback-prompts`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(z.object({ playback_id: z.string().uuid(), trigger: z.enum(["ended", "long_listen"]) }), request.body, reply, request); if (!body) return;
    const playback = await one<{ session_id: string; program_id: string; listen_ms: number | string }>(db, "SELECT session_id, program_id, listen_ms FROM playbacks WHERE id = $1 AND principal_id = $2", [body.playback_id, principal.id]);
    if (!playback) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "收听记录不存在。", false);
    if ((body.trigger === "ended" && asNumber(playback.listen_ms) < 30_000) || (body.trigger === "long_listen" && asNumber(playback.listen_ms) < 300_000)) return result(reply, request, { prompt: null });
    const recent = await one(db, "SELECT 1 FROM feedback_prompts WHERE principal_id = $1 AND issued_at > NOW() - INTERVAL '24 hours'", [principal.id]);
    if (recent) return result(reply, request, { prompt: null });
    const promptId = id();
    await db.query("INSERT INTO feedback_prompts (id, principal_id, session_id, program_id, playback_id, trigger) VALUES ($1, $2, $3, $4, $5, $6)", [promptId, principal.id, playback.session_id, playback.program_id, body.playback_id, body.trigger]);
    return result(reply, request, { prompt: { id: promptId, program_id: playback.program_id } }, 201);
  });

  app.post(`${API}/feedback-prompts/:id/shown`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const prompt = await one<{ session_id: string }>(db, "SELECT session_id FROM feedback_prompts WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    if (!prompt) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "反馈提示已不可用。", false);
    await db.query("UPDATE feedback_prompts SET shown_at = COALESCE(shown_at, NOW()) WHERE id = $1", [params.id]);
    const prefs = await preferencesFor(db, principal.id);
    await recordServerEvent(db, principal.id, prompt.session_id, "feedback_impression", { prompt_id: params.id }, prefs.analytics_enabled);
    return result(reply, request, { prompt_id: params.id, shown: true });
  });

  app.post(`${API}/feedback-prompts/:id/dismiss`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const changed = await db.query("UPDATE feedback_prompts SET dismissed_at = COALESCE(dismissed_at, NOW()) WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    return result(reply, request, { prompt_id: params.id, dismissed: true, changed: asNumber((changed as { affectedRows?: number }).affectedRows ?? 0) >= 0 });
  });

  app.put(`${API}/feedback-prompts/:id/answer`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(z.object({ answer: z.enum(["like", "neutral"]) }), request.body, reply, request); if (!body) return;
    const prompt = await one<{ program_id: string; playback_id: string; session_id: string }>(db, "SELECT program_id, playback_id, session_id FROM feedback_prompts WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    if (!prompt) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "反馈提示已不可用。", false);
    await db.query(
      `INSERT INTO feedback (id, principal_id, program_id, playback_id, prompt_id, answer) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (principal_id, prompt_id) DO UPDATE SET answer = EXCLUDED.answer, created_at = NOW()`,
      [id(), principal.id, prompt.program_id, prompt.playback_id, params.id, body.answer]
    );
    const prefs = await preferencesFor(db, principal.id);
    await recordServerEvent(db, principal.id, prompt.session_id, "feedback_submit", { prompt_id: params.id, answer: body.answer }, prefs.analytics_enabled, prompt.playback_id);
    return result(reply, request, { prompt_id: params.id, answer: body.answer });
  });

  app.post(`${API}/events/batch`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(z.object({ events: z.array(eventInputSchema).min(1).max(50) }), request.body, reply, request); if (!body) return;
    if (Buffer.byteLength(json(body)) > 64 * 1024) return fail(reply, request, 400, "INVALID_ARGUMENT", "事件批量数据过大。", false);
    const prefs = await preferencesFor(db, principal.id);
    const accepted: string[] = []; const duplicate: string[] = []; const rejected: Array<{ event_id: string; code: string }> = [];
    for (const event of body.events) {
      if (!await assertOwnSession(db, principal.id, event.session_id)) { rejected.push({ event_id: event.event_id, code: "FORBIDDEN" }); continue; }
      if (event.playback_id && !await one(db, "SELECT 1 FROM playbacks WHERE id = $1 AND principal_id = $2 AND session_id = $3", [event.playback_id, principal.id, event.session_id])) { rejected.push({ event_id: event.event_id, code: "FORBIDDEN" }); continue; }
      if (event.attempt_id && !await one(db, "SELECT 1 FROM play_attempts a JOIN playbacks p ON p.id = a.playback_id WHERE a.id = $1 AND p.principal_id = $2", [event.attempt_id, principal.id])) { rejected.push({ event_id: event.event_id, code: "DEPENDENCY_NOT_READY" }); continue; }
      if (!prefs.analytics_enabled) { rejected.push({ event_id: event.event_id, code: "ANALYTICS_DISABLED" }); continue; }
      const exists = await one(db, "SELECT 1 FROM analytics_events WHERE event_id = $1", [event.event_id]);
      if (exists) { duplicate.push(event.event_id); continue; }
      await db.query(
        `INSERT INTO analytics_events (event_id, principal_id, session_id, playback_id, attempt_id, name, client_at, environment, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [event.event_id, principal.id, event.session_id, event.playback_id ?? null, event.attempt_id ?? null, event.name, event.client_at, config.environment, json(event.payload)]
      );
      if (event.name === "play_started" && event.attempt_id) await db.query("UPDATE play_attempts SET status = 'started', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'pending'", [event.attempt_id]);
      accepted.push(event.event_id);
    }
    return result(reply, request, { accepted, duplicate, rejected });
  });

  app.post(`${API}/me/deletion-requests`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const body = parsed(z.object({ request_id: z.string().min(8).max(128), confirmed: z.literal(true) }), request.body, reply, request); if (!body) return;
    const response = await idempotent(db, principal.id, "deletion", body.request_id, body, async () => {
      const jobId = id();
      await db.query("INSERT INTO deletion_jobs (id, principal_id, status) VALUES ($1, $2, 'running')", [jobId, principal.id]);
      await db.query("DELETE FROM likes WHERE principal_id = $1", [principal.id]);
      await db.query("DELETE FROM preferences WHERE principal_id = $1", [principal.id]);
      await db.query("DELETE FROM feedback WHERE principal_id = $1", [principal.id]);
      await db.query("DELETE FROM feedback_prompts WHERE principal_id = $1", [principal.id]);
      await db.query("DELETE FROM analytics_events WHERE principal_id = $1", [principal.id]);
      await db.query("DELETE FROM auth_sessions WHERE principal_id = $1", [principal.id]);
      await db.query("UPDATE principals SET deleted_at = NOW() WHERE id = $1", [principal.id]);
      await db.query("UPDATE deletion_jobs SET status = 'done', finished_at = NOW() WHERE id = $1", [jobId]);
      return { job_id: jobId, status: "done" };
    });
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return result(reply, request, response, 202);
  });

  app.get(`${API}/me/deletion-requests/:id`, async (request, reply) => {
    const principal = await requirePrincipal(db, request, reply); if (!principal) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const job = await one<{ status: string; requested_at: string; finished_at: string | null }>(db, "SELECT status, requested_at, finished_at FROM deletion_jobs WHERE id = $1 AND principal_id = $2", [params.id, principal.id]);
    if (!job) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "清除任务不存在。", false);
    return result(reply, request, job);
  });

  app.post(`${API}/auth/logout`, async (request, reply) => {
    const principal = await sessionPrincipal(db, request);
    if (principal) await db.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1", [principal.sessionId]);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return result(reply, request, { logged_out: true });
  });

  app.get("/media/:key", async (request, reply) => {
    const params = parsed(z.object({ key: z.string().regex(/^[a-zA-Z0-9._-]+$/) }), request.params, reply, request); if (!params) return;
    const visible = await one(db,
      `SELECT 1 FROM audio_assets a JOIN programs p ON p.audio_asset_id = a.id
       WHERE a.object_key = $1 AND a.status = 'ready' AND p.status = 'published'`, [params.key]);
    if (!visible) return reply.code(404).send("Media unavailable");
    try {
      return reply.type("audio/wav").header("Cache-Control", "no-store").send(await storage.read(params.key));
    } catch { return reply.code(404).send("Media unavailable"); }
  });

  const adminProgramInput = z.object({
    title: z.string().min(2).max(160), era: filterEraSchema.refine((value: string) => value !== "all"), category: filterCategorySchema.refine((value: string) => value !== "all"),
    audio_asset_id: z.string().uuid(), source_kind: z.enum(["archive_original", "modern_performance", "ai_reconstruction"]),
    era_basis: z.string().min(3).max(500), source_note: z.string().min(3).max(1000), is_excerpt: z.boolean().default(false), excerpt_label: z.string().max(120).optional(),
    source_url: z.string().url().refine((value) => value.startsWith("https://") || value.startsWith("http://")), source_title: z.string().min(2).max(200), source_type: z.string().min(2).max(64),
    usage_basis: z.string().min(3).max(500), evidence_ref: z.string().min(3).max(500)
  });

  app.post(`${API}/admin/uploads`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const file = await request.file();
    if (!file) return fail(reply, request, 400, "INVALID_ARGUMENT", "请选择 WAV 音频文件。", false);
    if (file.mimetype !== "audio/wav" && file.mimetype !== "audio/x-wav") return fail(reply, request, 400, "INVALID_ARGUMENT", "本地 MVP 仅接受 WAV 音频。", false);
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return fail(reply, request, 400, "INVALID_ARGUMENT", "音频必须大于 0 且不超过 10MB。", false);
    const objectKey = await storage.save(file.filename, bytes);
    const assetId = id();
    await db.query("INSERT INTO audio_assets (id, object_key, status) VALUES ($1, $2, 'processing')", [assetId, objectKey]);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id, after_summary) VALUES ($1, $2, 'upload_received', $3, $4)", [id(), admin.id, assetId, json({ file_name: file.filename, bytes: bytes.length })]);
    return result(reply, request, { asset_id: assetId, status: "processing" }, 201);
  });

  app.post(`${API}/admin/uploads/:assetId/complete`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const params = parsed(z.object({ assetId: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const asset = await one<{ object_key: string }>(db, "SELECT object_key FROM audio_assets WHERE id = $1", [params.assetId]);
    if (!asset) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "音频资源不存在。", false);
    try {
      const inspected = await storage.inspectWave(asset.object_key);
      await db.query("UPDATE audio_assets SET mime_type = $1, bytes = $2, duration_ms = $3, checksum = $4, status = 'ready', updated_at = NOW() WHERE id = $5", [inspected.mimeType, inspected.bytes, inspected.durationMs, inspected.checksum, params.assetId]);
      await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id, after_summary) VALUES ($1, $2, 'upload_validated', $3, $4)", [id(), admin.id, params.assetId, json(inspected)]);
      return result(reply, request, { asset_id: params.assetId, status: "ready", duration_ms: inspected.durationMs });
    } catch (error) {
      await db.query("UPDATE audio_assets SET status = 'failed', updated_at = NOW() WHERE id = $1", [params.assetId]);
      return fail(reply, request, 400, "INVALID_ARGUMENT", error instanceof Error ? error.message : "音频校验失败。", false);
    }
  });

  app.post(`${API}/admin/programs`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const body = parsed(adminProgramInput, request.body, reply, request); if (!body) return;
    const asset = await one<{ id: string }>(db, "SELECT id FROM audio_assets WHERE id = $1", [body.audio_asset_id]);
    if (!asset) return fail(reply, request, 400, "INVALID_ARGUMENT", "请选择已上传的音频资源。", false);
    const programId = id();
    await db.query(
      `INSERT INTO programs (id, title, era, category, audio_asset_id, source_kind, era_basis, source_note, is_excerpt, excerpt_label, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')`,
      [programId, body.title, body.era, body.category, body.audio_asset_id, body.source_kind, body.era_basis, body.source_note, body.is_excerpt, body.excerpt_label ?? null]
    );
    await db.query("INSERT INTO program_sources (id, program_id, source_url, source_title, source_type, checked_by) VALUES ($1, $2, $3, $4, $5, $6)", [id(), programId, body.source_url, body.source_title, body.source_type, admin.id]);
    await db.query("INSERT INTO program_clearances (id, program_id, usage_basis, evidence_ref, checked_by) VALUES ($1, $2, $3, $4, $5)", [id(), programId, body.usage_basis, body.evidence_ref, admin.id]);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id, after_summary) VALUES ($1, $2, 'program_created', $3, $4)", [id(), admin.id, programId, json({ title: body.title })]);
    return result(reply, request, { id: programId, status: "draft", version: 1 }, 201);
  });

  app.patch(`${API}/admin/programs/:id`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(z.object({ version: z.number().int().positive(), title: z.string().min(2).max(160).optional(), era: filterEraSchema.optional(), category: filterCategorySchema.optional(), audio_asset_id: z.string().uuid().optional(), source_note: z.string().min(3).max(1000).optional(), era_basis: z.string().min(3).max(500).optional(), is_excerpt: z.boolean().optional(), excerpt_label: z.string().max(120).nullable().optional() }), request.body, reply, request); if (!body) return;
    if (body.era === "all" || body.category === "all") return fail(reply, request, 400, "INVALID_ARGUMENT", "节目必须指定实际年代和类型。", false);
    const program = await one<{ version: number; status: string }>(db, "SELECT version, status FROM programs WHERE id = $1", [params.id]);
    if (!program) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "节目不存在。", false);
    if (program.version !== body.version) return fail(reply, request, 409, "VERSION_CONFLICT", "节目已被更新，请刷新后再编辑。", false);
    if (body.audio_asset_id && !await one(db, "SELECT 1 FROM audio_assets WHERE id = $1 AND status = 'ready'", [body.audio_asset_id])) return fail(reply, request, 400, "INVALID_ARGUMENT", "替换音频必须先通过校验。", false);
    const fields: string[] = []; const values: unknown[] = [];
    for (const key of ["title", "era", "category", "audio_asset_id", "source_note", "era_basis", "is_excerpt", "excerpt_label"] as const) {
      if (body[key] !== undefined) { fields.push(`${key} = $${values.length + 1}`); values.push(body[key]); }
    }
    if (!fields.length) return result(reply, request, { id: params.id, version: program.version, unchanged: true });
    fields.push(`version = $${values.length + 1}`, `status = $${values.length + 2}`, "updated_at = NOW()"); values.push(program.version + 1, "draft", params.id, body.version);
    const updated = await db.query(`UPDATE programs SET ${fields.join(", ")} WHERE id = $${values.length - 1} AND version = $${values.length}`, values);
    if (asNumber((updated as { affectedRows?: number }).affectedRows ?? 1) === 0) return fail(reply, request, 409, "VERSION_CONFLICT", "节目已被更新，请刷新后再编辑。", false);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id, after_summary) VALUES ($1, $2, 'program_edited', $3, $4)", [id(), admin.id, params.id, json({ fields: Object.keys(body).filter((key) => key !== "version") })]);
    return result(reply, request, { id: params.id, version: program.version + 1, status: "draft" });
  });

  app.post(`${API}/admin/programs/:id/submit`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const program = await one<{ id: string }>(db, "SELECT p.id FROM programs p JOIN audio_assets a ON a.id = p.audio_asset_id WHERE p.id = $1 AND a.status = 'ready'", [params.id]);
    const source = await one(db, "SELECT 1 FROM program_sources WHERE program_id = $1", [params.id]);
    const clearance = await one(db, "SELECT 1 FROM program_clearances WHERE program_id = $1", [params.id]);
    if (!program || !source || !clearance) return fail(reply, request, 400, "INVALID_ARGUMENT", "送审前需要完整来源、使用依据和已校验音频。", false);
    await db.query("UPDATE programs SET status = 'in_review', updated_at = NOW() WHERE id = $1", [params.id]);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id) VALUES ($1, $2, 'program_submitted', $3)", [id(), admin.id, params.id]);
    return result(reply, request, { id: params.id, status: "in_review" });
  });

  app.post(`${API}/admin/programs/:id/review`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const body = parsed(z.object({ decision: z.enum(["approved", "rejected"]), notes: z.string().max(1000).optional() }), request.body, reply, request); if (!body) return;
    if (admin.role !== "reviewer" && admin.role !== "admin") return fail(reply, request, 403, "FORBIDDEN", "需要审核权限。", false);
    const program = await one<{ version: number; status: string }>(db, "SELECT version, status FROM programs WHERE id = $1", [params.id]);
    if (!program || program.status !== "in_review") return fail(reply, request, 409, "VERSION_CONFLICT", "节目当前不能审核。", false);
    await db.query("INSERT INTO program_reviews (id, program_id, script_version, decision, notes, reviewer_id) VALUES ($1, $2, $3, $4, $5, $6)", [id(), params.id, program.version, body.decision, body.notes ?? null, admin.id]);
    if (body.decision === "rejected") await db.query("UPDATE programs SET status = 'draft', updated_at = NOW() WHERE id = $1", [params.id]);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id, after_summary) VALUES ($1, $2, 'program_reviewed', $3, $4)", [id(), admin.id, params.id, json(body)]);
    return result(reply, request, { id: params.id, decision: body.decision, status: body.decision === "approved" ? "in_review" : "draft" });
  });

  app.post(`${API}/admin/programs/:id/publish`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const ready = await one<{ version: number }>(db,
      `SELECT p.version FROM programs p JOIN audio_assets a ON a.id = p.audio_asset_id
       WHERE p.id = $1 AND p.status = 'in_review' AND a.status = 'ready'
         AND EXISTS (SELECT 1 FROM program_sources s WHERE s.program_id = p.id)
         AND EXISTS (SELECT 1 FROM program_clearances c WHERE c.program_id = p.id)`, [params.id]);
    const approved = ready && await one(db, "SELECT 1 FROM program_reviews WHERE program_id = $1 AND script_version = $2 AND decision = 'approved'", [params.id, ready.version]);
    if (!ready || !approved) return fail(reply, request, 400, "INVALID_ARGUMENT", "发布需要当前版本已审核通过、资料完整且音频可用。", false);
    await db.query("UPDATE programs SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1", [params.id]);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id) VALUES ($1, $2, 'program_published', $3)", [id(), admin.id, params.id]);
    return result(reply, request, { id: params.id, status: "published" });
  });

  app.post(`${API}/admin/programs/:id/offline`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const params = parsed(z.object({ id: z.string().uuid() }), request.params, reply, request); if (!params) return;
    const exists = await one(db, "SELECT 1 FROM programs WHERE id = $1", [params.id]);
    if (!exists) return fail(reply, request, 404, "CONTENT_UNAVAILABLE", "节目不存在。", false);
    await db.query("UPDATE programs SET status = 'offline', updated_at = NOW() WHERE id = $1", [params.id]);
    await db.query("INSERT INTO audit_logs (id, admin_id, action, entity_id) VALUES ($1, $2, 'program_offline', $3)", [id(), admin.id, params.id]);
    return result(reply, request, { id: params.id, status: "offline" });
  });

  app.get(`${API}/admin/programs`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const rows = await db.query<{ id: string; title: string; era: string; category: string; status: string; version: number; duration_ms: number | string | null; source_kind: string }>(
      "SELECT p.id, p.title, p.era, p.category, p.status, p.version, a.duration_ms, p.source_kind FROM programs p LEFT JOIN audio_assets a ON a.id = p.audio_asset_id ORDER BY p.updated_at DESC"
    );
    return result(reply, request, { items: rows.rows.map((row) => ({ ...row, duration_ms: row.duration_ms == null ? null : asNumber(row.duration_ms) })) });
  });

  app.get(`${API}/admin/reports/daily`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const query = parsed(z.object({ date_from: z.string().date(), date_to: z.string().date(), dimension: z.enum(["all", "era", "category"]).default("all") }), request.query, reply, request); if (!query) return;
    const dimension = query.dimension === "era" ? "p.era" : query.dimension === "category" ? "p.category" : "'all'";
    const rows = await db.query<{ business_date: string; dimension: string; listen_ms: number | string; listeners: number | string; current_likes: number | string }>(
      `SELECT d.business_date::text, ${dimension} AS dimension, SUM(d.listen_ms) AS listen_ms, COUNT(DISTINCT p.principal_id) AS listeners,
              COUNT(DISTINCT l.principal_id) AS current_likes
         FROM playback_day_totals d JOIN playbacks p ON p.id = d.playback_id JOIN listening_sessions s ON s.id = p.session_id
         LEFT JOIN likes l ON l.program_id = p.program_id
        WHERE d.business_date BETWEEN $1::date AND $2::date AND s.analytics_enabled = TRUE
        GROUP BY d.business_date, ${dimension} ORDER BY d.business_date, dimension`, [query.date_from, query.date_to]
    );
    return result(reply, request, { report_version: "v1", analytics_coverage: "仅纳入主动开启非必要分析的会话", rows: rows.rows.map((row) => ({ ...row, listen_ms: asNumber(row.listen_ms), listeners: asNumber(row.listeners), current_likes: asNumber(row.current_likes) })) });
  });

  app.get(`${API}/admin/reports/export`, async (request, reply) => {
    const admin = await requireAdmin(db, config, request, reply); if (!admin) return;
    const query = parsed(z.object({ date_from: z.string().date(), date_to: z.string().date() }), request.query, reply, request); if (!query) return;
    const rows = await db.query<{ business_date: string; era: string; category: string; listen_ms: number | string }>(
      `SELECT d.business_date::text, p.era, p.category, SUM(d.listen_ms) AS listen_ms FROM playback_day_totals d JOIN playbacks p ON p.id = d.playback_id JOIN listening_sessions s ON s.id = p.session_id
       WHERE d.business_date BETWEEN $1::date AND $2::date AND s.analytics_enabled = TRUE GROUP BY d.business_date, p.era, p.category ORDER BY d.business_date`, [query.date_from, query.date_to]
    );
    const safe = (value: string | number) => /^[=+\-@]/.test(String(value)) ? `'${value}` : String(value).replace(/"/g, '""');
    const csv = ["business_date,era,category,listen_ms", ...rows.rows.map((row) => [row.business_date, row.era, row.category, asNumber(row.listen_ms)].map(safe).join(","))].join("\n");
    return reply.type("text/csv; charset=utf-8").header("Content-Disposition", "attachment; filename=voice-time-machine-report.csv").send(csv);
  });

  return { app, db, close: async () => { await app.close(); await closeDatabase(db); } };
}
