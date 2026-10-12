# -*- coding: utf-8 -*-
"""Download the store cart JS bundle and extract the IAccountCartService method names."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_cart_test import curl                       # noqa: E402
from steam_probe import OUT                            # noqa: E402

JS = ("https://store.st.dl.eccdnx.com/public/javascript/applications/store/libraries~b28b7af69.js"
      "?v=Vc3ir9_n6fyO&l=schinese&_cdn=china_eccdnx")
out = os.path.join(OUT, "cart_js.js")
if not os.path.exists(out) or os.path.getsize(out) < 10000:
    print("download:", curl(JS, "", out=out))
data = open(out, encoding="utf-8", errors="replace").read()
print("js size:", len(data))
methods = sorted(set(re.findall(r"IAccountCartService/([A-Za-z0-9_]+)", data)))
print("IAccountCartService methods:", methods)
for m in re.findall(r"[\"'](/?I[A-Za-z]+Service/[A-Za-z0-9_/]+)[\"']", data)[:40]:
    print("  ", m)
for m in sorted(set(re.findall(r"(?:Add|Remove)[A-Za-z]*Cart[A-Za-z]*", data)))[:20]:
    print("  fn:", m)
idx = data.find("IAccountCartService")
if idx > 0:
    print("context:", data[max(0, idx - 400):idx + 400].replace("\n", " ")[:800])
