# -*- coding: utf-8 -*-
"""UI test helper for XSpaceWidget (works even when the screen is locked).

All coordinates are PHYSICAL pixels, relative to the target window's top-left.

  python tools/uitest.py info <pid>
  python tools/uitest.py shot <pid> <index> <out.png> [--crop l,t,r,b]     (screen grab)
  python tools/uitest.py pwshot <pid> <index> <out.png> [--crop l,t,r,b]   (PrintWindow, lock-safe)
  python tools/uitest.py click <pid> <index> <x> <y>                       (real mouse)
  python tools/uitest.py wheel <pid> <index> <x> <y> <delta> <count>       (real wheel)
  python tools/uitest.py postclick <pid> <index> <x> <y>                   (posted messages, lock-safe)
  python tools/uitest.py postwheel <pid> <index> <x> <y> <delta> <count>   (posted messages, lock-safe)
  python tools/uitest.py topmost <pid> <index> <0|1>
  python tools/uitest.py ctrl <letter>
  python tools/uitest.py close <pid> <index>
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

WM_CLOSE = 0x0010
WM_MOUSEWHEEL = 0x020A
WM_MOUSEHWHEEL = 0x020E
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_MOUSEMOVE = 0x0200
MK_LBUTTON = 0x0001

MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
KEYEVENTF_KEYUP = 0x0002


def enum_windows(pid):
    out = []

    def cb(h, l):
        wpid = wt.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(wpid))
        if wpid.value != pid or not user32.IsWindowVisible(h):
            return True
        n = user32.GetWindowTextLengthW(h)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(h, buf, n + 1)
        r = wt.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        out.append({"hwnd": h, "title": buf.value, "left": r.left, "top": r.top,
                    "right": r.right, "bottom": r.bottom,
                    "w": r.right - r.left, "h": r.bottom - r.top})
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    out.sort(key=lambda x: -x["w"] * x["h"])
    return [w for w in out if w["w"] > 40 and w["h"] > 40]


def win_rect(pid, index):
    ws = enum_windows(pid)
    if index >= len(ws):
        raise SystemExit("window index %d not found (have %d)" % (index, len(ws)))
    return ws[index]


# ---------------------------------------------------------------- capture ----
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]


def print_window(hwnd, out, crop=None):
    from PIL import Image
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top

    hdc = user32.GetWindowDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mdc, bmp)

    ok = user32.PrintWindow(hwnd, mdc, 0x00000002)   # PW_RENDERFULLCONTENT

    bih = BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bih.biWidth = w
    bih.biHeight = h
    bih.biPlanes = 1
    bih.biBitCount = 32
    bih.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bih), 0)

    img = Image.frombuffer("RGB", (w, h), buf, "raw", "BGRX", 0, 1).transpose(Image.FLIP_TOP_BOTTOM)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(hwnd, hdc)

    if crop:
        l, t, rr, b = crop
        img = img.crop((l, t, min(rr, w), min(b, h)))
    img.save(out)
    return ok, img.size


# ------------------------------------------------------------------ input ----
def mouse_move(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.12)


def mouse_click(x, y):
    mouse_move(x, y)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.35)


def post_click(hwnd, cx, cy):
    lp = (int(cy) << 16) | (int(cx) & 0xFFFF)
    user32.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lp)
    time.sleep(0.05)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.08)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)
    time.sleep(0.4)


def post_wheel(hwnd, screen_x, screen_y, delta, count):
    lp = (int(screen_y) << 16) | (int(screen_x) & 0xFFFF)
    wparam = (int(delta) & 0xFFFF) << 16
    for _ in range(count):
        user32.PostMessageW(hwnd, WM_MOUSEWHEEL, wparam, lp)
        time.sleep(0.5)          # 等滑动动画(260ms)走完


def post_hwheel(hwnd, screen_x, screen_y, delta, count, gap_ms=40):
    """WM_MOUSEHWHEEL：模拟触摸板两指左右滑 / 鼠标倾斜滚轮。"""
    lp = (int(screen_y) << 16) | (int(screen_x) & 0xFFFF)
    wparam = (int(delta) & 0xFFFF) << 16
    for _ in range(count):
        user32.PostMessageW(hwnd, WM_MOUSEHWHEEL, wparam, lp)
        time.sleep(gap_ms / 1000.0)
    time.sleep(0.4)


def post_wheel_fine(hwnd, screen_x, screen_y, delta, count, gap_ms=12):
    """高精度触摸板：小增量（±8/±24）密集发送，用于验证“累计成一格”的行为。"""
    lp = (int(screen_y) << 16) | (int(screen_x) & 0xFFFF)
    wparam = (int(delta) & 0xFFFF) << 16
    for _ in range(count):
        user32.PostMessageW(hwnd, WM_MOUSEWHEEL, wparam, lp)
        time.sleep(gap_ms / 1000.0)
    time.sleep(0.5)


def mouse_drag(x, y, dy, steps=20):
    """真实鼠标拖动（按住左键沿 Y 拖 dy 像素）——与触屏提升出的鼠标路径一致。"""
    mouse_move(x, y)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.08)
    for i in range(1, steps + 1):
        mouse_move(x, y + dy * i / steps)
        time.sleep(0.02)
    time.sleep(0.05)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.5)


# ------------------------------------------------------- touch injection ----
class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _POINTER_INFO(ctypes.Structure):
    _fields_ = [("pointerType", ctypes.c_uint32), ("pointerId", ctypes.c_uint32),
                ("frameId", ctypes.c_uint32), ("pointerFlags", ctypes.c_uint32),
                ("sourceDevice", ctypes.c_void_p), ("hwndTarget", ctypes.c_void_p),
                ("ptPixelLocation", _POINT), ("ptHimetricLocation", _POINT),
                ("ptPixelLocationRaw", _POINT), ("ptHimetricLocationRaw", _POINT),
                ("dwTime", ctypes.c_uint32), ("historyCount", ctypes.c_uint32),
                ("InputData", ctypes.c_int32), ("dwKeyStates", ctypes.c_uint32),
                ("PerformanceCount", ctypes.c_uint64), ("ButtonChangeType", ctypes.c_int32)]


class _TOUCH_INFO(ctypes.Structure):
    _fields_ = [("pointerInfo", _POINTER_INFO), ("touchFlags", ctypes.c_uint32),
                ("touchMask", ctypes.c_uint32), ("rcContact", _RECT),
                ("rcContactRaw", _RECT), ("orientation", ctypes.c_uint32),
                ("pressure", ctypes.c_uint32)]


PT_TOUCH = 2
TOUCH_MASK_CONTACTAREA = 0x1
F_INRANGE, F_INCONTACT = 0x02, 0x04
F_PRIMARY, F_CONFIDENCE = 0x2000, 0x4000
F_DOWN, F_UPDATE, F_UP = 0x10000, 0x20000, 0x40000

_touch_ready = False


def _touch_init():
    global _touch_ready
    if _touch_ready:
        return
    user32.InitializeTouchInjection.restype = wt.BOOL
    if not user32.InitializeTouchInjection(10, 2):   # TOUCH_FEEDBACK_NONE = 2
        raise SystemExit("InitializeTouchInjection failed (err=%d)" % ctypes.get_last_error())
    _touch_ready = True


def _touch_frame(x, y, flags, tid=1):
    t = _TOUCH_INFO()
    t.pointerInfo.pointerType = PT_TOUCH
    t.pointerInfo.pointerId = tid
    t.pointerInfo.pointerFlags = flags
    for pt in (t.pointerInfo.ptPixelLocation, t.pointerInfo.ptPixelLocationRaw):
        pt.x, pt.y = int(x), int(y)
    t.touchFlags = 0
    t.touchMask = TOUCH_MASK_CONTACTAREA
    t.rcContact = _RECT(int(x) - 2, int(y) - 2, int(x) + 2, int(y) + 2)
    t.rcContactRaw = t.rcContact
    t.pressure = 32000
    return t


def _inject(x, y, flags):
    arr = (_TOUCH_INFO * 1)(_touch_frame(x, y, flags))
    if not user32.InjectTouchInput(1, arr):
        raise SystemExit("InjectTouchInput failed (err=%d)" % ctypes.get_last_error())


def touch_pan(x, y, dy, steps=20):
    """真实触摸注入：手指从 (x,y) 沿 Y 拖 dy 物理像素（负数=向上划）。"""
    _touch_init()
    base = F_INRANGE | F_INCONTACT | F_PRIMARY | F_CONFIDENCE
    _inject(x, y, F_DOWN | base)
    time.sleep(0.05)
    for i in range(1, steps + 1):
        _inject(x, y + dy * i / steps, F_UPDATE | base)
        time.sleep(0.025)
    _inject(x, y + dy, F_UP | F_INRANGE | F_PRIMARY | F_CONFIDENCE)
    time.sleep(0.45)


def touch_tap(x, y):
    """真实触摸轻点。"""
    _touch_init()
    base = F_INRANGE | F_INCONTACT | F_PRIMARY | F_CONFIDENCE
    _inject(x, y, F_DOWN | base)
    time.sleep(0.06)
    _inject(x, y, F_UP | F_INRANGE | F_PRIMARY | F_CONFIDENCE)
    time.sleep(0.5)


VK = {"up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
      "pgup": 0x21, "pgdn": 0x22, "home": 0x24, "end": 0x23,
      "enter": 0x0D, "esc": 0x1B, "tab": 0x09, "space": 0x20}


def send_keys(hwnd, key, count=1):
    """真实按键（先尝试把窗口拉到前台）。"""
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.25)
    vk = VK.get(str(key).lower(), None)
    if vk is None:
        vk = int(key, 0)
    for _ in range(count):
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.05)
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.30)


def main():
    a = sys.argv[1:]
    if not a:
        raise SystemExit(__doc__)
    cmd = a[0]

    if cmd == "info":
        pid = int(a[1])
        print("foreground=%s (0 means locked)" % user32.GetForegroundWindow())
        for i, w in enumerate(enum_windows(pid)):
            print("[%d] hwnd=%s title=%r rect=(%d,%d)-(%d,%d) size=%dx%d"
                  % (i, w["hwnd"], w["title"], w["left"], w["top"], w["right"], w["bottom"], w["w"], w["h"]))
        return

    if cmd == "allwins":
        # dump every visible top-level window title (any process) to a UTF-8 file
        out = a[1]
        rows = []

        def cb2(h, l):
            if not user32.IsWindowVisible(h):
                return True
            n = user32.GetWindowTextLengthW(h)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, buf, n + 1)
            if not buf.value.strip():
                return True
            wpid = wt.DWORD()
            user32.GetWindowThreadProcessId(h, ctypes.byref(wpid))
            rows.append("%s\t| pid=%d\t| hwnd=%s" % (buf.value.strip(), wpid.value, h))
            return True

        user32.EnumWindows(EnumProc(cb2), 0)
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(rows))
        print("wrote %d window titles to %s" % (len(rows), out))
        return

    if cmd == "shot":
        from PIL import ImageGrab
        pid, index, out = int(a[1]), int(a[2]), a[3]
        w = win_rect(pid, index)
        l, t, r, b = 0, 0, w["w"], w["h"]
        if "--crop" in a:
            l, t, r, b = [int(v) for v in a[a.index("--crop") + 1].split(",")]
        box = (w["left"] + l, w["top"] + t, w["left"] + r, w["top"] + b)
        img = ImageGrab.grab(bbox=box, all_screens=True)
        img.save(out)
        print("saved %s %dx%d" % (out, img.size[0], img.size[1]))
        return

    if cmd == "pwshot":
        pid, index, out = int(a[1]), int(a[2]), a[3]
        crop = None
        if "--crop" in a:
            crop = tuple(int(v) for v in a[a.index("--crop") + 1].split(","))
        w = win_rect(pid, index)
        ok, size = print_window(w["hwnd"], out, crop)
        print("saved %s %dx%d printwindow_ok=%s" % (out, size[0], size[1], ok))
        return

    if cmd in ("click", "postclick"):
        pid, index, x, y = int(a[1]), int(a[2]), int(a[3]), int(a[4])
        w = win_rect(pid, index)
        if cmd == "click":
            mouse_click(w["left"] + x, w["top"] + y)
        else:
            post_click(w["hwnd"], x, y)
        print("%s at %d,%d (window %d)" % (cmd, x, y, index))
        return

    if cmd in ("wheel", "postwheel"):
        pid, index = int(a[1]), int(a[2])
        x, y, delta, count = int(a[3]), int(a[4]), int(a[5]), int(a[6])
        w = win_rect(pid, index)
        if cmd == "wheel":
            mouse_move(w["left"] + x, w["top"] + y)
            for _ in range(count):
                user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0)
                time.sleep(0.5)
        else:
            post_wheel(w["hwnd"], w["left"] + x, w["top"] + y, delta, count)
        print("%s delta=%d x%d at %d,%d" % (cmd, delta, count, x, y))
        return

    if cmd == "clickat":
        # clickat <x> <y> —— 绝对屏幕坐标单击
        mouse_click(int(a[1]), int(a[2]))
        print("clicked at %d,%d" % (int(a[1]), int(a[2])))
        return

    if cmd == "dblclick":
        # dblclick <x> <y> [pid]  —— 绝对屏幕坐标（用于任务栏托盘图标）
        x, y = int(a[1]), int(a[2])
        mouse_move(x, y)
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.06)
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.5)
        print("double-clicked at %d,%d" % (x, y))
        return

    if cmd == "rclick":
        # rclick <pid> <index> <x> <y> —— 窗口相对右键
        pid, index, x, y = int(a[1]), int(a[2]), int(a[3]), int(a[4])
        w = win_rect(pid, index)
        mouse_move(w["left"] + x, w["top"] + y)
        user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
        time.sleep(0.06)
        user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
        time.sleep(0.5)
        print("right-clicked at %d,%d" % (x, y))
        return

    if cmd == "touch":
        # touch <pid> <index> <x> <y> <dy> [steps] —— 真实触摸：手指沿 Y 拖动 dy 像素
        w = win_rect(int(a[1]), int(a[2]))
        x, y, dy = int(a[3]), int(a[4]), int(a[5])
        steps = int(a[6]) if len(a) > 6 else 20
        touch_pan(w["left"] + x, w["top"] + y, dy, steps)
        print("touch pan at %d,%d dy=%d" % (x, y, dy))
        return

    if cmd == "touchtap":
        # touchtap <pid> <index> <x> <y>
        w = win_rect(int(a[1]), int(a[2]))
        x, y = int(a[3]), int(a[4])
        touch_tap(w["left"] + x, w["top"] + y)
        print("touch tap at %d,%d" % (x, y))
        return

    if cmd == "drag":
        # drag <pid> <index> <x> <y> <dy> [steps] —— 真实鼠标按住拖动
        w = win_rect(int(a[1]), int(a[2]))
        x, y, dy = int(a[3]), int(a[4]), int(a[5])
        steps = int(a[6]) if len(a) > 6 else 20
        mouse_drag(w["left"] + x, w["top"] + y, dy, steps)
        print("drag at %d,%d dy=%d" % (x, y, dy))
        return

    if cmd == "keys":
        # keys <pid> <index> <up|down|pgup|pgdn|home|end|0x28> [count]
        w = win_rect(int(a[1]), int(a[2]))
        count = int(a[4]) if len(a) > 4 else 1
        send_keys(w["hwnd"], a[3], count)
        print("sent %s x%d" % (a[3], count))
        return

    if cmd == "posthwheel":
        # posthwheel <pid> <index> <x> <y> <delta> <count> [gapMs] —— 触摸板两指左右滑
        pid, index = int(a[1]), int(a[2])
        x, y, delta, count = int(a[3]), int(a[4]), int(a[5]), int(a[6])
        gap = int(a[7]) if len(a) > 7 else 40
        w = win_rect(pid, index)
        post_hwheel(w["hwnd"], w["left"] + x, w["top"] + y, delta, count, gap)
        print("posted hwheel delta=%d x%d" % (delta, count))
        return

    if cmd == "finewheel":
        # finewheel <pid> <index> <x> <y> <delta> <count> —— 高精度触摸板小增量
        pid, index = int(a[1]), int(a[2])
        x, y, delta, count = int(a[3]), int(a[4]), int(a[5]), int(a[6])
        w = win_rect(pid, index)
        post_wheel_fine(w["hwnd"], w["left"] + x, w["top"] + y, delta, count)
        print("posted fine wheel delta=%d x%d" % (delta, count))
        return

    if cmd == "move":
        pid, index, x, y = int(a[1]), int(a[2]), int(a[3]), int(a[4])
        w = win_rect(pid, index)
        mouse_move(w["left"] + x, w["top"] + y)
        print("moved to %d,%d (window %d)" % (x, y, index))
        return

    if cmd == "rollburst":
        # rollburst <pid> <idx> <x> <y> <delta> <shots> <intervalMs> <prefix>
        # 投递一次滚轮后立刻连拍，用来抓动画中间帧
        pid, index = int(a[1]), int(a[2])
        x, y, delta = int(a[3]), int(a[4]), int(a[5])
        shots, interval, prefix = int(a[6]), int(a[7]), a[8]
        w = win_rect(pid, index)
        lp = ((w["top"] + y) << 16) | ((w["left"] + x) & 0xFFFF)
        wparam = (int(delta) & 0xFFFF) << 16
        user32.PostMessageW(w["hwnd"], WM_MOUSEWHEEL, wparam, lp)
        outs = []
        for i in range(shots):
            time.sleep(interval / 1000.0)
            out = "%s_%d.png" % (prefix, i)
            print_window(w["hwnd"], out)
            outs.append(out)
        print("burst: %s" % ", ".join(outs))
        return

    if cmd == "exstyle":
        # exstyle <pid> <index> —— 打印扩展样式，用于确认是否 WS_EX_TOPMOST(0x8)
        w = win_rect(int(a[1]), int(a[2]))
        ex = user32.GetWindowLongW(w["hwnd"], -20)
        print("exstyle=0x%08X topmost=%d" % (ex & 0xFFFFFFFF, 1 if (ex & 0x8) else 0))
        return

    if cmd == "topmost":
        pid, index, on = int(a[1]), int(a[2]), int(a[3])
        w = win_rect(pid, index)
        user32.SetWindowPos(w["hwnd"], -1 if on else -2, 0, 0, 0, 0, 0x0001)
        print("topmost=%d" % on)
        return

    if cmd == "close":
        pid, index = int(a[1]), int(a[2])
        w = win_rect(pid, index)
        user32.PostMessageW(w["hwnd"], WM_CLOSE, 0, 0)
        print("WM_CLOSE sent to window %d" % index)
        return

    if cmd == "ctrl":
        letter = a[1].upper()
        vk = ord(letter)
        user32.keybd_event(0x11, 0, 0, 0)
        time.sleep(0.08)
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.05)
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)
        user32.keybd_event(0x11, 0, KEYEVENTF_KEYUP, 0)
        print("sent ctrl+%s" % letter)
        return

    raise SystemExit("unknown command: %s" % cmd)


if __name__ == "__main__":
    main()
