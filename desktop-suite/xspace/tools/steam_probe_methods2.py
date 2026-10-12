# -*- coding: utf-8 -*-
"""Probe IAccountCartService removal method name with POST, then remove the test line item."""
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
names = ["RemoveItemsFromCart", "RemoveFromCart", "RemoveItems", "UpdateItems", "UpdateCartItems",
         "SetItems", "SetCartItems", "DeleteItems", "DeleteItemsFromCart", "ClearCart", "EmptyCart",
         "RemoveAllItems", "ModifyItems", "UpdateLineItems", "SetLineItems", "RemovePackages"]
hits = []
for n in names:
    url = "https://api.steampowered.com/IAccountCartService/%s/v1/?access_token=%s" % (n, tok)
    out = os.path.join(OUT, "probe2.json")
    code = curl(url, ck, data="{}", out=out)
    if not code.startswith("404"):
        body = open(out, encoding="utf-8", errors="replace").read()[:150] if os.path.exists(out) else ""
        hits.append(n)
        print("HIT %-22s %s %s" % (n, code, body.replace("\n", " ")))
print("hits:", hits)
with open(os.path.join(OUT, "cart_hits.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(hits))
