# -*- coding: utf-8 -*-
"""Diagnose the app's cached Steam session: expiry, network paths, API reachability."""
import base64
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steam_probe import dpapi_unprotect, OUT   # noqa: E402

CACHE = os.path.join(os.environ["LOCALAPPDATA"], "XSpaceWidget", "steam_session.dat")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
log = []
def p(*a):
    line = " ".join(str(x) for x in a)
    log.append(line)
    print(line.encode("ascii", "replace").decode())

p("now:", time.strftime("%Y-%m-%d %H:%M:%S"))
p("cache exists:", os.path.exists(CACHE), "mtime:", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(CACHE))) if os.path.exists(CACHE) else "-")

def jwt_exp(tok):
    try:
        seg = tok.split(".")[1]
        seg += "=" * ((4 - len(seg) % 4) % 4)
        d = json.loads(base64.urlsafe_b64decode(seg.replace("-", "+").replace("_", "/")))
        return d.get("exp"), d
    except Exception as ex:                     # noqa: BLE001
        return None, {"err": str(ex)}

if os.path.exists(CACHE):
    raw = dpapi_unprotect(open(CACHE, "rb").read())
    d = json.loads(raw)
    ck = d.get("cookies", "")
    p("cookies len:", len(ck), "has steamLoginSecure:", "steamLoginSecure=" in ck)
    s2 = re.search(r"steamLoginSecure=([^;]+)", ck)
    if s2:
        exp, payload = jwt_exp(urllib.parse.unquote(s2.group(1)))
        p("steamLoginSecure exp:", exp, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(exp)) if exp else "-",
          "expired:", (exp is not None and exp < time.time()))
    p("wapit len:", len(d.get("wapit", "")))
    if d.get("wapit"):
        exp, _ = jwt_exp(d["wapit"])
        p("wapit exp:", exp, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(exp)) if exp else "-",
          "expired:", (exp is not None and exp < time.time()))
    p("sessionExpiry:", d.get("sessionExpiry"), time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(d["sessionExpiry"])) if d.get("sessionExpiry") else "-")
else:
    p("!! no cache")

# proxy port?
for port in (7890, 7891, 10808, 10809):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=0.4)
        s.close()
        p("proxy port open:", port)
    except Exception:                            # noqa: BLE001
        pass

def curl(url, cookie="", socks=False, timeout=15):
    args = ["curl.exe", "-s", "--max-time", str(timeout), "-H", "User-Agent: " + UA,
            "-o", os.path.join(OUT, "diag_body.txt"), "-w", "%{http_code}"]
    if cookie:
        args += ["-H", "Cookie: " + cookie]
    if socks:
        ip = None
        host = urllib.parse.urlparse(url).hostname
        try:
            ip = socket.gethostbyname(host)
        except Exception:                        # noqa: BLE001
            pass
        args = args[:1] + ["-x", "socks5://127.0.0.1:7890"] + args[1:]
        if ip and os.environ.get("WITH_RESOLVE"):
            args += ["--resolve", "%s:443:%s" % (host, ip)]
    return subprocess.run(args + [url], capture_output=True, text=True).stdout.strip()

if os.path.exists(CACHE) and d.get("cookies"):
    ck = d["cookies"]
    tests = [
        ("cart page (wapit)", "https://store.steampowered.com/cart/?cc=cn&l=schinese"),
        ("wishlist api", "https://api.steampowered.com/IWishlistService/GetWishlist/v1/?access_token=%s&steamid=76561199111949599"
         % urllib.parse.quote(d.get("wapit", ""))),
        ("getcart api", "https://api.steampowered.com/IAccountCartService/GetCart/v1/?access_token=%s"
         % urllib.parse.quote(d.get("wapit", ""))),
    ]
    for label, url in tests:
        direct = curl(url, ck, socks=False, timeout=12)
        proxied = curl(url, ck, socks=True, timeout=15)
        body = open(os.path.join(OUT, "diag_body.txt"), encoding="utf-8", errors="replace").read()[:120] if os.path.exists(os.path.join(OUT, "diag_body.txt")) else ""
        p("%-18s direct=%s socks5=%s  %s" % (label, direct, proxied, body.replace("\n", " ").encode("ascii", "replace").decode()))

# regenerate wapit from the cart page via socks5 and test the wishlist again
p("--- refresh wapit via socks5 ---")
code = curl("https://store.steampowered.com/cart/?cc=cn&l=schinese", d.get("cookies", ""), socks=True, timeout=20)
body = open(os.path.join(OUT, "diag_body.txt"), encoding="utf-8", errors="replace").read()
m = re.search(r'g_wapit\s*=\s*"([^"]+)"', body)
p("cart page:", code, "len:", len(body), "has g_wapit:", bool(m))
if m:
    neww = m.group(1)
    url = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/?access_token=%s&steamid=76561199111949599" % urllib.parse.quote(neww)
    p("wishlist with fresh wapit socks5:", curl(url, d["cookies"], socks=True, timeout=20),
      open(os.path.join(OUT, "diag_body.txt"), encoding="utf-8", errors="replace").read()[:160].encode("ascii", "replace").decode())
open(os.path.join(OUT, "steam_diag.txt"), "w", encoding="utf-8").write("\n".join(log))
