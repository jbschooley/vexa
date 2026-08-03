"use client";

/**
 *  RecordingPlayer — plays a finished meeting's video recording in the meeting detail.
 *
 *  Minimal player (transcript↔video sync is a later layer): resolve the meeting's recording, ask the
 *  backend for its playable master (prefer the muxed audio+video `combined`, fall back to the silent
 *  `video` master), and render a `<video controls>` pointed at the streaming byte route
 *  (`/api/recordings/{id}/media/{fid}/raw`, which forwards Range so scrubbing works). Renders nothing
 *  when the meeting has no video recording — so it is safe to mount for any durable meeting.
 */
import { useEffect, useRef, useState } from "react";

type MediaFile = { id?: number; type?: string };
type Recording = { id?: number; meeting_id?: number | string; media_files?: MediaFile[] };
type MasterResponse = { raw_url?: string | null; media_file_id?: number | null };

async function resolvePlaybackUrl(meetingId: string, signal: AbortSignal): Promise<string | null> {
  // The recordings list is the authoritative source (list_meeting_recordings); filter to THIS meeting.
  // GET /recordings returns { recordings: [...] }, not a bare array.
  const listRes = await fetch("/api/recordings", { signal, cache: "no-store" });
  if (!listRes.ok) return null;
  const body = (await listRes.json()) as { recordings?: Recording[] };
  const all = body?.recordings ?? [];
  const mine = (Array.isArray(all) ? all : []).filter(
    (r) => String(r.meeting_id) === String(meetingId) && r.id != null,
  );
  // Prefer the muxed master (has sound); fall back to the silent video-only master. Requesting
  // `combined` also triggers the server-side mux-on-read if the finalize-time build hasn't run.
  for (const rec of mine) {
    for (const type of ["combined", "video"] as const) {
      const res = await fetch(`/api/recordings/${rec.id}/master?type=${type}`, { signal, cache: "no-store" });
      if (!res.ok) continue;
      const master = (await res.json()) as MasterResponse;
      if (master.media_file_id != null) {
        // → the flat streaming byte route (Range-forwarding proxy).
        return `/api/recording-media?rec=${rec.id}&mf=${master.media_file_id}&type=${type}`;
      }
    }
  }
  return null;
}

export function RecordingPlayer({ meetingId }: { meetingId?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!meetingId) { setState("none"); return; }
    const ctrl = new AbortController();
    setState("loading");
    resolvePlaybackUrl(meetingId, ctrl.signal)
      .then((url) => {
        if (ctrl.signal.aborted) return;
        setSrc(url);
        setState(url ? "ready" : "none");
      })
      .catch((e) => { if (!ctrl.signal.aborted && e?.name !== "AbortError") setState("error"); });
    return () => ctrl.abort();
  }, [meetingId]);

  if (state === "none" || state === "idle") return null; // no video recording → render nothing
  return (
    <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      {state === "loading" && (
        <div style={{ color: "var(--t3)", fontSize: 13 }}>Preparing recording…</div>
      )}
      {state === "error" && (
        <div style={{ color: "var(--red, #c00)", fontSize: 13 }}>Recording could not be loaded.</div>
      )}
      {state === "ready" && src && (
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          style={{ width: "100%", maxHeight: "60vh", borderRadius: 10, background: "#000" }}
        />
      )}
    </div>
  );
}
