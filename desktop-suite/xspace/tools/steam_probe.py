# -*- coding: utf-8 -*-
"""Prototype: extract Steam client (CEF) cookies and fetch wishlist/cart.

Writes JSON/HTML fixtures into _shots/ for parser design + offline tests.
"""
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

STEAMID = "76561199111949599"
HTMLCACHE = os.path.join(os.environ["LOCALAPPDATA"], "Steam", "htmlcache")
COOKIE_DB = os.path.join(HTMLCACHE, "Default", "Network", "Cookies")
LOCAL_STATE = os.path.join(HTMLCACHE, "Local State")
SOCKS = "socks5://127.0.0.1:7890"   # local-resolution SOCKS5 (bypasses Clash Steam->DIRECT rule)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shots")

crypt32 = ctypes.windll.crypt32
kernel32 = ctypes.windll.kernel32


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_unprotect(data: bytes) -> bytes:
    blob_in = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)),
                                               ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0,
                                      ctypes.byref(blob_out)):
        raise OSError("CryptUnprotectData failed: %d" % ctypes.get_last_error())
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def aes_key() -> bytes:
    with open(LOCAL_STATE, "r", encoding="utf-8") as f:
        state = json.load(f)
    raw = base64.b64decode(state["os_crypt"]["encrypted_key"])
    if raw[:5] != b"DPAPI":
        raise ValueError("unexpected os_crypt key prefix: %r" % raw[:8])
    return dpapi_unprotect(raw[5:])


def decrypt_value(key: bytes, value: bytes) -> str:
    if value[:3] in (b"v10", b"v11"):
        nonce, payload = value[3:15], value[15:]
        return AESGCM(key).decrypt(nonce, payload, None).decode("utf-8", "replace")
    return dpapi_unprotect(value).decode("utf-8", "replace")


kernel32.CreateFileW.restype = ctypes.c_void_p
kernel32.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                                 wt.DWORD, wt.DWORD, ctypes.c_void_p]
kernel32.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wt.DWORD,
                              ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]


def copy_locked(src: str, dst: str) -> bool:
    """Copy a file that another process holds open (share read/write/delete)."""
    if not os.path.exists(src):
        return False
    GENERIC_READ, OPEN_EXISTING = 0x80000000, 3
    SHARE_ALL = 0x1 | 0x2 | 0x4
    h = kernel32.CreateFileW(src, GENERIC_READ, SHARE_ALL, None, OPEN_EXISTING, 0, None)
    if not h or h == ctypes.c_void_p(-1).value:
        raise OSError("CreateFileW failed on %s (err=%d)" % (src, ctypes.get_last_error()))
    try:
        buf = ctypes.create_string_buffer(1 << 20)
        read = wt.DWORD()
        total = 0
        with open(dst, "wb") as out:
            while True:
                if not kernel32.ReadFile(h, buf, len(buf), ctypes.byref(read), None):
                    raise OSError("ReadFile failed on %s (err=%d)" % (src, ctypes.get_last_error()))
                if read.value == 0:
                    break
                out.write(buf.raw[:read.value])
                total += read.value
        print("  copied %s -> %d bytes" % (os.path.basename(src), total))
    finally:
        kernel32.CloseHandle(h)
    return True


def read_cookies() -> dict:
    key = aes_key()
    tmp = os.path.join(tempfile.gettempdir(), "steam_ck.db")
    if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
        tmp = os.path.join(tempfile.gettempdir(), "steam_cookies_copy.db")
        for suffix in ("", "-wal", "-shm"):
            try:
                copy_locked(COOKIE_DB + suffix, tmp + suffix)
            except OSError as ex:
                print("  ! copy %s failed: %s" % (suffix or "db", ex))
    print("  using cookie db: %s (%d bytes)" % (tmp, os.path.getsize(tmp)))
    out = {}
    con = sqlite3.connect(tmp)
    try:
        for host, name, enc in con.execute(
                "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE '%steampowered%'"):
            try:
                out[(host, name)] = decrypt_value(key, enc)
            except Exception as ex:                       # noqa: BLE001
                print("  ! decrypt failed %s %s: %s" % (host, name, ex))
    finally:
        con.close()
    return out


def cookie_header(cookies: dict, host: str) -> str:
    parts = ["%s=%s" % (n, v) for (h, n), v in cookies.items() if host.endswith(h.lstrip("."))]
    return "; ".join(parts)


def fetch(url: str, cookie: str, out_name: str) -> str:
    args = ["curl.exe", "-s", "-x", SOCKS, "-o", os.path.join(OUT, out_name),
            "-w", "%{http_code}", "--max-time", "40",
            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8"]
    if cookie:
        args += ["-H", "Cookie: " + cookie]
    args.append(url)
    code = subprocess.run(args, capture_output=True, text=True).stdout.strip()
    path = os.path.join(OUT, out_name)
    size = os.path.getsize(path) if os.path.exists(path) else 0
    print("%s  %s  %d bytes" % (code, url[:110], size))
    return path


def main():
    cookies = read_cookies()
    print("cookies for steampowered:", [(h, n) for (h, n) in cookies if "steampowered" in h])
    ck = cookie_header(cookies, "store.steampowered.com")
    print("cookie header len:", len(ck))

    fetch("https://store.steampowered.com/wishlist/profiles/%s/wishlistdata/?p=0&cc=cn" % STEAMID,
          ck, "steam_wishlist.json")
    fetch("https://store.steampowered.com/wishlist/profiles/%s/" % STEAMID, ck, "steam_wishlist.html")
    fetch("https://store.steampowered.com/cart/?cc=cn&l=schinese", ck, "steam_cart.html")
    fetch("https://store.steampowered.com/dynamicstore/userdata/?cc=cn&l=schinese", ck, "steam_userdata.json")
    fetch("https://store.steampowered.com/api/appdetails?appids=730&cc=cn", "", "steam_app730.json")


if __name__ == "__main__":
    sys.exit(main())
