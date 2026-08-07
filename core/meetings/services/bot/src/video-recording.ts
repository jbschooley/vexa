/**
 * Video recording wiring (2b) — the server-side screen-capture DELIVER path.
 *
 * Unlike audio (browser MediaRecorder tap → chunks → assembler, see recording.ts), video is
 * captured OUTSIDE the browser: @vexa/recording's VideoRecordingService spawns `ffmpeg -f x11grab`
 * against the bot's Xvfb display ($DISPLAY, per-container :99) and writes one file, then uploads it
 * to inv.recordingUploadUrl with media_type "video" — stored as a SEPARATE MediaFile alongside the
 * audio master (no bot-side mux; a combined download is a later serve-side concern).
 *
 * Because each bot runs in its own container with its own Xvfb, concurrent bots never capture each
 * other's screen — the shared-display cross-contamination that affected the pre-restructure design
 * (two bots' ffmpegs both grabbed one host :99) cannot occur here.
 *
 * Gating: recordingEnabled AND captureModes includes "video". Encoder/format is chosen by the
 * service from VIDEO_HWACCEL / ENCODE_H264 env (default: software VP9 → webm). L4-gated (needs
 * ffmpeg + a live X display) — exercised on the VM run, not unit tests. Every path here is
 * best-effort: a video fault must never change the bot's join/leave/exit behavior.
 */
import { VideoRecordingService } from '@vexa/recording';
import type { Invocation } from './config.js';
import type { Page } from '@vexa/remote-browser';

/** True when this invocation asks for server-side video capture (recording on + "video" mode). */
export function wantsVideoCapture(inv: Invocation): boolean {
  return !!inv.recordingEnabled && Array.isArray(inv.captureModes) && inv.captureModes.includes('video');
}

/**
 * Start server-side video recording for this invocation. Returns an idempotent, best-effort `stop`
 * that finalizes the ffmpeg capture, uploads the file (media_type "video") to inv.recordingUploadUrl,
 * and cleans up the temp file — it never throws.
 *
 * Call from pipeline.start() (post-admission) so capture begins once the live meeting is rendering
 * on the display; call the returned stop from pipeline.stop() and again in the composition-root
 * teardown (it is a no-op after the first call).
 */
export function startVideoRecording(inv: Invocation, log: (m: string) => void, page?: Page): () => Promise<void> {
  const meetingId = inv.meeting_id ?? 0;
  const sessionUid = inv.connectionId ?? inv.nativeMeetingId ?? 'session';

  let svc: VideoRecordingService | null = null;
  // PROTOTYPE (proto/screencast-recording): when VIDEO_CAPTURE=screencast, feed the meeting page's
  // compositor frames (CDP Page.startScreencast) into ffmpeg's stdin instead of x11grab — no
  // framebuffer readback, damage-driven, off the CPU that starves the audio thread.
  let cdp: any = null;
  let screencastOn = false;
  try {
    svc = new VideoRecordingService(meetingId, sessionUid);
    svc.start();
    log(`video: started (session ${sessionUid})`);
    if (svc.isScreencast()) {
      if (!page) {
        log(`video: screencast requested but no page handle — NO frames will be captured (session ${sessionUid})`);
      } else {
        const W = Number(process.env.VEXA_VIDEO_WIDTH || 1920);
        const H = Number(process.env.VEXA_VIDEO_HEIGHT || 1080);
        const svcRef = svc;
        void (async () => {
          try {
            cdp = await page.context().newCDPSession(page);
            let frames = 0;
            cdp.on('Page.screencastFrame', async (e: any) => {
              try { svcRef.writeFrame(Buffer.from(e.data, 'base64')); } catch { /* dropped */ }
              frames++;
              if (frames === 1 || frames % 300 === 0) log(`video: screencast frame ${frames}`);
              try { await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }); } catch { /* stopped */ }
            });
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
            screencastOn = true;
            log(`video: screencast started ${W}x${H} (session ${sessionUid})`);
          } catch (e) { log(`video: screencast start FAILED (session ${sessionUid}): ${String(e)}`); }
        })();
      }
    }
  } catch (e) {
    // Construction/spawn failure (e.g. ffmpeg missing) must not break capture/recording wiring.
    log(`video: start FAILED (session ${sessionUid}): ${String(e)}`);
    svc = null;
  }

  let stopped = false;
  return async () => {
    if (stopped || !svc) return;
    stopped = true;
    const s = svc;
    try {
      if (screencastOn && cdp) {
        try { await cdp.send('Page.stopScreencast'); } catch { /* already gone */ }
        try { await cdp.detach(); } catch { /* already detached */ }
      }
      await s.stop(); // screencast → EOF on stdin finalizes; x11grab → SIGTERM (15s SIGKILL fallback)
      const url = inv.recordingUploadUrl;
      if (url) {
        await s.upload(url, inv.internalSecret ?? ''); // multipart POST, metadata media_type "video"
        log(`video: uploaded (session ${sessionUid})`);
      } else {
        log(`video: no recordingUploadUrl — capture NOT uploaded (session ${sessionUid})`);
      }
    } catch (e) {
      log(`video: stop/upload FAILED (session ${sessionUid}): ${String(e)}`);
    } finally {
      await s.cleanup().catch(() => { /* best-effort */ });
    }
  };
}