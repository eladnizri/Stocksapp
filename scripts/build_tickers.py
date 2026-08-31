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
TILES = ["SPY", "QQQ", "IBIT", "GLD", "USO"]

ALERTS = os.path.join(DATA, "alerts.json")
MAX_SYMBOLS = 60          # a runaway watchlist should not stall the job
FETCH_DELAY = 0.25


def watched_symbols():
    """Everything the phone shows a live price for, from the file it syncs.

    The five tiles are always fetched. Beyond them the app writes its
    watchlist and open positions into data/alerts.json - the same file the
    alert checker already reads - so the runner can price those too. Before
    this, a watchlist symbol was still fetched on the phone through the CORS
    proxies, which is exactly the path that failed.
    """
    syms = list(TILES)
    try:
        with open(ALERTS) as fh:
            raw = json.load(fh)
    except Exception:
        return syms

    def add(sym):
        sym = str(sym or "").strip().upper()
        if sym and sym not in syms:
            syms.append(sym)

    for a in (raw.get("alerts") or []):
        if isinstance(a, dict):
            add(a.get("s"))
    for w in (raw.get("watch") or []):
        add(w)
    for pos in (raw.get("positions") or []):
        if isinstance(pos, dict):
            add(pos.get("s"))
    return syms[:MAX_SYMBOLS]


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


def quote_one(sess, symbol, assetclass):
    url = (f"https://api.nasdaq.com/api/quote/{symbol}/info"
           f"?assetclass={assetclass}")
    try:
        r = sess.get(url, timeout=20)
    except Exception as e:
        return None, None, "", type(e).__name__
    if r.status_code != 200:
        return None, None, "", f"HTTP {r.status_code}"
    try:
        data = r.json().get("data") or {}
    except Exception:
        return None, None, "", "non-JSON"
    pd = data.get("primaryData") or {}
    return (to_num(pd.get("lastSalePrice")), to_num(pd.get("percentageChange")),
            data.get("marketStatus") or "", "")


def quote(sess, symbol):
    """(price, pct_change, market_status). None price if nothing answered.

    Nasdaq partitions by asset class and returns nothing at all for the wrong
    one, so a watchlist of ordinary stocks needs "stocks" while the tiles need
    "etf". Tiles are known ETFs; everything else tries stocks first, since
    that is what a watchlist mostly holds.
    """
    order = ("etf", "stocks") if symbol in TILES else ("stocks", "etf")
    why = ""
    for assetclass in order:
        price, pct, status, err = quote_one(sess, symbol, assetclass)
        why = why or err
        if price is not None:
            log(f"    {symbol}: {price}" +
                (f" ({pct:+.2f}%)" if pct is not None else "") +
                (f" [{assetclass}]" if assetclass != order[0] else ""))
            return price, pct, status
        time.sleep(FETCH_DELAY)
    log(f"    {symbol}: unavailable{(' - ' + why) if why else ''}")
    return None, None, ""


def main():
    sess = session()
    symbols = watched_symbols()
    log(f"{len(symbols)} symbol(s): {', '.join(symbols)}")
    quotes = {}
    status = ""
    for sym in symbols:
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

    missing = [s for s in symbols if s not in quotes]
    log(f"Wrote {len(quotes)}/{len(symbols)} quotes, market {status or '?'}"
        + (f"; missing: {', '.join(missing)}" if missing else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
