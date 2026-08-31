#!/usr/bin/env python3
"""Fetch the home screen's ticker quotes on a runner and write data/tickers.json.

Why this exists, established by probe_cors_proxies.py and probe_server_quotes.py
rather than assumed:

  - Yahoo sets no CORS headers, so the page can only reach it through public
    CORS proxies. All three the app knows about failed at once (two timed out,
    corsproxy.io now demands a paid key), and they flap - one was alive again
    an hour later. Nothing to build on.
  - Nasdaq answers a runner perfectly but sends no Access-Control-Allow-Origin,
    so a browser is never allowed to read it. Reachable is not the same as
    readable, which is the distinction that cost two failed attempts.
  - Stooq refuses runners outright (404, or an HTML page instead of CSV).

What is left is the shape the screener already uses and that has never failed:
fetch on a runner, commit the result, let the page read it same-origin. No
CORS involved anywhere.

Nasdaq quotes stocks and ETFs but no index level, forex pair or futures
contract, so each tile uses the liquid ETF that tracks it. The price is the
fund's, not the index's - the app labels the tiles accordingly.
"""
import datetime as dt
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "tickers.json")

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 "
              "Safari/537.36")

# Symbol -> what the tile stands for. Kept here rather than in the app so the
# two cannot drift: the app renders whatever this file contains.
SYMBOLS = ["SPY", "QQQ", "IBIT", "GLD", "USO"]

FETCH_DELAY = 0.3


def log(msg):
    print(msg, flush=True)


def session():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA,
                      "Accept": "application/json, text/plain, */*"})
    return s


def to_num(s):
    if s is None:
        return None
    txt = str(s).replace("$", "").replace(",", "").replace("%", "").strip()
    if not txt or txt in ("N/A", "--", "UNCH"):
        return None
    try:
        return float(txt)
    except ValueError:
        return None


def quote(sess, symbol):
    """(price, pct_change, market_status). None price if it did not answer."""
    url = (f"https://api.nasdaq.com/api/quote/{symbol}/info"
           f"?assetclass=etf")
    try:
        r = sess.get(url, timeout=20)
    except Exception as e:
        log(f"    {symbol}: {type(e).__name__}")
        return None, None, ""
    if r.status_code != 200:
        log(f"    {symbol}: HTTP {r.status_code}")
        return None, None, ""
    try:
        data = r.json().get("data") or {}
    except Exception:
        log(f"    {symbol}: non-JSON response")
        return None, None, ""
    pd = data.get("primaryData") or {}
    price = to_num(pd.get("lastSalePrice"))
    pct = to_num(pd.get("percentageChange"))
    status = data.get("marketStatus") or ""
    if price is None:
        log(f"    {symbol}: no price in response")
        return None, None, status
    log(f"    {symbol}: {price} ({pct:+.2f}%)" if pct is not None
        else f"    {symbol}: {price}")
    return price, pct, status


def main():
    sess = session()
    quotes = {}
    status = ""
    for sym in SYMBOLS:
        price, pct, st = quote(sess, sym)
        if price is not None:
            quotes[sym] = {"p": price, "c": pct}
            # Every symbol reports the same session; keep the first one seen.
            if not status and st:
                status = st
        time.sleep(FETCH_DELAY)

    if not quotes:
        # Writing an empty file would blank a working home screen. Leave the
        # last good one in place and fail loudly instead.
        log("ERROR: not a single quote came back - leaving the previous file "
            "alone rather than publishing an empty one.")
        return 1

    payload = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "marketStatus": status,
        "quotes": quotes,
    }
    os.makedirs(DATA, exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(payload, fh, indent=1, sort_keys=True)
        fh.write("\n")

    missing = [s for s in SYMBOLS if s not in quotes]
    log(f"Wrote {len(quotes)}/{len(SYMBOLS)} quotes, market {status or '?'}"
        + (f"; missing: {', '.join(missing)}" if missing else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
