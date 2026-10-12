# -*- coding: utf-8 -*-
"""Dump the shape of IStoreBrowseService store items (for parser design)."""
import json
import os
import sys

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shots")
data = json.load(open(os.path.join(OUT, "steam_items.json"), encoding="utf-8"))
items = data["response"]["store_items"]
lines = []
for it in items:
    lines.append("### item id=%s name=%s type=%s" % (it.get("id"), it.get("name"), it.get("type")))
    lines.append(json.dumps(it, ensure_ascii=False, indent=1))
    lines.append("")
open(os.path.join(OUT, "steam_items_dump.txt"), "w", encoding="utf-8").write("\n".join(lines))
print("wrote steam_items_dump.txt")

# also dump wishlist raw
w = json.load(open(os.path.join(OUT, "steam_wish_api.json"), encoding="utf-8"))
open(os.path.join(OUT, "steam_wish_dump.txt"), "w", encoding="utf-8").write(
    json.dumps(w, ensure_ascii=False, indent=1))
print("wrote steam_wish_dump.txt")
