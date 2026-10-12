# -*- coding: utf-8 -*-
"""Verify the cart is empty again (and remove the test item properly if not)."""
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


def get_cart():
    p = os.path.join(OUT, "cart_check.json")
    curl("https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=" + tok, ck, out=p)
    raw = open(p, encoding="utf-8", errors="replace").read()
    try:
        return json.loads(raw)["response"]["cart"].get("line_items", [])
    except Exception:                                          # noqa: BLE001
        return ["<parse failed>", raw[:200]]


items = get_cart()
print("cart line_items:", len(items), json.dumps(items, ensure_ascii=False).encode("ascii", "replace").decode())

if items and isinstance(items[0], dict):
    lid = items[0]["line_item_id"]
    for payload in ({"line_item_id": lid}, {"line_item_ids": [lid]}, {"cart": {"line_items": [{"line_item_id": lid}]}}):
        url = ("https://api.steampowered.com/IAccountCartService/RemoveItemFromCart/v1/?access_token=%s&input_json=%s"
               % (tok, urllib.parse.quote(json.dumps(payload, separators=(",", ":")))))
        p = os.path.join(OUT, "cart_rm2.json")
        code = curl(url, ck, data="", out=p)
        body = open(p, encoding="utf-8", errors="replace").read()[:120] if os.path.exists(p) else ""
        print("RemoveItemFromCart", json.dumps(payload), "->", code, body.encode("ascii", "replace").decode())
        items = get_cart()
        print("   now line_items:", len(items))
        if not items:
            break

print("FINAL cart line_items:", len(get_cart()))
