#!/usr/bin/env python3
"""Can Nasdaq's screener endpoint supply a wider universe for technical
scanning, in one request, with enough to filter out illiquid junk?

The scanner today only covers S&P 500 + Nasdaq-100 (518 symbols), which is
why small/mid-caps like SOFI and IREN never show up in it. This checks
whether the same endpoint sector labels already come from
(api.nasdaq.com/api/screener/stocks) also carries market cap and volume per
row, cheaply enough to build a much larger universe without a request per
symbol.
"""
import json
import sys

import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


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


def main():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*"})

    url = ("https://api.nasdaq.com/api/screener/stocks"
           "?tableonly=true&limit=25000&download=true")
    try:
        r = s.get(url, timeout=60)
    except Exception as e:
        print(f"FAILED: {type(e).__name__}")
        return 1
    print(f"HTTP {r.status_code}  {len(r.content)/1024:.0f}KB")
    if r.status_code != 200:
        print(r.text[:400])
        return 1

    rows = find_rows(r.json()) or []
    print(f"rows: {len(rows)}")
    if not rows:
        print("no rows found under any known key")
        return 1

    print(f"keys: {sorted(rows[0].keys())}")
    print("\nsample rows:")
    for row in rows[:5]:
        print(" ", {k: row.get(k) for k in
                     ("symbol", "name", "marketCap", "lastsale", "volume",
                      "sector", "industry", "country", "ipoyear")
                     if k in row})

    # How many rows carry a usable market cap, and what does the distribution
    # look like - this decides where a liquidity cutoff should sit.
    caps = []
    for row in rows:
        raw = str(row.get("marketCap", "") or "").replace(",", "").strip()
        try:
            v = float(raw)
            if v > 0:
                caps.append(v)
        except ValueError:
            continue
    caps.sort(reverse=True)
    print(f"\n{len(caps)}/{len(rows)} rows have a positive marketCap")
    if caps:
        for cutoff in (300_000_000, 500_000_000, 1_000_000_000, 2_000_000_000):
            n = sum(1 for c in caps if c >= cutoff)
            print(f"  >= ${cutoff/1e6:.0f}M: {n} symbols")

    # Country field, if present, is how ADRs/foreign listings could be
    # excluded - worth knowing before committing to a filter.
    countries = {}
    for row in rows:
        c = row.get("country") or "?"
        countries[c] = countries.get(c, 0) + 1
    top = sorted(countries.items(), key=lambda x: -x[1])[:6]
    print(f"\ntop countries: {top}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
