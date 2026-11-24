"""Generate an original ambient score and sound design for the promo."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import wave

SR = 48_000
DUR = 46.0
N = int(SR * DUR)
rng = np.random.default_rng(20261110)
t = np.arange(N) / SR

OUT = Path(__file__).resolve().parents[2] / "deliverables"
OUT.mkdir(parents=True, exist_ok=True)


def midi(note: int) -> float:
    return 440.0 * 2 ** ((note - 69) / 12)


def env_ad(t: np.ndarray, attack: float, release: float, length: float) -> np.ndarray:
    a = np.clip(t / attack, 0, 1)
    r = np.clip((length - t) / release, 0, 1)
    return np.minimum(a, r) ** 1.4


def smoothstep(x: np.ndarray | float) -> np.ndarray | float:
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def pad_note(freq: float, start: float, length: float, amp: float, detune: float = 0.0) -> np.ndarray:
    begin = max(0, int(start * SR))
    end = min(N, int((start + length) * SR))
    if begin >= N or end <= begin:
        return np.zeros(N)
    tt = np.arange(end - begin) / SR
    local = np.zeros(end - begin)
    # warm additive stack: fundamental + soft octave + fifth air
    for harmonic, gain, phase in ((1, 1.0, 0.0), (2, 0.16, 0.8), (3, 0.06, 1.7), (4, 0.025, 2.4)):
        f = freq * harmonic * (1 + detune * (0.5 if harmonic % 2 else -0.5))
        local += gain * np.sin(2 * np.pi * f * tt + phase + 0.12 * np.sin(2 * np.pi * 0.07 * tt + phase))
    local *= env_ad(tt, min(3.2, length * 0.35), min(4.0, length * 0.4), length)
    local *= amp
    out = np.zeros(N)
    out[begin:end] = local
    return out


def add_at(target: np.ndarray, begin: int, sig: np.ndarray) -> None:
    begin = max(0, begin)
    end = min(N, begin + len(sig))
    if end > begin:
        target[begin:end] += sig[: end - begin]


# D minor -> B flat major -> F major -> C major, one chord every 11.5 s
chords = [
    (38, [50, 53, 57, 62]),  # D2, D3 F3 A3 D4
    (34, [46, 50, 53, 58]),  # Bb1, Bb2 D3 F3 Bb3
    (29, [41, 45, 48, 53]),  # F1, F2 A2 C3 F3
    (36, [43, 48, 52, 55]),  # C2, G2 C3 E3 G3
]
chord_len = 12.0
score = np.zeros(N)

for i, (bass, notes) in enumerate(chords):
    start = i * 11.4 - 0.8
    length = chord_len
    # bass drone, two detuned layers
    score += pad_note(midi(bass), start, length, 0.16, detune=0.0018)
    score += pad_note(midi(bass + 12), start, length, 0.055, detune=-0.0012)
    for j, note in enumerate(notes):
        score += pad_note(midi(note), start + j * 0.04, length, 0.042 - j * 0.004, detune=0.0015 * (1 if j % 2 else -1))
    # high air note, very quiet
    score += pad_note(midi(notes[-1] + 12), start + 0.8, length - 1.2, 0.008, detune=0.002)

# slow low pulse, like a barometer ticking under the pad
for beat in np.arange(2.0, DUR - 2.0, 4.0):
    length = 1.6
    tt = np.arange(int(length * SR)) / SR
    f = 52 + 10 * np.exp(-tt * 5)
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 2.8) * 0.082
    add_at(score, int(beat * SR), tone)

# distant metallic chime at section changes
for when, note in ((5.2, 74), (11.4, 77), (21.0, 81), (30.6, 79), (40.6, 74)):
    length = 5.5
    tt = np.arange(int(length * SR)) / SR
    f = midi(note)
    tone = (
        np.sin(2 * np.pi * f * tt)
        + 0.34 * np.sin(2 * np.pi * f * 2.01 * tt + 0.7)
        + 0.16 * np.sin(2 * np.pi * f * 3.98 * tt + 1.1)
    ) * np.exp(-tt * 1.1) * 0.028
    tone *= np.clip(tt / 0.03, 0, 1)
    add_at(score, int(when * SR), tone)

# wind bed: filtered noise with slow moving bands
noise = rng.normal(0, 1, N)
spectrum = np.fft.rfft(noise)
freqs = np.fft.rfftfreq(N, 1 / SR)
shape = (
    0.10 * np.exp(-((freqs - 180) / 150) ** 2)
    + 0.05 * np.exp(-((freqs - 540) / 320) ** 2)
    + 0.018 * np.exp(-((freqs - 1600) / 900) ** 2)
)
wind = np.fft.irfft(spectrum * shape, n=N)
wind /= max(1e-9, np.max(np.abs(wind)))
lfo = 0.55 + 0.45 * np.sin(2 * np.pi * 0.045 * t + 1.3)
score += wind * lfo * 0.055

# transition risers / whooshes
def whoosh(at: float, length: float = 1.35, amp: float = 0.10) -> None:
    begin = max(0, int((at - length) * SR))
    end = min(N, int((at + 0.12) * SR))
    n = end - begin
    if n <= 0:
        return
    tt = np.arange(n) / SR
    p = tt / length
    nz = rng.normal(0, 1, n)
    # moving band-pass approximation with ring modulation
    band = np.sin(2 * np.pi * (180 + 1500 * p**1.7) * tt)
    sig = nz * band * (np.sin(np.pi * np.clip(p, 0, 1)) ** 2) * amp
    score[begin:end] += sig

for boundary in (5.2, 11.4, 16.2, 21.0, 25.8, 30.6, 35.4, 40.6):
    whoosh(boundary, 1.25, 0.085)

# very soft tape hiss
hiss = rng.normal(0, 1, N)
hiss = np.convolve(hiss, np.ones(9) / 9, mode="same")
score += hiss * 0.004

# synthetic reverb (exponentially decaying stereo noise) via FFT convolution
ir_len = int(3.2 * SR)
ir_t = np.arange(ir_len) / SR
ir = rng.normal(0, 1, ir_len) * np.exp(-ir_t * 2.4)
ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
ir /= np.sqrt(np.sum(ir**2))

def convolve(sig: np.ndarray) -> np.ndarray:
    size = 1
    while size < len(sig) + len(ir):
        size <<= 1
    a = np.fft.rfft(sig, size)
    b = np.fft.rfft(ir, size)
    return np.fft.irfft(a * b, size)[: len(sig)]

wet = convolve(score)
score = score * 0.82 + wet * 0.18

# stereo: keep bass centered, spread the air with a small Haas delay
delay = int(0.012 * SR)
left = score.copy()
right = np.zeros_like(score)
right[delay:] = score[:-delay] * 0.88
right += score * 0.12
# widen the top end slightly
left = np.convolve(left, [0.94, 0.06], mode="same")
right = np.convolve(right, [0.06, 0.94], mode="same")

# keep the low end mono-compatible for phone speakers
mid = (left + right) * 0.5
side = (left - right) * 0.5
left = mid + side * 0.52
right = mid - side * 0.52

fade_in = np.clip(t / 1.6, 0, 1) ** 1.6
fade_out = np.clip((DUR - t) / 2.8, 0, 1) ** 1.3
left *= fade_in * fade_out
right *= fade_in * fade_out

peak = max(np.max(np.abs(left)), np.max(np.abs(right)))
left = left / peak * 0.72
right = right / peak * 0.72
stereo = np.stack([left, right], axis=1)
pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")

wav_path = OUT / "weather-promo-score-v2.wav"
with wave.open(str(wav_path), "wb") as fh:
    fh.setnchannels(2)
    fh.setsampwidth(2)
    fh.setframerate(SR)
    fh.writeframes(pcm.tobytes())

print(f"wrote {wav_path} ({DUR:.1f}s, peak {peak:.3f})")
