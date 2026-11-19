"""Synthesise the promo soundtrack (128 BPM electronic beat + SFX) and the TTS voiceover,
aligned to timeline.json. Writes assets/audio/{music,voice,mix}.wav (48 kHz stereo, 16-bit).

Arrangement (beats):  0-3 hook slams · 4-7 groove in · 8-11 build/riser · 12 DROP
                      12-47 full groove with whooshes on every cut · 48-55 outro + end card
"""
import json, pathlib, subprocess, tempfile, wave
import numpy as np

HERE = pathlib.Path(__file__).parent
TL = json.loads((HERE / "timeline.json").read_text())
OUT = HERE / "assets" / "audio"
OUT.mkdir(parents=True, exist_ok=True)

SR = 48000
BPM = TL["bpm"]
SPB = 60 / BPM                      # seconds per beat
TOTAL_BEATS = TL["beats"] + TL["tailBeats"]
N = int(TOTAL_BEATS * SPB * SR)
rng = np.random.default_rng(7)

L = np.zeros(N); R = np.zeros(N)

def at(beat): return int(round(beat * SPB * SR))

def place(sig, beat, gain=1.0, pan=0.0):
    i = at(beat)
    j = min(N, i + len(sig))
    if j <= i: return
    s = sig[: j - i] * gain
    L[i:j] += s * np.sqrt(0.5 * (1 - pan)) * np.sqrt(2) / 2 * 2 ** 0.5
    R[i:j] += s * np.sqrt(0.5 * (1 + pan)) * np.sqrt(2) / 2 * 2 ** 0.5

def env(n, attack=0.002, decay=0.2):
    t = np.arange(n) / SR
    a = np.clip(t / attack, 0, 1)
    return a * np.exp(-t / decay)

def lowpass(x, cutoff):
    """One-pole low-pass; cutoff may be a scalar or per-sample array."""
    c = np.broadcast_to(np.asarray(cutoff, float), x.shape)
    k = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):
        acc += k[i] * (x[i] - acc); y[i] = acc
    return y

def highpass(x, cutoff):
    return x - lowpass(x, cutoff)

# ------------------------------------------------------------------ instruments
def kick(punch=1.0):
    n = int(0.42 * SR); t = np.arange(n) / SR
    f = 46 + 120 * np.exp(-t / 0.035)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
    click = rng.standard_normal(n) * np.exp(-t / 0.003) * 0.35
    return np.tanh((body + click) * 1.6 * punch) * 0.9

def clap():
    n = int(0.25 * SR); t = np.arange(n) / SR
    noise = highpass(rng.standard_normal(n), 900)
    bursts = sum(np.exp(-np.clip(t - d, 0, None) / 0.012) * (t >= d) for d in (0, 0.009, 0.018))
    tail = np.exp(-t / 0.09)
    return noise * (0.6 * bursts + 0.5 * tail) * 0.55

def hat(open_=False):
    n = int((0.16 if open_ else 0.05) * SR); t = np.arange(n) / SR
    x = highpass(highpass(rng.standard_normal(n), 6000), 6000)
    return x * np.exp(-t / (0.06 if open_ else 0.012)) * 0.28

def saw(freq, n, detune=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for d in (-detune, 0, detune):
        ph = (t * freq * (1 + d)) % 1.0
        out += 2 * ph - 1
    return out / 3

def bass_note(freq, length_beats=0.45):
    n = int(length_beats * SPB * SR)
    x = saw(freq, n, 0.004) + 0.6 * np.sin(2 * np.pi * freq * np.arange(n) / SR)
    x = lowpass(x, 420)
    return np.tanh(x * 2.2) * env(n, 0.003, 0.16) * 0.42

def stab(freqs, length_beats=0.4, cutoff=2600):
    n = int(length_beats * SPB * SR)
    x = sum(saw(f, n, 0.008) for f in freqs) / len(freqs)
    x = lowpass(x, cutoff)
    return x * env(n, 0.004, 0.12) * 0.32

def impact(size=1.0):
    n = int(1.6 * SR); t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * np.cumsum(38 + 70 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.55)
    crash = highpass(rng.standard_normal(n), 3000) * np.exp(-t / 0.5) * 0.35
    return np.tanh((sub * 1.2 + crash) * size) * 0.85

def whoosh(length=0.32):
    n = int(length * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n)
    sweep = 400 + 7000 * (t / length) ** 2
    y = lowpass(x, sweep) - lowpass(x, sweep * 0.25)
    shape = np.sin(np.pi * np.clip(t / length, 0, 1)) ** 2
    return y * shape * 0.5

def riser(beats=4):
    n = int(beats * SPB * SR); t = np.arange(n) / SR
    p = t / t[-1]
    noise = rng.standard_normal(n)
    y = lowpass(noise, 300 + 9000 * p ** 2) - lowpass(noise, 120 + 2500 * p ** 2)
    tone = np.sin(2 * np.pi * np.cumsum(220 + 660 * p ** 2) / SR) * 0.25
    return (y * 0.55 + tone) * p ** 1.5 * 0.6

def pad(freqs, beats):
    n = int(beats * SPB * SR); t = np.arange(n) / SR
    x = sum(saw(f, n, 0.01) for f in freqs) / len(freqs)
    x = lowpass(x, 1400)
    a = np.clip(t / 0.4, 0, 1) * np.clip((t[-1] - t) / 1.2, 0, 1)
    return x * a * 0.22

# ------------------------------------------------------------------ arrangement
NOTE = {"A1": 55.0, "F1": 43.65, "C2": 65.41, "G1": 49.0}
PROG = [("A1", [220.0, 261.63, 329.63]), ("F1", [174.61, 220.0, 261.63]),
        ("C2", [196.0, 261.63, 329.63]), ("G1", [196.0, 246.94, 293.66])]

duck = np.ones(N)  # sidechain pump applied to bass + stabs
music_pump = (np.zeros(N), np.zeros(N))

def place_pumped(sig, beat, gain=1.0, pan=0.0):
    i = at(beat); j = min(N, i + len(sig))
    if j <= i: return
    s = sig[: j - i] * gain
    music_pump[0][i:j] += s * (1 - pan * 0.5)
    music_pump[1][i:j] += s * (1 + pan * 0.5)

def kick_at(b, punch=1.0):
    place(kick(punch), b)
    i = at(b); n = int(0.28 * SR); j = min(N, i + n)
    duck[i:j] = np.minimum(duck[i:j], 1 - 0.75 * np.exp(-np.arange(j - i) / SR / 0.09))

# hook: four heavy slams + impacts on the big words
for b in (0, 1, 2, 3):
    kick_at(b, 1.3)
place(impact(1.0), 0, 0.8); place(impact(1.2), 2, 1.0)

# groove in
for b in range(4, 8):
    kick_at(b)
    for h in (0.5,):
        place(hat(), b + h, 1.0, 0.3)
    root = NOTE[PROG[(b // 4) % 4][0]]
    place_pumped(bass_note(root * 2), b + 0.5)

# build: kick drops out, riser + accelerating snare roll
place(riser(4), 8, 1.0)
roll = [8 + i * 0.5 for i in range(4)] + [10 + i * 0.25 for i in range(4)] + [11 + i * 0.125 for i in range(8)]
for k, b in enumerate(roll):
    place(clap(), b, 0.35 + 0.65 * k / len(roll))
place(pad(PROG[0][1], 4), 8, 0.8)

# DROP and full groove
place(impact(1.4), 12, 1.1)
for b in range(12, 48):
    kick_at(b)
    if b % 2 == 1:
        place(clap(), b, 0.9)
    for h in (0.25, 0.5, 0.75):
        place(hat(open_=(h == 0.5)), b + h, 0.9 if h == 0.5 else 0.6, -0.3 if h == 0.25 else 0.3)
    root, chord = PROG[((b - 12) // 4) % 4]
    place_pumped(bass_note(NOTE[root] * 2), b + 0.5)
    place_pumped(bass_note(NOTE[root] * 2, 0.2), b + 0.75, 0.6)
    if b % 2 == 0:
        place_pumped(stab([f * 2 for f in chord]), b + 0.5, 1.0, 0.2)
        place_pumped(stab([f * 2 for f in chord], 0.25, 3400), b + 1.25, 0.7, -0.2)

# whoosh into every clip cut
for b in [16, 20, 24, 28, 32, 36, 40, 44, 48]:
    w = whoosh()
    place(w, b - len(w) / SR / SPB, 0.9)

# outro: end-card hit, pad, a few soft kicks
place(impact(1.2), 48, 0.9)
place(pad(PROG[0][1], 8), 48, 1.1)
for b in (48, 49, 50, 51):
    kick_at(b, 0.8)

pumpL, pumpR = music_pump
L += pumpL * duck; R += pumpR * duck

# ------------------------------------------------------------------ voiceover
def tts(text, rate):
    with tempfile.TemporaryDirectory() as d:
        aiff = pathlib.Path(d) / "v.aiff"
        subprocess.run(["say", "-v", TL["voice"], "-r", str(rate), "-o", str(aiff), text], check=True)
        raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(aiff), "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                             check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(float) / 32768

def trim(x, thresh=0.01):
    idx = np.where(np.abs(x) > thresh)[0]
    return x[idx[0]: idx[-1] + int(0.05 * SR)] if len(idx) else x

voice = np.zeros(N)
vo = TL["vo"]
timings = []
for k, line in enumerate(vo):
    nxt = vo[k + 1]["beat"] if k + 1 < len(vo) else TOTAL_BEATS
    slot = (nxt - line["beat"]) * SPB * 0.97
    rate = 205
    x = trim(tts(line["text"], rate))
    while len(x) / SR > slot and rate < 250:
        rate = min(250, int(rate * min(1.15, (len(x) / SR) / slot + 0.02)))
        x = trim(tts(line["text"], rate))
    x = highpass(x, 110)
    x = np.tanh(x / (np.max(np.abs(x)) + 1e-9) * 1.8) * 0.8   # gentle saturation / level
    start = line["beat"] + 0.04 / SPB
    i = at(start); j = min(N, i + len(x))
    voice[i:j] += x[: j - i]
    timings.append({"beat": line["beat"], "text": line["text"], "rate": rate, "seconds": round(len(x) / SR, 2)})
    print(f"VO b{line['beat']:>2} rate {rate:>3}  {len(x)/SR:4.2f}s / slot {slot:4.2f}s  {line['text']}")

# duck music under voice
vo_env = lowpass((np.abs(voice) > 0.02).astype(float), 6)
gain = 1 - 0.45 * np.clip(vo_env * 3, 0, 1)
mL, mR = L * gain, R * gain

def write(path, left, right, peak=0.89):
    st = np.stack([left, right], 1)
    st = st / (np.max(np.abs(st)) + 1e-9) * peak
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())

write(OUT / "music.wav", L, R)
write(OUT / "voice.wav", voice, voice)
mixL = np.tanh((mL * 0.55 + voice * 0.95) * 1.1)
mixR = np.tanh((mR * 0.55 + voice * 0.95) * 1.1)
write(OUT / "mix.wav", mixL, mixR, 0.93)
(OUT / "vo_timings.json").write_text(json.dumps(timings, indent=2))
print("wrote", OUT / "mix.wav", f"{N / SR:.2f}s")
