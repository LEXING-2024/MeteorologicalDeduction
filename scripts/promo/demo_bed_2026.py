"""Ambient bed for the 2026 gameplay demo (88 s)."""
from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np

SR = 48_000
DUR = 88.0
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(20261112)
OUT = Path(__file__).resolve().parents[2] / "deliverables" / "weather-demo-bed-2026.wav"


def midi(n: int) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def env(length: float, attack: float = 3.4, release: float = 4.6) -> np.ndarray:
    tt = np.arange(int(length * SR)) / SR
    a = np.clip(tt / attack, 0, 1)
    r = np.clip((length - tt) / release, 0, 1)
    return (np.minimum(a, r) ** 1.3) * (0.72 + 0.28 * np.sin(2 * np.pi * 0.045 * tt + 1.1))


def pad(note: int, start: float, length: float, amp: float) -> np.ndarray:
    begin = max(0, int(start * SR))
    end = min(N, int((start + length) * SR))
    if end <= begin:
        return np.zeros(N)
    tt = np.arange(end - begin) / SR
    f = midi(note)
    sig = (
        np.sin(2 * np.pi * f * tt)
        + 0.18 * np.sin(2 * np.pi * f * 2 * tt + 0.5)
        + 0.07 * np.sin(2 * np.pi * f * 3 * tt + 1.3)
        + 0.025 * np.sin(2 * np.pi * f * 4 * tt + 2.0)
    )
    sig *= env(len(tt) / SR)[: len(tt)] * amp
    out = np.zeros(N)
    out[begin:end] = sig
    return out


score = np.zeros(N)
chords = [
    (38, [50, 53, 57]),
    (34, [46, 50, 53]),
    (29, [41, 45, 48]),
    (36, [43, 48, 52]),
    (31, [43, 46, 50]),
]
for i, (bass, notes) in enumerate(chords):
    start = i * 17.6 - 1.2
    score += pad(bass, start, 21.0, 0.10)
    score += pad(bass + 12, start, 21.0, 0.034)
    for note in notes:
        score += pad(note, start + 0.5, 19.5, 0.028)
    score += pad(notes[-1] + 12, start + 2.0, 17.0, 0.006)

# Air / wind.
noise = rng.normal(0, 1, N)
spec = np.fft.rfft(noise)
freqs = np.fft.rfftfreq(N, 1 / SR)
shape = 0.07 * np.exp(-((freqs - 210) / 240) ** 2) + 0.022 * np.exp(-((freqs - 900) / 700) ** 2)
wind = np.fft.irfft(spec * shape, n=N)
wind /= max(1e-9, np.max(np.abs(wind)))
score += wind * (0.55 + 0.45 * np.sin(2 * np.pi * 0.028 * t + 0.7)) * 0.038

# A distant chime when the level opens and when the result lands.
for when, note, amp in ((14.8, 74, 0.016), (80.8, 81, 0.020)):
    length = 6.0
    tt = np.arange(int(length * SR)) / SR
    f = midi(note)
    sig = (
        np.sin(2 * np.pi * f * tt)
        + 0.3 * np.sin(2 * np.pi * f * 2.01 * tt + 0.8)
        + 0.12 * np.sin(2 * np.pi * f * 3.98 * tt + 1.2)
    ) * np.exp(-tt * 1.1) * amp
    begin = int(when * SR)
    end = min(N, begin + len(sig))
    score[begin:end] += sig[: end - begin]

# Gentle swell under the three-step simulation.
swell_start, swell_end = 69.0, 78.0
mask = (t >= swell_start) & (t <= swell_end)
score[mask] += (
    np.sin(2 * np.pi * 55 * (t[mask] - swell_start))
    * np.sin(np.pi * (t[mask] - swell_start) / (swell_end - swell_start)) ** 2
    * 0.020
)

# Small room.
ir_len = int(2.6 * SR)
ir_t = np.arange(ir_len) / SR
ir = rng.normal(0, 1, ir_len) * np.exp(-ir_t * 2.7)
ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
ir /= np.sqrt(np.sum(ir**2))


def conv(sig: np.ndarray) -> np.ndarray:
    size = 1
    while size < len(sig) + len(ir):
        size <<= 1
    return np.fft.irfft(np.fft.rfft(sig, size) * np.fft.rfft(ir, size), size)[: len(sig)]


score = score * 0.9 + conv(score) * 0.1

delay = int(0.010 * SR)
left = score.copy()
right = np.zeros_like(score)
right[delay:] = score[:-delay] * 0.82
right += score * 0.18
mid = (left + right) / 2
side = (left - right) / 2
left = mid + side * 0.55
right = mid - side * 0.55

fade_in = np.clip(t / 2.4, 0, 1) ** 1.5
fade_out = np.clip((DUR - t) / 3.2, 0, 1) ** 1.3
left *= fade_in * fade_out
right *= fade_in * fade_out
peak = max(np.max(np.abs(left)), np.max(np.abs(right)))
left = left / peak * 0.38
right = right / peak * 0.38
pcm = (np.clip(np.stack([left, right], 1), -1, 1) * 32767).astype("<i2")
with wave.open(str(OUT), "wb") as fh:
    fh.setnchannels(2)
    fh.setsampwidth(2)
    fh.setframerate(SR)
    fh.writeframes(pcm.tobytes())
print("wrote", OUT, OUT.stat().st_size)

