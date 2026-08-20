#!/usr/bin/env python3
"""Find free sources for analyst targets and the next earnings date.

The app currently asks Yahoo for both from the device, and Yahoo gates that
endpoint behind a cookie+crumb, so it reports "not available" most of the time.
Nasdaq's API already backs the price history in the nightly scan, so if it
carries these too they belong in the snapshot instead - fetched once on a
runner rather than fought for on every phone.
"""
import datetime as dt
import json
import sys

import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
SYMS = ["MU", "AAPL", "JPM", "NVDA"]


def sess():
    s = requests.Session()
    s.headers.update({"User-Agent": UA,
                      "Accept": "application/json, text/plain, */*"})
    return s


def head(t):
    print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


def show(name, url, keep=900):
    try:
        r = sess().get(url, timeout=30)
    except Exception as e:
        print(f"  {name}: {type(e).__name__}")
        return None
    print(f"  {name}: HTTP {r.status_code} ({len(r.content)} bytes)")
    if r.status_code != 200:
        return None
    try:
        d = r.json()
    except Exception:
        print(f"    non-JSON: {r.text[:160]!r}")
        return None
    body = json.dumps(d, ensure_ascii=False)
    print(f"    {body[:keep]}")
    return d


head("1. Analyst price targets")
for sym in SYMS[:2]:
    show(f"{sym} targetprice",
         f"https://api.nasdaq.com/api/analyst/{sym}/targetprice")

head("2. Analyst ratings / recommendation mix")
for sym in SYMS[:2]:
    show(f"{sym} ratings",
         f"https://api.nasdaq.com/api/analyst/{sym}/ratings")

head("3. Quote info - may carry the next report date")
for sym in SYMS[:2]:
    show(f"{sym} info",
         f"https://api.nasdaq.com/api/quote/{sym}/info?assetclass=stocks")

head("4. Earnings date, per company")
for sym in SYMS[:2]:
    for path in (f"https://api.nasdaq.com/api/company/{sym}/earnings-date",
                 f"https://api.nasdaq.com/api/company/{sym}/earnings-surprise",
                 f"https://api.nasdaq.com/api/analyst/{sym}/earnings-date"):
        show(f"{sym} {path.rsplit('/', 1)[1]}", path, keep=400)

head("5. Earnings calendar by day - one request covers every company")
today = dt.date.today()
for offset in (1, 2, 7):
    day = today + dt.timedelta(days=offset)
    d = show(f"calendar {day}",
             f"https://api.nasdaq.com/api/calendar/earnings?date={day}",
             keep=500)
    if d:
        rows = (((d.get("data") or {}).get("rows")) or [])
        print(f"    rows: {len(rows)}")
        if rows:
            print(f"    keys: {sorted(rows[0].keys())}")

head("6. SEC - does the company facts feed carry a FUTURE report date?")
print("  (SEC publishes filings after the fact, so expect no forward date;")
print("   checking only to rule it out as a source.)")

head("VERDICT")
print("  Read the sections above: any endpoint returning 200 with a usable")
print("  target price or a forward date can move into the nightly snapshot.")
sys.exit(0)
