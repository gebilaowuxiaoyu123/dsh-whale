# -*- coding: utf-8 -*-
"""Find the API endpoints / embedded JSON used by the modern Steam cart & wishlist pages."""
import os
import re

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shots")


def endpoints(name):
    path = os.path.join(OUT, name)
    data = open(path, "r", encoding="utf-8", errors="replace").read()
    print("== %s (%d chars)" % (name, len(data)))
    pats = [r"/api/[A-Za-z0-9_/\-]+", r"/dynamicstore/[A-Za-z0-9_/\-?=&]+",
            r"/wishlist/[A-Za-z0-9_/\-]+", r"/cart/[A-Za-z0-9_/\-]*",
            r"/I[A-Za-z]+Service/[A-Za-z0-9_/]+", r"store\.steampowered\.com/[A-Za-z0-9_/\-]*",
            r"window\.[A-Za-z_$]{3,40}\s*=", r"data-[a-z_]*cart[a-z_]*", r"g_[A-Za-z_]{4,30}"]
    seen = {}
    for p in pats:
        for m in re.finditer(p, data):
            seen.setdefault(m.group(0), 0)
            seen[m.group(0)] += 1
    for k, v in sorted(seen.items(), key=lambda kv: -kv[1])[:60]:
        print("   %4d  %s" % (v, k))


endpoints("steam_cart.html")
endpoints("steam_wishlist.html")
