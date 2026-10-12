# -*- coding: utf-8 -*-
"""Try the legacy store form POST to add a package to the cart, then dump the cart JSON."""
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_cart_test import curl                      # noqa: E402
from steam_probe import cookie_header, read_cookies, OUT   # noqa: E402

PACKAGE_ID = 89783          # Wallpaper Engine

ck = cookie_header(read_cookies(), "store.steampowered.com")
html = open(os.path.join(OUT, "steam_cart2.html"), encoding="utf-8", errors="replace").read()
wapit = re.search(r'g_wapit\s*=\s*"([^"]+)"', html).group(1)
m = re.search(r'g_sessionID\s*=\s*"([^"]+)"', html)
sid = m.group(1) if m else ""
print("sessionid:", sid)

data = "action=add_to_cart&sessionid=%s&subid=%d" % (sid, PACKAGE_ID)
print("legacy add:", curl("https://store.steampowered.com/cart/", ck, data=data,
                          out=os.path.join(OUT, "cart_add2.html")))

u = "https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=" + urllib.parse.quote(wapit)
print("cart now:", curl(u, ck, out=os.path.join(OUT, "cart_now.json")))
print(open(os.path.join(OUT, "cart_now.json"), encoding="utf-8", errors="replace").read()[:800])
