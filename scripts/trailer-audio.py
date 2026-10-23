"""Scores a Poké Jam trailer cut: a chiptune track (each cut has its own tempo, key and hook) plus
sound effects on the cue times the trailer exported. Usage: python3 scripts/trailer-audio.py cues.json out.wav  (needs numpy)."""
import json
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
# Per-cut grooves: tempo, chord progression (name, arpeggio), bass roots, hook (16th step, note, length in
# 16ths), drum pattern and the final stab.
STYLES = {
    'main': dict(
        bpm=128, kicks=(0, 4, 8, 12), snares=(4, 12), hats=2, hook_from=2,
        prog=[('Dm', ['D4', 'F4', 'A4', 'D5']), ('Bb', ['D4', 'F4', 'A#4', 'D5']), ('C', ['E4', 'G4', 'C5', 'E5']), ('A', ['E4', 'A4', 'C#5', 'E5'])],
        roots={'Dm': 'D2', 'Bb': 'A#1', 'C': 'C2', 'A': 'A1'},
        hook={
            'Dm': [(0, 'D6', 2), (2, 'D6', 1), (3, 'F6', 3), (6, 'A6', 2), (8, 'G6', 2), (10, 'F6', 2), (12, 'E6', 2), (14, 'F6', 2)],
            'Bb': [(0, 'D6', 3), (3, 'A#5', 3), (6, 'D6', 2), (8, 'F6', 4), (12, 'D6', 2), (14, 'C6', 2)],
            'C': [(0, 'E6', 2), (2, 'E6', 1), (3, 'G6', 3), (6, 'C7', 2), (8, 'A#6', 2), (10, 'G6', 2), (12, 'E6', 4)],
            'A': [(0, 'C#6', 3), (3, 'E6', 3), (6, 'A6', 4), (10, 'G6', 2), (12, 'E6', 2), (14, 'C#6', 2)],
        },
        stab=['D2', 'D3', 'F3', 'A3', 'D4']),
    # Vertical: fast and punchy, trap-style hats, hook from the first bar (short attention spans).
    'vertical': dict(
        bpm=144, kicks=(0, 3, 6, 10), snares=(8,), hats=1, hook_from=0,
        prog=[('Em', ['E4', 'G4', 'B4', 'E5']), ('C', ['E4', 'G4', 'C5', 'E5']), ('G', ['D4', 'G4', 'B4', 'D5']), ('D', ['D4', 'F#4', 'A4', 'D5'])],
        roots={'Em': 'E2', 'C': 'C2', 'G': 'G1', 'D': 'D2'},
        hook={
            'Em': [(0, 'B5', 2), (2, 'B5', 2), (4, 'E6', 2), (6, 'G6', 2), (8, 'F#6', 2), (10, 'E6', 2), (12, 'B5', 4)],
            'C': [(0, 'C6', 2), (2, 'C6', 2), (4, 'E6', 2), (6, 'G6', 2), (8, 'E6', 2), (10, 'C6', 2), (12, 'G5', 4)],
            'G': [(0, 'D6', 2), (2, 'D6', 2), (4, 'G6', 2), (6, 'B6', 2), (8, 'A6', 2), (10, 'G6', 2), (12, 'D6', 4)],
            'D': [(0, 'F#6', 3), (3, 'E6', 3), (6, 'D6', 2), (8, 'A5', 4), (12, 'F#6', 2), (14, 'A6', 2)],
        },
        stab=['E2', 'E3', 'G3', 'B3', 'E4']),
    # Franchise: an uplifting major-key anthem for the season story.
    'franchise': dict(
        bpm=116, kicks=(0, 8, 10), snares=(4, 12), hats=2, hook_from=2,
        prog=[('C', ['C4', 'E4', 'G4', 'C5']), ('G', ['B3', 'D4', 'G4', 'B4']), ('Am', ['A3', 'C4', 'E4', 'A4']), ('F', ['A3', 'C4', 'F4', 'A4'])],
        roots={'C': 'C2', 'G': 'G1', 'Am': 'A1', 'F': 'F1'},
        hook={
            'C': [(0, 'E6', 4), (4, 'G6', 4), (8, 'C7', 6), (14, 'B6', 2)],
            'G': [(0, 'B6', 4), (4, 'A6', 2), (6, 'G6', 2), (8, 'D6', 8)],
            'Am': [(0, 'C7', 4), (4, 'B6', 2), (6, 'A6', 2), (8, 'E6', 6), (14, 'G6', 2)],
            'F': [(0, 'A6', 4), (4, 'G6', 2), (6, 'F6', 2), (8, 'C6', 4), (12, 'D6', 2), (14, 'E6', 2)],
        },
        stab=['C2', 'C3', 'E3', 'G3', 'C4']),
    # Top 5: a funky, syncopated highlight-show groove.
    'top5': dict(
        bpm=132, kicks=(0, 6, 8, 11), snares=(4, 12), hats=2, hook_from=1,
        prog=[('Gm', ['G4', 'A#4', 'D5', 'G5']), ('Eb', ['G4', 'A#4', 'D#5', 'G5']), ('F', ['F4', 'A4', 'C5', 'F5']), ('D', ['F#4', 'A4', 'D5', 'F#5'])],
        roots={'Gm': 'G1', 'Eb': 'D#2', 'F': 'F1', 'D': 'D2'},
        hook={
            'Gm': [(0, 'G5', 1), (2, 'A#5', 1), (3, 'D6', 2), (6, 'G6', 1), (7, 'F6', 1), (8, 'D6', 2), (11, 'A#5', 2), (14, 'A5', 2)],
            'Eb': [(0, 'G5', 1), (2, 'A#5', 1), (3, 'D#6', 2), (6, 'G6', 1), (7, 'F6', 1), (8, 'D#6', 2), (11, 'A#5', 2), (14, 'G5', 2)],
            'F': [(0, 'A5', 1), (2, 'C6', 1), (3, 'F6', 2), (6, 'A6', 1), (7, 'G6', 1), (8, 'F6', 2), (11, 'C6', 2), (14, 'A5', 2)],
            'D': [(0, 'F#5', 2), (2, 'A5', 2), (4, 'D6', 4), (8, 'F#6', 4), (12, 'A6', 4)],
        },
        stab=['G1', 'G2', 'A#2', 'D3', 'G3']),
}
rng = np.random.default_rng(7)


def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def env(dur, attack=0.004, decay=None):
    t = t_axis(dur)
    e = np.minimum(1, t / max(attack, 1e-4))
    if decay:
        e *= np.exp(-t / decay)
    return e


def square(freq, dur, duty=0.5):
    t = t_axis(dur)
    return np.where((t * freq) % 1 < duty, 1.0, -1.0)


def saw(freq, dur):
    t = t_axis(dur)
    return 2 * ((t * freq) % 1) - 1


def sine_sweep(f0, f1, dur, curve=0.08):
    t = t_axis(dur)
    f = f1 + (f0 - f1) * np.exp(-t / curve)
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def noise(dur):
    return rng.uniform(-1, 1, int(dur * SR))


def onepole(x, cutoff):
    """One-pole lowpass."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - onepole(x, cutoff)


def note(name):
    names = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
    n, octave = name[:-1], int(name[-1])
    return 440 * 2 ** ((names[n] + 12 * (octave + 1) - 69) / 12)


# ---------- instruments ----------

KICK = sine_sweep(160, 45, 0.35, 0.05) * env(0.35, 0.001, 0.14)
SNARE = (highpass(noise(0.22), 1200) * env(0.22, 0.001, 0.06) * 0.8 + np.sin(2 * np.pi * 190 * t_axis(0.22)) * env(0.22, 0.001, 0.05) * 0.5)
HAT = highpass(noise(0.05), 6000) * env(0.05, 0.001, 0.012)
OPEN_HAT = highpass(noise(0.25), 5000) * env(0.25, 0.001, 0.08)
CRASH = highpass(noise(1.6), 3500) * env(1.6, 0.002, 0.45)


def bass_note(freq, dur):
    s = square(freq, dur, 0.5) * 0.6 + saw(freq, dur) * 0.4
    return onepole(s, 900) * env(dur, 0.003, dur * 0.7)


def lead_note(freq, dur, duty=0.25):
    return onepole(square(freq, dur, duty), 5000) * env(dur, 0.002, dur * 0.6)


def hook_note(freq, dur):
    t = t_axis(dur)
    vib = 1 + 0.006 * np.sin(2 * np.pi * 6 * t) * np.minimum(1, t / 0.15)
    s = np.where((np.cumsum(freq * vib) / SR) % 1 < 0.5, 1.0, -1.0)
    return onepole(s, 4000) * env(dur, 0.005, dur * 1.2)


# ---------- sound effects ----------

def sfx(name):
    if name == 'whoosh':
        n = noise(0.45)
        sweep = np.linspace(0, 1, len(n))
        return (highpass(n, 800) * np.sin(np.pi * sweep) ** 2) * 0.5
    if name == 'slam':
        return np.concatenate([sine_sweep(120, 38, 0.9, 0.12) * env(0.9, 0.001, 0.35)]) * 1.0 + np.pad(onepole(noise(0.3), 1500) * env(0.3, 0.001, 0.08), (0, int(0.6 * SR))) * 0.8
    if name == 'card':
        return np.concatenate([highpass(noise(0.06), 3000) * env(0.06, 0.001, 0.02) * 0.4, sine_sweep(220, 70, 0.18, 0.04) * env(0.18, 0.001, 0.06) * 0.6])
    if name == 'dunk':
        return sine_sweep(130, 40, 0.8, 0.1) * env(0.8, 0.001, 0.3) * 1.0 + np.pad(square(260, 0.15, 0.5) * env(0.15, 0.001, 0.05) * 0.15, (0, int(0.65 * SR)))
    if name == 'swish':
        return highpass(noise(0.3), 3000) * env(0.3, 0.01, 0.1) * 0.5
    if name == 'rim':
        return (square(330, 0.14) * 0.5 + square(495, 0.14) * 0.3) * env(0.14, 0.001, 0.05) * 0.4
    if name == 'block':
        return sine_sweep(180, 60, 0.3, 0.06) * env(0.3, 0.001, 0.1) * 0.8 + onepole(noise(0.3), 900) * env(0.3, 0.001, 0.06) * 0.6
    if name in ('steal', 'special'):
        notes = [523, 659, 784, 1047] if name == 'special' else [600, 1200]
        return np.concatenate([lead_note(f, 0.07, 0.5) * 0.4 for f in notes])
    if name == 'fire':
        arp = np.concatenate([lead_note(f, 0.08, 0.5) * 0.4 for f in [523, 659, 784, 1047, 1319]])
        return arp + np.pad(onepole(noise(0.9), 700) * env(0.9, 0.05, 0.3), (0, 0))[: len(arp)] * 0.4
    if name == 'evolve':
        # The classic flicker: two tones alternating faster and faster, then a rising sweep.
        parts = []
        dur = 0.16
        for i in range(10):
            parts.append(lead_note(note('E5') if i % 2 else note('A5'), dur, 0.5) * 0.35)
            dur *= 0.85
        parts.append(lead_note(note('A6'), 0.4, 0.5) * 0.35)
        return np.concatenate(parts)
    if name == 'whistle':
        t = t_axis(0.25)
        trill = np.sin(2 * np.pi * (2600 + 80 * np.sin(2 * np.pi * 40 * t)) * t) * env(0.25, 0.01, 0.15)
        return np.concatenate([trill, np.zeros(int(0.05 * SR)), trill]) * 0.25
    if name == 'dribble':
        return sine_sweep(140, 60, 0.08, 0.03) * env(0.08, 0.001, 0.03) * 0.35
    if name in ('bounce', 'catch', 'pass', 'shot'):
        return onepole(noise(0.06), 2000) * env(0.06, 0.001, 0.02) * 0.2
    if name == 'tick':
        click = square(1800, 0.03, 0.5) * env(0.03, 0.001, 0.01) * 0.35
        body = sine_sweep(900, 600, 0.06, 0.02) * env(0.06, 0.001, 0.02) * 0.3
        return body + np.pad(click, (0, len(body) - len(click)))
    if name == 'badge':
        return np.concatenate([lead_note(note('E6'), 0.06, 0.5), lead_note(note('B6'), 0.14, 0.5)]) * 0.35
    if name == 'coin':
        # The classic two-note coin, then a shimmer.
        ding = np.concatenate([lead_note(note('B5'), 0.08, 0.5), lead_note(note('E6'), 0.5, 0.5)]) * 0.45
        shimmer = highpass(noise(0.9), 7000) * env(0.9, 0.05, 0.3) * 0.25
        return ding + np.pad(shimmer, (0, max(0, len(ding) - len(shimmer))))[: len(ding)]
    if name == 'buzzer':
        return (saw(165, 0.9) * 0.5 + saw(220, 0.9) * 0.3) * env(0.9, 0.01, 0.6) * 0.3
    return None


ANNOUNCER = Path(__file__).resolve().parent.parent / 'public' / 'announcer'


def voice_clip(name):
    """An announcer recording (public/announcer/<name>.mp3), decoded to mono floats."""
    if not re.fullmatch(r'[a-z0-9_]+', name):
        return None
    path = ANNOUNCER / f'{name}.mp3'
    if not path.exists():
        return None
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def main():
    data = json.load(open(sys.argv[1]))
    out_path = sys.argv[2]
    dur = data['duration'] + 1.0
    n = int(dur * SR)
    music = np.zeros(n)
    fx = np.zeros(n)
    crowd_env = np.full(n, 0.12)

    def put(buf, at, sig, gain=1.0):
        i = int(at * SR)
        if i >= n or sig is None:
            return
        if i < 0:  # starts before the video: keep only the part that's on screen
            sig = sig[-i:]
            i = 0
        j = min(n, i + len(sig))
        buf[i:j] += sig[: j - i] * gain

    cues = data['cues']
    start = next(c['t'] for c in cues if c['sound'] == 'music_start')
    end = next(c['t'] for c in cues if c['sound'] == 'music_end')

    # Riser into the logo slam.
    riser_len = 1.6
    r = highpass(noise(riser_len), 1500) * np.linspace(0, 1, int(riser_len * SR)) ** 2 * 0.35
    put(music, start - riser_len, r)

    # ---------- the groove ----------
    st = STYLES.get(data.get('style', 'main'), STYLES['main'])
    beat = 60 / st['bpm']
    step16 = beat / 4
    prog, roots, hook = st['prog'], st['roots'], st['hook']
    bar_len = 4 * beat
    bars = int(np.ceil((end - start) / bar_len))
    put(music, start, CRASH, 0.5)
    for b in range(bars):
        t0 = start + b * bar_len
        chord, arp = prog[b % 4]
        if b % 8 == 0 and b:
            put(music, t0, CRASH, 0.4)
        for s16 in range(16):
            t = t0 + s16 * step16
            if t >= end:
                break
            if s16 in st['kicks'] or (b % 2 == 1 and s16 == 14):
                put(music, t, KICK, 0.9)
            if s16 in st['snares']:
                put(music, t, SNARE, 0.55)
            if s16 % st['hats'] == 0:
                put(music, t, OPEN_HAT if s16 == 14 else HAT, 0.25 if st['hats'] == 2 else 0.18)
            if s16 % 2 == 0:
                # Octave-jumping bass, offbeats up an octave.
                f = note(roots[chord]) * (2 if s16 % 4 == 2 else 1)
                put(music, t, bass_note(f, step16 * 2), 0.32)
            put(music, t, lead_note(note(arp[s16 % 4]), step16 * 0.9), 0.07)
        if b >= st['hook_from']:  # the hook comes in after the intro bars
            for s16, nm, length in hook[chord]:
                t = t0 + s16 * step16
                if t < end:
                    put(music, t, hook_note(note(nm), step16 * length), 0.12)

    # Final hit: a stab in the cut's key ringing out under $PJAM.
    stab = sum(saw(note(x), 2.4) for x in st['stab']) / 5
    put(music, end, onepole(stab, 2500) * env(2.4, 0.003, 0.9), 0.5)
    put(music, end, KICK, 1.0)
    put(music, end, CRASH, 0.6)

    # ---------- effects + crowd ----------
    gains = {'dribble': 0.4, 'dunk': 0.9, 'slam': 0.9, 'card': 0.6, 'whoosh': 0.45}
    voice = np.zeros(n)
    for c in cues:
        s = c['sound']
        if s.startswith('ann:'):
            clip = voice_clip(s[4:])
            if clip is not None:
                put(voice, c['t'], clip / (np.max(np.abs(clip)) or 1))
            continue
        if s in ('crowd', 'crowd_big', 'crowd_low'):
            i = int(c['t'] * SR)
            length = {'crowd': 1.8, 'crowd_big': 3.0, 'crowd_low': 2.0}[s]
            peak = {'crowd': 0.55, 'crowd_big': 0.8, 'crowd_low': 0.25}[s]
            e = peak * env(length, 0.12, length * 0.45)
            j = min(n, i + len(e))
            crowd_env[i:j] = np.maximum(crowd_env[i:j], e[: j - i])
            continue
        put(fx, c['t'], sfx(s), gains.get(s, 0.7))

    crowd = onepole(noise(dur), 1400) - onepole(noise(dur), 250) * 0.5
    crowd = crowd / np.max(np.abs(crowd))
    # Slow fade at the very end.
    fade = np.ones(n)
    tail = int(1.2 * SR)
    fade[-tail:] = np.linspace(1, 0, tail)

    # Duck the music and crowd under the announcer so every call reads.
    talking = onepole((np.abs(voice) > 0.01).astype(np.float64), 6)
    duck = 1 - 0.5 * np.clip(talking * 8, 0, 1)
    mix = ((music * 0.85 + crowd * crowd_env * 0.5) * duck + fx * 0.8 + voice * 0.95) * fade
    mix = np.tanh(mix * 1.2)
    mix /= np.max(np.abs(mix)) / 0.89
    pcm = (mix * 32767).astype(np.int16)
    stereo = np.repeat(pcm[:, None], 2, axis=1)
    with wave.open(out_path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(stereo.tobytes())
    print(f'wrote {out_path} ({dur:.1f}s, music {start:.2f}s to {end:.2f}s)')


if __name__ == '__main__':
    main()
