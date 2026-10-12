# -*- coding: utf-8 -*-
"""Probe cart API method names with POST (forced via socks5 for speed)."""
import json
import os
import re
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_probe import cookie_header, read_cookies, OUT   # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def post(url, cookie, data):
    args = ["curl.exe", "-s", "-x", "socks5://127.0.0.1:7890", "--max-time", "20",
            "-H", "User-Agent: " + UA, "-H", "Cookie: " + cookie,
            "-o", os.path.join(OUT, "probe3.json"), "-w", "%{http_code}", "-d", data, url]
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    code = r.stdout.strip()
    body = ""
    p = os.path.join(OUT, "probe3.json")
    if os.path.exists(p):
        body = open(p, encoding="utf-8", errors="replace").read()[:120].replace("\n", " ")
    return code, body


ck = cookie_header(read_cookies(), "store.steampowered.com")
html = open(os.path.join(OUT, "steam_cart2.html"), encoding="utf-8", errors="replace").read()
wapit = re.search(r'g_wapit\s*=\s*"([^"]+)"', html).group(1)
tok = urllib.parse.quote(wapit)

names = ["RemoveItemsFromCart", "RemoveLineItems", "RemoveCartItems", "RemoveItems", "DeleteItems",
         "DeleteCartItems", "DeleteLineItems", "RemoveFromCart", "RemovePackages", "RemoveBundles",
         "RemoveAllItems", "RemoveEverything", "EmptyCart", "ClearCart", "SetItems", "SetCart",
         "UpdateCart", "ModifyCart", "PurchaseCart", "RemoveCartLineItems", "RemoveLineItem",
         "DeleteLineItem", "AddItemsToCart", "SetCartLineItems", "RemoveItemFromCart"]
hits = []
for n in names:
    url = ("https://api.steampowered.com/IAccountCartService/%s/v1/?access_token=%s&input_json=%s"
           % (n, tok, urllib.parse.quote(json.dumps({"line_item_ids": ["4925770365"]}))))
    code, body = post(url, ck, "")
    if code and code != "404":
        hits.append("%s -> %s %s" % (n, code, body))
        print("HIT", n, code, body.encode("ascii", "replace").decode())
print("done, hits=%d" % len(hits))
open(os.path.join(OUT, "cart_probe3.txt"), "w", encoding="utf-8").write("\n".join(hits))
