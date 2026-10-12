# -*- coding: utf-8 -*-
"""Grep the store cart JS bundles for the cart API method names."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_cart_test import curl                       # noqa: E402
from steam_probe import OUT                            # noqa: E402

URLS = {
    "store_main.js": "https://store.st.dl.eccdnx.com/public/javascript/applications/store/main.js?v=VEM3WvDaaysv&l=schinese&_cdn=china_eccdnx",
    "store_dyn.js": "https://store.st.dl.eccdnx.com/public/javascript/dynamicstore.js?v=QUmAWFmBnJyI&l=schinese&_cdn=china_eccdnx",
    "store_shared.js": "https://store.st.dl.eccdnx.com/public/shared/javascript/shared_global.js?v=i4II62-Novzd&l=schinese&_cdn=china_eccdnx",
}
report = []
for name, url in URLS.items():
    path = os.path.join(OUT, name)
    if not os.path.exists(path) or os.path.getsize(path) < 1000:
        print(name, curl(url, "", out=path))
    data = open(path, encoding="utf-8", errors="replace").read()
    report.append("== %s (%d chars)" % (name, len(data)))
    for pat in (r"IAccountCartService[/\w]*", r"I[A-Za-z]+Service/[A-Za-z0-9_]+",
                r"[\w/]*cart[\w/]*\.js\?v=[\w\-]+", r"\"[^\"]*[Cc]art[^\"]*\",\s*\"[A-Za-z]+\""):
        hits = sorted(set(re.findall(pat, data)))
        for h in hits[:25]:
            report.append("   %s" % h)
    idx = data.find("CartService")
    if idx > 0:
        report.append("   ctx: " + data[max(0, idx - 200):idx + 200].replace("\n", " "))

open(os.path.join(OUT, "cart_js_methods.txt"), "w", encoding="utf-8").write("\n".join(report))
print("wrote cart_js_methods.txt, lines=%d" % len(report))
