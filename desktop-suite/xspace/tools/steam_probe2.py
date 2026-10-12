# -*- coding: utf-8 -*-
"""Quick check: can we read the (locked) Steam CEF cookie DB with a plain file read?"""
import os
import sqlite3
import tempfile

p = os.path.join(os.environ["LOCALAPPDATA"], "Steam", "htmlcache", "Default", "Network", "Cookies")
try:
    data = open(p, "rb").read()
    print("plain open ok bytes=", len(data), data[:16])
except Exception as ex:                                       # noqa: BLE001
    print("plain open failed:", ex)
    raise SystemExit(1)

t = os.path.join(tempfile.gettempdir(), "ck.db")
open(t, "wb").write(data)
con = sqlite3.connect(t)
print("tables=", [r[0] for r in con.execute("select name from sqlite_master where type='table'")])
try:
    print("count=", list(con.execute("select count(*) from cookies")))
    print("hosts=", [r[0] for r in con.execute(
        "select distinct host_key from cookies where host_key like '%steam%'")])
    print("names=", [(r[0], r[1]) for r in con.execute(
        "select host_key, name from cookies where host_key like '%steampowered%'")])
except Exception as ex:                                       # noqa: BLE001
    print("query failed:", ex)
