# -*- coding: utf-8 -*-
"""Remove the temporary cart test item (try legacy form + SetLineItems), then verify the cart is empty."""
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_cart_test import curl                       # noqa: E402
from steam_probe import cookie_header, read_cookies, OUT   # noqa: E402

LOG = []


def log(*parts):
    line = " ".join(str(p) for p in parts)
    LOG.append(line)
    print(line.encode("ascii", "replace").decode("ascii"))   # 控制台是 GBK，避免中文报错


ck = cookie_header(read_cookies(), "store.steampowered.com")
html = open(os.path.join(OUT, "steam_cart2.html"), encoding="utf-8", errors="replace").read()
wapit = re.search(r'g_wapit\s*=\s*"([^"]+)"', html).group(1)
sid = (re.search(r'g_sessionID\s*=\s*"([^"]+)"', html) or [None, ""])[1]
tok = urllib.parse.quote(wapit)

cart = json.load(open(os.path.join(OUT, "cart_now.json"), encoding="utf-8"))
items = cart["response"]["cart"].get("line_items", [])
log("line_items before:", json.dumps(items, ensure_ascii=False))
lid = items[0]["line_item_id"] if items else ""
subid = items[0].get("packageid", 0) if items else 0

if items:
    for action, extra in (("remove_from_cart", "&line_item_id=%s" % lid),
                          ("remove_from_cart", "&subid=%s" % subid),
                          ("remove", "&line_item_id=%s" % lid)):
        body = "action=%s&sessionid=%s%s" % (action, sid, extra)
        code = curl("https://store.steampowered.com/cart/", ck, data=body,
                    out=os.path.join(OUT, "cart_rm.html"))
        log("legacy", action, extra, "->", code)

    for name, payload in (("SetLineItems", {"line_items": []}),
                          ("SetLineItems", {"cart": {"line_items": []}})):
        url = ("https://api.steampowered.com/IAccountCartService/%s/v1/?access_token=%s&input_json=%s"
               % (name, tok, urllib.parse.quote(json.dumps(payload, separators=(",", ":")))))
        out = os.path.join(OUT, "cart_setline.json")
        code = curl(url, ck, data="", out=out)
        txt = open(out, encoding="utf-8", errors="replace").read()[:200] if os.path.exists(out) else ""
        log(name, payload, "->", code, txt.replace("\n", " "))

url = "https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=" + tok
code = curl(url, ck, out=os.path.join(OUT, "cart_final.json"))
final = open(os.path.join(OUT, "cart_final.json"), encoding="utf-8", errors="replace").read()
log("final cart:", code, final[:400])
open(os.path.join(OUT, "cart_cleanup.log"), "w", encoding="utf-8").write("\n".join(LOG))
