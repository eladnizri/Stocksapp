#!/usr/bin/env python3
"""Round 3: find a price-history source that works from a datacenter IP.

Settled so far:
  SEC EDGAR  - CONFIRMED. Fundamentals straight from filings. frames API
               returns one concept for thousands of filers per request.
  Yahoo      - BLOCKED from runners (429 on every endpoint).
  Stooq      - responded, but the CSV parsed to 2 empty rows. Debug it.

Still needed: daily OHLCV for ~600 symbols, to compute moving averages, RSI,
ATR and 52-week position for the screener.

Run:  python scripts/probe_yahoo.py
"""
import csv
import io
import sys
import time

import requests

SEC_UA = "Stocksapp-Screener/1.0 (eladn2006@gmail.com)"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 "
              "Safari/537.36")


def head(title):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


# --------------------------------------------------------------------------
# 1. Stooq - show the raw body so we can see why parsing produced empty rows
# --------------------------------------------------------------------------
def probe_stooq_raw():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA})
    variants = [
        ("csv daily",      "https://stooq.com/q/d/l/?s=mu.us&i=d"),
        ("csv daily range",
         "https://stooq.com/q/d/l/?s=mu.us&d1=20250101&d2=20260820&i=d"),
        ("csv no suffix",  "https://stooq.com/q/d/l/?s=mu&i=d"),
        ("quote light",    "https://stooq.com/q/l/?s=mu.us&f=sd2t2ohlcv&h&e=csv"),
        ("http scheme",    "http://stooq.com/q/d/l/?s=mu.us&i=d"),
    ]
    winner = None
    for label, url in variants:
        try:
            r = s.get(url, timeout=25)
        except Exception as e:
            print(f"  {label:16} EXC {type(e).__name__}")
            continue
        body = r.text
        print(f"  {label:16} HTTP {r.status_code} len={len(body)} "
              f"raw={body[:110]!r}")
        if r.status_code == 200 and "," in body and len(body) > 400:
            rows = list(csv.DictReader(io.StringIO(body)))
            if rows:
                print(f"  {'':16} -> {len(rows)} rows, "
                      f"cols={list(rows[0].keys())}, last={rows[-1]}")
                if len(rows) > 200:
                    winner = url
        time.sleep(0.5)
    return winner


# --------------------------------------------------------------------------
# 2. Stooq bulk archive - the entire US daily history in one download
# --------------------------------------------------------------------------
def probe_stooq_bulk():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA})
    url = "https://stooq.com/db/d/?b=d_us_txt"
    try:
        r = s.get(url, timeout=60, stream=True)
        chunk = next(r.iter_content(2048), b"")
        ctype = r.headers.get("Content-Type", "")
        clen = r.headers.get("Content-Length", "?")
        print(f"  HTTP {r.status_code} type={ctype} len={clen}")
        print(f"  first bytes={chunk[:60]!r}")
        r.close()
        return r.status_code == 200 and chunk[:2] == b"PK"
    except Exception as e:
        print(f"  EXC {type(e).__name__}: {e}")
        return False


# --------------------------------------------------------------------------
# 3. Public CORS proxies - do they let us reach Yahoo from a datacenter?
# --------------------------------------------------------------------------
def probe_proxied_yahoo():
    """The phone app already routes Yahoo through these when it hits CORS. If a
    proxy's own IP is not blocked, the runner can borrow the same trick."""
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA})
    target = ("https://query1.finance.yahoo.com/v8/finance/chart/MU"
              "?interval=1d&range=6mo")
    from urllib.parse import quote
    proxies = [
        ("corsproxy.io", f"https://corsproxy.io/?{quote(target, safe='')}"),
        ("allorigins",
         f"https://api.allorigins.win/raw?url={quote(target, safe='')}"),
        ("codetabs",
         f"https://api.codetabs.com/v1/proxy?quest={quote(target, safe='')}"),
        ("r.jina.ai", f"https://r.jina.ai/{target}"),
    ]
    winner = None
    for label, url in proxies:
        try:
            r = s.get(url, timeout=30)
        except Exception as e:
            print(f"  {label:14} EXC {type(e).__name__}")
            continue
        body = r.text
        ok = r.status_code == 200 and '"timestamp"' in body
        print(f"  {label:14} HTTP {r.status_code} len={len(body)} "
              f"usable={'YES' if ok else 'no'} body={body[:80]!r}")
        if ok and not winner:
            winner = label
        time.sleep(0.5)
    return winner


# --------------------------------------------------------------------------
# 4. SEC dei - shares outstanding, needed to turn price into market cap
# --------------------------------------------------------------------------
def probe_sec_shares():
    s = requests.Session()
    s.headers.update({"User-Agent": SEC_UA})
    tests = [
        ("dei shares outstanding", "dei",
         "EntityCommonStockSharesOutstanding", "shares", "CY2025Q2I"),
        ("us-gaap common shares", "us-gaap",
         "CommonStockSharesOutstanding", "shares", "CY2025Q2I"),
        ("weighted diluted", "us-gaap",
         "WeightedAverageNumberOfDilutedSharesOutstanding", "shares",
         "CY2025Q2"),
    ]
    ok = False
    for label, taxo, tag, unit, period in tests:
        url = (f"https://data.sec.gov/api/xbrl/frames/{taxo}/{tag}/{unit}/"
               f"{period}.json")
        try:
            r = s.get(url, timeout=30)
        except Exception as e:
            print(f"  {label:26} EXC {type(e).__name__}")
            continue
        if r.status_code != 200:
            print(f"  {label:26} HTTP {r.status_code}")
            continue
        data = r.json().get("data", [])
        mu = next((x for x in data if x.get("cik") == 723125), None)
        print(f"  {label:26} HTTP 200 filers={len(data):5} "
              f"MU={mu.get('val') if mu else 'n/a'}")
        ok = True
        time.sleep(0.15)
    return ok


# --------------------------------------------------------------------------
# 5. Other keyless price sources
# --------------------------------------------------------------------------
def probe_other_prices():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA,
                      "Accept": "application/json, text/plain, */*"})
    tests = [
        ("nasdaq historical",
         "https://api.nasdaq.com/api/quote/MU/historical"
         "?assetclass=stocks&fromdate=2025-08-20&todate=2026-08-20&limit=300"),
        ("nasdaq info", "https://api.nasdaq.com/api/quote/MU/info"
                        "?assetclass=stocks"),
        ("wsj quote",
         "https://www.wsj.com/market-data/quotes/MU/historical-prices/download"
         "?MOD=mw_quote&startDate=08/20/2025&endDate=08/20/2026"),
    ]
    winner = None
    for label, url in tests:
        try:
            r = s.get(url, timeout=30)
        except Exception as e:
            print(f"  {label:20} EXC {type(e).__name__}")
            continue
        body = r.text
        usable = r.status_code == 200 and len(body) > 500
        print(f"  {label:20} HTTP {r.status_code} len={len(body)} "
              f"body={body[:90]!r}")
        if usable and not winner:
            winner = label
        time.sleep(0.5)
    return winner


def main():
    head("1. STOOQ - raw response, all URL variants")
    stooq_url = probe_stooq_raw()

    head("2. STOOQ BULK - whole US market in one archive")
    bulk_ok = probe_stooq_bulk()

    head("3. YAHOO VIA PUBLIC CORS PROXY")
    proxy = probe_proxied_yahoo()

    head("4. SEC - shares outstanding (for market cap and P/E)")
    shares_ok = probe_sec_shares()

    head("5. OTHER KEYLESS PRICE SOURCES")
    other = probe_other_prices()

    head("VERDICT - price history for ~600 symbols")
    print(f"  stooq per-symbol csv : {stooq_url or 'FAIL'}")
    print(f"  stooq bulk archive   : {'OK' if bulk_ok else 'FAIL'}")
    print(f"  yahoo via proxy      : {proxy or 'FAIL'}")
    print(f"  sec shares out       : {'OK' if shares_ok else 'FAIL'}")
    print(f"  other sources        : {other or 'FAIL'}")
    print()
    if stooq_url or bulk_ok or proxy or other:
        print("  => GO. A price source is available.")
        return 0
    print("  => No price history source. Technicals must move to the device.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
