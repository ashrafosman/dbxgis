# dbxgis promo video

27-second vertical (1080×1920, 30 fps) promo for the demo, cut to a 128 BPM beat with a TTS voiceover.
Everything is generated locally from `timeline.json`, which holds the beats, voiceover lines and app clips.

```bash
cd promo && bun install
# 1. footage: start the app first (`bun run dev` at the repo root), then
node capture.mjs            # frame-by-frame screenshots of the real app → assets/clips/
# 2. soundtrack: synthesised 128 BPM beat + macOS `say` voiceover → assets/audio/mix.wav
python3 audio.py
# 3. compose + encode → out/dbxgis-promo.mp4   (add --stills for quick preview frames)
node render.mjs
```

- To change wording or timing, edit `timeline.json`, then re-run `audio.py` and `render.mjs`.
- To replace the TTS voice with your own, record over `assets/audio/music.wav` using the beat
  timings in `assets/audio/vo_timings.json`. Save the result as `assets/audio/mix.wav`, then run `render.mjs`.
- Requires Google Chrome, ffmpeg and Python 3 with numpy. The voice is "Jamie (Premium)" from macOS.
- Map tiles: © CARTO, © OpenStreetMap contributors; imagery © Esri, Maxar, Earthstar Geographics. The credits are shown in the video.
