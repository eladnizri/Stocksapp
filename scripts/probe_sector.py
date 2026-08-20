#!/usr/bin/env python3
"""Find the cheapest free source of sector labels for ~520 US tickers.

Asking SEC for each company's SIC code costs one request per company. If
Nasdaq's screener returns a sector column in a single call, that is 500x
cheaper, so check that first and only fall back to SEC if it fails.
"""
import json
import sys
import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
SAMPLE = ["MU", "JPM", "XOM", "NEE", "AAPL", "PLD", "CAT", "KO", "LIN", "T"]


def line(t):
    print("\n" + "=" * 70 + f"\n{t}\n" + "=" * 70)


def s():
    x = requests.Session()
    x.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
    return x


def find_rows(node, depth=0):
    if depth > 6:
        return None
    if isinstance(node, list):
        if node and isinstance(node[0], dict) and "symbol" in node[0]:
            return node
        return None
    if isinstance(node, dict):
        for k in ("rows", "data", "records", "table"):
            if k in node:
                r = find_rows(node[k], depth + 1)
                if r:
                    return r
        for v in node.values():
            r = find_rows(v, depth + 1)
            if r:
                return r
    return None


line("1. Nasdaq screener - one request for the whole market?")
got = {}
for url in [
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25000&download=true",
    "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25000",
]:
    try:
        r = s().get(url, timeout=60)
        print(f"  HTTP {r.status_code}  {len(r.content)/1024:.0f}KB  {url[:62]}...")
        if r.status_code != 200:
            continue
        rows = find_rows(r.json()) or []
        print(f"  rows: {len(rows)}")
        if rows:
            print(f"  keys: {sorted(rows[0].keys())}")
            has = [k for k in rows[0] if "sector" in k.lower() or "industry" in k.lower()]
            print(f"  sector-ish keys: {has}")
            if has:
                for row in rows:
                    sym = str(row.get("symbol", "")).upper().replace(".", "-")
                    val = row.get(has[0])
                    if sym and val:
                        got[sym] = val
                print(f"  symbols with a sector: {len(got)}")
                break
    except Exception as e:
        print(f"  {type(e).__name__}: {e}")

if got:
    print("\n  sample:")
    for k in SAMPLE:
        print(f"    {k:5} -> {got.get(k, '(missing)')}")
    vals = {}
    for v in got.values():
        vals[v] = vals.get(v, 0) + 1
    print(f"\n  distinct sectors ({len(vals)}):")
    for k, v in sorted(vals.items(), key=lambda x: -x[1]):
        print(f"    {v:6}  {k}")

line("2. SEC submissions - SIC per company (the fallback)")
try:
    r = s().get("https://www.sec.gov/files/company_tickers.json",
                headers={"User-Agent": "stocksapp probe contact@example.com"},
                timeout=30)
    m = {v["ticker"].upper(): str(v["cik_str"]).zfill(10) for v in r.json().values()}
    print(f"  ticker->cik entries: {len(m)}")
    for sym in SAMPLE[:4]:
        cik = m.get(sym)
        if not cik:
            continue
        u = f"https://data.sec.gov/submissions/CIK{cik}.json"
        rr = s().get(u, headers={"User-Agent": "stocksapp probe contact@example.com"},
                     timeout=30)
        if rr.status_code == 200:
            d = rr.json()
            print(f"    {sym:5} SIC={d.get('sic')} {d.get('sicDescription')}")
        else:
            print(f"    {sym:5} HTTP {rr.status_code}")
except Exception as e:
    print(f"  {type(e).__name__}: {e}")

line("VERDICT")
if len(got) > 3000:
    print("  => Nasdaq screener covers the market in ONE request. Use it.")
    sys.exit(0)
print("  => Nasdaq insufficient; fall back to per-company SEC SIC codes.")
sys.exit(2)
