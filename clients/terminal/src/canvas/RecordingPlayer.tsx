"use client";

/**
 *  RecordingPlayer — plays a finished meeting's recording in the meeting detail.
 *
 *  Resolves BOTH tracks the recording carries: the video master (preferring the muxed audio+video
 *  `combined`, falling back to the silent `video` master) and the `audio` master. When both exist it
 *  shows a video/audio toggle; with only one it just plays that one (no toggle). Sources point at the
 *  streaming byte route (`/api/recording-media`, which forwards Range so scrubbing works). Renders
 *  nothing when the meeting has no recording — so it is safe to mount for any durable meeting.
 *
 *  Sync (playbackSync): the active element registers a `seekTo` handler (transcript click → jump here)
 *  and emits its `currentTime` so the transcript can follow along. Toggling audio↔video PRESERVES the
 *  position + play state (the two elements are one at a time, so we carry the clock across the swap).
 */
import { useEffect, useRef, useState } from "react";
import { usePlaybackSync } from "./playbackSync";

type MediaFile = { id?: number; type?: string; first_chunk_at?: string };
type Recording = { id?: number; meeting_id?: number | string; media_files?: MediaFile[] };
type MasterResponse = { media_file_id?: number | null };
// Per-track recording start (epoch ms) = the media file's `first_chunk_at` (the bot's true recorder t=0,
// same clock as the transcript). Video and audio start at different moments, so we anchor per active track.
type Resolved = {
  videoSrc: string | null; audioSrc: string | null; videoStartMs: number | null; audioStartMs: number | null;
  // The recording that carries the video, and whether videoSrc is already the muxed `combined` master
  // (with sound) or the silent `video` fallback we play while the combined master builds server-side.
  recId: number | null; videoIsCombined: boolean;
};

const parseMs = (s?: string): number | null => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

/** Resolve a recording's master of `type` to the streaming byte URL, or null if there's none. */
async function masterUrl(recId: number, type: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(`/api/recordings/${recId}/master?type=${type}`, { signal, cache: "no-store" });
  if (!res.ok) return null;
  const m = (await res.json()) as MasterResponse;
  return m.media_file_id != null ? `/api/recording-media?rec=${recId}&mf=${m.media_file_id}&type=${type}` : null;
}

const EMPTY: Resolved = { videoSrc: null, audioSrc: null, videoStartMs: null, audioStartMs: null, recId: null, videoIsCombined: false };

async function resolveMedia(meetingId: string, signal: AbortSignal): Promise<Resolved> {
  // The recordings list is the authoritative source; GET /recordings returns { recordings: [...] }.
  const listRes = await fetch("/api/recordings", { signal, cache: "no-store" });
  if (!listRes.ok) return EMPTY;
  const body = (await listRes.json()) as { recordings?: Recording[] };
  const mine = (body?.recordings ?? []).filter(
    (r) => String(r.meeting_id) === String(meetingId) && r.id != null,
  );
  let videoSrc: string | null = null;
  let audioSrc: string | null = null;
  let videoStartMs: number | null = null;
  let audioStartMs: number | null = null;
  let recId: number | null = null;
  let videoIsCombined = false;
  for (const rec of mine) {
    const files = rec.media_files ?? [];
    const types = new Set(files.map((m) => m.type));
    if (!videoSrc && types.has("video")) {
      // Prefer the muxed master (has sound). When it isn't built yet the server returns 202 (no
      // media_file_id) so masterUrl is null → play the SILENT video-only master now, remember recId,
      // and the poll below swaps in the combined master the moment it's ready. Both share the video
      // timeline, so anchor to the raw VIDEO file's start either way.
      const combined = await masterUrl(rec.id!, "combined", signal);
      videoSrc = combined || (await masterUrl(rec.id!, "video", signal));
      videoIsCombined = !!combined;
      recId = rec.id!;
      videoStartMs = parseMs(files.find((m) => m.type === "video")?.first_chunk_at);
    }
    if (!audioSrc && types.has("audio")) {
      audioSrc = await masterUrl(rec.id!, "audio", signal);
      audioStartMs = parseMs(files.find((m) => m.type === "audio")?.first_chunk_at);
    }
    if (videoSrc && audioSrc) break;
  }
  return { videoSrc, audioSrc, videoStartMs, audioStartMs, recId, videoIsCombined };
}

export function RecordingPlayer({
  meetingId,
  preferAudio = false,
  onTracks,
}: {
  meetingId?: string;
  /** Which track to show when both exist — the toggle lives in the meeting header, lifted out so it can
   *  sit on the same row as the raw/processed control. */
  preferAudio?: boolean;
  /** Report resolved tracks up so the header knows whether to show the audio/video toggle. */
  onTracks?: (t: { hasVideo: boolean; hasAudio: boolean }) => void;
}) {
  const [media, setMedia] = useState<Resolved>(EMPTY);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sync = usePlaybackSync();
  // The active element's live position — read on a toggle to carry the clock to the other element.
  const lastPos = useRef<{ sec: number; playing: boolean }>({ sec: 0, playing: false });
  // A position to restore after the NEXT video src change — set when the silent video is swapped for
  // the combined master, so playback continues from where the viewer was instead of jumping to 0.
  const pendingSeek = useRef<{ sec: number; playing: boolean } | null>(null);
  // Which element the last effect wired — a CHANGE means a toggle (preserve position), null = first mount.
  const prevShowAudio = useRef<boolean | null>(null);
  // Whichever element is currently mounted — the seek handler reads this so one registration spans toggles.
  const mediaElRef = useRef<HTMLMediaElement | null>(null);

  useEffect(() => {
    if (!meetingId) { setState("none"); return; }
    const ctrl = new AbortController();
    setState("loading");
    resolveMedia(meetingId, ctrl.signal)
      .then((m) => {
        if (ctrl.signal.aborted) return;
        setMedia(m);
        setState(m.videoSrc || m.audioSrc ? "ready" : "none");
      })
      .catch((e) => { if (!ctrl.signal.aborted && e?.name !== "AbortError") setState("error"); });
    return () => ctrl.abort();
  }, [meetingId]);

  // While showing the SILENT video fallback, poll the combined master until the server has built it,
  // then swap it in (carrying the current position). The server returns 202 until ready and builds
  // ONCE in the background, so this poll never restarts the mux. Stops on unmount / once combined.
  useEffect(() => {
    if (state !== "ready" || media.recId == null || media.videoIsCombined || !media.videoSrc) return;
    const recId = media.recId;
    const ctrl = new AbortController();
    let stopped = false;
    let attempts = 0;
    const tick = async () => {
      while (!stopped && attempts < 120) {   // ~10 min ceiling (5s cadence) — then give up quietly
        attempts += 1;
        await new Promise((r) => setTimeout(r, 5000));
        if (stopped) return;
        const url = await masterUrl(recId, "combined", ctrl.signal).catch(() => null);
        if (stopped || !url) continue;
        const v = videoRef.current;
        pendingSeek.current = v ? { sec: v.currentTime, playing: !v.paused } : null;
        setMedia((prev) => ({ ...prev, videoSrc: url, videoIsCombined: true }));
        return;
      }
    };
    void tick();
    return () => { stopped = true; ctrl.abort(); };
  }, [state, media.recId, media.videoIsCombined, media.videoSrc]);

  const hasVideo = !!media.videoSrc;
  const hasAudio = !!media.audioSrc;
  // Audio-only meetings always show the audio element; when both exist the toggle decides.
  const showAudio = !hasVideo || (preferAudio && hasAudio);

  // Tell the header which tracks exist (so it shows the toggle only when both are present).
  useEffect(() => { onTracks?.({ hasVideo, hasAudio }); }, [hasVideo, hasAudio, onTracks]);

  // Register ONE seek handler for the transcript (reads the active element via the ref, so it survives
  // toggles). hasPlayer flips true here → transcript lines become clickable.
  useEffect(() => {
    if (!sync) return;
    sync.registerSeek((sec) => {
      const el = mediaElRef.current;
      if (el) { el.currentTime = Math.max(0, sec); void el.play(); }
    });
    return () => sync.registerSeek(null);
  }, [sync]);

  // Wire the ACTIVE element's time events (re-runs on toggle). Emits position to the transcript, tracks
  // lastPos, and on a toggle restores the carried position + play state onto the freshly-shown element.
  useEffect(() => {
    if (state !== "ready") return;
    const el = showAudio ? audioRef.current : videoRef.current;
    mediaElRef.current = el;
    if (!el) return;
    const onTime = () => { lastPos.current = { sec: el.currentTime, playing: !el.paused }; sync?.emitTime(el.currentTime, !el.paused); };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onTime);
    el.addEventListener("pause", onTime);
    // A CHANGE of active element (not the first mount) is a toggle → carry the position + play state over.
    // A pending seek (the silent-video → combined-master swap) restores position on the SAME element.
    const isToggle = prevShowAudio.current !== null && prevShowAudio.current !== showAudio;
    prevShowAudio.current = showAudio;
    const swap = pendingSeek.current; pendingSeek.current = null;
    if (isToggle || swap) {
      const pos = swap ?? lastPos.current;
      const restore = () => { el.currentTime = pos.sec; if (pos.playing) void el.play(); };
      if (el.readyState >= 1) restore(); else el.addEventListener("loadedmetadata", restore, { once: true });
    }
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onTime);
      el.removeEventListener("pause", onTime);
    };
  }, [showAudio, media.videoSrc, media.audioSrc, state, sync]);

  // Publish the recording's start (created_at) as the transcript's anchor. Same for both tracks (one
  // recording), so a toggle doesn't disturb it.
  // Anchor the transcript to the ACTIVE track's recording start (video and audio differ). Recomputes on
  // toggle so the sync follows whichever file is playing.
  useEffect(() => {
    sync?.setRecStartMs(showAudio ? media.audioStartMs : media.videoStartMs);
  }, [showAudio, media.audioStartMs, media.videoStartMs, sync]);

  if (state === "none" || state === "idle") return null; // no recording → render nothing

  return (
    <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      {state === "loading" && (
        <div style={{ color: "var(--t3)", fontSize: 13 }}>Preparing recording…</div>
      )}
      {state === "error" && (
        <div style={{ color: "var(--red, #c00)", fontSize: 13 }}>Recording could not be loaded.</div>
      )}
      {state === "ready" && (
        <>
          {/* The audio/video toggle now lives in the meeting header (same row as raw/processed). */}
          {showAudio ? (
            <audio ref={audioRef} src={media.audioSrc!} controls preload="metadata" style={{ width: "100%" }} />
          ) : (
            <video
              ref={videoRef}
              src={media.videoSrc!}
              controls
              preload="metadata"
              style={{ width: "100%", maxHeight: "60vh", borderRadius: 10, background: "#000" }}
            />
          )}
        </>
      )}
    </div>
  );
}
