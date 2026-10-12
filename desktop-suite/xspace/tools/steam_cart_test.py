# -*- coding: utf-8 -*-
"""Temporarily add one game to the Steam cart, dump the real line_items shape, then remove it.

Goal: verify the cart parsing path (the user's cart is normally empty).
Everything is reverted at the end (cart back to empty).
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_probe import cookie_header, read_cookies, OUT   # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TEST_APPID = 431960          # Wallpaper Engine（在愿望单里，便宜，验证完就移除）
_direct_ok = None


def curl(url, cookie="", data=None, out=None, method=None):
    """先试直连，失败则走 SOCKS5 + 本地解析（绕过代理规则的 Steam 直连分流）。"""
    global _direct_ok
    common = ["curl.exe", "-s", "--max-time", "40", "-H", "User-Agent: " + UA,
              "-H", "Accept-Language: zh-CN,zh;q=0.9"]
    if cookie:
        common += ["-H", "Cookie: " + cookie]
    if data is not None:
        common += ["--data-urlencode", "input_json=" + data] if False else ["-d", data]
    if out:
        common += ["-o", out, "-w", "%{http_code} %{size_download}B"]
    if method:
        common += ["-X", method]

    for label, prefix in (("direct", []), ("socks5", ["-x", "socks5://127.0.0.1:7890"])):
        if label == "socks5" and _direct_ok is not False:
            break
        args = common[:1] + prefix + common[1:]
        r = subprocess.run(args + [url], capture_output=True, text=True, encoding="utf-8", errors="replace")
        txt = r.stdout.strip()
        code = txt.split(" ")[0] if out else ""
        if out and code and code != "000":
            _direct_ok = (label == "direct")
            return txt
        if not out:
            _direct_ok = (label == "direct")
            return txt
        _direct_ok = False
        print("   (%s 失败，改走 socks5)" % label)
    return "000"


def main():
    cookies = read_cookies()
    ck = cookie_header(cookies, "store.steampowered.com")
    print("cookie len:", len(ck))

    cart_html = os.path.join(OUT, "steam_cart2.html")
    print("cart page:", curl("https://store.steampowered.com/cart/?cc=cn&l=schinese", ck, out=cart_html))
    html = open(cart_html, encoding="utf-8", errors="replace").read()
    m = re.search(r'g_wapit\s*=\s*"([^"]+)"', html)
    if not m:
        print("!! no g_wapit")
        return 1
    wapit = m.group(1)
    print("wapit ok, len", len(wapit))

    def api(method, params=""):
        url = ("https://api.steampowered.com/IAccountCartService/%s/v1/?access_token=%s%s"
               % (method, urllib.parse.quote(wapit), params))
        out = os.path.join(OUT, "cart_%s.json" % method)
        code = curl(url, ck, out=out)
        raw = open(out, encoding="utf-8", errors="replace").read() if os.path.exists(out) else ""
        print("%-12s %s  %s" % (method, code, raw[:400].replace("\n", " ")))
        return raw

    print("--- before ---")
    api("GetCart")

    print("--- add appid %d ---" % TEST_APPID)
    body = json.dumps({"items": [{"appid": TEST_APPID}]}, separators=(",", ":"))
    raw = api("AddItems", "&input_json=" + urllib.parse.quote(body))
    line_item_id = ""
    try:
        d = json.loads(raw)
        cart = d.get("response", {}).get("cart", {})
        items = cart.get("line_items", [])
        print("   line_items:", len(items))
        if items:
            line_item_id = items[0].get("line_item_id", "")
            open(os.path.join(OUT, "cart_line_item_dump.txt"), "w", encoding="utf-8").write(
                json.dumps(items[0], ensure_ascii=False, indent=1))
            print("   dumped cart_line_item_dump.txt ; line_item_id=", line_item_id)
    except Exception as ex:                                        # noqa: BLE001
        print("   parse:", ex)

    print("--- after add ---")
    raw = api("GetCart")
    try:
        d = json.loads(raw)
        cart = d.get("response", {}).get("cart", {})
        print("   line_items=", len(cart.get("line_items", [])), " keys=", list(cart.keys()))
        open(os.path.join(OUT, "cart_after_add.txt"), "w", encoding="utf-8").write(
            json.dumps(cart, ensure_ascii=False, indent=1))
    except Exception as ex:                                        # noqa: BLE001
        print("   parse:", ex)

    if line_item_id:
        print("--- remove %s ---" % line_item_id)
        body = json.dumps({"line_item_ids": [line_item_id]}, separators=(",", ":"))
        api("RemoveItems", "&input_json=" + urllib.parse.quote(body))
        print("--- final cart ---")
        api("GetCart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
