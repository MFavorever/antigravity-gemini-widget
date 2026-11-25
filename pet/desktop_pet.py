#!/usr/bin/env python3
"""Floating bottom-docked Gemini 星语猫姬 desktop pet widget for Antigravity.

Zero third-party pip dependencies (uses Python 3.12 built-in tkinter, ctypes,
winsound, urllib, json + Pillow which is installed on this host).
"""

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import math
import os
import queue
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageTk

if sys.platform == "win32":
    import winsound

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = PLUGIN_ROOT / "assets"
PET_IMAGE_PATH = ASSETS_DIR / "gemini-pet.png"
SOUNDS_DIR = ASSETS_DIR / "sounds"

TRANSPARENT_KEY = "#010203"
MUTEX_NAME = "Global\\AntigravityGeminiWidgetPet_v1"

# Antigravity inner panel border insets (at 96 DPI / 1.0x) so the pet hugs
# the inside of the 1px panel borders instead of overlapping the outer window bezel.
AGY_INNER_INSET_LEFT = 5
AGY_INNER_INSET_TOP = 38
AGY_INNER_INSET_RIGHT = 5
AGY_INNER_INSET_BOTTOM = 9

# Palette inspired by Gemini 星语猫姬
C_BG = "#16182c"
C_CARD = "#1d2038"
C_CARD_INNER = "#262a48"
C_BORDER = "#4a528c"
C_TEXT = "#f2f4ff"
C_MUTED = "#a3aad6"
C_BLUE = "#7289ff"
C_PINK = "#f083b5"
C_GOLD = "#f5cc5a"
C_GREEN = "#5de2a5"
C_RED = "#ff6b8b"


def setup_dpi_awareness():
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def acquire_single_instance_mutex():
    if sys.platform != "win32":
        return None
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    last_err = kernel32.GetLastError()
    # ERROR_ALREADY_EXISTS = 183
    if last_err == 183:
        return False
    return handle


def get_work_area():
    if sys.platform != "win32":
        return (0, 0, 1920, 1040)
    rect = wintypes.RECT()
    # SPI_GETWORKAREA = 0x0030
    ok = ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0)
    if ok:
        return (rect.left, rect.top, rect.right, rect.bottom)
    return (0, 0, 1920, 1040)


def get_window_dpi_scale(hwnd: int) -> float:
    if sys.platform != "win32":
        return 1.0
    try:
        dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
        if dpi > 0:
            return dpi / 96.0
    except Exception:
        pass
    return 1.0


def apply_antigravity_insets(rect: tuple[int, int, int, int], dpi_scale: float = 1.0) -> tuple[int, int, int, int]:
    l, t, r, b = rect
    il = int(round(AGY_INNER_INSET_LEFT * dpi_scale))
    it = int(round(AGY_INNER_INSET_TOP * dpi_scale))
    ir = int(round(AGY_INNER_INSET_RIGHT * dpi_scale))
    ib = int(round(AGY_INNER_INSET_BOTTOM * dpi_scale))
    if (r - l) - (il + ir) >= 300 and (b - t) - (it + ib) >= 200:
        return (l + il, t + it, r - ir, b - ib)
    return rect


def find_antigravity_window_rect(own_hwnds: set[int]):
    """Find the visible Antigravity main window rect (left, top, right, bottom) or None."""
    if sys.platform != "win32":
        return None

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    best = None
    best_area = 0

    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        nonlocal best, best_area
        if hwnd in own_hwnds:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip()
        if not title:
            return True

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == os.getpid():
            return True

        proc_name = ""
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if hproc:
            try:
                pbuf = ctypes.create_unicode_buffer(512)
                psize = wintypes.DWORD(512)
                if kernel32.QueryFullProcessImageNameW(hproc, 0, pbuf, ctypes.byref(psize)):
                    proc_name = os.path.basename(pbuf.value).lower()
            finally:
                kernel32.CloseHandle(hproc)

        is_agy = ("antigravity" in proc_name) or ("antigravity" in title.lower())
        if not is_agy:
            return True

        if user32.IsIconic(hwnd):
            # Antigravity is minimized
            if best is None:
                best = "MINIMIZED"
            return True

        crect = wintypes.RECT()
        pt = wintypes.POINT(0, 0)
        dpi_scale = get_window_dpi_scale(hwnd)
        if user32.GetClientRect(hwnd, ctypes.byref(crect)) and user32.ClientToScreen(hwnd, ctypes.byref(pt)):
            w = crect.right - crect.left
            h = crect.bottom - crect.top
            if w >= 360 and h >= 260:
                area = w * h
                if area > best_area:
                    best_area = area
                    best = apply_antigravity_insets((pt.x, pt.y, pt.x + w, pt.y + h), dpi_scale)
        else:
            rect = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                if w >= 360 and h >= 260:
                    area = w * h
                    if area > best_area:
                        best_area = area
                        best = apply_antigravity_insets((rect.left, rect.top, rect.right, rect.bottom), dpi_scale)
        return True

    user32.EnumWindows(EnumWindowsProc(callback), 0)
    return best


def discover_runtime_port(cli_port: int | None) -> int:
    if cli_port and cli_port > 0:
        return cli_port
    env_port = os.environ.get("GEMINI_WIDGET_PORT")
    if env_port and env_port.isdigit():
        return int(env_port)

    app_data = Path(os.environ.get("ANTIGRAVITY_APP_DATA_DIR") or (Path.home() / ".gemini" / "antigravity"))
    candidates = [
        Path(os.environ.get("GEMINI_WIDGET_DATA_DIR", "")) / "runtime.json" if os.environ.get("GEMINI_WIDGET_DATA_DIR") else None,
        app_data / "plugin_data" / "antigravity-gemini-widget" / "runtime.json",
        app_data / "sidecar_data" / "antigravity-gemini-widget" / "gemini_widget" / "data" / "runtime.json",
        app_data / "sidecar_data" / "antigravity-gemini-widget_gemini_widget" / "data" / "runtime.json",
    ]
    for path in candidates:
        if path and path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                p = int(data.get("port", 0))
                if p > 0:
                    return p
            except Exception:
                pass
    return 18923


def fmt_tokens(n) -> str:
    v = int(n or 0)
    if v >= 1_000_000:
        return f"{v / 1_000_000:.2f}M"
    if v >= 1_000:
        return f"{v / 1_000:.1f}K"
    return str(v)


def fmt_money(usd: float, cny: float, currency: str) -> str:
    if currency == "USD":
        return f"${usd:.4f}" if usd < 0.1 else f"${usd:.2f}"
    return f"¥{cny:.4f}" if cny < 0.1 else f"¥{cny:.2f}"


class GeminiPetApp:
    def __init__(self, port: int, smoke_test: bool = False):
        self.port = port
        self.smoke_test = smoke_test
        self.base_url = f"http://127.0.0.1:{port}"

        self.root = tk.Tk()
        self.root.title("Gemini哈基米账单")
        self.root.overrideredirect(True)
        self.root.wm_attributes("-topmost", True)
        self.root.configure(bg=TRANSPARENT_KEY)
        if sys.platform == "win32":
            self.root.wm_attributes("-transparentcolor", TRANSPARENT_KEY)

        self.base_image = self._load_pet_image()
        self.settings = {
            "scale": 1.0,
            "soundEnabled": True,
            "soundVolume": 0.75,
            "autoBroadcast": True,
            "broadcastDurationSec": 5,
            "dockMode": "antigravity",
            "snapEdge": "bottom-right",
            "snapOffsetX": 0,
            "snapOffsetY": 0,
            "flipped": False,
            "currency": "CNY",
            "usdToCny": 7.25,
        }
        self.summary = None
        self.pet_state = "idle"
        self.current_dialogue = "嗨~今天也要闪闪发光哦！"

        # Animation state
        self.base_width = 132
        self.scale_x = 1.0
        self.scale_y = 1.0
        self.jump_offset_y = 0.0
        self.anim_job = None
        self._hi_res_timer = False
        self._work_sprite_key = None
        self._work_sprite = None
        self._frame_cache = {}
        self._last_canvas_dims = (0, 0)
        self._last_rendered_frame = None
        self.is_pressed = False
        self.dragging = False
        self.drag_start_root = (0, 0)
        self.drag_start_win = (0, 0)
        self.drag_bounds = get_work_area()
        self.hidden_for_minimize = False

        # Animated token counter
        self.displayed_today_tokens = 0
        self.target_today_tokens = 0
        self.counter_job = None

        # Canvas for pet sprite
        self.canvas = tk.Canvas(
            self.root,
            bg=TRANSPARENT_KEY,
            highlightthickness=0,
            bd=0,
            cursor="hand2",
        )
        self.canvas.pack(fill="both", expand=True)
        self.photo_ref = None
        self.sprite_item = None

        # Popups
        self.card_win = None
        self.card_visible = False
        self.card_vars = {}
        self.card_bars = {}
        self._outside_watch_job = None
        self._outside_prev_down = False
        self._card_opened_at = 0.0
        self._menu_open = False

        self.bubble_win = None
        self.bubble_visible = False
        self.bubble_hide_job = None

        # Bindings
        self.canvas.bind("<ButtonPress-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Button-3>", self._on_right_click)

        # Event queue from SSE / HTTP threads
        self.evt_queue: queue.Queue = queue.Queue()
        self.stop_event = threading.Event()

        # Context menu
        self.menu = tk.Menu(self.root, tearoff=0, bg=C_CARD, fg=C_TEXT, activebackground=C_BLUE, activeforeground="#ffffff")
        self._build_menu()

        self._render_pet_sprite(sync_geometry=True)
        self._apply_dock_position()

        if not self.smoke_test:
            self._ensure_billing_card()
            self._start_background_threads()
            self.root.after(80, self._process_queue)
            self.root.after(200, self._prewarm_frames)
            self.root.after(350, self._dock_tick)
            self.root.after(150, self._idle_breath_tick)

    def _load_pet_image(self) -> Image.Image:
        if PET_IMAGE_PATH.exists():
            return Image.open(PET_IMAGE_PATH).convert("RGBA")
        # Fallback placeholder badge if asset missing
        img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((16, 16, 240, 240), fill=(114, 137, 255, 255), outline=(31, 36, 69, 255), width=8)
        return img

    def _build_menu(self):
        self.menu.delete(0, "end")
        scale_menu = tk.Menu(self.menu, tearoff=0, bg=C_CARD, fg=C_TEXT, activebackground=C_BLUE)
        for s in (0.7, 0.85, 1.0, 1.25, 1.5, 2.0):
            scale_menu.add_command(
                label=f"{s:.2g}x",
                command=lambda val=s: self._update_remote_settings({"scale": val}),
            )
        self.menu.add_cascade(label="调整大小", menu=scale_menu)
        self.menu.add_command(
            label="切换币种 (¥ / $)",
            command=lambda: self._update_remote_settings({
                "currency": "USD" if self.settings.get("currency") == "CNY" else "CNY"
            }),
        )
        self.menu.add_command(
            label="音效开关",
            command=lambda: self._update_remote_settings({
                "soundEnabled": not bool(self.settings.get("soundEnabled", True))
            }),
        )
        self.menu.add_command(
            label="自动播报开关",
            command=lambda: self._update_remote_settings({
                "autoBroadcast": not bool(self.settings.get("autoBroadcast", True))
            }),
        )
        self.menu.add_command(
            label="切换跟随/自由模式",
            command=lambda: self._update_remote_settings({
                "dockMode": "free" if self.settings.get("dockMode") == "antigravity" else "antigravity"
            }),
        )
        self.menu.add_separator()
        self.menu.add_command(label="回到右下角", command=self._reset_to_bottom_right)
        self.menu.add_command(label="立即刷新数据", command=self._trigger_refresh)
        self.menu.add_separator()
        self.menu.add_command(label="退出猫姬挂件", command=self.quit)

    def _play_sound(self, name: str):
        if self.smoke_test or not self.settings.get("soundEnabled", True):
            return
        if sys.platform != "win32":
            return
        wav_path = SOUNDS_DIR / f"{name}.wav"
        if not wav_path.exists():
            return
        try:
            winsound.PlaySound(
                str(wav_path),
                winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
            )
        except Exception:
            pass

    def _get_pet_canvas_size(self):
        scale = float(self.settings.get("scale", 1.0))
        w = max(72, int(round(self.base_width * scale)))
        aspect = self.base_image.height / max(1, self.base_image.width)
        h = max(72, int(round(w * aspect)))
        # Generous inward & top headroom for 60fps jelly stretch/jump while keeping border edge flush
        pad_inward = max(24, int(round(w * 0.22)))
        pad_top = max(24, int(round(h * 0.18)))
        return w, h, w + pad_inward, h + pad_top

    def _ensure_work_sprite(self, w: int, h: int, flipped: bool):
        key = (w, h, flipped)
        if self._work_sprite_key == key and self._work_sprite is not None:
            return self._work_sprite
        img = self.base_image
        if flipped:
            img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        self._work_sprite = img.resize((w, h), Image.Resampling.LANCZOS)
        self._work_sprite_key = key
        self._frame_cache.clear()
        self._last_rendered_frame = None
        return self._work_sprite

    def _get_frame_photo(self, w: int, h: int, flipped: bool, dw: int, dh: int) -> ImageTk.PhotoImage:
        key = (w, h, flipped, dw, dh)
        cached = self._frame_cache.get(key)
        if cached is not None:
            return cached

        work = self._ensure_work_sprite(w, h, flipped)
        if dw == w and dh == h:
            resized = work
        else:
            resized = work.resize((dw, dh), Image.Resampling.BILINEAR)

        # Clean alpha binary threshold for crisp chroma-key transparency in tkinter
        r, g, b, a = resized.split()
        a_bin = a.point(lambda v: 255 if v >= 120 else 0)
        bg_canvas = Image.new("RGBA", (dw, dh), (1, 2, 3, 255))
        masked = Image.composite(resized, bg_canvas, a_bin)

        photo = ImageTk.PhotoImage(masked)
        if len(self._frame_cache) >= 256:
            # Keep rest frame and drop oldest entries
            first_key = next(iter(self._frame_cache))
            if first_key != (w, h, flipped, w, h):
                self._frame_cache.pop(first_key, None)
        self._frame_cache[key] = photo
        return photo

    def _prewarm_frames(self):
        if self.stop_event.is_set():
            return
        w, h, _, _ = self._get_pet_canvas_size()
        flipped = bool(self.settings.get("flipped", False))
        # Pre-warm key press and spring overshoot sizes without blocking startup
        samples = [1.0, 0.78, 0.84, 0.90, 0.96, 1.04, 1.08, 1.12]
        for idx, sy in enumerate(samples):
            sx = max(0.88, min(1.18, 1.0 / math.sqrt(sy)))
            dw = max(24, int(round(w * sx)))
            dh = max(24, int(round(h * sy)))
            self.root.after(idx * 12, lambda d_w=dw, d_h=dh, f=flipped, bw=w, bh=h: self._get_frame_photo(bw, bh, f, d_w, d_h))

    def _render_pet_sprite(self, sync_geometry: bool = False):
        w, h, cw, ch = self._get_pet_canvas_size()
        dw = max(24, int(round(w * self.scale_x)))
        dh = max(24, int(round(h * self.scale_y)))
        flipped = bool(self.settings.get("flipped", False))
        jump_px = int(round(self.jump_offset_y))
        frame_sig = (w, h, flipped, dw, dh, jump_px)

        if not sync_geometry and self._last_canvas_dims == (cw, ch) and self._last_rendered_frame == frame_sig:
            return

        self.photo_ref = self._get_frame_photo(w, h, flipped, dw, dh)
        cx = 0 if flipped else cw
        cy = ch - jump_px
        anchor_mode = "sw" if flipped else "se"

        if sync_geometry or self._last_canvas_dims != (cw, ch):
            self.canvas.config(width=cw, height=ch)
            self._last_canvas_dims = (cw, ch)
            cur_x = self.root.winfo_x()
            cur_y = self.root.winfo_y()
            self.root.geometry(f"{cw}x{ch}+{cur_x}+{cur_y}")

        if self.sprite_item is None:
            self.sprite_item = self.canvas.create_image(cx, cy, image=self.photo_ref, anchor=anchor_mode)
        else:
            self.canvas.coords(self.sprite_item, cx, cy)
            self.canvas.itemconfig(self.sprite_item, image=self.photo_ref, anchor=anchor_mode)
        self._last_rendered_frame = frame_sig

    def _get_target_bounds(self):
        dock_mode = self.settings.get("dockMode", "antigravity")
        if dock_mode == "antigravity" and not self.smoke_test:
            own = {self.root.winfo_id()}
            if self.card_win:
                own.add(self.card_win.winfo_id())
            if self.bubble_win:
                own.add(self.bubble_win.winfo_id())
            res = find_antigravity_window_rect(own)
            if res == "MINIMIZED":
                return ("MINIMIZED", get_work_area())
            if isinstance(res, tuple):
                return ("WINDOW", res)
        return ("SCREEN", get_work_area())

    @staticmethod
    def _clamp_to_rect(x: int, y: int, w: int, h: int, rect: tuple[int, int, int, int]) -> tuple[int, int]:
        left, top, right, bottom = rect
        max_x = max(left, right - w)
        max_y = max(top, bottom - h)
        return (
            int(max(left, min(max_x, x))),
            int(max(top, min(max_y, y))),
        )

    def _apply_dock_position(self):
        if self.dragging:
            return
        kind, rect = self._get_target_bounds()
        if kind == "MINIMIZED":
            if not self.hidden_for_minimize:
                self.hidden_for_minimize = True
                self.root.withdraw()
                if self.card_win and self.card_visible:
                    self.card_win.withdraw()
                if self.bubble_win and self.bubble_visible:
                    self.bubble_win.withdraw()
            return
        elif self.hidden_for_minimize:
            self.hidden_for_minimize = False
            self.root.deiconify()

        _, _, cw, ch = self._get_pet_canvas_size()
        left, top, right, bottom = rect
        edge = self.settings.get("snapEdge", "bottom-right")
        ox = int(self.settings.get("snapOffsetX", 0))
        oy = int(self.settings.get("snapOffsetY", 0))

        if "left" in edge:
            x = left + ox
        else:
            x = right - cw - ox

        if "top" in edge:
            y = top + oy
        else:
            y = bottom - ch - oy

        # Clamp strictly inside target bounds (Antigravity interior when docked, or screen work area)
        x, y = self._clamp_to_rect(x, y, cw, ch, rect)
        if kind == "WINDOW":
            wa = get_work_area()
            # Also ensure visible on screen if Antigravity extends beyond monitor edge
            if wa[2] - wa[0] >= cw and wa[3] - wa[1] >= ch:
                x, y = self._clamp_to_rect(x, y, cw, ch, (max(left, wa[0]), max(top, wa[1]), min(right, wa[2]), min(bottom, wa[3])))

        if abs(self.root.winfo_x() - x) > 1 or abs(self.root.winfo_y() - y) > 1:
            self.root.geometry(f"{cw}x{ch}+{x}+{y}")
            self._reposition_popups()

    def _dock_tick(self):
        if not self.stop_event.is_set():
            self._apply_dock_position()
            self.root.after(350, self._dock_tick)

    def _idle_breath_tick(self):
        if not self.stop_event.is_set():
            next_ms = 120
            if not self.is_pressed and not self.dragging and self.anim_job is None:
                if self.pet_state == "working":
                    t = time.perf_counter() * 4.5
                    self.scale_y = 1.0 + 0.025 * math.sin(t)
                    self.scale_x = 1.0 / math.sqrt(self.scale_y)
                    self._render_pet_sprite()
                    next_ms = 8
                elif self.scale_x != 1.0 or self.scale_y != 1.0 or self.jump_offset_y != 0.0:
                    self.scale_x = 1.0
                    self.scale_y = 1.0
                    self.jump_offset_y = 0.0
                    self._render_pet_sprite()
            self.root.after(next_ms, self._idle_breath_tick)

    def _set_hi_res_timer(self, enabled: bool):
        if sys.platform != "win32" or self.smoke_test:
            return
        if enabled and not self._hi_res_timer:
            try:
                ctypes.windll.winmm.timeBeginPeriod(1)
                self._hi_res_timer = True
            except Exception:
                pass
        elif not enabled and self._hi_res_timer:
            try:
                ctypes.windll.winmm.timeEndPeriod(1)
            except Exception:
                pass
            self._hi_res_timer = False

    def _cancel_anim(self):
        if self.anim_job is not None:
            self.root.after_cancel(self.anim_job)
            self.anim_job = None
        self._set_hi_res_timer(False)

    def _start_press_squish(self):
        self._cancel_anim()
        self._set_hi_res_timer(True)
        start_t = time.perf_counter()
        start_y = self.scale_y
        target_y = 0.78
        duration = 0.075

        def step():
            if not self.is_pressed:
                self.anim_job = None
                self._set_hi_res_timer(False)
                return
            t = time.perf_counter() - start_t
            u = min(1.0, t / duration)
            # Smooth ease-out cubic
            ease = 1.0 - (1.0 - u) ** 3
            self.scale_y = start_y + (target_y - start_y) * ease
            self.scale_x = max(0.88, min(1.18, 1.0 / math.sqrt(self.scale_y)))
            self.jump_offset_y = 0.0
            self._render_pet_sprite()
            if u < 1.0:
                self.anim_job = self.root.after(1, step)
            else:
                self.anim_job = None
                self._set_hi_res_timer(False)

        step()

    def _start_rebound(self, jump=False):
        self._cancel_anim()
        self._set_hi_res_timer(True)
        start_t = time.perf_counter()
        # Guarantee a full bouncy amplitude even on ultra-fast taps
        amp = self.scale_y - 1.0
        if abs(amp) < 0.18:
            amp = -0.20
        damping = 7.2
        omega = 23.0
        duration = 0.50 if jump else 0.42

        def step():
            t = time.perf_counter() - start_t
            if t >= duration:
                self.scale_x = 1.0
                self.scale_y = 1.0
                self.jump_offset_y = 0.0
                self._render_pet_sprite()
                self.anim_job = None
                self._set_hi_res_timer(False)
                return

            dy = amp * math.exp(-damping * t) * math.cos(omega * t)
            self.scale_y = max(0.72, min(1.16, 1.0 + dy))
            self.scale_x = max(0.88, min(1.18, 1.0 / math.sqrt(self.scale_y)))
            if jump and t < 0.26:
                u = t / 0.26
                self.jump_offset_y = 14.0 * math.sin(u * math.pi)
            else:
                self.jump_offset_y = 0.0
            self._render_pet_sprite()
            self.anim_job = self.root.after(1, step)

        step()

    def _on_press(self, event):
        self.is_pressed = True
        self.dragging = False
        self.drag_start_root = (event.x_root, event.y_root)
        self.drag_start_win = (self.root.winfo_x(), self.root.winfo_y())
        kind, rect = self._get_target_bounds()
        self.drag_bounds = rect if kind in ("WINDOW", "SCREEN") else get_work_area()
        self._play_sound("bing")
        self._start_press_squish()

    def _on_drag(self, event):
        if not self.is_pressed:
            return
        dx = event.x_root - self.drag_start_root[0]
        dy = event.y_root - self.drag_start_root[1]
        if not self.dragging and (abs(dx) >= 6 or abs(dy) >= 6):
            self.dragging = True
        if self.dragging:
            _, _, cw, ch = self._get_pet_canvas_size()
            raw_x = self.drag_start_win[0] + dx
            raw_y = self.drag_start_win[1] + dy
            nx, ny = self._clamp_to_rect(raw_x, raw_y, cw, ch, self.drag_bounds)
            self.root.geometry(f"{cw}x{ch}+{nx}+{ny}")
            self._reposition_popups()

    def _on_release(self, event):
        if not self.is_pressed:
            return
        self.is_pressed = False
        was_dragging = self.dragging
        self.dragging = False
        # Always rebound immediately on release (prevents stuck-squished bug!)
        self._start_rebound(jump=False)

        if not was_dragging:
            if self._point_in_widget(self.root, event.x_root, event.y_root):
                self._toggle_billing_card()
            return

        # Snap to nearest quarter/corner strictly inside target bounds and auto-flip on left side
        kind, rect = self._get_target_bounds()
        left, top, right, bottom = rect
        _, _, cw, ch = self._get_pet_canvas_size()
        wx, wy = self._clamp_to_rect(self.root.winfo_x(), self.root.winfo_y(), cw, ch, rect)
        cx = wx + cw / 2
        cy = wy + ch / 2
        mid_x = (left + right) / 2
        mid_y = (top + bottom) / 2

        is_left = cx < mid_x
        is_top = cy < mid_y
        edge = f"{'top' if is_top else 'bottom'}-{'left' if is_left else 'right'}"
        max_ox = max(0, (right - left) - cw)
        max_oy = max(0, (bottom - top) - ch)
        ox = max(0, min(max_ox, (wx - left) if is_left else (right - cw - wx)))
        oy = max(0, min(max_oy, (wy - top) if is_top else (bottom - ch - wy)))
        # Magnetic flush snap when released close to the window edge
        if ox <= 40:
            ox = 0
        if oy <= 40:
            oy = 0

        self.settings["snapEdge"] = edge
        self.settings["snapOffsetX"] = int(ox)
        self.settings["snapOffsetY"] = int(oy)
        self.settings["flipped"] = bool(is_left)
        self._render_pet_sprite()
        self._apply_dock_position()
        self._update_remote_settings({
            "snapEdge": edge,
            "snapOffsetX": int(ox),
            "snapOffsetY": int(oy),
            "flipped": bool(is_left),
        })

    def _on_right_click(self, event):
        self.is_pressed = False
        self.dragging = False
        self._menu_open = True
        try:
            self.menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.menu.grab_release()
            self._menu_open = False
            self._card_opened_at = time.perf_counter()
            self._outside_prev_down = True

    def _reset_to_bottom_right(self):
        self.settings.update({
            "snapEdge": "bottom-right",
            "snapOffsetX": 0,
            "snapOffsetY": 0,
            "flipped": False,
        })
        self._render_pet_sprite()
        self._apply_dock_position()
        self._update_remote_settings({
            "snapEdge": "bottom-right",
            "snapOffsetX": 0,
            "snapOffsetY": 0,
            "flipped": False,
        })

    # ---------------- Popups (Broadcast Bubble & Full Billing Card) ----------------

    def _position_popup_above_pet(self, win: tk.Toplevel, pw: int, ph: int):
        kind, rect = self._get_target_bounds()
        wa_l, wa_t, wa_r, wa_b = get_work_area()
        if kind == "WINDOW" and (rect[2] - rect[0] >= pw + 16) and (rect[3] - rect[1] >= ph + 16):
            b_l = max(wa_l, rect[0]) + 8
            b_t = max(wa_t, rect[1]) + 8
            b_r = min(wa_r, rect[2]) - 8
            b_b = min(wa_b, rect[3]) - 8
        else:
            b_l, b_t, b_r, b_b = wa_l + 8, wa_t + 8, wa_r - 8, wa_b - 8

        pet_x = self.root.winfo_x()
        pet_y = self.root.winfo_y()
        _, _, cw, ch = self._get_pet_canvas_size()
        is_top = "top" in self.settings.get("snapEdge", "bottom-right")

        x = pet_x + (cw // 2) - (pw // 2)
        if self.settings.get("flipped", False):
            x = max(pet_x, x)
        else:
            x = min(pet_x + cw - pw + 8, x)
        x = max(b_l, min(max(b_l, b_r - pw), x))

        if is_top:
            y = pet_y + ch + 6
        else:
            y = pet_y - ph - 6
        y = max(b_t, min(max(b_t, b_b - ph), y))
        win.geometry(f"{pw}x{ph}+{int(x)}+{int(y)}")

    def _get_popup_size(self, win: tk.Toplevel, min_w: int, min_h: int) -> tuple[int, int]:
        win.update_idletasks()
        pw = max(min_w, win.winfo_reqwidth())
        ph = max(min_h, win.winfo_reqheight())
        return pw, ph

    def _reposition_popups(self):
        if self.card_win and self.card_visible:
            pw, ph = self._get_popup_size(self.card_win, 360, 380)
            self._position_popup_above_pet(self.card_win, pw, ph)
        if self.bubble_win and self.bubble_visible:
            pw, ph = self._get_popup_size(self.bubble_win, 280, 72)
            self._position_popup_above_pet(self.bubble_win, pw, ph)

    def _ensure_bubble_win(self):
        if self.bubble_win is not None:
            return
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.wm_attributes("-topmost", True)
        win.configure(bg=C_BORDER)
        win.bind("<Escape>", lambda _e: self._hide_billing_card())

        frame = tk.Frame(win, bg=C_CARD, padx=10, pady=8, cursor="hand2")
        frame.pack(fill="both", expand=True, padx=1, pady=1)

        self.bubble_title_var = tk.StringVar(value="✦ 星语猫姬播报")
        self.bubble_body_var = tk.StringVar(value="嗨~今天也要闪闪发光哦！")

        lbl_title = tk.Label(
            frame,
            textvariable=self.bubble_title_var,
            fg=C_GOLD,
            bg=C_CARD,
            font=("Microsoft YaHei UI", 8, "bold"),
            anchor="w",
        )
        lbl_title.pack(fill="x")

        lbl_body = tk.Label(
            frame,
            textvariable=self.bubble_body_var,
            fg=C_TEXT,
            bg=C_CARD,
            font=("Microsoft YaHei UI", 9),
            anchor="w",
            justify="left",
            wraplength=248,
        )
        lbl_body.pack(fill="x", pady=(2, 0))

        for w in (frame, lbl_title, lbl_body):
            w.bind("<Button-1>", lambda _e: self._on_bubble_click())

        self.bubble_win = win
        win.withdraw()

    def _on_bubble_click(self):
        self._hide_bubble()
        self._show_billing_card()

    def show_bubble(self, title: str, text: str, duration_sec: int = 5):
        self._ensure_bubble_win()
        if self.card_visible:
            return
        self.bubble_title_var.set(title)
        self.bubble_body_var.set(text)
        pw, ph = self._get_popup_size(self.bubble_win, 280, 72)
        self._position_popup_above_pet(self.bubble_win, pw, ph)
        self.bubble_win.deiconify()
        self.bubble_win.lift()
        self.bubble_visible = True
        if self.bubble_hide_job is not None:
            self.root.after_cancel(self.bubble_hide_job)
        if duration_sec > 0:
            self.bubble_hide_job = self.root.after(duration_sec * 1000, self._hide_bubble)

    def _hide_bubble(self):
        self.bubble_visible = False
        if self.bubble_hide_job is not None:
            self.root.after_cancel(self.bubble_hide_job)
            self.bubble_hide_job = None
        if self.bubble_win:
            self.bubble_win.withdraw()

    def _ensure_billing_card(self):
        if self.card_win is not None:
            return
        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.wm_attributes("-topmost", True)
        win.configure(bg=C_BORDER)
        win.bind("<Escape>", lambda _e: self._hide_billing_card())

        outer = tk.Frame(win, bg=C_BG, padx=12, pady=10)
        outer.pack(fill="both", expand=True, padx=1, pady=1)

        # Header
        hdr = tk.Frame(outer, bg=C_BG)
        hdr.pack(fill="x")
        tk.Label(
            hdr,
            text="✦ Gemini哈基米账单",
            fg=C_GOLD,
            bg=C_BG,
            font=("Microsoft YaHei UI", 10, "bold"),
        ).pack(side="left")

        btn_close = tk.Label(hdr, text=" ✕ ", fg=C_MUTED, bg=C_BG, font=("Microsoft YaHei UI", 9, "bold"), cursor="hand2")
        btn_close.pack(side="right")
        btn_close.bind("<Button-1>", lambda _e: self._hide_billing_card())

        btn_refresh = tk.Label(hdr, text=" ↻ ", fg=C_BLUE, bg=C_BG, font=("Microsoft YaHei UI", 10, "bold"), cursor="hand2")
        btn_refresh.pack(side="right")
        btn_refresh.bind("<Button-1>", lambda _e: self._trigger_refresh())

        # Today stats card
        today_box = tk.Frame(outer, bg=C_CARD, padx=10, pady=8)
        today_box.pack(fill="x", pady=(8, 6))

        top_row = tk.Frame(today_box, bg=C_CARD)
        top_row.pack(fill="x")

        left_col = tk.Frame(top_row, bg=C_CARD)
        left_col.pack(side="left", fill="x", expand=True)
        tk.Label(left_col, text="今日已用 Token", fg=C_MUTED, bg=C_CARD, font=("Microsoft YaHei UI", 8)).pack(anchor="w")
        self.card_vars["today_tokens"] = tk.StringVar(value="0")
        tk.Label(left_col, textvariable=self.card_vars["today_tokens"], fg=C_TEXT, bg=C_CARD, font=("Consolas", 15, "bold")).pack(anchor="w")

        right_col = tk.Frame(top_row, bg=C_CARD)
        right_col.pack(side="right")
        tk.Label(right_col, text="今日等效费用", fg=C_MUTED, bg=C_CARD, font=("Microsoft YaHei UI", 8)).pack(anchor="e")
        self.card_vars["today_cost"] = tk.StringVar(value="¥0.00")
        tk.Label(right_col, textvariable=self.card_vars["today_cost"], fg=C_PINK, bg=C_CARD, font=("Consolas", 14, "bold")).pack(anchor="e")

        self.card_vars["today_sub1"] = tk.StringVar(value="输入 0 · 缓存 0 · 输出 0")
        tk.Label(
            today_box,
            textvariable=self.card_vars["today_sub1"],
            fg=C_MUTED,
            bg=C_CARD,
            font=("Microsoft YaHei UI", 8),
            anchor="w",
            justify="left",
            wraplength=330,
        ).pack(fill="x", pady=(4, 0))

        self.card_vars["today_sub2"] = tk.StringVar(value="缓存命中 0% · 节省 ¥0.00")
        tk.Label(
            today_box,
            textvariable=self.card_vars["today_sub2"],
            fg=C_GREEN,
            bg=C_CARD,
            font=("Microsoft YaHei UI", 8),
            anchor="w",
            justify="left",
            wraplength=330,
        ).pack(fill="x", pady=(1, 0))

        # Quota card (Gemini + ChatGPT/Claude 5h & Weekly)
        quota_box = tk.Frame(outer, bg=C_CARD, padx=10, pady=8)
        quota_box.pack(fill="x", pady=(0, 6))

        q_hdr = tk.Frame(quota_box, bg=C_CARD)
        q_hdr.pack(fill="x")
        tk.Label(q_hdr, text="剩余额度 (5小时 / 周)", fg=C_TEXT, bg=C_CARD, font=("Microsoft YaHei UI", 9, "bold")).pack(side="left")
        self.card_vars["quota_source"] = tk.StringVar(value="本地估算")
        tk.Label(q_hdr, textvariable=self.card_vars["quota_source"], fg=C_BLUE, bg=C_CARD, font=("Microsoft YaHei UI", 8)).pack(side="right")

        for pool_key, title, color in (
            ("gemini", "Gemini 模型", C_BLUE),
            ("claude_chatgpt", "ChatGPT / Claude", C_PINK),
        ):
            self._add_quota_pool_rows(quota_box, pool_key, title, color)

        # Latest turn card
        turn_box = tk.Frame(outer, bg=C_CARD, padx=10, pady=6)
        turn_box.pack(fill="x", pady=(0, 6))
        self.card_vars["latest_turn"] = tk.StringVar(value="最近一轮：暂无记录")
        tk.Label(
            turn_box,
            textvariable=self.card_vars["latest_turn"],
            fg=C_MUTED,
            bg=C_CARD,
            font=("Microsoft YaHei UI", 8),
            anchor="w",
            justify="left",
            wraplength=330,
        ).pack(fill="x")

        # Interactive dialogue pill (click to cycle shuffle bag)
        dlg_box = tk.Frame(outer, bg=C_CARD_INNER, padx=9, pady=6, cursor="hand2")
        dlg_box.pack(fill="x", pady=(0, 6))
        self.card_vars["dialogue"] = tk.StringVar(value=f"💬 {self.current_dialogue}")
        dlg_lbl = tk.Label(
            dlg_box,
            textvariable=self.card_vars["dialogue"],
            fg=C_TEXT,
            bg=C_CARD_INNER,
            font=("Microsoft YaHei UI", 8),
            anchor="w",
            justify="left",
            wraplength=330,
            cursor="hand2",
        )
        dlg_lbl.pack(fill="x")
        for w in (dlg_box, dlg_lbl):
            w.bind("<Button-1>", lambda _e: self._cycle_dialogue())

        # Footer action strip
        foot = tk.Frame(outer, bg=C_BG)
        foot.pack(fill="x")

        self.card_vars["btn_currency"] = tk.StringVar(value="币种: ¥")
        self.card_vars["btn_sound"] = tk.StringVar(value="🔊 音效开")

        for var, cmd in (
            (self.card_vars["btn_currency"], lambda: self._update_remote_settings({"currency": "USD" if self.settings.get("currency") == "CNY" else "CNY"})),
            (self.card_vars["btn_sound"], lambda: self._update_remote_settings({"soundEnabled": not bool(self.settings.get("soundEnabled", True))})),
        ):
            b = tk.Label(foot, textvariable=var, fg=C_MUTED, bg=C_CARD, padx=7, pady=3, font=("Microsoft YaHei UI", 8), cursor="hand2")
            b.pack(side="left", padx=(0, 6))
            b.bind("<Button-1>", lambda _e, fn=cmd: fn())

        b_menu = tk.Label(foot, text="☰ 更多设置", fg=C_GOLD, bg=C_CARD, padx=8, pady=3, font=("Microsoft YaHei UI", 8), cursor="hand2")
        b_menu.pack(side="right")
        b_menu.bind("<Button-1>", self._on_right_click)

        self.card_win = win
        win.withdraw()

    def _add_quota_pool_rows(self, parent, pool_key: str, title: str, accent_color: str):
        block = tk.Frame(parent, bg=C_CARD)
        block.pack(fill="x", pady=(6, 2))
        tk.Label(block, text=title, fg=accent_color, bg=C_CARD, font=("Microsoft YaHei UI", 8, "bold")).pack(anchor="w")

        for win_key, label_txt in (("fiveHour", "5h"), ("weekly", "周")):
            row = tk.Frame(block, bg=C_CARD)
            row.pack(fill="x", pady=2)
            tk.Label(row, text=label_txt, fg=C_MUTED, bg=C_CARD, font=("Consolas", 8), width=3, anchor="w").pack(side="left")

            bar_canvas = tk.Canvas(row, width=128, height=8, bg=C_CARD_INNER, highlightthickness=0, bd=0)
            bar_canvas.pack(side="left", padx=(2, 6))
            fill_id = bar_canvas.create_rectangle(0, 0, 128, 8, fill=accent_color, width=0)

            val_var = tk.StringVar(value="100%")
            tk.Label(row, textvariable=val_var, fg=C_TEXT, bg=C_CARD, font=("Consolas", 8, "bold"), width=5, anchor="e").pack(side="left")

            rst_var = tk.StringVar(value="")
            tk.Label(row, textvariable=rst_var, fg=C_MUTED, bg=C_CARD, font=("Microsoft YaHei UI", 7), anchor="e").pack(side="right")

            self.card_bars[f"{pool_key}_{win_key}"] = (bar_canvas, fill_id, accent_color)
            self.card_vars[f"{pool_key}_{win_key}_pct"] = val_var
            self.card_vars[f"{pool_key}_{win_key}_rst"] = rst_var

    def _toggle_billing_card(self):
        if self.card_visible:
            self._hide_billing_card()
        else:
            self._hide_bubble()
            self._show_billing_card()

    @staticmethod
    def _point_in_widget(widget, px: int, py: int) -> bool:
        if not widget:
            return False
        try:
            x1 = widget.winfo_rootx()
            y1 = widget.winfo_rooty()
            x2 = x1 + widget.winfo_width()
            y2 = y1 + widget.winfo_height()
            return x1 <= px <= x2 and y1 <= py <= y2
        except Exception:
            return False

    def _start_outside_click_watch(self):
        self._stop_outside_click_watch()
        if sys.platform != "win32" or self.smoke_test:
            return
        self._card_opened_at = time.perf_counter()
        self._outside_prev_down = True

        def poll():
            if not self.card_visible or self.stop_event.is_set():
                self._outside_watch_job = None
                return
            user32 = ctypes.windll.user32
            l_down = bool(user32.GetAsyncKeyState(0x01) & 0x8000)
            r_down = bool(user32.GetAsyncKeyState(0x02) & 0x8000)
            down = l_down or r_down
            if (
                down
                and not self._outside_prev_down
                and not self._menu_open
                and (time.perf_counter() - self._card_opened_at) >= 0.18
            ):
                pt = wintypes.POINT()
                if user32.GetCursorPos(ctypes.byref(pt)):
                    in_card = self._point_in_widget(self.card_win, pt.x, pt.y)
                    in_pet = self._point_in_widget(self.root, pt.x, pt.y)
                    if not in_card and not in_pet:
                        self._outside_prev_down = down
                        self._hide_billing_card()
                        return
            self._outside_prev_down = down
            self._outside_watch_job = self.root.after(40, poll)

        self._outside_watch_job = self.root.after(40, poll)

    def _stop_outside_click_watch(self):
        if self._outside_watch_job is not None:
            try:
                self.root.after_cancel(self._outside_watch_job)
            except Exception:
                pass
            self._outside_watch_job = None

    def _show_billing_card(self):
        self._ensure_billing_card()
        self._update_card_ui()
        pw, ph = self._get_popup_size(self.card_win, 360, 380)
        self._position_popup_above_pet(self.card_win, pw, ph)
        self.card_win.deiconify()
        self.card_win.lift()
        self.card_visible = True
        self._start_outside_click_watch()
        self._trigger_refresh(silent=True)

    def _hide_billing_card(self):
        self.card_visible = False
        self._stop_outside_click_watch()
        if self.card_win:
            self.card_win.withdraw()

    def _animate_today_counter(self):
        if self.counter_job is not None:
            self.root.after_cancel(self.counter_job)
            self.counter_job = None

        diff = self.target_today_tokens - self.displayed_today_tokens
        if abs(diff) <= 5:
            self.displayed_today_tokens = self.target_today_tokens
            if "today_tokens" in self.card_vars:
                self.card_vars["today_tokens"].set(f"{self.displayed_today_tokens:,}")
            return

        step = int(diff * 0.35)
        if step == 0:
            step = 1 if diff > 0 else -1
        self.displayed_today_tokens += step
        if "today_tokens" in self.card_vars:
            self.card_vars["today_tokens"].set(f"{self.displayed_today_tokens:,}")
        self.counter_job = self.root.after(8, self._animate_today_counter)

    def _update_card_ui(self):
        if not self.card_win or not self.summary:
            return
        s = self.summary
        today = s.get("today") or {}
        currency = self.settings.get("currency", "CNY")

        self.target_today_tokens = int(today.get("total_tokens", 0))
        if self.smoke_test:
            self.displayed_today_tokens = self.target_today_tokens
            self.card_vars["today_tokens"].set(f"{self.displayed_today_tokens:,}")
        else:
            self._animate_today_counter()

        self.card_vars["today_cost"].set(fmt_money(today.get("cost_usd", 0), today.get("cost_cny", 0), currency))
        saved_str = fmt_money(today.get("saved_usd", 0), today.get("saved_cny", 0), currency)
        self.card_vars["today_sub1"].set(
            f"输入 {fmt_tokens(today.get('input_tokens'))} · 缓存 {fmt_tokens(today.get('cache_read_tokens'))} · 输出 {fmt_tokens(today.get('output_tokens'))}"
        )
        self.card_vars["today_sub2"].set(
            f"缓存命中 {today.get('cache_hit_pct', 0)}% · 节省 {saved_str}"
        )

        quota = s.get("quota") or {}
        src_label = "实时配额" if quota.get("source") == "live" else "本地窗口估算"
        if quota.get("planName"):
            src_label = f"{quota.get('planName')} · {src_label}"
        self.card_vars["quota_source"].set(src_label)

        for pool_key in ("gemini", "claude_chatgpt"):
            pool = quota.get(pool_key) or {}
            for win_key in ("fiveHour", "weekly"):
                item = pool.get(win_key) or {}
                pct = max(0, min(100, int(item.get("remainingPct", 100))))
                bar_canvas, fill_id, base_color = self.card_bars[f"{pool_key}_{win_key}"]
                bar_w = max(2, int(round(128 * (pct / 100.0)))) if pct > 0 else 0
                color = C_RED if pct <= 15 else (C_GOLD if pct <= 35 else base_color)
                bar_canvas.coords(fill_id, 0, 0, bar_w, 8)
                bar_canvas.itemconfig(fill_id, fill=color)
                self.card_vars[f"{pool_key}_{win_key}_pct"].set(f"{pct}%")
                self.card_vars[f"{pool_key}_{win_key}_rst"].set(item.get("resetIn", ""))

        turn = s.get("latestTurn")
        if turn:
            t_cost = fmt_money(turn.get("cost_usd", 0), turn.get("cost_cny", 0), currency)
            self.card_vars["latest_turn"].set(
                f"最近一轮 ({turn.get('model', 'unknown')})：{fmt_tokens(turn.get('total_tokens'))} tok · "
                f"缓存 {turn.get('cache_hit_pct', 0)}% · ≈ {t_cost}"
            )
        else:
            self.card_vars["latest_turn"].set("最近一轮：暂无对话记录")

        self.card_vars["btn_currency"].set(f"币种: {'¥' if currency == 'CNY' else '$'}")
        self.card_vars["btn_sound"].set("🔊 音效开" if self.settings.get("soundEnabled", True) else "🔇 已静音")

    # ---------------- Network & SSE Bridge ----------------

    def _http_json(self, path: str, method: str = "GET", body: dict | None = None, timeout: float = 3.0):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _update_remote_settings(self, patch: dict):
        self.settings.update(patch)
        self._render_pet_sprite()
        self._apply_dock_position()
        self._update_card_ui()

        def worker():
            try:
                res = self._http_json("/api/settings", method="POST", body=patch)
                if res.get("settings"):
                    self.evt_queue.put(("settings", res["settings"]))
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def _trigger_refresh(self, silent: bool = False):
        if not silent:
            self._play_sound("pop")

        def worker():
            try:
                res = self._http_json("/api/refresh", method="POST", body={})
                self.evt_queue.put(("summary", res))
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def _cycle_dialogue(self):
        self._play_sound("pop")

        def worker():
            try:
                res = self._http_json("/api/bubble/next", method="GET")
                if res.get("text"):
                    self.evt_queue.put(("dialogue", res["text"]))
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def _start_background_threads(self):
        threading.Thread(target=self._poll_loop, daemon=True).start()
        threading.Thread(target=self._sse_loop, daemon=True).start()

    def _poll_loop(self):
        while not self.stop_event.is_set():
            try:
                res = self._http_json("/api/summary", method="GET", timeout=3.5)
                self.evt_queue.put(("summary", res))
            except Exception:
                pass
            self.stop_event.wait(10.0)

    def _sse_loop(self):
        while not self.stop_event.is_set():
            try:
                req = urllib.request.Request(f"{self.base_url}/api/events", method="GET")
                with urllib.request.urlopen(req, timeout=60.0) as resp:
                    event_name = "message"
                    data_lines = []
                    for raw_line in resp:
                        if self.stop_event.is_set():
                            break
                        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                        if not line:
                            if data_lines:
                                payload_str = "\n".join(data_lines)
                                try:
                                    payload = json.loads(payload_str)
                                    self.evt_queue.put((event_name, payload))
                                except Exception:
                                    pass
                            event_name = "message"
                            data_lines = []
                        elif line.startswith("event:"):
                            event_name = line[6:].strip()
                        elif line.startswith("data:"):
                            data_lines.append(line[5:].strip())
            except Exception:
                self.stop_event.wait(2.0)

    def _process_queue(self):
        if self.stop_event.is_set():
            return
        while True:
            try:
                ev_type, payload = self.evt_queue.get_nowait()
            except queue.Empty:
                break

            if ev_type == "summary" and isinstance(payload, dict):
                self.summary = payload
                if isinstance(payload.get("settings"), dict):
                    self._apply_settings(payload["settings"])
                if payload.get("petState"):
                    self.pet_state = payload["petState"]
                self._update_card_ui()

            elif ev_type == "settings" and isinstance(payload, dict):
                self._apply_settings(payload)
                self._update_card_ui()

            elif ev_type == "status_change" and isinstance(payload, dict):
                self.pet_state = payload.get("petState", "idle")

            elif ev_type == "dialogue":
                self.current_dialogue = str(payload)
                if "dialogue" in self.card_vars:
                    self.card_vars["dialogue"].set(f"💬 {self.current_dialogue}")

            elif ev_type == "turn_complete" and isinstance(payload, dict):
                self._handle_turn_complete(payload)

            elif ev_type == "shutdown":
                self.quit()
                return

        self.root.after(80, self._process_queue)

    def _apply_settings(self, new_settings: dict):
        old_scale = self.settings.get("scale")
        old_flip = self.settings.get("flipped")
        self.settings.update(new_settings)
        if self.settings.get("scale") != old_scale or self.settings.get("flipped") != old_flip:
            self._render_pet_sprite()
        self._apply_dock_position()

    def _handle_turn_complete(self, payload: dict):
        is_error = bool(payload.get("isError"))
        self.pet_state = "error" if is_error else "done"
        self._play_sound("error" if is_error else "turn_done")
        self._start_rebound(jump=not is_error)

        if self.summary is None:
            self.summary = {}
        if payload.get("today"):
            self.summary["today"] = payload["today"]
        if payload.get("quota"):
            self.summary["quota"] = payload["quota"]
        if payload.get("turn"):
            self.summary["latestTurn"] = payload["turn"]
        self._update_card_ui()

        if self.settings.get("autoBroadcast", True):
            turn = payload.get("turn") or {}
            currency = self.settings.get("currency", "CNY")
            cost_str = fmt_money(turn.get("cost_usd", 0), turn.get("cost_cny", 0), currency)
            dur = int(self.settings.get("broadcastDurationSec", 5))
            if is_error:
                self.show_bubble("⚠ 本轮执行异常", f"耗费 {fmt_tokens(turn.get('total_tokens', 0))} tok · ≈ {cost_str}", dur)
            else:
                self.show_bubble(
                    f"✨ 本轮完成 ({turn.get('model', 'Gemini')})",
                    f"消耗 {fmt_tokens(turn.get('total_tokens', 0))} tok · 缓存 {turn.get('cache_hit_pct', 0)}% · ≈ {cost_str}",
                    dur,
                )

    def run_smoke_test(self):
        self.summary = {
            "today": {
                "total_tokens": 128450,
                "input_tokens": 18200,
                "cache_read_tokens": 102000,
                "output_tokens": 8250,
                "cache_hit_pct": 84.9,
                "cost_usd": 0.137,
                "cost_cny": 0.99,
                "saved_usd": 0.095,
                "saved_cny": 0.69,
            },
            "quota": {
                "source": "live",
                "planName": "Google AI Pro",
                "gemini": {
                    "fiveHour": {"remainingPct": 92, "resetIn": "4小时12分后"},
                    "weekly": {"remainingPct": 88, "resetIn": "近 7 天参考池"},
                },
                "claude_chatgpt": {
                    "fiveHour": {"remainingPct": 76, "resetIn": "3小时40分后"},
                    "weekly": {"remainingPct": 81, "resetIn": "近 7 天参考池"},
                },
            },
            "latestTurn": {
                "model": "gemini-4-neon-high",
                "total_tokens": 42300,
                "cache_hit_pct": 83.2,
                "cost_usd": 0.025,
                "cost_cny": 0.18,
            },
        }
        # Test normal & flipped sprite rendering
        self.settings["flipped"] = True
        self._render_pet_sprite()
        self.settings["flipped"] = False
        self._render_pet_sprite()
        # Test squish & spring frames via 60fps cache
        self.scale_y = 0.78
        self.scale_x = 1.0 / math.sqrt(self.scale_y)
        self._render_pet_sprite()
        self.scale_y = 1.10
        self.scale_x = 1.0 / math.sqrt(self.scale_y)
        self._render_pet_sprite()
        self.scale_x = 1.0
        self.scale_y = 1.0
        self._render_pet_sprite()
        # Test strict in-window bounds clamping & inner panel insets
        sample_rect = apply_antigravity_insets((100, 80, 1100, 880), 1.0)
        assert sample_rect == (105, 118, 1095, 871)
        assert self._clamp_to_rect(20, 40, 144, 151, sample_rect) == (105, 118)
        assert self._clamp_to_rect(2000, 1500, 144, 151, sample_rect) == (951, 720)
        # Test billing card & bubble creation
        self._ensure_billing_card()
        self._update_card_ui()
        card_size = self._get_popup_size(self.card_win, 360, 380)
        self.show_bubble("✨ 烟雾测试", "消耗 42.3K tok · ≈ ¥0.18", duration_sec=0)
        self.root.update_idletasks()
        self.root.update()
        cx_in = self.root.winfo_rootx() + 10
        cy_in = self.root.winfo_rooty() + 10
        assert self._point_in_widget(self.root, cx_in, cy_in) is True
        assert self._point_in_widget(self.root, -9999, -9999) is False
        # Stray drag/release without prior press must not open billing card
        stray_evt = type("Evt", (), {"x_root": cx_in, "y_root": cy_in})()
        self.is_pressed = False
        self.dragging = False
        self._on_drag(stray_evt)
        self._on_release(stray_evt)
        assert self.dragging is False
        assert self.card_visible is False
        print(json.dumps({
            "ok": True,
            "pet_image_size": list(self.base_image.size),
            "canvas_size": list(self._get_pet_canvas_size()),
            "cached_frames": len(self._frame_cache),
            "card_size": list(card_size),
            "today_tokens": self.card_vars["today_tokens"].get(),
            "today_cost": self.card_vars["today_cost"].get(),
        }, ensure_ascii=False))
        self.quit()

    def quit(self):
        self.stop_event.set()
        self._stop_outside_click_watch()
        self._cancel_anim()
        try:
            self.root.destroy()
        except Exception:
            pass

    def run(self):
        if self.smoke_test:
            self.root.after(120, self.run_smoke_test)
        self.root.mainloop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--smoke-test", action="store_true")
    args = parser.parse_args()

    setup_dpi_awareness()
    if not args.smoke_test:
        mutex = acquire_single_instance_mutex()
        if mutex is False:
            # Another instance is already running
            sys.exit(0)

    port = discover_runtime_port(args.port)
    app = GeminiPetApp(port=port, smoke_test=args.smoke_test)
    app.run()


if __name__ == "__main__":
    main()
