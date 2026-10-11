import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";

type TestApplication = Awaited<ReturnType<typeof createApplication>>;
let directory = "";
let application: TestApplication;

function payload(response: { payload: string }) { return JSON.parse(response.payload) as { data: any; error?: { code: string } }; }
function cookie(response: { headers: Record<string, string | string[] | number | undefined> }) { return String(response.headers["set-cookie"]).split(";")[0]; }

async function identity() {
  const guest = await application.app.inject({ method: "POST", url: "/api/v1/guest-session" });
  const auth = cookie(guest);
  const session = await application.app.inject({ method: "POST", url: "/api/v1/listening-sessions", headers: { cookie: auth }, payload: { entry_source: "test" } });
  return { auth, sessionId: payload(session).data.session_id as string };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sound-time-machine-"));
  application = await createApplication({ dataDir: directory, environment: "test", autoMigrate: true, seed: true, adminBootstrapToken: "test-admin-token" });
});

afterEach(async () => { await application.close(); await rm(directory, { recursive: true, force: true }); });

describe("声音时间机器 API", () => {
  it("只返回有内容的年代和类型，并区分空与单条候选", async () => {
    const user = await identity();
    const catalog = await application.app.inject({ method: "GET", url: "/api/v1/catalog", headers: { cookie: user.auth } });
    expect(payload(catalog).data.eras.map((item: { value: string }) => item.value)).toEqual(["1970s", "1980s", "1990s", "2000s"]);
    expect(payload(catalog).data.categories.map((item: { value: string }) => item.value)).not.toContain("music");
    const none = await application.app.inject({ method: "POST", url: "/api/v1/queues", headers: { cookie: user.auth }, payload: { session_id: user.sessionId, request_id: "empty-queue-001", mode: "era", era: "1970s", category: "opera" } });
    expect(payload(none).data.result).toBe("NO_CONTENT");
    const single = await application.app.inject({ method: "POST", url: "/api/v1/queues", headers: { cookie: user.auth }, payload: { session_id: user.sessionId, request_id: "single-queue-001", mode: "era", era: "1990s", category: "novel" } });
    const queue = payload(single).data;
    const next = await application.app.inject({ method: "POST", url: `/api/v1/queues/${queue.queue_id}/next`, headers: { cookie: user.auth }, payload: { request_id: "single-next-001", reason: "manual" } });
    expect(payload(next).data.result).toBe("NO_ALTERNATIVE");
  });

  it("队列幂等、不会立即重复，且不能被其他游客读取", async () => {
    const first = await identity(); const second = await identity();
    const queueResponse = await application.app.inject({ method: "POST", url: "/api/v1/queues", headers: { cookie: first.auth }, payload: { session_id: first.sessionId, request_id: "multi-queue-001", mode: "era", era: "1980s", category: "storytelling" } });
    const queue = payload(queueResponse).data;
    const one = await application.app.inject({ method: "POST", url: `/api/v1/queues/${queue.queue_id}/next`, headers: { cookie: first.auth }, payload: { request_id: "multi-next-001", reason: "manual" } });
    const repeated = await application.app.inject({ method: "POST", url: `/api/v1/queues/${queue.queue_id}/next`, headers: { cookie: first.auth }, payload: { request_id: "multi-next-001", reason: "manual" } });
    expect(payload(one).data.program.id).not.toBe(queue.program.id);
    expect(payload(repeated).data).toEqual(payload(one).data);
    const foreign = await application.app.inject({ method: "POST", url: `/api/v1/queues/${queue.queue_id}/next`, headers: { cookie: second.auth }, payload: { request_id: "foreign-next-01", reason: "manual" } });
    expect(foreign.statusCode).toBe(403);
  });

  it("收藏属于当前游客，并且进度重复或乱序不会多计", async () => {
    const first = await identity(); const second = await identity();
    const queueResponse = await application.app.inject({ method: "POST", url: "/api/v1/queues", headers: { cookie: first.auth }, payload: { session_id: first.sessionId, request_id: "listen-queue-01", mode: "today", era: "all", category: "all" } });
    const queue = payload(queueResponse).data;
    const playbackResponse = await application.app.inject({ method: "POST", url: "/api/v1/playbacks", headers: { cookie: first.auth }, payload: { program_id: queue.program.id, session_id: first.sessionId, queue_id: queue.queue_id, request_id: "playback-new-01" } });
    const playbackId = payload(playbackResponse).data.playback_id;
    const media = await application.app.inject({ method: "GET", url: payload(playbackResponse).data.audio_url });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toContain("audio/wav");
    expect(media.rawPayload.byteLength).toBeGreaterThan(44);
    await application.db.query("UPDATE playbacks SET started_at = NOW() - INTERVAL '30 seconds' WHERE id = $1", [playbackId]);
    const progress = (seq: number, listen: number) => application.app.inject({ method: "POST", url: `/api/v1/playbacks/${playbackId}/progress`, headers: { cookie: first.auth }, payload: { seq, cumulative_listen_ms: listen, observed_wall_ms: listen + 500, position_ms: listen, state: "playing", sampled_at: new Date().toISOString() } });
    expect(payload(await progress(1, 10_000)).data.listen_ms).toBe(10_000);
    expect(payload(await progress(2, 20_000)).data.listen_ms).toBe(20_000);
    expect(payload(await progress(2, 20_000)).data.duplicate).toBe(true);
    expect(payload(await progress(1, 10_000)).data.duplicate).toBe(true);
    expect(payload(await progress(3, 25_000)).data.listen_ms).toBe(25_000);
    await application.app.inject({ method: "PUT", url: `/api/v1/me/likes/${queue.program.id}`, headers: { cookie: first.auth } });
    const ownLikes = await application.app.inject({ method: "GET", url: "/api/v1/me/likes", headers: { cookie: first.auth } });
    const otherLikes = await application.app.inject({ method: "GET", url: "/api/v1/me/likes", headers: { cookie: second.auth } });
    expect(payload(ownLikes).data.items).toHaveLength(1);
    expect(payload(otherLikes).data.items).toHaveLength(0);
  });

  it("运营接口必须由服务端令牌保护", async () => {
    const guest = await application.app.inject({ method: "GET", url: "/api/v1/admin/programs" });
    expect(guest.statusCode).toBe(403);
    const operator = await application.app.inject({ method: "GET", url: "/api/v1/admin/programs", headers: { "x-admin-token": "test-admin-token" } });
    expect(operator.statusCode).toBe(200);
    expect(payload(operator).data.items.length).toBeGreaterThan(0);
  });
});
