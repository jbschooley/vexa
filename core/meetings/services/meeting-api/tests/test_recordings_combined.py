"""recordings — the muxed audio+video "combined" master (finalize_combined_master).

Drives the SHIPPED ``finalize_combined_master`` over the in-memory fakes with an INJECTED muxer (no
ffmpeg, no MinIO, no DB): the two per-type masters are built by the golden codec, the muxer is called
once, the combined object is cached in the session folder, and a synthetic ``combined`` media-file +
``playback_url.combined`` are stamped WITHOUT clobbering the audio/video playback URLs. The real
ffmpeg mux is L4 (needs ffmpeg + real media); this proves the orchestration.
"""
from __future__ import annotations

from meeting_api.recordings import finalize_combined_master, upload_chunk
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage

USER = 7
MEETING_ID = 1
SESSION_UID = "conn-abc"


def _wav(n_data: int = 4) -> bytes:
    import struct

    data = b"\x00" * n_data
    fmt = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 1, 16000, 32000, 2, 16)
    chunk = struct.pack("<4sI", b"data", len(data)) + data
    riff_len = 4 + len(fmt) + len(chunk)
    return struct.pack("<4sI4s", b"RIFF", riff_len, b"WAVE") + fmt + chunk


def _seeded():
    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=MEETING_ID, user_id=USER, session_uid=SESSION_UID)
    return repo, InMemoryStorage()


async def _upload_audio_and_video(repo, storage):
    r = await upload_chunk(
        repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        data=_wav(), media_type="audio", media_format="wav", chunk_seq=0, is_final=True,
    )
    rid = r["recording_id"]
    await upload_chunk(
        repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        data=b"VIDEOBYTES", media_type="video", media_format="webm", chunk_seq=0, is_final=True,
    )
    return rid


async def test_combined_master_muxes_and_stamps():
    repo, storage = _seeded()
    rid = await _upload_audio_and_video(repo, storage)

    seen = {}

    def fake_mux(vbytes, vfmt, abytes, afmt, out_fmt):
        seen.update(vfmt=vfmt, afmt=afmt, out_fmt=out_fmt)
        return b"MUXED-" + vbytes + abytes

    key = await finalize_combined_master(
        repo, storage, meeting_id=MEETING_ID, recording_id=rid, muxer=fake_mux,
    )
    # webm video → webm/opus combined, co-located in the session folder next to audio/ + video/.
    assert key.endswith(f"/{SESSION_UID}/combined/master.webm")
    assert seen == {"vfmt": "webm", "afmt": "wav", "out_fmt": "webm"}
    assert key in storage.blobs and storage.blobs[key].startswith(b"MUXED-")

    rec = (await repo.get_recordings(MEETING_ID))[0]
    cmf = next(m for m in rec["media_files"] if m["type"] == "combined")
    assert cmf["is_final"] is True
    assert cmf["format"] == "webm"
    assert cmf["storage_path"] == key
    assert cmf["finalized_by"] == "recording_finalizer.combined"
    # combined stamped WITHOUT dropping the audio/video playback URLs.
    pb = rec["playback_url"]
    assert pb["combined"] == f"/recordings/{rid}/master?type=combined"
    assert pb["audio"] and pb["video"]


async def test_combined_noop_without_video():
    repo, storage = _seeded()
    r = await upload_chunk(
        repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        data=_wav(), media_type="audio", media_format="wav", chunk_seq=0, is_final=True,
    )
    rid = r["recording_id"]

    called = False

    def fake_mux(*a, **k):
        nonlocal called
        called = True
        return b"X"

    key = await finalize_combined_master(
        repo, storage, meeting_id=MEETING_ID, recording_id=rid, muxer=fake_mux,
    )
    assert key is None
    assert called is False  # never muxed — there is no video master
    rec = (await repo.get_recordings(MEETING_ID))[0]
    assert "combined" not in (rec.get("playback_url") or {})


async def test_combined_idempotent_reuses_cache():
    repo, storage = _seeded()
    rid = await _upload_audio_and_video(repo, storage)

    calls = []

    def fake_mux(vbytes, vfmt, abytes, afmt, out_fmt):
        calls.append(1)
        return b"MUX"

    k1 = await finalize_combined_master(repo, storage, meeting_id=MEETING_ID, recording_id=rid, muxer=fake_mux)
    k2 = await finalize_combined_master(repo, storage, meeting_id=MEETING_ID, recording_id=rid, muxer=fake_mux)
    assert k1 == k2
    assert len(calls) == 1  # second call reused the cached combined object — no re-mux


async def test_combined_returns_none_when_mux_fails():
    repo, storage = _seeded()
    rid = await _upload_audio_and_video(repo, storage)

    def failing_mux(*a, **k):
        return None  # ffmpeg missing/failed

    key = await finalize_combined_master(repo, storage, meeting_id=MEETING_ID, recording_id=rid, muxer=failing_mux)
    assert key is None
    rec = (await repo.get_recordings(MEETING_ID))[0]
    assert "combined" not in (rec.get("playback_url") or {})  # not stamped on failure