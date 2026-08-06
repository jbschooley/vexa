- **Record meetings to video (#1015).** Vexa can now capture a server-side video recording of a meeting
  alongside the transcript, muxed with the meeting audio into a downloadable master.
- **Record at a lower resolution to save CPU (#1015).** A new `VIDEO_RESOLUTION` deployment setting
  (default `1920x1080`, given as `WIDTHxHEIGHT` — e.g. `1280x800`) sets the recording capture
  resolution; recording fewer pixels cuts video-encoding CPU roughly in proportion, so lower-powered
  hosts can still record.
