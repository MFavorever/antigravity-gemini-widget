#!/usr/bin/env python3
"""Asset processor for antigravity-gemini-widget.

1. Chroma-keys & edge-despills raw_pet.png into:
   - assets/gemini-pet.png (512px wide RGBA, bottom-flush peeking pose)
   - assets/logo.png (256x256 centered RGBA icon with ~10% margin)
2. Synthesizes 4 zero-copyright 16-bit PCM WAV sound effects under assets/sounds/:
   - squish.wav
   - pop.wav
   - turn_done.wav
   - error.wav
"""

import argparse
import math
import os
import struct
import sys
import wave
from collections import deque
from pathlib import Path
from PIL import Image


def chroma_key_and_crop(raw_path: Path, pet_out: Path, logo_out: Path) -> dict:
    img = Image.open(raw_path).convert("RGBA")
    w, h = img.size
    px = img.load()

    # Sample background corner colors to handle either pure #00FF00 or slight compression variance
    corners = [px[0, 0], px[w - 1, 0], px[0, h // 4], px[w - 1, h // 4]]
    bg_r = sum(c[0] for c in corners) / 4.0
    bg_g = sum(c[1] for c in corners) / 4.0
    bg_b = sum(c[2] for c in corners) / 4.0

    def is_bg_pixel(r: int, g: int, b: int) -> bool:
        # Chroma-green dominant or close to sampled corner color
        if g > 140 and (g - max(r, b)) > 35:
            return True
        dist = abs(r - bg_r) + abs(g - bg_g) + abs(b - bg_b)
        return dist < 75 and g >= max(r, b)

    # Mark both outer connected background AND any enclosed chroma-green hair pockets
    visited = bytearray(w * h)
    bg_mask = bytearray(w * h)
    q = deque()

    def try_push(x: int, y: int):
        if 0 <= x < w and 0 <= y < h:
            idx = y * w + x
            if not visited[idx]:
                visited[idx] = 1
                r, g, b, a = px[x, y]
                if a < 16 or is_bg_pixel(r, g, b):
                    bg_mask[idx] = 1
                    q.append((x, y))

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if x == 0 or x == w - 1 or y == 0 or a < 16 or is_bg_pixel(r, g, b):
                try_push(x, y)

    while q:
        cx, cy = q.popleft()
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                idx = ny * w + nx
                if not visited[idx]:
                    visited[idx] = 1
                    r, g, b, a = px[nx, ny]
                    if a < 16 or is_bg_pixel(r, g, b):
                        bg_mask[idx] = 1
                        q.append((nx, ny))

    # Apply transparency + edge despill against dark-navy outline (#23264a)
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            r, g, b, a = px[x, y]
            if bg_mask[idx]:
                px[x, y] = (0, 0, 0, 0)
                continue

            # Check if adjacent to background for anti-aliased edge cleanup & green despill
            near_bg = False
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < w and 0 <= ny < h and bg_mask[ny * w + nx]:
                    near_bg = True
                    break

            if g > max(r, b) + 6 and (near_bg or g > max(r, b) + 18):
                new_g = min(g, max(r, b))
                excess = g - new_g
                new_a = max(0, min(255, int(a - excess * 1.5))) if near_bg else a
                if new_a < 48:
                    px[x, y] = (0, 0, 0, 0)
                else:
                    px[x, y] = (r, new_g, b, new_a)

    # Find opaque bounding box
    bbox = img.getbbox()
    if not bbox:
        raise RuntimeError("Processed image has no opaque pixels")

    # Keep BOTH right (bbox[2]) and bottom (bbox[3]) completely flush with ZERO right/bottom padding
    left = max(0, bbox[0] - 2)
    top = max(0, bbox[1] - 2)
    right = bbox[2]
    bottom = bbox[3]
    cropped = img.crop((left, top, right, bottom))

    # Resize pet sprite to width=512 keeping aspect ratio, strip faint alpha specks
    cw, ch = cropped.size
    target_w = 512
    target_h = max(1, round(ch * (target_w / cw)))
    pet_img = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)
    pet_px = pet_img.load()
    for py in range(target_h):
        for px_i in range(target_w):
            r, g, b, a = pet_px[px_i, py]
            if a <= 18:
                pet_px[px_i, py] = (0, 0, 0, 0)
            elif g > max(r, b) + 6:
                pet_px[px_i, py] = (r, max(r, b), b, a)
    pet_out.parent.mkdir(parents=True, exist_ok=True)
    pet_img.save(pet_out, format="PNG")

    # Create 256x256 logo with ~10% padding
    logo_size = 256
    inner = int(logo_size * 0.82)
    scale = min(inner / cw, inner / ch)
    lw = max(1, round(cw * scale))
    lh = max(1, round(ch * scale))
    resized_logo = cropped.resize((lw, lh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (logo_size, logo_size), (0, 0, 0, 0))
    canvas.paste(resized_logo, ((logo_size - lw) // 2, (logo_size - lh) // 2), resized_logo)
    c_px = canvas.load()
    for cy in range(logo_size):
        for cx in range(logo_size):
            r, g, b, a = c_px[cx, cy]
            if a <= 18:
                c_px[cx, cy] = (0, 0, 0, 0)
            elif g > max(r, b) + 6:
                c_px[cx, cy] = (r, max(r, b), b, a)
    logo_out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(logo_out, format="PNG")

    return {
        "raw_size": [w, h],
        "pet_size": [target_w, target_h],
        "logo_size": [logo_size, logo_size],
    }


def write_wav(path: Path, samples: list[float], sample_rate: int = 44100):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for s in samples:
            clamped = max(-0.98, min(0.98, s))
            frames.extend(struct.pack("<h", int(clamped * 32767)))
        wf.writeframes(bytes(frames))


def gen_squish_wav(path: Path):
    sr = 44100
    dur = 0.12
    n = int(sr * dur)
    samples = []
    phase = 0.0
    for i in range(n):
        t = i / sr
        u = i / n
        # Bouncy pitch drop then pop up (320 -> 540 Hz)
        freq = 300.0 + 260.0 * math.sin(u * math.pi * 0.85)
        phase += 2.0 * math.pi * freq / sr
        env = math.sin(u * math.pi) ** 0.7 * math.exp(-u * 2.5)
        samples.append(0.38 * env * (math.sin(phase) + 0.25 * math.sin(phase * 2.0)))
    write_wav(path, samples, sr)


def gen_pop_wav(path: Path):
    sr = 44100
    dur = 0.085
    n = int(sr * dur)
    samples = []
    phase = 0.0
    for i in range(n):
        u = i / n
        freq = 520.0 + 480.0 * u
        phase += 2.0 * math.pi * freq / sr
        env = math.sin(u * math.pi) ** 0.5 * math.exp(-u * 4.5)
        samples.append(0.32 * env * math.sin(phase))
    write_wav(path, samples, sr)


def gen_turn_done_wav(path: Path):
    sr = 44100
    dur = 0.30
    n = int(sr * dur)
    # Starry two-note chime: C6 (1046.5 Hz) -> E6 (1318.5 Hz) with soft harmonic
    notes = [(0.0, 0.14, 1046.50), (0.09, 0.28, 1318.51)]
    samples = [0.0] * n
    for start, end, freq in notes:
        s_idx = int(start * sr)
        e_idx = min(n, int(end * sr))
        span = max(1, e_idx - s_idx)
        for idx in range(s_idx, e_idx):
            t = (idx - s_idx) / sr
            u = (idx - s_idx) / span
            attack = min(1.0, t / 0.008)
            decay = math.exp(-u * 4.8)
            val = 0.24 * attack * decay * (
                math.sin(2.0 * math.pi * freq * t)
                + 0.22 * math.sin(2.0 * math.pi * freq * 2.0 * t)
            )
            samples[idx] += val
    write_wav(path, samples, sr)


def gen_error_wav(path: Path):
    sr = 44100
    dur = 0.24
    n = int(sr * dur)
    notes = [(0.0, 0.11, 392.0), (0.10, 0.23, 311.13)]
    samples = [0.0] * n
    for start, end, freq in notes:
        s_idx = int(start * sr)
        e_idx = min(n, int(end * sr))
        span = max(1, e_idx - s_idx)
        for idx in range(s_idx, e_idx):
            t = (idx - s_idx) / sr
            u = (idx - s_idx) / span
            attack = min(1.0, t / 0.008)
            decay = math.exp(-u * 4.2)
            samples[idx] += 0.25 * attack * decay * math.sin(2.0 * math.pi * freq * t)
    write_wav(path, samples, sr)


def synthesize_sounds(sounds_dir: Path):
    gen_squish_wav(sounds_dir / "squish.wav")
    gen_pop_wav(sounds_dir / "pop.wav")
    gen_turn_done_wav(sounds_dir / "turn_done.wav")
    gen_error_wav(sounds_dir / "error.wav")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--project-root",
        default=str(Path(__file__).resolve().parent.parent),
    )
    parser.add_argument("--sounds-only", action="store_true")
    parser.add_argument("--images-only", action="store_true")
    args = parser.parse_args()

    root = Path(args.project_root)
    assets = root / "assets"

    if not args.images_only:
        synthesize_sounds(assets / "sounds")
        print("Synthesized sounds in", assets / "sounds")

    if not args.sounds_only:
        raw = assets / "raw_pet.png"
        if not raw.exists():
            print("raw_pet.png not found at", raw, file=sys.stderr)
            sys.exit(1)
        info = chroma_key_and_crop(raw, assets / "gemini-pet.png", assets / "logo.png")
        print("Processed images:", info)


if __name__ == "__main__":
    main()
