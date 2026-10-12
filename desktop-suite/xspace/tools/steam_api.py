# -*- coding: utf-8 -*-
"""Call the Steam web API endpoints used by the modern cart / wishlist pages.

Transport: SOCKS5 with LOCAL dns resolution (bypasses Clash's Steam->DIRECT rule).
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_probe import cookie_header, read_cookies, OUT, STEAMID   # noqa: E402

SOCKS = "socks5://127.0.0.1:7890"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def fetch(url, cookie="", out=None, extra=None):
    args = ["curl.exe", "-s", "-x", SOCKS, "--max-time", "40", "-H", "User-Agent: " + UA,
            "-H", "Accept-Language: zh-CN,zh;q=0.9"]
    if cookie:
        args += ["-H", "Cookie: " + cookie]
    for h in (extra or []):
        args += ["-H", h]
    if out:
        args += ["-o", out, "-w", "%{http_code} %{size_download}B"]
    args.append(url)
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout.strip()


def main():
    cookies = read_cookies()
    store_ck = cookie_header(cookies, "store.steampowered.com")
    api_ck = cookie_header(cookies, "api.steampowered.com") or store_ck

    cart_html = os.path.join(OUT, "steam_cart.html")
    if not os.path.exists(cart_html) or os.path.getsize(cart_html) < 1000:
        print(fetch("https://store.steampowered.com/cart/?cc=cn&l=schinese", store_ck, cart_html))
    html = open(cart_html, "r", encoding="utf-8", errors="replace").read()
    m = re.search(r'g_wapit\s*=\s*"([^"]+)"', html)
    wapit = m.group(1) if m else ""
    print("g_wapit len=", len(wapit), "prefix=", wapit[:24])
    m = re.search(r'g_sessionID\s*=\s*"([^"]+)"', html)
    print("g_sessionID=", m.group(1) if m else None)

    tests = [
        ("cart v1", "https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=%s" % wapit, api_ck, "steam_cart_api.json"),
        ("cart v1 +cc", "https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=%s&cc=cn" % wapit, api_ck, "steam_cart_api_cc.json"),
        ("wishlist v1", "https://api.steampowered.com/IWishlistService/GetWishlist/v1/?access_token=%s&steamid=%s" % (wapit, STEAMID), api_ck, "steam_wish_api.json"),
        ("wishlistdata +L", "https://store.steampowered.com/wishlist/profiles/%s/wishlistdata/?p=0" % STEAMID, store_ck, "steam_wishlistdata.json"),
        ("wishlist api store", "https://store.steampowered.com/api/wishlistdata/?p=0&steamid=%s" % STEAMID, store_ck, "steam_wish_alt.json"),
    ]
    for label, url, ck, out in tests:
        code = fetch(url, ck, os.path.join(OUT, out))
        size = os.path.getsize(os.path.join(OUT, out))
        print("%-18s %s  %d bytes" % (label, code, size))
        if size and size < 400000:
            raw = open(os.path.join(OUT, out), "r", encoding="utf-8", errors="replace").read()
            print("      ", raw[:260].replace("\n", " "))


if __name__ == "__main__":
    main()
