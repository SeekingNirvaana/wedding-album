"""Synthesises the app's UI sounds (santoor plucks, temple bell, tanpura drone, shutter) into public/audio.

Run: python3 scripts/make-sounds.py   (needs numpy and ffmpeg)
Everything is generated from scratch, so there are no licensing questions.
"""
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'audio')
rng = np.random.default_rng(7)

SA = 261.63  # C4 as Sa
RATIO = {'S': 1, 'R': 9 / 8, 'G': 5 / 4, 'm': 4 / 3, 'P': 3 / 2, 'D': 5 / 3, 'N': 15 / 8}


def note(sym, octave=0):
    return SA * RATIO[sym] * (2 ** octave)


def silence(sec):
    return np.zeros(int(SR * sec))


def ks_string(freq, dur, bright=0.996, damp=0.5):
    """Karplus-Strong plucked string."""
    n = int(SR * dur)
    period = int(SR / freq)
    buf = rng.uniform(-1, 1, period)
    out = np.empty(n)
    idx = 0
    for i in range(n):
        out[i] = buf[idx]
        nxt = (idx + 1) % period
        buf[idx] = bright * (damp * buf[idx] + (1 - damp) * buf[nxt])
        idx = nxt
    return out


def santoor(freq, dur=1.6, vel=1.0):
    """Hammered course of 3 slightly detuned strings plus a soft hammer tick."""
    s = sum(ks_string(freq * d, dur, bright=0.9975) for d in (1.0, 1.0025, 0.9978)) / 3
    tick = rng.normal(0, 1, int(SR * 0.006)) * np.linspace(1, 0, int(SR * 0.006)) * 0.25
    s[: len(tick)] += tick
    env = np.minimum(1, np.linspace(0, 40, len(s)))  # 25 ms soft attack
    return s * env * vel


def bell(freq, dur=2.6, vel=1.0):
    """Temple bell: inharmonic partials with different decay rates and a slight beat."""
    t = np.arange(int(SR * dur)) / SR
    partials = [(0.5, 0.35, 1.2), (1.0, 1.0, 1.6), (2.76, 0.55, 2.6), (5.4, 0.3, 4.5), (8.93, 0.16, 7.0)]
    s = np.zeros_like(t)
    for ratio, amp, decay in partials:
        f = freq * ratio
        s += amp * np.exp(-decay * t) * (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * (f * 1.003) * t))
    strike = rng.normal(0, 1, int(SR * 0.01)) * np.linspace(1, 0, int(SR * 0.01)) * 0.15
    s[: len(strike)] += strike
    return s * vel / 1.6


def tanpura(dur=3.2):
    """Soft Pa-Sa-Sa-Sa drone with the buzzing jawari brightness approximated by many harmonics."""
    t = np.arange(int(SR * dur)) / SR
    s = np.zeros_like(t)
    for f0, start in ((note('P', -1), 0.0), (note('S'), 0.55), (note('S'), 1.1), (note('S', -1), 1.65)):
        tt = np.clip(t - start, 0, None)
        env = (1 - np.exp(-tt * 6)) * np.exp(-tt * 0.9) * (t >= start)
        for k in range(1, 12):
            s += env * (0.6 / k ** 1.1) * np.sin(2 * np.pi * f0 * k * t + k)
    return s * 0.18


def reverb(x, sec=1.4, mix=0.28):
    n = int(SR * sec)
    ir = rng.normal(0, 1, n) * np.exp(-np.linspace(0, 7, n))
    ir[0] = 0
    from scipy.signal import fftconvolve
    wet = fftconvolve(x, ir)[: len(x) + n]
    wet = np.pad(wet, (0, len(x) + n - len(wet)))
    dry = np.concatenate([x, np.zeros(n)])
    wet /= np.max(np.abs(wet)) + 1e-9
    return dry * (1 - mix) + wet * mix * np.max(np.abs(x))


def place(track, clip, at):
    i = int(SR * at)
    end = i + len(clip)
    if end > len(track):
        track = np.concatenate([track, np.zeros(end - len(track))])
    track[i:end] += clip
    return track


def fade(x, out=0.4):
    n = int(SR * out)
    x[-n:] *= np.linspace(1, 0, n)
    return x


def save(name, x, peak=0.7):
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    pcm = (x * 32767).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        path = f.name
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    out = os.path.join(OUT, name + '.mp3')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-ac', '1', '-b:a', '96k', out], check=True)
    os.remove(path)
    print(name, f'{os.path.getsize(out) / 1024:.1f} KB')


def main():
    os.makedirs(OUT, exist_ok=True)

    # welcome: tanpura swell, then a rising santoor phrase in Yaman-ish colours, ending on a bell
    w = tanpura(3.6)
    phrase = [('N', -1), ('R', 0), ('G', 0), ('P', 0), ('D', 0), ('S', 1)]
    for k, (sym, octv) in enumerate(phrase):
        w = place(w, santoor(note(sym, octv), 1.8, 0.55 + k * 0.06), 0.35 + k * 0.17)
    w = place(w, bell(note('S', 1), 2.4, 0.45), 1.45)
    save('welcome', fade(reverb(w, 1.6, 0.32), 0.8))

    # found: quick sparkle up the scale, then two bells a fifth apart
    f = silence(0.1)
    for k, (sym, octv) in enumerate([('S', 1), ('G', 1), ('P', 1), ('S', 2), ('G', 2)]):
        f = place(f, santoor(note(sym, octv), 1.2, 0.5 + k * 0.07), 0.02 + k * 0.075)
    f = place(f, bell(note('P', 1), 2.2, 0.5), 0.42)
    f = place(f, bell(note('S', 2), 2.2, 0.4), 0.62)
    save('found', fade(reverb(f, 1.3, 0.3), 0.6))

    # bell: a single soft temple bell
    save('bell', fade(reverb(bell(note('S', 1), 2.4), 1.2, 0.25), 0.5), peak=0.6)

    # tap: one gentle santoor note for buttons
    save('tap', fade(santoor(note('P', 1), 0.45, 0.8), 0.2), peak=0.45)

    # shutter: two filtered clicks like a mechanical leaf shutter
    def click(dur, cutoff):
        n = int(SR * dur)
        x = rng.normal(0, 1, n) * np.exp(-np.linspace(0, 9, n))
        a = np.exp(-2 * np.pi * cutoff / SR)
        y = np.zeros(n)
        for i in range(1, n):
            y[i] = (1 - a) * x[i] + a * y[i - 1]
        return x - y  # high-pass
    sh = silence(0.25)
    sh = place(sh, click(0.03, 1800) * 1.0, 0.0)
    sh = place(sh, click(0.04, 1200) * 0.7, 0.075)
    save('shutter', sh, peak=0.55)

    # whoosh: soft airy swish for sheets opening
    n = int(SR * 0.45)
    x = rng.normal(0, 1, n)
    env = np.sin(np.linspace(0, np.pi, n)) ** 2
    y = np.zeros(n)
    for i in range(1, n):
        a = 0.97 - 0.12 * (i / n)
        y[i] = (1 - a) * x[i] + a * y[i - 1]
    save('whoosh', y * env, peak=0.3)


if __name__ == '__main__':
    main()
