#!/usr/bin/env python3
"""Extract clean single '冰' (bing.wav) and full '冰冰冰' (bing_triple.wav)
from an MP4 video using Windows Media Foundation (mfplat + mfreadwrite).
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import math
import uuid
import wave
from pathlib import Path

import numpy as np


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wt.DWORD),
        ("Data2", wt.WORD),
        ("Data3", wt.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    @classmethod
    def from_str(cls, s: str):
        return cls.from_buffer_copy(uuid.UUID(s).bytes_le)


def vcall(ptr, idx: int, restype, *argtypes):
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    fn = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtbl[idx])
    return lambda *args: fn(ptr, *args)


def decode_mp4_to_mono_pcm(mp4_path: Path, sample_rate: int = 44100) -> np.ndarray:
    ole32 = ctypes.OleDLL("ole32")
    mfplat = ctypes.WinDLL("mfplat")
    mfrw = ctypes.WinDLL("mfreadwrite")

    MFMediaType_Audio = GUID.from_str("73647561-0000-0010-8000-00AA00389B71")
    MFAudioFormat_PCM = GUID.from_str("00000001-0000-0010-8000-00AA00389B71")
    MF_MT_MAJOR_TYPE = GUID.from_str("48eba18e-f8c9-4687-bf11-0a74c9f96a8f")
    MF_MT_SUBTYPE = GUID.from_str("f7e34c9a-42e8-4714-b74b-cb29d72c35e5")
    MF_MT_AUDIO_BITS_PER_SAMPLE = GUID.from_str("f2deb57f-40fa-4764-aa33-ed4f2d1ff669")
    MF_MT_AUDIO_NUM_CHANNELS = GUID.from_str("37e48bf5-645e-4c5b-89de-ada9e29b696a")
    MF_MT_AUDIO_SAMPLES_PER_SECOND = GUID.from_str("5faeeae7-0290-4c31-9e8a-c534f68d9dba")

    ole32.CoInitializeEx(None, 2)
    mfplat.MFStartup(0x00020070, 0)

    reader = ctypes.c_void_p()
    hr = mfrw.MFCreateSourceReaderFromURL(ctypes.c_wchar_p(str(mp4_path)), None, ctypes.byref(reader))
    if hr != 0:
        raise RuntimeError(f"MFCreateSourceReaderFromURL failed: {hr:#x}")

    mt = ctypes.c_void_p()
    if mfplat.MFCreateMediaType(ctypes.byref(mt)) != 0:
        raise RuntimeError("MFCreateMediaType failed")

    set_guid = vcall(mt, 24, ctypes.c_long, ctypes.POINTER(GUID), ctypes.POINTER(GUID))
    set_u32 = vcall(mt, 21, ctypes.c_long, ctypes.POINTER(GUID), wt.UINT)
    set_guid(ctypes.byref(MF_MT_MAJOR_TYPE), ctypes.byref(MFMediaType_Audio))
    set_guid(ctypes.byref(MF_MT_SUBTYPE), ctypes.byref(MFAudioFormat_PCM))
    set_u32(ctypes.byref(MF_MT_AUDIO_BITS_PER_SAMPLE), 16)
    set_u32(ctypes.byref(MF_MT_AUDIO_NUM_CHANNELS), 1)
    set_u32(ctypes.byref(MF_MT_AUDIO_SAMPLES_PER_SECOND), sample_rate)

    FIRST_AUDIO = 0xFFFFFFFD
    ALL_STREAMS = 0xFFFFFFFE
    vcall(reader, 4, ctypes.c_long, wt.DWORD, wt.BOOL)(ALL_STREAMS, False)
    vcall(reader, 4, ctypes.c_long, wt.DWORD, wt.BOOL)(FIRST_AUDIO, True)
    vcall(reader, 7, ctypes.c_long, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.c_void_p)(FIRST_AUDIO, None, mt)

    read_sample = vcall(
        reader,
        9,
        ctypes.c_long,
        wt.DWORD,
        wt.DWORD,
        ctypes.POINTER(wt.DWORD),
        ctypes.POINTER(wt.DWORD),
        ctypes.POINTER(ctypes.c_longlong),
        ctypes.POINTER(ctypes.c_void_p),
    )

    chunks = []
    while True:
        sidx = wt.DWORD()
        flags = wt.DWORD()
        ts = ctypes.c_longlong()
        sample = ctypes.c_void_p()
        hr = read_sample(FIRST_AUDIO, 0, ctypes.byref(sidx), ctypes.byref(flags), ctypes.byref(ts), ctypes.byref(sample))
        if hr != 0:
            raise RuntimeError(f"ReadSample failed: {hr:#x}")
        if flags.value & 2:
            break
        if sample.value:
            buf = ctypes.c_void_p()
            vcall(sample, 41, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(buf))
            data_ptr = ctypes.c_void_p()
            max_len = wt.DWORD()
            cur_len = wt.DWORD()
            vcall(
                buf,
                3,
                ctypes.c_long,
                ctypes.POINTER(ctypes.c_void_p),
                ctypes.POINTER(wt.DWORD),
                ctypes.POINTER(wt.DWORD),
            )(ctypes.byref(data_ptr), ctypes.byref(max_len), ctypes.byref(cur_len))
            if cur_len.value > 0:
                chunks.append(ctypes.string_at(data_ptr.value, cur_len.value))
            vcall(buf, 4, ctypes.c_long)()
            vcall(buf, 2, wt.ULONG)()
            vcall(sample, 2, wt.ULONG)()

    vcall(mt, 2, wt.ULONG)()
    vcall(reader, 2, wt.ULONG)()
    return np.frombuffer(b"".join(chunks), dtype=np.int16).astype(np.float32) / 32768.0


def find_zero_crossing(samples: np.ndarray, idx: int, search_radius: int = 160) -> int:
    lo = max(1, idx - search_radius)
    hi = min(len(samples) - 1, idx + search_radius)
    best_i = idx
    best_abs = abs(float(samples[idx]))
    for i in range(lo, hi):
        if samples[i - 1] <= 0.0 <= samples[i] or samples[i - 1] >= 0.0 >= samples[i]:
            return i
        a = abs(float(samples[i]))
        if a < best_abs:
            best_abs = a
            best_i = i
    return best_i


def normalize_and_fade(clip: np.ndarray, sample_rate: int, fade_in_ms: float, fade_out_ms: float, target_peak: float = 0.80) -> np.ndarray:
    out = clip.astype(np.float32).copy()
    out -= float(np.mean(out))
    peak = float(np.max(np.abs(out)))
    if peak > 1e-5:
        out *= target_peak / peak

    fi = min(len(out) // 4, int(round(sample_rate * fade_in_ms / 1000.0)))
    fo = min(len(out) // 2, int(round(sample_rate * fade_out_ms / 1000.0)))
    if fi > 1:
        t = np.linspace(0.0, math.pi / 2.0, fi, dtype=np.float32)
        out[:fi] *= np.sin(t) ** 2
    if fo > 1:
        t = np.linspace(0.0, math.pi / 2.0, fo, dtype=np.float32)
        out[-fo:] *= np.cos(t) ** 2
    return np.clip(out, -0.98, 0.98)


def save_wav(path: Path, samples: np.ndarray, sample_rate: int = 44100):
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm16 = (samples * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())


def extract_clips(mp4_path: Path, out_dir: Path):
    sr = 44100
    pcm = decode_mp4_to_mono_pcm(mp4_path, sr)

    # Cycle 2 sits cleanly surrounded by pure digital silence: 3.78s .. 4.92s
    win_start = int(3.78 * sr)
    win_end = min(len(pcm), int(4.92 * sr))

    # Locate Beat 1 onset (first sample > 0.015), back up ~2ms to zero crossing
    onset_idx = win_start
    for i in range(win_start, win_end):
        if abs(float(pcm[i])) > 0.015:
            onset_idx = find_zero_crossing(pcm, max(win_start, i - int(0.002 * sr)), 120)
            break

    # Locate Beat 2 onset by scanning 5ms RMS jump after Beat 1 transient settles (~60ms after onset)
    ms5 = int(0.005 * sr)
    search_from = onset_idx + int(0.070 * sr)
    search_to = min(win_end - ms5, onset_idx + int(0.240 * sr))
    beat2_idx = onset_idx + int(0.145 * sr)
    prev_rms = 1.0
    for i in range(search_from, search_to, int(0.001 * sr)):
        cur_rms = float(np.sqrt(np.mean(pcm[i : i + ms5] ** 2)))
        if cur_rms > 0.25 and cur_rms > prev_rms * 1.9:
            beat2_idx = i
            break
        prev_rms = max(0.01, cur_rms)

    # End Beat 1 cleanly ~3ms BEFORE Beat 2 onset so zero second-syllable bleed enters
    beat1_end = find_zero_crossing(pcm, max(onset_idx + int(0.080 * sr), beat2_idx - int(0.003 * sr)), 80)

    # Locate Beat 3 onset (3rd "冰" with the iconic full resonating tail)
    ms2 = int(0.002 * sr)
    b3_from = beat2_idx + int(0.120 * sr)
    b3_to = min(win_end - ms2, beat2_idx + int(0.240 * sr))
    beat3_idx = beat2_idx + int(0.164 * sr)
    for i in range(b3_from, b3_to, int(0.001 * sr)):
        cur_rms = float(np.sqrt(np.mean(pcm[i : i + ms2] ** 2)))
        if cur_rms > 0.40:
            beat3_idx = find_zero_crossing(pcm, max(b3_from, i - int(0.001 * sr)), 80)
            break

    # Locate end of Cycle 2 ("冰冰冰") where amplitude drops below 0.004
    triple_end = win_end
    for i in range(win_end - 1, beat3_idx, -1):
        if abs(float(pcm[i])) > 0.004:
            triple_end = min(win_end, i + int(0.008 * sr))
            break

    short_clip = normalize_and_fade(pcm[onset_idx:beat1_end], sr, fade_in_ms=2.0, fade_out_ms=25.0, target_peak=0.80)
    tail_clip = normalize_and_fade(pcm[beat3_idx:triple_end], sr, fade_in_ms=2.0, fade_out_ms=15.0, target_peak=0.80)
    triple_clip = normalize_and_fade(pcm[onset_idx:triple_end], sr, fade_in_ms=2.0, fade_out_ms=18.0, target_peak=0.80)

    single_path = out_dir / "bing.wav"
    short_path = out_dir / "bing_short.wav"
    triple_path = out_dir / "bing_triple.wav"
    save_wav(single_path, tail_clip, sr)
    save_wav(short_path, short_clip, sr)
    save_wav(triple_path, triple_clip, sr)

    return {
        "onset_sec": round(onset_idx / sr, 4),
        "beat2_onset_sec": round(beat2_idx / sr, 4),
        "beat3_onset_sec": round(beat3_idx / sr, 4),
        "triple_end_sec": round(triple_end / sr, 4),
        "bing_dur_ms": round(len(tail_clip) / sr * 1000.0, 1),
        "bing_bytes": single_path.stat().st_size,
        "short_dur_ms": round(len(short_clip) / sr * 1000.0, 1),
        "triple_dur_ms": round(len(triple_clip) / sr * 1000.0, 1),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        required=True,
        help="Path to source video/audio file",
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parent.parent / "assets" / "sounds"),
    )
    args = parser.parse_args()
    info = extract_clips(Path(args.input), Path(args.out_dir))
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
