#!/usr/bin/env python3
"""Diagnostic probe: find a free data stack that works from a datacenter IP.

Round 1 established that Yahoo hard-blocks GitHub runners (429 on every
endpoint, including the cookie bootstrap). Yahoo still works fine from the
user's phone, so it stays as the on-device source - but the nightly 600-symbol
scan needs providers that tolerate server IPs.

Candidates under test:
  SEC EDGAR  - official, free, no key, explicitly allows automated access.
               The `frames` API returns one financial concept for EVERY filer
               in a single request, which is the only way to cover 600 symbols
               without 600x the traffic.
  Stooq      - free daily OHLCV as CSV, no key. Covers the technicals.
  Wikipedia  - constituent lists (already confirmed working).

Run:  python scripts/probe_yahoo.py
"""
import csv
import io
import json
import sys
import time

import requests

# SEC requires a descriptive User-Agent with contact info or it returns 403.
SEC_UA = "Stocksapp-Screener/1.0 (eladn2006@gmail.com)"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 "
              "Safari/537.36")


def head(title):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def sec_session():
    s = requests.Session()
    s.headers.update({"User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate"})
    return s


# --------------------------------------------------------------------------
# 1. Confirm the Yahoo block is IP-based and not a transient rate limit
# --------------------------------------------------------------------------
def probe_yahoo_retry():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA})
    codes = []
    for attempt in range(3):
        try:
            r = s.get("https://query1.finance.yahoo.com/v8/finance/chart/MU"
                      "?interval=1d&range=1mo", timeout=15)
            codes.append(r.status_code)
            print(f"  attempt {attempt + 1}: HTTP {r.status_code}")
            if r.status_code == 200:
                return True
        except Exception as e:
            codes.append(0)
            print(f"  attempt {attempt + 1}: EXC {type(e).__name__}")
        time.sleep(3)
    print(f"  -> codes={codes}; consistent 429 means the runner IP is blocked, "
          f"not throttled")
    return False


# --------------------------------------------------------------------------
# 2. SEC ticker -> CIK map
# --------------------------------------------------------------------------
def probe_sec_tickers(s):
    try:
        r = s.get("https://www.sec.gov/files/company_tickers.json", timeout=30)
    except Exception as e:
        print(f"  EXC {type(e).__name__}")
        return None
    print(f"  HTTP {r.status_code}, {len(r.content)} bytes")
    if r.status_code != 200:
        print(f"  body={r.text[:200]!r}")
        return None
    try:
        d = r.json()
    except Exception:
        print(f"  non-JSON: {r.text[:200]!r}")
        return None
    m = {}
    for row in d.values():
        m[row["ticker"]] = str(row["cik_str"]).zfill(10)
    print(f"  parsed {len(m)} tickers; "
          f"MU={m.get('MU')} AAPL={m.get('AAPL')} NVDA={m.get('NVDA')}")
    return m


# --------------------------------------------------------------------------
# 3. SEC frames API - one concept, all filers, one request
# --------------------------------------------------------------------------
def probe_sec_frames(s):
    """This is the make-or-break call for the screener: if one request returns
    a financial concept for thousands of companies, a 600-symbol scan is cheap."""
    tests = [
        ("Revenues", "us-gaap", "Revenues", "USD", "CY2025Q1"),
        ("RevenueFromContractWithCustomer", "us-gaap",
         "RevenueFromContractWithCustomerExcludingAssessedTax", "USD", "CY2025Q1"),
        ("NetIncomeLoss", "us-gaap", "NetIncomeLoss", "USD", "CY2025Q1"),
        ("Assets", "us-gaap", "Assets", "USD", "CY2025Q1I"),
        ("StockholdersEquity", "us-gaap", "StockholdersEquity", "USD", "CY2025Q1I"),
        ("EPS diluted", "us-gaap", "EarningsPerShareDiluted", "USD-per-shares",
         "CY2025Q1"),
    ]
    ok_any = False
    for label, taxo, tag, unit, period in tests:
        url = (f"https://data.sec.gov/api/xbrl/frames/{taxo}/{tag}/{unit}/"
               f"{period}.json")
        try:
            r = s.get(url, timeout=30)
        except Exception as e:
            print(f"  {label:38} EXC {type(e).__name__}")
            continue
        if r.status_code != 200:
            print(f"  {label:38} HTTP {r.status_code}")
            continue
        try:
            data = r.json().get("data", [])
        except Exception:
            print(f"  {label:38} non-JSON")
            continue
        ok_any = True
        sample = next((x for x in data if x.get("cik") == 723125), None)  # MU
        print(f"  {label:38} HTTP 200  filers={len(data):5}  "
              f"MU={sample.get('val') if sample else 'n/a'}")
        time.sleep(0.15)
    return ok_any


# --------------------------------------------------------------------------
# 4. SEC companyfacts - full history for one company
# --------------------------------------------------------------------------
def probe_sec_companyfacts(s, cik):
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    try:
        r = s.get(url, timeout=45)
    except Exception as e:
        print(f"  EXC {type(e).__name__}")
        return False
    print(f"  HTTP {r.status_code}, {len(r.content) / 1024:.0f} KB")
    if r.status_code != 200:
        return False
    d = r.json()
    facts = d.get("facts", {}).get("us-gaap", {})
    print(f"  entity={d.get('entityName')!r}, us-gaap concepts={len(facts)}")
    wanted = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
              "NetIncomeLoss", "Assets", "Liabilities", "StockholdersEquity",
              "EarningsPerShareDiluted", "CashAndCashEquivalentsAtCarryingValue",
              "NetCashProvidedByUsedInOperatingActivities",
              "PaymentsToAcquirePropertyPlantAndEquipment",
              "LongTermDebtNoncurrent", "GrossProfit", "OperatingIncomeLoss",
              "CommonStockSharesOutstanding"]
    have = [w for w in wanted if w in facts]
    print(f"  key concepts present: {len(have)}/{len(wanted)}")
    missing = [w for w in wanted if w not in facts]
    if missing:
        print(f"  missing: {', '.join(missing)}")
    return len(have) >= 8


# --------------------------------------------------------------------------
# 5. Stooq - daily OHLCV for technicals
# --------------------------------------------------------------------------
def probe_stooq():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA})
    ok = 0
    for sym in ["mu.us", "aapl.us", "nvda.us"]:
        url = f"https://stooq.com/q/d/l/?s={sym}&i=d"
        try:
            r = s.get(url, timeout=25)
        except Exception as e:
            print(f"  {sym}: EXC {type(e).__name__}")
            continue
        body = r.text
        if r.status_code != 200 or body.strip().lower().startswith("exceeded"):
            print(f"  {sym}: HTTP {r.status_code} body={body[:80]!r}")
            continue
        rows = list(csv.DictReader(io.StringIO(body)))
        if not rows:
            print(f"  {sym}: empty CSV body={body[:80]!r}")
            continue
        last = rows[-1]
        print(f"  {sym}: OK {len(rows)} daily rows, "
              f"last {last.get('Date')} close={last.get('Close')}")
        ok += 1
        time.sleep(0.3)
    return ok >= 2


# --------------------------------------------------------------------------
# 6. stockanalysis.com - unofficial all-in-one fallback
# --------------------------------------------------------------------------
def probe_stockanalysis():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA, "Accept": "application/json"})
    urls = [
        ("screener api",
         "https://stockanalysis.com/api/screener/s/f?m=marketCap&s=desc"
         "&c=no,s,n,marketCap,peRatio,revenueGrowth&cn=20"),
        ("quote MU", "https://stockanalysis.com/api/symbol/s/mu/overview"),
    ]
    ok = False
    for label, url in urls:
        try:
            r = s.get(url, timeout=25)
            body = r.text[:160]
            print(f"  {label}: HTTP {r.status_code} len={len(r.text)} "
                  f"body={body!r}")
            if r.status_code == 200 and r.text.strip().startswith("{"):
                ok = True
        except Exception as e:
            print(f"  {label}: EXC {type(e).__name__}")
    return ok


def main():
    head("1. YAHOO - confirm the block is by IP, not throttling")
    yahoo_ok = probe_yahoo_retry()

    s = sec_session()

    head("2. SEC EDGAR - ticker to CIK map")
    tickers = probe_sec_tickers(s)

    head("3. SEC EDGAR frames - one concept covers every filer at once")
    frames_ok = probe_sec_frames(s)

    head("4. SEC EDGAR companyfacts - full history for one company (MU)")
    facts_ok = False
    if tickers and tickers.get("MU"):
        facts_ok = probe_sec_companyfacts(s, tickers["MU"])
    else:
        print("  skipped - no CIK for MU")

    head("5. STOOQ - daily OHLCV for technicals")
    stooq_ok = probe_stooq()

    head("6. STOCKANALYSIS.COM - unofficial fallback")
    sa_ok = probe_stockanalysis()

    head("VERDICT")
    rows = [
        ("yahoo from runner", yahoo_ok),
        ("sec ticker->cik", bool(tickers)),
        ("sec frames (bulk)", frames_ok),
        ("sec companyfacts", facts_ok),
        ("stooq ohlcv", stooq_ok),
        ("stockanalysis", sa_ok),
    ]
    for label, ok in rows:
        print(f"  {label:22}: {'OK' if ok else 'FAIL'}")

    fundamentals = frames_ok or facts_ok or sa_ok
    technicals = stooq_ok or sa_ok
    print()
    if fundamentals and technicals:
        print("  => GO. Server-side scan is viable without Yahoo.")
        return 0
    print("  => Still short. fundamentals=%s technicals=%s"
          % (fundamentals, technicals))
    return 2


if __name__ == "__main__":
    sys.exit(main())
