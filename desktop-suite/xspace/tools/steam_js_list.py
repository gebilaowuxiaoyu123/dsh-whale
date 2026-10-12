# -*- coding: utf-8 -*-
"""List every script on the cart page and grep the cart-specific bundle for the API method names."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_cart_test import curl                       # noqa: E402
from steam_probe import OUT                            # noqa: E402

html = open(os.path.join(OUT, "steam_cart2.html"), encoding="utf-8", errors="replace").read()
srcs = re.findall(r'src="([^"]+\.js[^"]*)"', html)
print("scripts on cart page:", len(srcs))
report = []
for s in srcs:
    url = s.replace("&amp;", "&")
    name = re.sub(r"[^A-Za-z0-9_.~-]", "_", url.split("/")[-1].split("?")[0]) or "x.js"
    path = os.path.join(OUT, "js_" + name)
    if not os.path.exists(path) or os.path.getsize(path) < 1000:
        curl(url, "", out=path)
    size = os.path.getsize(path) if os.path.exists(path) else 0
    data = open(path, encoding="utf-8", errors="replace").read() if size else ""
    hits = sorted(set(re.findall(r"IAccountCartService[\w/]*", data)))
    cartish = sorted(set(re.findall(r"[\"'][\w/]*[Cc]art[\w/]*[\"']", data)))[:12]
    report.append("%-46s %8d bytes  cartService=%s cartish=%s" % (name, size, hits[:6], cartish))
    if "cart" in name.lower() or hits:
        report.append("    >>> CANDIDATE: " + url)
open(os.path.join(OUT, "cart_js_list.txt"), "w", encoding="utf-8").write("\n".join(report))
print("wrote cart_js_list.txt")
