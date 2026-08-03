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
 *  (Transcript↔video sync is a later layer.)
 */
import { useEffect, useRef, useState } from "react";

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

export function RecordingPlayer({ meetingId }: { meetingId?: string }) {
  const [media, setMedia] = useState<Resolved>({ videoSrc: null, audioSrc: null });
  const [preferAudio, setPreferAudio] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement>(null);

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

  if (state === "none" || state === "idle") return null; // no recording → render nothing

  const hasVideo = !!media.videoSrc;
  const hasAudio = !!media.audioSrc;
  // Audio-only meetings always show the audio element; when both exist the toggle decides.
  const showAudio = !hasVideo || (preferAudio && hasAudio);

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
          {/* Toggle only when BOTH a video and an audio recording exist. */}
          {hasVideo && hasAudio && (
            <button
              type="button"
              onClick={() => setPreferAudio((p) => !p)}
              title={preferAudio ? "Show the video recording" : "Play the audio-only recording"}
              style={{
                alignSelf: "flex-start", cursor: "pointer",
                background: "transparent", color: "var(--t2)",
                border: "1px solid var(--line2)", borderRadius: 8,
                padding: "3px 9px", fontSize: 12, fontWeight: 600,
              }}
            >
              {preferAudio ? "Show video" : "Audio only"}
            </button>
          )}
          {showAudio ? (
            <audio src={media.audioSrc!} controls preload="metadata" style={{ width: "100%" }} />
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
