import type { FeatureFlags, Preferences } from "@sound-time-machine/contracts";

const prefix = "/api/v1";
const queuedEventsKey = "stm-development-event-queue";

export type Program = {
  id: string; title: string; era: string; era_label: string; category: string; category_label: string;
  duration_ms: number; source_kind: "archive_original" | "modern_performance" | "ai_reconstruction";
  display_year: number | null; source_note: string; is_excerpt: boolean; excerpt_label: string | null; is_liked: boolean;
};
export type Bootstrap = { preferences: Preferences; feature_flags: FeatureFlags; principal_kind: string };
export type ListeningSession = { session_id: string; analytics_enabled: boolean };
export type ApiError = Error & { code?: string; retryable?: boolean };

function newId(): string { return crypto.randomUUID(); }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-request-id", newId());
  if (init.body && !headers.has("content-type") && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${prefix}${path}`, { ...init, headers, credentials: "include" });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) throw Object.assign(new Error("服务暂时不可用，请稍后重试。"), { code: "SERVICE_UNAVAILABLE", retryable: true }) as ApiError;
    return (await response.text()) as T;
  }
  const payload = await response.json() as { data?: T; error?: { code: string; message: string; retryable: boolean } };
  if (!response.ok || payload.error) throw Object.assign(new Error(payload.error?.message ?? "服务暂时不可用，请稍后重试。"), payload.error) as ApiError;
  return payload.data as T;
}

export async function bootstrap(): Promise<{ me: Bootstrap; session: ListeningSession }> {
  const me = await api<Bootstrap>("/guest-session", { method: "POST" });
  const session = await api<ListeningSession>("/listening-sessions", { method: "POST", body: JSON.stringify({ entry_source: new URLSearchParams(location.search).get("src") === "share" ? "share" : "direct" }) });
  return { me, session };
}

export async function getMe(): Promise<Bootstrap> { return api<Bootstrap>("/me"); }
export async function getCatalog(era?: string) { return api<{ eras: Array<{ value: string; label: string }>; categories: Array<{ value: string; label: string }>; combinations: Array<{ era: string; category: string; count: number }> }>(`/catalog${era ? `?era=${encodeURIComponent(era)}` : ""}`); }
export async function getProgram(id: string) { return api<{ program: Program }>(`/programs/${id}`); }

export async function createQueue(sessionId: string, era: string, category: string, mode: "today" | "era") {
  return api<{ queue_id: string | null; result: "PROGRAM" | "NO_CONTENT"; program: Program | null }>("/queues", { method: "POST", body: JSON.stringify({ session_id: sessionId, request_id: newId(), mode, era, category }) });
}
export async function nextQueue(queueId: string) {
  return api<{ queue_id: string; result: "PROGRAM" | "NO_ALTERNATIVE"; program: Program | null }>(`/queues/${queueId}/next`, { method: "POST", body: JSON.stringify({ request_id: newId(), reason: "manual" }) });
}
export async function setPreferences(preferences: Preferences) { return api<Preferences>("/me/preferences", { method: "PUT", body: JSON.stringify(preferences) }); }
export async function setLike(programId: string, liked: boolean) { return api<{ program_id: string; liked: boolean }>(`/me/likes/${programId}`, { method: liked ? "PUT" : "DELETE" }); }
export async function getLikes() { return api<{ items: Array<Program & { available: boolean; liked_at: string }>; next_cursor: string | null }>("/me/likes"); }
export async function requestDeletion() { return api<{ job_id: string; status: string }>("/me/deletion-requests", { method: "POST", body: JSON.stringify({ request_id: newId(), confirmed: true }) }); }
export async function logout() { return api<{ logged_out: boolean }>("/auth/logout", { method: "POST" }); }

export type ClientEvent = { event_id: string; session_id: string; playback_id?: string; attempt_id?: string; name: string; client_at: string; payload: Record<string, unknown> };
function queuedEvents(): ClientEvent[] {
  try { return JSON.parse(localStorage.getItem(queuedEventsKey) ?? "[]") as ClientEvent[]; } catch { return []; }
}
function saveEvents(events: ClientEvent[]) { localStorage.setItem(queuedEventsKey, JSON.stringify(events.slice(-50))); }
export function clearPendingEvents() { localStorage.removeItem(queuedEventsKey); }
export async function enqueueEvent(event: Omit<ClientEvent, "event_id" | "client_at">, analyticsEnabled: boolean): Promise<void> {
  if (!analyticsEnabled) return;
  const next = { ...event, event_id: newId(), client_at: new Date().toISOString() };
  const events = [...queuedEvents(), next]; saveEvents(events);
  await flushEvents();
}
export async function flushEvents(): Promise<void> {
  const events = queuedEvents(); if (!events.length) return;
  try {
    const result = await api<{ accepted: string[]; duplicate: string[] }>("/events/batch", { method: "POST", body: JSON.stringify({ events }) });
    const handled = new Set([...result.accepted, ...result.duplicate]);
    saveEvents(events.filter((event) => !handled.has(event.event_id)));
  } catch { /* Preserve a bounded queue for a later retry; user clearing data removes it. */ }
}

export function minutes(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
