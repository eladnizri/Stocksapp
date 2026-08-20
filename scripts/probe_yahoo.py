#!/usr/bin/env python3
"""Diagnostic probe: determine exactly which free data sources work from a
GitHub Actions runner, and which fields they actually populate.

This exists because the data layer for the whole app rests on Yahoo's
undocumented endpoints. Rather than guess, we run this once on the real
runner and read the report.

Run:  python scripts/probe_yahoo.py
"""
import json
import sys
import time

import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

SYMBOLS = ["MU", "AAPL", "NVDA"]

MODULES = [
    "price", "summaryDetail", "financialData", "defaultKeyStatistics",
    "assetProfile", "recommendationTrend", "earningsTrend", "calendarEvents",
]

# The fields the analysis page and screener actually need, grouped by module.
NEEDED = {
    "price": ["regularMarketPrice", "regularMarketChangePercent", "shortName",
              "longName", "currency", "exchangeName"],
    "summaryDetail": ["marketCap", "trailingPE", "forwardPE", "dividendYield",
                      "beta", "fiftyTwoWeekLow", "fiftyTwoWeekHigh",
                      "fiftyDayAverage", "twoHundredDayAverage",
                      "averageVolume", "priceToSalesTrailing12Months"],
    "financialData": ["targetHighPrice", "targetLowPrice", "targetMeanPrice",
                      "recommendationMean", "recommendationKey",
                      "numberOfAnalystOpinions", "totalCash", "totalDebt",
                      "currentRatio", "quickRatio", "totalRevenue",
                      "debtToEquity", "returnOnAssets", "returnOnEquity",
                      "freeCashflow", "operatingCashflow", "revenueGrowth",
                      "earningsGrowth", "grossMargins", "operatingMargins",
                      "profitMargins", "ebitdaMargins"],
    "defaultKeyStatistics": ["enterpriseValue", "forwardPE", "pegRatio",
                             "priceToBook", "trailingEps", "forwardEps",
                             "bookValue", "sharesOutstanding", "beta",
                             "earningsQuarterlyGrowth", "enterpriseToRevenue",
                             "enterpriseToEbitda", "52WeekChange",
                             "shortPercentOfFloat"],
    "assetProfile": ["sector", "industry", "fullTimeEmployees"],
}


def line(ch="-", n=72):
    print(ch * n)


def head(title):
    print()
    line("=")
    print(title)
    line("=")


def new_session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "application/json,*/*"})
    return s


def get_crumb(s):
    """Yahoo gates quoteSummary behind a cookie+crumb pair. Try the known
    bootstrap routes in order and return the first crumb we manage to get."""
    routes = [
        ("fc.yahoo.com", "https://fc.yahoo.com/"),
        ("finance home", "https://finance.yahoo.com/"),
        ("quote page", "https://finance.yahoo.com/quote/AAPL"),
    ]
    for name, url in routes:
        try:
            s.get(url, timeout=15)
        except Exception as e:
            print(f"  bootstrap via {name}: EXC {type(e).__name__}")
            continue
        try:
            r = s.get("https://query2.finance.yahoo.com/v1/test/getcrumb",
                      timeout=15)
            crumb = (r.text or "").strip()
            ok = r.status_code == 200 and crumb and "<" not in crumb and len(crumb) < 40
            print(f"  bootstrap via {name}: HTTP {r.status_code} crumb={crumb!r} "
                  f"cookies={len(s.cookies)} -> {'OK' if ok else 'no'}")
            if ok:
                return crumb
        except Exception as e:
            print(f"  bootstrap via {name}: crumb EXC {type(e).__name__}")
    return None


def try_quote_summary(s, sym, crumb=None, host="query2"):
    url = (f"https://{host}.finance.yahoo.com/v10/finance/quoteSummary/{sym}"
           f"?modules={','.join(MODULES)}")
    if crumb:
        url += f"&crumb={crumb}"
    try:
        r = s.get(url, timeout=20)
    except Exception as e:
        return None, f"EXC {type(e).__name__}: {e}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code} body={r.text[:120]!r}"
    try:
        d = r.json()
    except Exception:
        return None, f"non-JSON body={r.text[:120]!r}"
    res = (d.get("quoteSummary") or {}).get("result")
    if not res:
        err = (d.get("quoteSummary") or {}).get("error")
        return None, f"no result, error={err}"
    return res[0], "OK"


def unwrap(v):
    """Yahoo wraps numbers as {'raw':..,'fmt':..}; unwrap to a plain value."""
    if isinstance(v, dict):
        if "raw" in v:
            return v["raw"]
        if not v:
            return None
        return v
    return v


def report_coverage(data):
    total = filled = 0
    for mod, fields in NEEDED.items():
        block = data.get(mod)
        if block is None:
            print(f"  [{mod}] MODULE MISSING ({len(fields)} fields lost)")
            total += len(fields)
            continue
        got, miss = [], []
        for f in fields:
            v = unwrap(block.get(f))
            total += 1
            if v is None or v == {}:
                miss.append(f)
            else:
                filled += 1
                got.append(f)
        print(f"  [{mod}] {len(got)}/{len(fields)} present")
        if miss:
            print(f"      missing: {', '.join(miss)}")
    print(f"  TOTAL FIELD COVERAGE: {filled}/{total}")
    return filled, total


def probe_chart(s, sym):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1d&range=1y")
    try:
        r = s.get(url, timeout=20)
    except Exception as e:
        print(f"  {sym}: EXC {type(e).__name__}")
        return False
    if r.status_code != 200:
        print(f"  {sym}: HTTP {r.status_code}")
        return False
    try:
        res = r.json()["chart"]["result"][0]
        closes = res["indicators"]["quote"][0]["close"]
        n = sum(1 for c in closes if c is not None)
        meta = res.get("meta", {})
        print(f"  {sym}: OK {n} daily closes, currency={meta.get('currency')}, "
              f"last={meta.get('regularMarketPrice')}")
        return n > 200
    except Exception as e:
        print(f"  {sym}: parse fail {type(e).__name__}")
        return False


def probe_universe(s):
    """Can we build the S&P 500 + Nasdaq 100 ticker list for free?"""
    results = {}
    tests = [
        ("wikipedia S&P500",
         "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"),
        ("wikipedia Nasdaq-100",
         "https://en.wikipedia.org/wiki/Nasdaq-100"),
    ]
    for name, url in tests:
        try:
            r = s.get(url, timeout=25)
            ok = r.status_code == 200 and "wikitable" in r.text
            print(f"  {name}: HTTP {r.status_code} len={len(r.text)} "
                  f"table={'yes' if ok else 'NO'}")
            results[name] = ok
        except Exception as e:
            print(f"  {name}: EXC {type(e).__name__}")
            results[name] = False
    return results


def main():
    head("1. CHART ENDPOINT  (technicals: MA / ATR / RSI / 52w)")
    s = new_session()
    chart_ok = all(probe_chart(s, sym) for sym in SYMBOLS)

    head("2. QUOTESUMMARY WITHOUT CRUMB")
    data, msg = try_quote_summary(s, "MU")
    print(f"  MU: {msg}")
    nocrumb_ok = data is not None
    if nocrumb_ok:
        report_coverage(data)

    head("3. QUOTESUMMARY WITH COOKIE + CRUMB")
    s2 = new_session()
    crumb = get_crumb(s2)
    crumb_ok = False
    best = None
    if crumb:
        for host in ("query2", "query1"):
            data2, msg2 = try_quote_summary(s2, "MU", crumb=crumb, host=host)
            print(f"  MU via {host}: {msg2}")
            if data2:
                crumb_ok = True
                best = data2
                break
    else:
        print("  could not obtain a crumb")
    if best:
        report_coverage(best)

    head("4. SAMPLE VALUES (sanity-check the numbers are real)")
    src = best or data
    if src:
        fd = src.get("financialData") or {}
        sd = src.get("summaryDetail") or {}
        ks = src.get("defaultKeyStatistics") or {}
        ap = src.get("assetProfile") or {}
        for label, v in [
            ("sector", ap.get("sector")),
            ("marketCap", unwrap(sd.get("marketCap"))),
            ("trailingPE", unwrap(sd.get("trailingPE"))),
            ("targetMeanPrice", unwrap(fd.get("targetMeanPrice"))),
            ("recommendationKey", fd.get("recommendationKey")),
            ("profitMargins", unwrap(fd.get("profitMargins"))),
            ("revenueGrowth", unwrap(fd.get("revenueGrowth"))),
            ("returnOnEquity", unwrap(fd.get("returnOnEquity"))),
            ("debtToEquity", unwrap(fd.get("debtToEquity"))),
            ("freeCashflow", unwrap(fd.get("freeCashflow"))),
            ("pegRatio", unwrap(ks.get("pegRatio"))),
            ("priceToBook", unwrap(ks.get("priceToBook"))),
            ("enterpriseToEbitda", unwrap(ks.get("enterpriseToEbitda"))),
        ]:
            print(f"  {label:22} = {v}")
        rt = src.get("recommendationTrend") or {}
        print(f"  recommendationTrend rows = {len(rt.get('trend') or [])}")
        ce = src.get("calendarEvents") or {}
        print(f"  calendarEvents.earnings  = "
              f"{json.dumps(ce.get('earnings'), default=str)[:160]}")
    else:
        print("  no quoteSummary data from any strategy")

    head("5. THROUGHPUT  (how long would 600 symbols take?)")
    if best or data:
        sess = s2 if crumb_ok else s
        t0 = time.time()
        n = 0
        for sym in ["AAPL", "MSFT", "GOOGL", "AMZN", "META"]:
            d, _ = try_quote_summary(sess, sym, crumb=crumb if crumb_ok else None)
            if d:
                n += 1
            time.sleep(0.3)
        dt = time.time() - t0
        print(f"  {n}/5 ok in {dt:.1f}s -> ~{dt / 5 * 600 / 60:.1f} min for 600 "
              f"(sequential, 0.3s pause)")
    else:
        print("  skipped")

    head("6. UNIVERSE SOURCE  (S&P 500 + Nasdaq 100 constituents)")
    uni = probe_universe(new_session())

    head("VERDICT")
    print(f"  chart (technicals)      : {'OK' if chart_ok else 'FAIL'}")
    print(f"  quoteSummary no-crumb   : {'OK' if nocrumb_ok else 'FAIL'}")
    print(f"  quoteSummary with crumb : {'OK' if crumb_ok else 'FAIL'}")
    print(f"  universe from wikipedia : "
          f"{'OK' if all(uni.values()) else 'PARTIAL/FAIL'}")
    fundamentals = nocrumb_ok or crumb_ok
    print()
    if chart_ok and fundamentals:
        print("  => GO. Free stack is sufficient for the full plan.")
        return 0
    if chart_ok:
        print("  => PARTIAL. Technicals fine, fundamentals need another source.")
        return 2
    print("  => BLOCKED. Need a different data provider.")
    return 3


if __name__ == "__main__":
    sys.exit(main())
