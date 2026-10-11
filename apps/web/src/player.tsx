import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, enqueueEvent, minutes, type Program } from "./api";

type PlayerStatus = "idle" | "ready" | "loading" | "playing" | "paused" | "buffering" | "blocked" | "error" | "ended";
type PlayerContextValue = {
  sessionId: string;
  current: Program | null; status: PlayerStatus; positionMs: number; durationMs: number; message: string | null;
  playProgram: (program: Program, queueId?: string | null, trigger?: "user" | "autonext" | "retry") => Promise<void>;
  toggle: () => Promise<void>; retry: () => Promise<void>; stop: () => Promise<void>;
};
const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("PlayerProvider is required");
  return value;
}

export function PlayerProvider({ sessionId, analyticsEnabled, children }: { sessionId: string; analyticsEnabled: boolean; children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackId = useRef<string | null>(null);
  const queueId = useRef<string | null>(null);
  const attemptId = useRef<string | null>(null);
  const generation = useRef(0);
  const currentRef = useRef<Program | null>(null);
  const currentStatus = useRef<PlayerStatus>("idle");
  const meter = useRef({ lastMedia: 0, lastClock: 0, listen: 0, wall: 0, seq: 0, lastSent: 0 });
  const [current, setCurrent] = useState<Program | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const setPlayerStatus = (next: PlayerStatus) => { currentStatus.current = next; setStatus(next); };

  const sendProgress = useCallback(async (state: "playing" | "paused" | "buffering" | "ended") => {
    if (!playbackId.current) return;
    const sample = meter.current;
    try {
      await api(`/playbacks/${playbackId.current}/progress`, { method: "POST", body: JSON.stringify({ seq: ++sample.seq, cumulative_listen_ms: Math.floor(sample.listen), observed_wall_ms: Math.floor(sample.wall), position_ms: Math.floor(audioRef.current?.currentTime ?? 0) * 1000, state, sampled_at: new Date().toISOString() }) });
      sample.lastSent = performance.now();
    } catch { /* The next bounded client event/progress opportunity can retry. */ }
  }, []);

  const finish = useCallback(async (reason: "ended" | "manual" | "error" | "offline") => {
    if (!playbackId.current) return;
    await sendProgress(reason === "ended" ? "ended" : "paused");
    const completed = playbackId.current; playbackId.current = null;
    try { await api(`/playbacks/${completed}/end`, { method: "POST", body: JSON.stringify({ request_id: crypto.randomUUID(), reason }) }); } catch { /* Offline reporting is best effort. */ }
  }, [sendProgress]);

  const beginAttempt = useCallback(async (trigger: "user" | "autonext" | "retry") => {
    const audio = audioRef.current; if (!audio || !playbackId.current) return;
    const localGeneration = generation.current;
    attemptId.current = crypto.randomUUID();
    try {
      await api(`/playbacks/${playbackId.current}/attempts`, { method: "POST", body: JSON.stringify({ attempt_id: attemptId.current, trigger }) });
      if (localGeneration !== generation.current) return;
      setMessage(null); setPlayerStatus("loading");
      await audio.play();
    } catch (error) {
      if (localGeneration !== generation.current) return;
      const isBlocked = error instanceof DOMException || (error as { name?: string }).name === "NotAllowedError";
      setPlayerStatus(isBlocked ? "blocked" : "error");
      setMessage(isBlocked ? "点一下开始收听" : "声音还没准备好，重试或换个节目。");
      if (attemptId.current) void enqueueEvent({ session_id: sessionId, playback_id: playbackId.current, attempt_id: attemptId.current, name: isBlocked ? "play_blocked" : "play_error", payload: { reason: isBlocked ? "policy_blocked" : "network" } }, analyticsEnabled);
    }
  }, [analyticsEnabled, sessionId]);

  const playProgram = useCallback(async (program: Program, nextQueueId?: string | null, trigger: "user" | "autonext" | "retry" = "user") => {
    const audio = audioRef.current; if (!audio) return;
    if (currentRef.current?.id === program.id && playbackId.current && (currentStatus.current === "paused" || currentStatus.current === "ready" || currentStatus.current === "blocked" || currentStatus.current === "error")) return beginAttempt(trigger);
    const nextGeneration = ++generation.current;
    if (playbackId.current) await finish("manual");
    audio.pause(); audio.removeAttribute("src"); audio.load();
    setCurrent(program); currentRef.current = program; queueId.current = nextQueueId ?? null;
    setPositionMs(0); setDurationMs(program.duration_ms); setMessage(null); setPlayerStatus("loading");
    meter.current = { lastMedia: 0, lastClock: performance.now(), listen: 0, wall: 0, seq: 0, lastSent: 0 };
    try {
      const response = await api<{ playback_id: string; audio_url: string; duration_ms: number }>("/playbacks", { method: "POST", body: JSON.stringify({ program_id: program.id, session_id: sessionId, queue_id: nextQueueId ?? undefined, request_id: crypto.randomUUID() }) });
      if (nextGeneration !== generation.current) return;
      playbackId.current = response.playback_id; setDurationMs(response.duration_ms);
      audio.src = response.audio_url; audio.load();
      await beginAttempt(trigger);
    } catch (error) {
      if (nextGeneration !== generation.current) return;
      setPlayerStatus("error"); setMessage(error instanceof Error ? error.message : "声音暂时不能播放。");
    }
  }, [beginAttempt, finish, sessionId]);

  const retry = useCallback(async () => {
    const audio = audioRef.current; if (!audio || !currentRef.current) return;
    if (!playbackId.current) { await playProgram(currentRef.current, queueId.current, "retry"); return; }
    if (playbackId.current) {
      try {
        const response = await api<{ audio_url: string }>(`/playbacks/${playbackId.current}/media-refresh`, { method: "POST" });
        audio.src = response.audio_url; audio.load();
      } catch { /* beginAttempt displays the recoverable error. */ }
    }
    await beginAttempt("retry");
  }, [beginAttempt, playProgram]);

  const toggle = useCallback(async () => {
    const audio = audioRef.current; if (!audio || !currentRef.current) return;
    if (currentStatus.current === "playing" || currentStatus.current === "buffering" || currentStatus.current === "loading") { audio.pause(); return; }
    await beginAttempt("user");
  }, [beginAttempt]);

  const stop = useCallback(async () => {
    const audio = audioRef.current; if (!audio) return;
    audio.pause(); await finish("manual"); setPlayerStatus("paused");
  }, [finish]);

  useEffect(() => {
    const audio = new Audio(); audio.preload = "metadata"; audioRef.current = audio;
    const onPlaying = () => {
      meter.current.lastMedia = audio.currentTime; meter.current.lastClock = performance.now(); setPlayerStatus("playing"); setMessage(null);
      if (playbackId.current && attemptId.current) void enqueueEvent({ session_id: sessionId, playback_id: playbackId.current, attempt_id: attemptId.current, name: "play_started", payload: { trigger: "user", position_ms: Math.floor(audio.currentTime * 1000) } }, analyticsEnabled);
    };
    const onPause = () => { if (!audio.ended && currentStatus.current !== "error" && currentStatus.current !== "blocked") { void sendProgress("paused"); setPlayerStatus("paused"); } };
    const onWaiting = () => { if (!audio.paused) { void sendProgress("buffering"); setPlayerStatus("buffering"); setMessage("网络有点慢，正在等声音。") } };
    const onError = () => { setPlayerStatus("error"); setMessage("声音加载失败，请重试或换个节目。"); void finish("error"); };
    const onEnded = async () => {
      setPlayerStatus("ended"); await finish("ended");
      if (!queueId.current) { setMessage("这一段听完了。"); return; }
      try {
        const response = await api<{ result: "PROGRAM" | "NO_ALTERNATIVE"; program: Program | null }>(`/queues/${queueId.current}/next`, { method: "POST", body: JSON.stringify({ request_id: crypto.randomUUID(), reason: "ended" }) });
        if (response.result === "PROGRAM" && response.program) await playProgram(response.program, queueId.current, "autonext");
        else { setPlayerStatus("ended"); setMessage("这里暂时只有这段，重听一次或换个年代。") }
      } catch { setMessage("下一段准备失败，您可以换个节目。") }
    };
    audio.addEventListener("playing", onPlaying); audio.addEventListener("pause", onPause); audio.addEventListener("waiting", onWaiting); audio.addEventListener("error", onError); audio.addEventListener("ended", onEnded);
    const ticker = window.setInterval(() => {
      if (currentStatus.current !== "playing" || audio.paused || audio.seeking) return;
      const now = performance.now(); const media = audio.currentTime; const mediaDelta = Math.max(0, (media - meter.current.lastMedia) * 1000); const clockDelta = Math.max(0, now - meter.current.lastClock);
      if (mediaDelta > 0 && clockDelta <= 5_000 && !audio.muted) { meter.current.listen += Math.min(mediaDelta, clockDelta); meter.current.wall += clockDelta; setPositionMs(Math.floor(media * 1000)); }
      meter.current.lastMedia = media; meter.current.lastClock = now;
      if (now - meter.current.lastSent >= 10_000) void sendProgress("playing");
    }, 1_000);
    return () => { window.clearInterval(ticker); audio.pause(); audio.removeEventListener("playing", onPlaying); audio.removeEventListener("pause", onPause); audio.removeEventListener("waiting", onWaiting); audio.removeEventListener("error", onError); audio.removeEventListener("ended", onEnded); audioRef.current = null; };
  }, [analyticsEnabled, finish, playProgram, sendProgress, sessionId]);

  const value = useMemo<PlayerContextValue>(() => ({ sessionId, current, status, positionMs, durationMs, message, playProgram, toggle, retry, stop }), [sessionId, current, status, positionMs, durationMs, message, playProgram, toggle, retry, stop]);
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function PlayerButton({ program, queueId, full = false }: { program?: Program | null; queueId?: string | null; full?: boolean }) {
  const player = usePlayer();
  const target = program ?? player.current;
  if (!target) return <button className={full ? "primary-button" : "mini-player-button"} disabled>正在准备声音</button>;
  const same = player.current?.id === target.id;
  const playing = same && (player.status === "playing" || player.status === "buffering" || player.status === "loading");
  const label = !same ? "收听这个节目" : playing ? "暂停收听" : player.status === "error" ? "重试播放" : "开始收听";
  return <button className={full ? "primary-button" : "mini-player-button"} onClick={() => same ? (player.status === "error" ? player.retry() : player.toggle()) : player.playProgram(target, queueId)}>{label}</button>;
}

export function MiniPlayer() {
  const player = usePlayer();
  if (!player.current) return null;
  return <aside className="mini-player" aria-live="polite"><span>{player.current.title}</span><button className="mini-player-button" onClick={() => player.status === "error" ? player.retry() : player.toggle()}>{player.status === "playing" ? "暂停" : "播放"}</button><small>{minutes(player.positionMs)} / {minutes(player.durationMs)}</small></aside>;
}
