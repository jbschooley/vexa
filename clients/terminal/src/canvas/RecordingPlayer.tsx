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

type MediaFile = { id?: number; type?: string };
type Recording = { id?: number; meeting_id?: number | string; media_files?: MediaFile[] };
type MasterResponse = { media_file_id?: number | null };
type Resolved = { videoSrc: string | null; audioSrc: string | null };

/** Resolve a recording's master of `type` to the streaming byte URL, or null if there's none. */
async function masterUrl(recId: number, type: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(`/api/recordings/${recId}/master?type=${type}`, { signal, cache: "no-store" });
  if (!res.ok) return null;
  const m = (await res.json()) as MasterResponse;
  return m.media_file_id != null ? `/api/recording-media?rec=${recId}&mf=${m.media_file_id}&type=${type}` : null;
}

async function resolveMedia(meetingId: string, signal: AbortSignal): Promise<Resolved> {
  // The recordings list is the authoritative source; GET /recordings returns { recordings: [...] }.
  const listRes = await fetch("/api/recordings", { signal, cache: "no-store" });
  if (!listRes.ok) return { videoSrc: null, audioSrc: null };
  const body = (await listRes.json()) as { recordings?: Recording[] };
  const mine = (body?.recordings ?? []).filter(
    (r) => String(r.meeting_id) === String(meetingId) && r.id != null,
  );
  let videoSrc: string | null = null;
  let audioSrc: string | null = null;
  for (const rec of mine) {
    const types = new Set((rec.media_files ?? []).map((m) => m.type));
    if (!videoSrc && types.has("video")) {
      // Prefer the muxed master (has sound); fall back to the silent video-only master.
      videoSrc = (await masterUrl(rec.id!, "combined", signal)) || (await masterUrl(rec.id!, "video", signal));
    }
    if (!audioSrc && types.has("audio")) {
      audioSrc = await masterUrl(rec.id!, "audio", signal);
    }
    if (videoSrc && audioSrc) break;
  }
  return { videoSrc, audioSrc };
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
  const [media, setMedia] = useState<Resolved>({ videoSrc: null, audioSrc: null });
  const [state, setState] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sync = usePlaybackSync();
  // The active element's live position — read on a toggle to carry the clock to the other element.
  const lastPos = useRef<{ sec: number; playing: boolean }>({ sec: 0, playing: false });
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
    const isToggle = prevShowAudio.current !== null && prevShowAudio.current !== showAudio;
    prevShowAudio.current = showAudio;
    if (isToggle) {
      const pos = lastPos.current;
      const restore = () => { el.currentTime = pos.sec; if (pos.playing) void el.play(); };
      if (el.readyState >= 1) restore(); else el.addEventListener("loadedmetadata", restore, { once: true });
    }
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onTime);
      el.removeEventListener("pause", onTime);
    };
  }, [showAudio, media.videoSrc, media.audioSrc, state, sync]);

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
