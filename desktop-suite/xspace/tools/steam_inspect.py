# -*- coding: utf-8 -*-
"""Inspect the fetched Steam wishlist/cart pages for their embedded data structures."""
import json
import os
import re

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shots")


def show(name, patterns):
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        print("== %s MISSING" % name)
        return
    data = open(path, "r", encoding="utf-8", errors="replace").read()
    print("== %s  (%d chars)" % (name, len(data)))
    for label, pat in patterns:
        hits = [m.start() for m in re.finditer(pat, data, re.I)]
        print("   %-28s hits=%d" % (label, len(hits)))
        for h in hits[:3]:
            print("      ...%s..." % data[max(0, h - 90):h + 190].replace("\n", " ")[:300])


show("steam_cart.html", [
    ("cart_item", r"cart_item"),
    ("g_rgCartData", r"g_rgCartData"),
    ("data-cart", r"data-cart"),
    ("price/price", r'class="[^"]*price'),
    ("appid", r"appid"),
    ("packageid", r"packageid"),
    ("bundleid", r"bundleid"),
    ("CartCount", r"CartCount"),
    ("ScriptData", r"JSON\.parse"),
    ("dataLayer", r"dataLayer"),
    ("先登录/sign in", r"login/\?redir"),
])

show("steam_wishlist.html", [
    ("wishlistdata", r"wishlistdata"),
    ("g_rgWishlistData", r"g_rgWishlistData"),
    ("g_strWishlistURL", r"g_strWishlistURL"),
    ("app_id list", r'"appid"'),
    ("wishlist/app", r"/wishlist/app"),
    ("Sign in", r"login/\?redir"),
])

wish = os.path.join(OUT, "steam_wishlist.json")
if os.path.exists(wish):
    d = open(wish, "rb").read()
    print("== steam_wishlist.json  %d bytes  head=%r" % (len(d), d[:200]))
