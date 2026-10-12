# -*- coding: utf-8 -*-
"""Check cart state and probe richer endpoints (IStoreBrowseService for prices)."""
import json
import os
import re
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_probe import cookie_header, read_cookies, OUT, STEAMID   # noqa: E402

SOCKS = "socks5://127.0.0.1:7890"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def fetch(url, cookie="", out=None):
    args = ["curl.exe", "-s", "-x", SOCKS, "--max-time", "40", "-H", "User-Agent: " + UA,
            "-H", "Accept-Language: zh-CN,zh;q=0.9"]
    if cookie:
        args += ["-H", "Cookie: " + cookie]
    if out:
        args += ["-o", out, "-w", "%{http_code} %{size_download}B"]
    args.append(url)
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout.strip()


html = open(os.path.join(OUT, "steam_cart.html"), "r", encoding="utf-8", errors="replace").read()
print("--- cart page empty-state hints ---")
for kw in ["\u8d2d\u7269\u8f66\u662f\u7a7a", "\u7a7a\u7684", "empty", "0 item", "\u7ed3\u8d26",
           "checkout", "line_item", "cart_count", "CartCount"]:
    n = html.lower().count(kw.lower())
    if n:
        i = html.lower().find(kw.lower())
        print("  %-12s x%d   ...%s..." % (kw, n, html[max(0, i - 80):i + 120].replace("\n", " ")))

wl = open(os.path.join(OUT, "steam_wishlist.html"), "r", encoding="utf-8", errors="replace").read()
m = re.search(r'g_cart\s*=\s*(\{.{0,300}?\})', wl, re.S)
print("--- wishlist page g_cart ---")
print("  ", (m.group(1)[:300] if m else "not found").replace("\n", " "))

cookies = read_cookies()
ck = cookie_header(cookies, "store.steampowered.com")
api_ck = cookie_header(cookies, "api.steampowered.com") or ck
wapit = re.search(r'g_wapit\s*=\s*"([^"]+)"', html).group(1)

# richer cart call
for params in ["", "&include_items=true", "&include_bundles=true&include_items=true"]:
    out = os.path.join(OUT, "steam_cart_api2.json")
    print("cart params='%s':" % params,
          fetch("https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=%s%s"
                % (wapit, params), api_ck, out))
    print("   ", open(out, encoding="utf-8", errors="replace").read()[:300])

# wishlist prices via IStoreBrowseService
wish = json.load(open(os.path.join(OUT, "steam_wish_api.json"), encoding="utf-8"))
ids = [it["appid"] for it in wish["response"]["items"]]
print("--- wishlist appids:", len(ids), ids[:8])
ids = ids[:6]
input_json = {
    "ids": [{"appid": a} for a in ids],
    "context": {"language": "schinese", "country_code": "CN", "steam_realm": 1},
    "data_request": {"include_basic_info": True, "include_release": True, "include_all_purchase_options": True},
}
url = ("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?access_token=%s&input_json=%s"
       % (wapit, urllib.parse.quote(json.dumps(input_json, separators=(",", ":")))))
print(fetch(url, api_ck, os.path.join(OUT, "steam_items.json")))
raw = open(os.path.join(OUT, "steam_items.json"), encoding="utf-8", errors="replace").read()
try:
    data = json.loads(raw)
    items = data["response"]["store_items"]
    print("store_items:", len(items))
    print(json.dumps(items[0], ensure_ascii=False)[:1200])
except Exception as ex:                                       # noqa: BLE001
    print("parse failed:", ex, raw[:300])
