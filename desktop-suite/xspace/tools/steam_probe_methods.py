# -*- coding: utf-8 -*-
"""Probe IAccountCartService method names (to find Add/Remove), then clean the test item out."""
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_cart_test import curl                       # noqa: E402
from steam_probe import cookie_header, read_cookies, OUT   # noqa: E402

ck = cookie_header(read_cookies(), "store.steampowered.com")
html = open(os.path.join(OUT, "steam_cart2.html"), encoding="utf-8", errors="replace").read()
wapit = re.search(r'g_wapit\s*=\s*"([^"]+)"', html).group(1)
tok = urllib.parse.quote(wapit)

candidates = ["AddItems", "AddToCart", "AddItemsToCart", "Add", "AddPackages", "AddPackage",
              "RemoveItems", "RemoveFromCart", "RemoveItemsFromCart", "Remove", "RemoveLineItem",
              "DeleteItems", "SetItems", "UpdateItems", "EmptyCart", "ClearCart"]
for name in candidates:
    url = "https://api.steampowered.com/IAccountCartService/%s/v1/?access_token=%s" % (name, tok)
    out = os.path.join(OUT, "probe.json")
    code = curl(url, ck, out=out)
    if not code.startswith("404"):
        body = open(out, encoding="utf-8", errors="replace").read()[:160] if os.path.exists(out) else ""
        print("HIT %-22s %s  %s" % (name, code, body.replace("\n", " ")))
print("probe done")
