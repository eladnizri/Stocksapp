#!/usr/bin/env python3
"""Build the nightly screener snapshot: data/screener.json

Runs on a GitHub runner, so it deliberately avoids Yahoo (which 429s every
request from datacenter IPs). Sources, all free and keyless:

  Wikipedia   - S&P 500 and Nasdaq-100 constituents
  SEC EDGAR   - fundamentals straight from filings. The `frames` API returns
                one concept for every filer in a single request, so the whole
                universe costs ~100 requests instead of ~600.
  Nasdaq API  - daily OHLCV for moving averages, RSI, ATR, 52-week position

Output is one compact JSON the phone downloads once and filters locally.
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SEC_UA = "Stocksapp-Screener/1.0 (eladn2006@gmail.com)"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 "
              "Safari/537.36")

# SEC asks for <=10 requests/second. Stay well under.
SEC_DELAY = 0.12


def log(msg):
    print(msg, flush=True)


def sec_session():
    s = requests.Session()
    s.headers.update({"User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate"})
    return s


def web_session():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA,
                      "Accept": "application/json, text/plain, */*"})
    return s


# ==========================================================================
# Universe
# ==========================================================================
class WikiTableParser(HTMLParser):
    """Collects every wikitable on the page as a list of text rows.

    Regex over the markup was too brittle: the S&P 500 page links tickers to
    the exchange while the Nasdaq-100 page does not, so a pattern tuned to one
    silently returned nothing for the other."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._table = None
        self._row = None
        self._cell = None
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self._depth += 1
            if self._depth == 1 and "wikitable" in (a.get("class") or ""):
                self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag == "table":
            if self._depth == 1 and self._table is not None:
                self.tables.append(self._table)
                self._table = None
            self._depth = max(0, self._depth - 1)
        elif tag == "tr" and self._row is not None:
            if self._row:
                self._table.append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


# Must start with a letter, so numeric cells like a year never match, but
# digits are allowed after it because real tickers do contain them.
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")


def scrape_wikipedia_symbols(session, url, label):
    """Find the constituents table and read its ticker column."""
    r = session.get(url, timeout=40)
    r.raise_for_status()
    p = WikiTableParser()
    p.feed(r.text)

    def column(table, idx):
        vals = []
        for row in table[1:]:
            if idx < len(row):
                vals.append(row[idx].strip().upper())
        return vals

    best = []
    for table in p.tables:
        if len(table) < 20:
            continue
        header = [h.lower() for h in table[0]]
        width = max(len(r) for r in table)

        # Prefer a column the header names, but do not depend on it - header
        # wording differs between these pages. Fall back to whichever column
        # actually looks like tickers.
        ordered = [i for i, h in enumerate(header)
                   if "ticker" in h or "symbol" in h]
        ordered += [i for i in range(width) if i not in ordered]

        for idx in ordered:
            vals = column(table, idx)
            if not vals:
                continue
            good = [v for v in vals if TICKER_RE.match(v)]
            if len(good) < 20 or len(good) / len(vals) < 0.8:
                continue
            if len(good) > len(best):
                best = [g.replace(".", "-") for g in good]
            break

    out, seen = [], set()
    for s in best:
        if s not in seen:
            seen.add(s)
            out.append(s)
    log(f"    {label}: {len(out)} tickers ({len(p.tables)} wikitables)")
    if not out:
        for t in p.tables:
            log(f"      unmatched table: {len(t)} rows, header={t[0][:6]}")
    return out


def nasdaq100_from_api(session):
    """Nasdaq publishes the index membership directly.

    Preferred over Wikipedia because the Nasdaq-100 article no longer carries a
    components table at all - the only tables left there track index history."""
    url = "https://api.nasdaq.com/api/quote/list-type/nasdaq100"
    try:
        r = session.get(url, timeout=30)
    except Exception as e:
        log(f"    Nasdaq API: {type(e).__name__}")
        return []
    if r.status_code != 200:
        log(f"    Nasdaq API: HTTP {r.status_code}")
        return []
    try:
        payload = r.json()
    except Exception:
        log("    Nasdaq API: non-JSON response")
        return []

    # The envelope has shifted before, so hunt for the row list rather than
    # hard-coding one path through it.
    def find_rows(node, depth=0):
        if depth > 6:
            return None
        if isinstance(node, list):
            if node and isinstance(node[0], dict) and "symbol" in node[0]:
                return node
            return None
        if isinstance(node, dict):
            for key in ("rows", "data", "records", "table"):
                if key in node:
                    found = find_rows(node[key], depth + 1)
                    if found:
                        return found
            for v in node.values():
                found = find_rows(v, depth + 1)
                if found:
                    return found
        return None

    rows = find_rows(payload) or []
    out, seen = [], set()
    for row in rows:
        sym = str(row.get("symbol", "")).strip().upper().replace(".", "-")
        if TICKER_RE.match(sym) and sym not in seen:
            seen.add(sym)
            out.append(sym)
    log(f"    Nasdaq-100 via Nasdaq API: {len(out)} tickers")
    return out


def build_universe(session):
    log("[1/5] Universe")
    sp = scrape_wikipedia_symbols(
        session, "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        "S&P 500")
    nd = nasdaq100_from_api(session)
    if len(nd) < 50:
        log("    falling back to Wikipedia for the Nasdaq-100")
        nd = scrape_wikipedia_symbols(
            session, "https://en.wikipedia.org/wiki/Nasdaq-100", "Nasdaq-100")

    if not sp or not nd:
        log(f"    WARNING: an index came back empty "
            f"(sp500={len(sp)}, ndx={len(nd)}); its filter will match nothing")

    members = {}
    for s in sp:
        members.setdefault(s, set()).add("sp500")
    for s in nd:
        members.setdefault(s, set()).add("ndx")

    if len(members) < 400:
        path = os.path.join(DATA, "universe.json")
        if os.path.exists(path):
            log(f"    only {len(members)} scraped; reusing committed universe")
            prev = json.load(open(path))
            return {row["s"]: set(row["i"]) for row in prev["rows"]}
        raise SystemExit(f"universe too small ({len(members)}) and no fallback")

    log(f"    total unique: {len(members)}")
    return {k: v for k, v in members.items()}


# ==========================================================================
# SEC: ticker -> CIK
# ==========================================================================
def sec_cik_map(session):
    """Returns {ticker: (cik, company name)} - the same file carries both."""
    log("[2/5] SEC ticker -> CIK map")
    r = session.get("https://www.sec.gov/files/company_tickers.json", timeout=40)
    r.raise_for_status()
    m = {}
    for row in r.json().values():
        sym = row["ticker"].upper().replace(".", "-")
        m[sym] = (int(row["cik_str"]), (row.get("title") or "").strip())
    log(f"    {len(m)} tickers mapped")
    return m


# ==========================================================================
# SEC: fundamentals via the frames API
# ==========================================================================
def recent_periods(n_quarters, instant):
    """Calendar period labels the frames API understands, newest first.
    Balance-sheet concepts are point-in-time and take an 'I' suffix."""
    today = dt.date.today()
    q = (today.month - 1) // 3 + 1
    y = today.year
    out = []
    # The most recent quarter is rarely filed yet; start one back.
    q -= 1
    if q == 0:
        q, y = 4, y - 1
    for _ in range(n_quarters):
        out.append(f"CY{y}Q{q}" + ("I" if instant else ""))
        q -= 1
        if q == 0:
            q, y = 4, y - 1
    return out


def fetch_frame(session, taxo, tag, unit, period):
    url = (f"https://data.sec.gov/api/xbrl/frames/{taxo}/{tag}/{unit}/"
           f"{period}.json")
    try:
        r = session.get(url, timeout=40)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json().get("data", [])
    except Exception:
        return None


# Each metric lists the XBRL tags companies actually use, in preference order.
# Filers are inconsistent, so every metric needs alternates or coverage craters.
FLOW_METRICS = {
    # Banks and insurers do not file a plain "Revenues" line at all, which is
    # why revenue coverage sat at 65% and dragged margins and growth with it.
    "revenue": ("us-gaap", ["RevenueFromContractWithCustomerExcludingAssessedTax",
                            "Revenues", "SalesRevenueNet",
                            "RevenueFromContractWithCustomerIncludingAssessedTax",
                            "RevenuesNetOfInterestExpense",
                            "InterestAndDividendIncomeOperating",
                            "SalesRevenueGoodsNet",
                            "SalesRevenueServicesNet",
                            "TotalRevenuesAndOtherIncome"],
                "USD"),
    "netIncome": ("us-gaap", ["NetIncomeLoss",
                              "ProfitLoss",
                              "NetIncomeLossAvailableToCommonStockholdersBasic"],
                  "USD"),
    "grossProfit": ("us-gaap", ["GrossProfit"], "USD"),
    "costOfRevenue": ("us-gaap", ["CostOfRevenue", "CostOfGoodsAndServicesSold",
                                  "CostOfServices"], "USD"),
    "operatingIncome": ("us-gaap", ["OperatingIncomeLoss"], "USD"),
    "opCashFlow": ("us-gaap",
                   ["NetCashProvidedByUsedInOperatingActivities",
                    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
                   "USD"),
    "capex": ("us-gaap", ["PaymentsToAcquirePropertyPlantAndEquipment",
                          "PaymentsToAcquireProductiveAssets",
                          "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets"],
              "USD"),
    "eps": ("us-gaap", ["EarningsPerShareDiluted", "EarningsPerShareBasic",
                        "EarningsPerShareBasicAndDiluted"],
            "USD-per-shares"),
}

INSTANT_METRICS = {
    "assets": ("us-gaap", ["Assets"], "USD"),
    "liabilities": ("us-gaap", ["Liabilities"], "USD"),
    "equity": ("us-gaap", ["StockholdersEquity",
                           "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
               "USD"),
    "cash": ("us-gaap", ["CashAndCashEquivalentsAtCarryingValue",
                         "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
             "USD"),
    "assetsCurrent": ("us-gaap", ["AssetsCurrent"], "USD"),
    "liabilitiesCurrent": ("us-gaap", ["LiabilitiesCurrent"], "USD"),
    "longTermDebt": ("us-gaap", ["LongTermDebtNoncurrent", "LongTermDebt",
                                 "LongTermDebtAndCapitalLeaseObligations",
                                 "DebtLongtermAndShorttermCombinedAmount"], "USD"),
    "shares": ("dei", ["EntityCommonStockSharesOutstanding"], "shares"),
}

# Quarterly frames are the freshest but sparse: the API buckets by calendar
# quarter, so any filer on an off-cycle fiscal calendar is simply absent.
# Annual frames cover far more companies and give clean year-over-year growth,
# so collect both and prefer whichever is available.
# Merging across alternate tags multiplies the request count, so trim the
# period lists to what the maths actually needs: 6 quarters covers a TTM with
# slack for a late filing, and 3 annual periods covers year-over-year growth.
FLOW_QUARTERS = 6
INSTANT_QUARTERS = 4
ANNUAL_YEARS = 3


def annual_periods(n):
    """Annual calendar frames, newest first. The current year is never filed
    yet, so start from last year."""
    y = dt.date.today().year - 1
    return [f"CY{y - i}" for i in range(n)]


def collect_fundamentals(session, wanted_ciks):
    """Returns {cik: {"q": {...}, "a": {...}, "i": {...}}} where each inner map
    is {metric: [(period, value), ...]} sorted newest first."""
    log("[3/5] SEC fundamentals via frames")
    out = {}

    def store(cik, bucket, metric, period, val):
        out.setdefault(cik, {}).setdefault(bucket, {}) \
           .setdefault(metric, []).append((period, val))

    jobs = []
    for metric, (taxo, tags, unit) in FLOW_METRICS.items():
        for period in recent_periods(FLOW_QUARTERS, instant=False):
            jobs.append(("q", metric, taxo, tags, unit, period))
        for period in annual_periods(ANNUAL_YEARS):
            jobs.append(("a", metric, taxo, tags, unit, period))
    for metric, (taxo, tags, unit) in INSTANT_METRICS.items():
        for period in recent_periods(INSTANT_QUARTERS, instant=True):
            jobs.append(("i", metric, taxo, tags, unit, period))

    # Every alternate tag has to be fetched and merged, not raced. Stopping at
    # the first tag that returned anything looks reasonable but silently drops
    # every filer that uses a different one - which is most banks and insurers.
    # Earlier tags win where a company reports under several.
    filled = set()
    total_reqs = sum(len(j[3]) for j in jobs)
    log(f"    {len(jobs)} metric-periods, {total_reqs} frame requests")
    hits = 0
    done = 0
    for bucket, metric, taxo, tags, unit, period in jobs:
        for tag in tags:
            data = fetch_frame(session, taxo, tag, unit, period)
            time.sleep(SEC_DELAY)
            done += 1
            if not data:
                continue
            hits += 1
            for row in data:
                cik = row.get("cik")
                if cik not in wanted_ciks or row.get("val") is None:
                    continue
                key = (cik, bucket, metric, period)
                if key in filled:
                    continue
                filled.add(key)
                store(cik, bucket, metric, period, row["val"])
            if done % 60 == 0:
                log(f"    ...{done}/{total_reqs} requests, "
                    f"{len(out)} companies with data")

    for cik, buckets in out.items():
        for bucket in buckets.values():
            for series in bucket.values():
                series.sort(key=lambda x: x[0], reverse=True)

    log(f"    {hits}/{total_reqs} frames returned data; "
        f"{len(out)} companies covered")
    return out


def ttm(series, n=4):
    """Sum the n most recent quarterly values, if we have that many."""
    if not series or len(series) < n:
        return None
    return sum(v for _, v in series[:n])


def latest(series):
    return series[0][1] if series else None


def derive_fundamentals(raw):
    """Turn raw SEC facts into the metrics the app displays.

    Quarterly data is preferred for freshness; annual data fills the many gaps
    the calendar-quarter bucketing leaves behind, and drives growth rates."""
    q = raw.get("q", {})
    a = raw.get("a", {})
    inst = raw.get("i", {})
    f = {}

    def flow(metric):
        """Trailing twelve months, falling back to the latest full year."""
        v = ttm(q.get(metric, []))
        return v if v is not None else latest(a.get(metric, []))

    def yoy(metric):
        """Year-over-year growth from annual filings, else TTM vs prior TTM."""
        ann = a.get(metric, [])
        if len(ann) >= 2 and ann[1][1]:
            return ((ann[0][1] - ann[1][1]) / abs(ann[1][1])) * 100
        qs = q.get(metric, [])
        if len(qs) >= 8:
            cur, prev = ttm(qs), ttm(qs[4:], 4)
            if cur is not None and prev:
                return ((cur - prev) / abs(prev)) * 100
        return None

    rev_ttm = flow("revenue")
    ni_ttm = flow("netIncome")
    gp_ttm = flow("grossProfit")
    if gp_ttm is None:
        cor = flow("costOfRevenue")
        if rev_ttm is not None and cor is not None:
            gp_ttm = rev_ttm - cor
    oi_ttm = flow("operatingIncome")
    ocf_ttm = flow("opCashFlow")
    capex_ttm = flow("capex")
    eps_ttm = flow("eps")

    assets = latest(inst.get("assets", []))
    liabilities = latest(inst.get("liabilities", []))
    equity = latest(inst.get("equity", []))
    cash = latest(inst.get("cash", []))
    ac = latest(inst.get("assetsCurrent", []))
    lc = latest(inst.get("liabilitiesCurrent", []))
    ltd = latest(inst.get("longTermDebt", []))
    shares = latest(inst.get("shares", []))

    f["revTTM"] = rev_ttm
    f["niTTM"] = ni_ttm
    f["epsTTM"] = eps_ttm
    f["shares"] = shares
    f["equity"] = equity
    f["cash"] = cash
    f["debt"] = ltd

    if ocf_ttm is not None and capex_ttm is not None:
        f["fcf"] = ocf_ttm - capex_ttm
    elif ocf_ttm is not None:
        f["fcf"] = ocf_ttm

    def pct(a, b):
        if a is None or not b:
            return None
        return (a / b) * 100

    f["grossMargin"] = pct(gp_ttm, rev_ttm)
    f["opMargin"] = pct(oi_ttm, rev_ttm)
    f["netMargin"] = pct(ni_ttm, rev_ttm)
    f["fcfMargin"] = pct(f.get("fcf"), rev_ttm)
    f["roe"] = pct(ni_ttm, equity)
    f["roa"] = pct(ni_ttm, assets)

    if equity and equity > 0:
        if ltd is not None:
            f["debtToEquity"] = (ltd / equity) * 100
        elif liabilities is not None:
            # No debt tag filed: total liabilities is a coarser stand-in.
            f["liabToEquity"] = (liabilities / equity) * 100
    if lc and ac:
        f["currentRatio"] = ac / lc

    f["revGrowth"] = yoy("revenue")
    f["niGrowth"] = yoy("netIncome")
    f["epsGrowth"] = yoy("eps")

    return {k: v for k, v in f.items() if v is not None}


# ==========================================================================
# Prices and technicals
# ==========================================================================
def parse_money(s):
    if s is None:
        return None
    s = str(s).replace("$", "").replace(",", "").strip()
    if not s or s in ("N/A", "--"):
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def fetch_history(session, symbol, days=400):
    """Daily OHLCV from Nasdaq, newest first in their response."""
    end = dt.date.today()
    start = end - dt.timedelta(days=int(days * 1.5))
    url = (f"https://api.nasdaq.com/api/quote/{symbol}/historical"
           f"?assetclass=stocks&fromdate={start}&todate={end}&limit={days}")
    try:
        r = session.get(url, timeout=30)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        table = (r.json().get("data") or {}).get("tradesTable") or {}
        rows = table.get("rows") or []
    except Exception:
        return None
    out = []
    for row in rows:
        c = parse_money(row.get("close"))
        if c is None:
            continue
        out.append({
            "d": row.get("date"),
            "c": c,
            "h": parse_money(row.get("high")),
            "l": parse_money(row.get("low")),
            "v": parse_money(row.get("volume")),
        })
    out.reverse()  # oldest first
    return out or None


def sma(vals, n):
    if len(vals) < n:
        return None
    return sum(vals[-n:]) / n


def rsi(closes, n=14):
    if len(closes) < n + 1:
        return None
    gains = losses = 0.0
    for i in range(-n, 0):
        ch = closes[i] - closes[i - 1]
        if ch >= 0:
            gains += ch
        else:
            losses -= ch
    if losses == 0:
        return 100.0
    rs = (gains / n) / (losses / n)
    return 100 - (100 / (1 + rs))


def atr(bars, n=14):
    if len(bars) < n + 1:
        return None
    trs = []
    for i in range(-n, 0):
        h, l = bars[i]["h"], bars[i]["l"]
        pc = bars[i - 1]["c"]
        if h is None or l is None:
            continue
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else None


def ret_pct(closes, n):
    if len(closes) <= n or not closes[-1 - n]:
        return None
    return ((closes[-1] / closes[-1 - n]) - 1) * 100


def compute_technicals(bars):
    closes = [b["c"] for b in bars]
    if len(closes) < 60:
        return None
    price = closes[-1]
    yr = closes[-252:] if len(closes) >= 252 else closes
    hi52, lo52 = max(yr), min(yr)
    vols = [b["v"] for b in bars[-60:] if b["v"]]
    t = {
        "price": price,
        "ma50": sma(closes, 50),
        "ma150": sma(closes, 150),
        "ma200": sma(closes, 200),
        "rsi": rsi(closes),
        "atr": atr(bars),
        "hi52": hi52,
        "lo52": lo52,
        "chg1d": ret_pct(closes, 1),
        "chg1m": ret_pct(closes, 21),
        "chg3m": ret_pct(closes, 63),
        "chg6m": ret_pct(closes, 126),
        "chg12m": ret_pct(closes, 252),
        "avgVol": (sum(vols) / len(vols)) if vols else None,
    }
    if hi52:
        t["from52High"] = ((price / hi52) - 1) * 100
    if lo52:
        t["from52Low"] = ((price / lo52) - 1) * 100
    for k in ("ma50", "ma150", "ma200"):
        if t.get(k):
            t["v" + k] = ((price / t[k]) - 1) * 100
    if t.get("atr") and price:
        t["atrPct"] = (t["atr"] / price) * 100
    return {k: v for k, v in t.items() if v is not None}


# ==========================================================================
# Scoring
# ==========================================================================
def band(v, lo, hi, invert=False):
    """Map a value onto 0..100 between lo and hi."""
    if v is None:
        return None
    x = (v - lo) / (hi - lo) if hi != lo else 0.0
    x = max(0.0, min(1.0, x))
    return round((1 - x if invert else x) * 100)


def avg(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals)) if vals else None


def score_row(r):
    """Six transparent sub-scores, each 0..100, then a weighted blend.
    Deliberately simple and inspectable - the app shows every component."""
    f, t = r.get("f", {}), r.get("t", {})
    pe = r.get("pe")
    ps = r.get("ps")
    pb = r.get("pb")

    value = avg([
        band(pe, 45, 8, invert=False) if pe and pe > 0 else None,
        band(ps, 15, 1, invert=False) if ps and ps > 0 else None,
        band(pb, 12, 1, invert=False) if pb and pb > 0 else None,
    ])
    growth = avg([
        band(f.get("revGrowth"), -10, 40),
        band(f.get("epsGrowth"), -20, 60),
    ])
    profit = avg([
        band(f.get("grossMargin"), 10, 70),
        band(f.get("opMargin"), 0, 35),
        band(f.get("netMargin"), 0, 30),
        band(f.get("roe"), 0, 35),
    ])
    leverage = f.get("debtToEquity")
    if leverage is None and f.get("liabToEquity") is not None:
        # Total liabilities run much larger than debt alone, so widen the band.
        leverage = f["liabToEquity"] / 2.5
    health = avg([
        band(leverage, 200, 0),
        band(f.get("currentRatio"), 0.6, 3.0),
        band(f.get("fcfMargin"), -5, 30),
    ])
    momentum = avg([
        band(t.get("vma50"), -20, 20),
        band(t.get("vma200"), -30, 40),
        band(t.get("from52High"), -60, 0),
        band(t.get("chg6m"), -30, 50),
    ])
    quality = avg([profit, health])

    parts = {"value": value, "growth": growth, "profit": profit,
             "health": health, "momentum": momentum}
    weights = {"value": 0.2, "growth": 0.2, "profit": 0.25,
               "health": 0.15, "momentum": 0.2}
    num = den = 0.0
    for k, w in weights.items():
        if parts[k] is not None:
            num += parts[k] * w
            den += w
    total = round(num / den) if den >= 0.5 else None
    parts["total"] = total
    parts["quality"] = quality
    return {k: v for k, v in parts.items() if v is not None}


# ==========================================================================
# Assembly
# ==========================================================================
def round_sig(v, nd=4):
    if v is None or isinstance(v, str):
        return v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        if abs(v) >= 1000:
            return round(v)
        return round(v, nd)
    return v


def clean(d):
    return {k: round_sig(v) for k, v in d.items() if v is not None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="only process the first N symbols (for smoke tests)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    os.makedirs(DATA, exist_ok=True)
    sec = sec_session()
    web = web_session()

    members = build_universe(web)
    symbols = sorted(members)
    if args.limit:
        symbols = symbols[:args.limit]
        log(f"    limited to {len(symbols)} symbols")

    cik_map = sec_cik_map(sec)
    sym_cik = {s: cik_map[s][0] for s in symbols if s in cik_map}
    sym_name = {s: cik_map[s][1] for s in symbols if s in cik_map}
    log(f"    {len(sym_cik)}/{len(symbols)} symbols resolved to a CIK")

    facts = collect_fundamentals(sec, set(sym_cik.values()))

    log("[4/5] Prices and technicals")
    hist = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_history, web_session(), s): s for s in symbols}
        done = 0
        for fut in as_completed(futs):
            sym = futs[fut]
            try:
                bars = fut.result()
            except Exception:
                bars = None
            if bars:
                hist[sym] = bars
            done += 1
            if done % 50 == 0:
                log(f"    ...{done}/{len(symbols)} fetched, {len(hist)} with data")
    log(f"    {len(hist)}/{len(symbols)} symbols have price history")

    log("[5/5] Assemble")
    rows = []
    for sym in symbols:
        cik = sym_cik.get(sym)
        raw = facts.get(cik, {})
        f = derive_fundamentals(raw) if raw else {}
        bars = hist.get(sym)
        # A recent listing can have fewer than 60 closes, and compute_technicals
        # returns None for those rather than emitting misleading averages.
        t = (compute_technicals(bars) or {}) if bars else {}
        if not t and not f:
            continue

        r = {"s": sym, "n": sym_name.get(sym, ""),
             "i": sorted(members.get(sym, []))}
        price = t.get("price")
        shares = f.get("shares")
        if price and shares:
            r["mcap"] = price * shares
        if price and f.get("epsTTM"):
            r["pe"] = price / f["epsTTM"] if f["epsTTM"] > 0 else None
        if r.get("mcap") and f.get("revTTM"):
            r["ps"] = r["mcap"] / f["revTTM"]
        if r.get("mcap") and f.get("equity") and f["equity"] > 0:
            r["pb"] = r["mcap"] / f["equity"]
        if r.get("mcap") and f.get("fcf") and f["fcf"] > 0:
            r["pfcf"] = r["mcap"] / f["fcf"]

        r = {k: (v if isinstance(v, (str, list)) else round_sig(v))
             for k, v in r.items() if v is not None}
        r["sc"] = score_row({**r, "f": f, "t": t})
        r["f"] = clean(f)
        r["t"] = clean(t)
        rows.append(r)

    scored = sum(1 for r in rows if r.get("sc", {}).get("total") is not None)
    log(f"    {len(rows)} rows, {scored} fully scored")

    out = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "count": len(rows),
        "sources": {
            "fundamentals": "SEC EDGAR XBRL frames",
            "prices": "Nasdaq historical API",
            "universe": "Wikipedia S&P 500 + Nasdaq-100",
        },
        "rows": rows,
    }
    path = os.path.join(DATA, "screener.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    size = os.path.getsize(path)
    log(f"    wrote {path} ({size / 1024:.0f} KB)")

    uni = {"generated": out["generated"],
           "rows": [{"s": s, "i": sorted(members[s])} for s in sorted(members)]}
    with open(os.path.join(DATA, "universe.json"), "w") as fh:
        json.dump(uni, fh, separators=(",", ":"))

    if scored < len(rows) * 0.4:
        log("WARNING: fewer than 40% of rows scored - check SEC coverage")
    return 0


if __name__ == "__main__":
    sys.exit(main())
