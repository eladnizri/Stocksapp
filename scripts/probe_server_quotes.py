#!/usr/bin/env python3
"""Which sources can a RUNNER fetch the seven home-screen tickers from?

Established the hard way:
  - Yahoo answers 429 to datacenter IPs, so a runner cannot use it.
  - Nasdaq answers a runner fine but sends no Access-Control-Allow-Origin,
    so a browser can never read it - server-side only.
  - The public CORS proxies flap: all three dead one hour, one alive the next.

So the durable path is to fetch on a runner and commit the result, the way
data/screener.json already works. That only needs a source reachable from a
runner - CORS stops mattering entirely. This finds which one, per symbol,
before any of it gets built on.

Run: python scripts/probe_server_quotes.py
"""
import sys
import time

import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# What the home screen shows, and the candidate symbol at each source.
# stooq quotes indices, forex and futures that Nasdaq has no listing for.
WANTED = [
    ("S&P 500",     {"stooq": "^spx",   "nasdaq_etf": "SPY"}),
    ("Nasdaq",      {"stooq": "^ndq",   "nasdaq_etf": "QQQ"}),
    ("VIX",         {"stooq": "^vix",   "nasdaq_etf": None}),
    ("Bitcoin",     {"stooq": "btcusd", "nasdaq_etf": "IBIT"}),
    ("USD/ILS",     {"stooq": "usdils", "nasdaq_etf": None}),
    ("Gold",        {"stooq": "xauusd", "nasdaq_etf": "GLD"}),
    ("Oil (WTI)",   {"stooq": "cl.f",   "nasdaq_etf": "USO"}),
]


def log(m):
    print(m, flush=True)


def sess():
    s = requests.Session()
    s.headers.update({"User-Agent": UA,
                      "Accept": "text/csv, application/json, text/plain, */*"})
    return s


def stooq_light(s, sym):
    """Stooq's light quote: one CSV row, symbol/date/time/OHLC/volume."""
    url = f"https://stooq.com/q/l/?s={sym}&f=sd2t2ohlcv&h&e=csv"
    try:
        r = s.get(url, timeout=20)
    except Exception as e:
        return None, f"EXC {type(e).__name__}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    body = r.text.strip()
    lines = body.splitlines()
    if len(lines) < 2:
        return None, f"no rows: {body[:60]!r}"
    head = [h.strip().lower() for h in lines[0].split(",")]
    row = [c.strip() for c in lines[1].split(",")]
    rec = dict(zip(head, row))
    close = rec.get("close")
    if not close or close.upper() in ("N/D", "N/A", ""):
        return None, f"no close: {row}"
    try:
        return float(close), f"ok ({rec.get('date','')} {rec.get('time','')})"
    except ValueError:
        return None, f"unparseable close {close!r}"


def stooq_daily(s, sym):
    """Stooq's daily history CSV - the form the snapshot probe found working."""
    url = f"https://stooq.com/q/d/l/?s={sym}&i=d"
    try:
        r = s.get(url, timeout=25)
    except Exception as e:
        return None, f"EXC {type(e).__name__}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    lines = r.text.strip().splitlines()
    if len(lines) < 2:
        return None, f"no rows: {r.text[:60]!r}"
    head = [h.strip().lower() for h in lines[0].split(",")]
    last = [c.strip() for c in lines[-1].split(",")]
    rec = dict(zip(head, last))
    try:
        return float(rec["close"]), f"ok (last {rec.get('date','')}, {len(lines)-1} rows)"
    except (KeyError, ValueError):
        return None, f"unparseable {last}"


def nasdaq_etf(s, sym):
    if not sym:
        return None, "no ETF equivalent"
    url = f"https://api.nasdaq.com/api/quote/{sym}/info?assetclass=etf"
    try:
        r = s.get(url, timeout=20)
    except Exception as e:
        return None, f"EXC {type(e).__name__}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    try:
        pd = ((r.json().get("data") or {}).get("primaryData") or {})
    except Exception:
        return None, "non-JSON"
    raw = pd.get("lastSalePrice")
    if not raw:
        return None, "no lastSalePrice"
    try:
        return float(str(raw).replace("$", "").replace(",", "")), \
            f"ok ({pd.get('percentageChange')})"
    except ValueError:
        return None, f"unparseable {raw!r}"


def main():
    s = sess()
    log(f"{'tile':12} {'source':14} {'value':>12}  note")
    log("-" * 72)
    covered = {}
    for label, syms in WANTED:
        best = None
        for source, fn, arg in (
            ("stooq light", stooq_light, syms["stooq"]),
            ("stooq daily", stooq_daily, syms["stooq"]),
            ("nasdaq etf", nasdaq_etf, syms["nasdaq_etf"]),
        ):
            val, note = fn(s, arg) if arg else (None, "n/a")
            shown = f"{val:,.4f}" if val is not None else "-"
            log(f"{label:12} {source:14} {shown:>12}  {note}")
            if val is not None and best is None:
                best = (source, val)
            time.sleep(0.4)
        covered[label] = best
        log("")

    log("=" * 72)
    log("BEST AVAILABLE PER TILE")
    missing = []
    for label, _ in WANTED:
        b = covered.get(label)
        if b:
            log(f"  {label:12} <- {b[0]} ({b[1]:,.4f})")
        else:
            log(f"  {label:12} <- NOTHING WORKS")
            missing.append(label)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
