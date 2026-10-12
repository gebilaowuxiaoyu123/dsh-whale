# -*- coding: utf-8 -*-
"""Check that IStoreBrowseService resolves a packageid (the cart line item only carries packageid)."""
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

for ids in ([{"packageid": 89783}], [{"appid": 431960}], [{"packageid": 89783}, {"appid": 949230}]):
    input_json = {
        "ids": ids,
        "context": {"language": "schinese", "country_code": "CN", "steam_realm": 1},
        "data_request": {"include_basic_info": True, "include_release": True, "include_all_purchase_options": True},
    }
    url = ("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?access_token=%s&input_json=%s"
           % (urllib.parse.quote(wapit), urllib.parse.quote(json.dumps(input_json, separators=(",", ":")))))
    p = os.path.join(OUT, "items_probe.json")
    code = curl(url, ck, out=p)
    raw = open(p, encoding="utf-8", errors="replace").read()
    try:
        items = json.loads(raw)["response"]["store_items"]
        brief = [{"id": i.get("id"), "name": i.get("name"), "price": (i.get("best_purchase_option") or {}).get("formatted_final_price"),
                  "pct": (i.get("best_purchase_option") or {}).get("discount_pct")} for i in items]
        print(code, json.dumps(ids), "->", json.dumps(brief, ensure_ascii=False).encode("ascii", "replace").decode())
    except Exception as ex:                                     # noqa: BLE001
        print(code, json.dumps(ids), "-> parse failed:", str(ex)[:80], raw[:120].encode("ascii", "replace").decode())
