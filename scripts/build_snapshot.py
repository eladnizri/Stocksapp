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
import threading
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
# Per-thread pause for the one-request-per-company sector lookup:
# SECTOR_WORKERS / SECTOR_DELAY must stay below 10 requests/second.
SECTOR_WORKERS = 4
SECTOR_DELAY = 0.5


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
    log("[1/8] Universe")
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
# --------------------------------------------------------- wide universe
# The index universe above is what a fundamental screen wants: 500 large caps
# with SEC filings behind every number. A technical screen wants the opposite -
# as many liquid tickers as possible, because a moving-average cross is just as
# real on a $2B name as on Apple, and half the interesting ones are in neither
# index. SOFI and IREN both sat in the user's own alert list and neither could
# ever appear in the scanner.
#
# Nasdaq's screener endpoint returns the whole market - 7,128 rows, 2MB, one
# request - with a market cap and a sector per row. Measured, not assumed:
# scripts/probe_universe.py. That makes the wide list free; what is not free is
# the daily history behind each symbol, which is one request each. So the cap
# cutoff is really a runtime dial, and it is exposed as one.
WIDE_MIN_CAP = 500_000_000

# Blank-check shells have no chart worth screening and there are hundreds of
# them. Their industry label is reliable enough to drop them on.
SKIP_INDUSTRIES = {"blank checks"}


def fetch_wide_universe(session, min_cap=WIDE_MIN_CAP):
    """{symbol: {"cap", "sector", "name"}} for every liquid-enough US ticker.

    One request for the entire market. Returns {} on any failure - the scan
    then simply proceeds with the index universe, which is the behaviour it
    had before this existed.
    """
    log(f"[1b/8] Wide universe (cap >= ${min_cap/1e6:.0f}M)")
    try:
        r = session.get("https://api.nasdaq.com/api/screener/stocks"
                        "?tableonly=true&limit=25000&download=true", timeout=90)
        if r.status_code != 200:
            log(f"    HTTP {r.status_code} - continuing without it")
            return {}
        rows = _find_rows(r.json()) or []
    except Exception as e:
        log(f"    unavailable ({type(e).__name__}) - continuing without it")
        return {}

    out, skipped = {}, 0
    for row in rows:
        sym = str(row.get("symbol", "")).strip().upper().replace(".", "-")
        # Warrants, units and preferred lines share a root with the common
        # stock and have no chart of their own worth screening.
        if not sym or not re.fullmatch(r"[A-Z][A-Z0-9-]{0,6}", sym):
            continue
        if str(row.get("industry", "")).strip().lower() in SKIP_INDUSTRIES:
            skipped += 1
            continue
        try:
            cap = float(str(row.get("marketCap", "") or "").replace(",", ""))
        except ValueError:
            continue
        if cap < min_cap:
            continue
        out[sym] = {
            "cap": cap,
            "sector": NASDAQ_SECTOR_HE.get(
                str(row.get("sector", "")).strip().lower()),
            "name": str(row.get("name", "")).strip(),
        }
    log(f"    {len(rows)} listed, {len(out)} above the cutoff "
        f"({skipped} blank-check shells dropped)")
    return out


def _find_rows(node, depth=0):
    """Nasdaq has moved the row list around inside this envelope before, so
    search for it rather than hard-coding a path."""
    if depth > 6:
        return None
    if isinstance(node, list):
        if node and isinstance(node[0], dict) and "symbol" in node[0]:
            return node
        return None
    if isinstance(node, dict):
        for k in ("rows", "data", "records", "table"):
            if k in node:
                f = _find_rows(node[k], depth + 1)
                if f:
                    return f
        for v in node.values():
            f = _find_rows(v, depth + 1)
            if f:
                return f
    return None


def sec_cik_map(session):
    """Returns {ticker: (cik, company name)} - the same file carries both."""
    log("[2/8] SEC ticker -> CIK map")
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


# ---------------------------------------------------------------- sectors
# Ten buckets, chosen to be the ones an investor actually screens on. Nasdaq's
# own labels and SEC's SIC ranges both fold into these.
SECTORS = ["טכנולוגיה", "בריאות", "פיננסים", "נדל\u05f4ן", "אנרגיה",
           "תשתיות", "תקשורת", "צריכה", "תעשייה", "חומרים"]

NASDAQ_SECTOR_HE = {
    "technology": "טכנולוגיה",
    "computer and technology": "טכנולוגיה",
    "health care": "בריאות",
    "healthcare": "בריאות",
    "medical": "בריאות",
    "finance": "פיננסים",
    "financials": "פיננסים",
    "real estate": "נדל\u05f4ן",
    "energy": "אנרגיה",
    "oils/energy": "אנרגיה",
    "utilities": "תשתיות",
    "public utilities": "תשתיות",
    "telecommunications": "תקשורת",
    "telecommunication": "תקשורת",
    "communication services": "תקשורת",
    "consumer discretionary": "צריכה",
    "consumer staples": "צריכה",
    "consumer durables": "צריכה",
    "consumer non-durables": "צריכה",
    "consumer services": "צריכה",
    "retail trade": "צריכה",
    "retail-wholesale": "צריכה",
    "industrials": "תעשייה",
    "industrial applications and services": "תעשייה",
    "capital goods": "תעשייה",
    "transportation": "תעשייה",
    "basic materials": "חומרים",
    "basic industries": "חומרים",
    "materials": "חומרים",
}

# SIC is organised by product, not by market sector, so the ranges have to be
# picked deliberately: pharma sits inside Chemicals, and software inside
# Business Services.
SIC_RANGES = [
    ((2833, 2836), "בריאות"), ((3826, 3827), "בריאות"),
    ((3840, 3851), "בריאות"), ((8000, 8099), "בריאות"),
    ((8731, 8731), "בריאות"),
    ((3570, 3579), "טכנולוגיה"), ((3600, 3699), "טכנולוגיה"),
    ((7370, 7379), "טכנולוגיה"), ((3820, 3825), "טכנולוגיה"),
    # Health insurers file under an insurance SIC, but an investor reads them
    # as health care. The narrow range wins over 6000-6499.
    ((6324, 6324), "בריאות"),
    ((6500, 6599), "נדל\u05f4ן"), ((6798, 6798), "נדל\u05f4ן"),
    ((6000, 6499), "פיננסים"), ((6700, 6799), "פיננסים"),
    ((1200, 1399), "אנרגיה"), ((2900, 2999), "אנרגיה"),
    ((4600, 4699), "אנרגיה"),
    ((4900, 4999), "תשתיות"),
    ((2700, 2799), "תקשורת"), ((4800, 4899), "תקשורת"),
    ((7810, 7841), "תקשורת"),
    ((2000, 2199), "צריכה"), ((2300, 2399), "צריכה"),
    ((5000, 5999), "צריכה"), ((7000, 7099), "צריכה"),
    ((7900, 7999), "צריכה"),
    ((2800, 2899), "חומרים"), ((1000, 1099), "חומרים"),
    ((1400, 1499), "חומרים"), ((2400, 2699), "חומרים"),
    ((3300, 3399), "חומרים"),
    ((1500, 1799), "תעשייה"), ((3400, 3569), "תעשייה"),
    ((3580, 3599), "תעשייה"), ((3700, 3799), "תעשייה"),
    ((4000, 4599), "תעשייה"), ((8700, 8730), "תעשייה"),
]


def submissions_url(cik):
    """The submissions endpoint needs the CIK zero-padded to ten digits.

    sec_cik_map stores it as a plain int because the frames API keys on that,
    and passing it through unpadded 404s for every company - which sent every
    sector to the fallback while looking like it had merely 'errored'."""
    return f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json"


def sector_from_sic(sic):
    """Narrowest matching range wins.

    Some ranges deliberately sit inside others - pharma (2833-2836) inside
    chemicals, REITs (6798) inside finance - and the specific one must win.
    Picking by width says so outright instead of depending on list order, which
    a later edit could reorder without anyone noticing."""
    try:
        code = int(sic)
    except (TypeError, ValueError):
        return None
    best, best_width = None, None
    for (lo, hi), name in SIC_RANGES:
        if lo <= code <= hi:
            width = hi - lo
            if best_width is None or width < best_width:
                best, best_width = name, width
    return best


def fetch_sectors(web, sec, symbols, sym_cik):
    """Sector per symbol, most trustworthy source first.

    Nasdaq answers for the whole market in one request, which is tempting, but
    its taxonomy disagrees with how these companies are normally classified:
    it filed Agilent, a lab-instruments maker, under industrials rather than
    health care, sent Sherwin-Williams to consumer rather than materials, and
    left materials with five names out of the S&P 500's ~25. SEC's SIC code is
    authoritative and costs one request per company, which a nightly job can
    afford. Take SIC first and let Nasdaq fill whatever SEC cannot resolve."""
    log("[3/8] Sectors")
    out = {}

    with_cik = [s for s in symbols if s in sym_cik]
    log(f"    asking SEC for the SIC of {len(with_cik)} companies")

    # SEC asks for no more than 10 requests a second. The first version fired
    # six threads with no pause and no retry, so a large share came back 403,
    # returned None, and were silently filled in by Nasdaq's wrong answer -
    # which is exactly how Agilent ended up in industrials. Stay under the
    # limit, retry the throttled ones, and count what still fails.
    failures = {"throttled": 0, "error": 0, "unmapped": 0}
    lock = threading.Lock()
    local = threading.local()

    def one(sym):
        if not hasattr(local, "s"):
            local.s = sec_session()
        cik = sym_cik[sym]
        for attempt in range(4):
            time.sleep(SECTOR_DELAY)
            try:
                r = local.s.get(submissions_url(cik), timeout=30)
            except Exception:
                continue
            if r.status_code in (403, 429, 503):
                time.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code != 200:
                with lock:
                    failures["error"] += 1
                return sym, None
            try:
                sic = r.json().get("sic")
            except Exception:
                with lock:
                    failures["error"] += 1
                return sym, None
            hebrew = sector_from_sic(sic)
            if hebrew is None:
                with lock:
                    failures["unmapped"] += 1
                log(f"      unmapped SIC {sic} for {sym}")
            return sym, hebrew
        with lock:
            failures["throttled"] += 1
        return sym, None

    done = 0
    with ThreadPoolExecutor(max_workers=SECTOR_WORKERS) as ex:
        for sym, hebrew in ex.map(one, with_cik):
            done += 1
            if hebrew:
                out[sym] = hebrew
            if done % 150 == 0:
                log(f"    ...{done}/{len(with_cik)}, {len(out)} classified")
    log(f"    SEC classified {len(out)}/{len(symbols)}  "
        f"(throttled {failures['throttled']}, errors {failures['error']}, "
        f"unmapped SIC {failures['unmapped']})")
    if with_cik and len(out) < len(with_cik) * 0.8:
        log(f"    WARNING: SEC resolved only {len(out)}/{len(with_cik)} - the "
            f"fallback is doing the work, and its taxonomy disagrees")
    if failures["throttled"] > len(with_cik) * 0.02:
        log("    WARNING: throttling is losing companies to the fallback")
    log(f"    SEC classified {len(out)}/{len(symbols)}")

    missing = [s for s in symbols if s not in out]
    if missing:
        log(f"    {len(missing)} unresolved; trying Nasdaq")
        try:
            r = web.get("https://api.nasdaq.com/api/screener/stocks"
                        "?tableonly=true&limit=25000&download=true", timeout=60)
            rows = []
            if r.status_code == 200:
                def find(node, depth=0):
                    if depth > 6:
                        return None
                    if isinstance(node, list):
                        if node and isinstance(node[0], dict) and "symbol" in node[0]:
                            return node
                        return None
                    if isinstance(node, dict):
                        for k in ("rows", "data", "records", "table"):
                            if k in node:
                                f = find(node[k], depth + 1)
                                if f:
                                    return f
                        for v in node.values():
                            f = find(v, depth + 1)
                            if f:
                                return f
                    return None
                rows = find(r.json()) or []
            want = set(missing)
            added = 0
            for row in rows:
                sym = str(row.get("symbol", "")).upper().replace(".", "-")
                if sym not in want:
                    continue
                he = NASDAQ_SECTOR_HE.get(str(row.get("sector", "")).strip().lower())
                if he:
                    out[sym] = he
                    added += 1
            log(f"    Nasdaq filled {added}")
        except Exception as e:
            log(f"    Nasdaq unavailable: {type(e).__name__}")

    dist = {}
    for v in out.values():
        dist[v] = dist.get(v, 0) + 1
    log(f"    {len(out)}/{len(symbols)} symbols have a sector")
    for k, v in sorted(dist.items(), key=lambda x: -x[1]):
        log(f"      {v:4}  {k}")
    return out


# ------------------------------------------------- analysts and earnings
def fetch_analyst(symbols, workers=6):
    """Consensus price target and the buy/hold/sell split, per company.

    The app used to ask Yahoo for this from the device, but Yahoo gates that
    endpoint behind a cookie+crumb, so the card almost always read
    "unavailable". Nasdaq serves it plainly, and once a night is often enough
    for a figure that moves on analyst revisions."""
    log("[4/8] Analyst targets")
    out = {}
    lock = threading.Lock()
    local = threading.local()

    def one(sym):
        if not hasattr(local, "s"):
            local.s = web_session()
        try:
            r = local.s.get(
                f"https://api.nasdaq.com/api/analyst/{sym}/targetprice",
                timeout=25)
            if r.status_code != 200:
                return sym, None
            c = ((r.json().get("data") or {}).get("consensusOverview")) or {}
        except Exception:
            return sym, None
        target = c.get("priceTarget")
        if not target:
            return sym, None
        rec = {"mean": target,
               "lo": c.get("lowPriceTarget"),
               "hi": c.get("highPriceTarget"),
               "buy": c.get("buy"), "hold": c.get("hold"), "sell": c.get("sell")}
        return sym, {k: v for k, v in rec.items() if v is not None}

    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for sym, rec in ex.map(one, symbols):
            done += 1
            if rec:
                with lock:
                    out[sym] = rec
            if done % 150 == 0:
                log(f"    ...{done}/{len(symbols)}, {len(out)} with a target")
    log(f"    {len(out)}/{len(symbols)} have an analyst target")
    return out


def fetch_earnings_dates(session, days=80):
    """Next scheduled report date, from Nasdaq's earnings calendar.

    Walking the calendar forward costs one request per weekday and covers every
    company at once, which is far cheaper than asking per company - and unlike
    the per-company endpoint it returns a real date rather than prose."""
    log("[5/8] Earnings calendar")
    out = {}
    today = dt.date.today()
    asked = 0
    for offset in range(0, days):
        day = today + dt.timedelta(days=offset)
        if day.weekday() >= 5:          # nothing is scheduled at the weekend
            continue
        asked += 1
        try:
            r = session.get(
                "https://api.nasdaq.com/api/calendar/earnings"
                f"?date={day.isoformat()}", timeout=25)
            if r.status_code != 200:
                continue
            rows = ((r.json().get("data") or {}).get("rows")) or []
        except Exception:
            continue
        for row in rows:
            sym = str(row.get("symbol", "")).upper().replace(".", "-")
            if not sym or sym in out:   # keep the soonest date
                continue
            rec = {"d": day.isoformat()}
            eps = (row.get("epsForecast") or "").strip()
            if eps:
                rec["eps"] = eps
            when = (row.get("time") or "")
            if "pre" in when:
                rec["t"] = "pre"
            elif "after" in when:
                rec["t"] = "post"
            out[sym] = rec
        time.sleep(0.2)
    log(f"    {asked} weekdays checked, {len(out)} companies scheduled")
    return out


def collect_fundamentals(session, wanted_ciks):
    """Returns {cik: {"q": {...}, "a": {...}, "i": {...}}} where each inner map
    is {metric: [(period, value), ...]} sorted newest first."""
    log("[6/8] SEC fundamentals via frames")
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


def cross(closes, fast, slow, lookback=10):
    """'golden', 'death' or None: did the fast average cross the slow one
    within the last `lookback` sessions, and which way?

    Reads the sign of (fast - slow) across the window and reports a change,
    rather than just which is on top today. "Above" is a state and already
    covered by the vma fields; a cross is an event, and the event is the part
    that is only true for a few days.
    """
    if len(closes) < slow + lookback + 1:
        return None
    signs = []
    for back in range(lookback, -1, -1):
        upto = closes[:len(closes) - back] if back else closes
        f, sl = sma(upto, fast), sma(upto, slow)
        if f is None or sl is None:
            return None
        # A tie carries no direction. Collapsing it to one side would invent a
        # transition on the next real move - on a series that sat flat and then
        # fell, "equal" read as "below" and the fall looked like no change at
        # all.
        signs.append(0 if f == sl else (1 if f > sl else -1))
    now = signs[-1]
    if now == 0:
        return None
    if any(x != 0 and x != now for x in signs):
        return "golden" if now > 0 else "death"
    return None


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

    # Today's volume against its own 60-day average. 1.0 is an ordinary day;
    # the interesting readings are the ones well above it, which is why this
    # is a ratio rather than a raw share count - it is comparable across a
    # $2B name and a $2T one.
    last_vol = bars[-1].get("v")
    if last_vol and t.get("avgVol"):
        t["volRatio"] = last_vol / t["avgVol"]

    for slow, key in ((150, "cross150"), (200, "cross200")):
        c = cross(closes, 50, slow)
        if c:
            t[key] = c
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


def load_previous(path):
    """The snapshot from the last run, read before this run overwrites it."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def compute_changes(prev, rows, top=14, cap=40):
    """What moved since the previous run.

    This job is the only place that ever holds two snapshots at once, so the
    diff is computed here rather than asking every device to keep yesterday's
    copy and work it out again. A first run has nothing to compare against and
    returns None, which the app renders as "no comparison yet" rather than as
    an empty result.
    """
    if not prev or not prev.get("rows"):
        return None
    old = {r["s"]: r for r in prev["rows"]}
    if not old:
        return None

    score, ma_up, ma_dn, hi52, lo52 = [], [], [], [], []

    for r in rows:
        o = old.get(r["s"])
        if not o:
            continue

        new_s = (r.get("sc") or {}).get("total")
        old_s = (o.get("sc") or {}).get("total")
        if new_s is not None and old_s is not None and new_s != old_s:
            score.append({"s": r["s"], "a": old_s, "b": new_s})

        nt, ot = r.get("t") or {}, o.get("t") or {}
        np_, op = nt.get("price"), ot.get("price")
        nm, om = nt.get("ma200"), ot.get("ma200")
        if None not in (np_, op, nm, om):
            if op <= om and np_ > nm:
                ma_up.append(r["s"])
            elif op >= om and np_ < nm:
                ma_dn.append(r["s"])

        # from52High is 0 at the high and negative below it; from52Low is the
        # mirror. A threshold rather than equality, because the high itself
        # moves with the price and an exact 0 is not guaranteed to survive
        # rounding.
        nh, oh = nt.get("from52High"), ot.get("from52High")
        if nh is not None and oh is not None and nh >= -0.5 > oh:
            hi52.append(r["s"])
        nl, ol = nt.get("from52Low"), ot.get("from52Low")
        if nl is not None and ol is not None and nl <= 0.5 < ol:
            lo52.append(r["s"])

    score.sort(key=lambda x: abs(x["b"] - x["a"]), reverse=True)

    out = {
        "since": prev.get("generated"),
        "score": score[:top],
        "maUp": sorted(ma_up)[:cap],
        "maDown": sorted(ma_dn)[:cap],
        "hi52": sorted(hi52)[:cap],
        "lo52": sorted(lo52)[:cap],
        "compared": sum(1 for r in rows if r["s"] in old),
    }
    log(f"    changes vs {out['since']}: {len(score)} score moves, "
        f"{len(ma_up)}/{len(ma_dn)} MA200 crossings, "
        f"{len(hi52)} new highs, {len(lo52)} new lows")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="only process the first N symbols (for smoke tests)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--wide-min-cap", type=float, default=WIDE_MIN_CAP,
                    help="market-cap floor for the technical-only universe; "
                         "this is the runtime dial, since each extra symbol "
                         "costs one history request")
    ap.add_argument("--no-wide", action="store_true",
                    help="index universe only, as before the wide scan existed")
    args = ap.parse_args()

    os.makedirs(DATA, exist_ok=True)
    # Read before anything else can overwrite it - this is the previous run,
    # and it is the only copy of it that will ever exist.
    prev_snapshot = load_previous(os.path.join(DATA, "screener.json"))

    sec = sec_session()
    web = web_session()

    members = build_universe(web)
    core = sorted(members)          # index members: the full fundamental scan

    # Everything liquid enough to have a chart worth screening. These get
    # price history and nothing else - no SEC filings, no analyst targets, no
    # fundamentals - because the screener that reads them is technical, and
    # fetching filings for three thousand extra companies would turn a twelve
    # minute job into an hour-plus one for data nothing would display.
    wide = {} if args.no_wide else fetch_wide_universe(web, args.wide_min_cap)
    symbols = sorted(set(core) | set(wide))

    if args.limit:
        # Keep the smoke test on index members, which exercise every phase.
        core = core[:args.limit]
        symbols = sorted(set(core) | set(list(wide)[:args.limit]))
        log(f"    limited to {len(symbols)} symbols")
    core_set = set(core)
    log(f"    {len(core)} with fundamentals, "
        f"{len(symbols) - len(core)} technical-only, {len(symbols)} total")

    cik_map = sec_cik_map(sec)
    sym_cik = {s: cik_map[s][0] for s in core if s in cik_map}
    sym_name = {s: cik_map[s][1] for s in core if s in cik_map}
    log(f"    {len(sym_cik)}/{len(core)} index symbols resolved to a CIK")

    sectors = fetch_sectors(web, sec, core, sym_cik)
    # The wide list already carries a sector per row, free, from the same
    # response the symbols came from - no second lookup for them.
    for sym, meta in wide.items():
        if sym not in sectors and meta.get("sector"):
            sectors[sym] = meta["sector"]

    analyst = fetch_analyst(core, workers=args.workers)
    earnings = fetch_earnings_dates(web)

    facts = collect_fundamentals(sec, set(sym_cik.values()))

    log(f"[7/8] Prices and technicals for {len(symbols)} symbols")
    hist = {}
    # The wide universe multiplies this phase by roughly six, and it is one
    # request per symbol with no bulk alternative. More workers than the SEC
    # phases use, because Nasdaq has taken six concurrently for months without
    # complaint, but still bounded - a throttled request returns nothing and
    # the symbol quietly loses its technicals, which is exactly the kind of
    # silent degradation the warning below exists to surface.
    hist_workers = max(args.workers, 10 if len(symbols) > 1000 else args.workers)
    with ThreadPoolExecutor(max_workers=hist_workers) as ex:
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
            if done % 250 == 0:
                log(f"    ...{done}/{len(symbols)} fetched, {len(hist)} with data")
    log(f"    {len(hist)}/{len(symbols)} symbols have price history")
    if symbols and len(hist) < len(symbols) * 0.8:
        log(f"    WARNING: only {len(hist)/len(symbols)*100:.0f}% returned "
            f"history - Nasdaq is likely throttling, and the screener is "
            f"missing symbols rather than reporting an error")

    log("[8/8] Assemble")
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

        # "wide" is a membership label like sp500 and ndx, so the app's
        # existing index chips can include or exclude the technical-only
        # names without a second mechanism. A row with no label at all would
        # be filtered out by every chip and silently never appear.
        tags = sorted(members.get(sym, []))
        if not tags:
            tags = ["wide"]
        r = {"s": sym, "n": sym_name.get(sym, "") or wide.get(sym, {}).get("name", ""),
             "i": tags}
        if sectors.get(sym):
            r["sec"] = sectors[sym]
        if analyst.get(sym):
            r["an"] = analyst[sym]
        if earnings.get(sym):
            r["er"] = earnings[sym]
        price = t.get("price")
        shares = f.get("shares")
        if price and shares:
            r["mcap"] = price * shares
        elif wide.get(sym, {}).get("cap"):
            # No filings to derive it from, but the listing itself carries one.
            r["mcap"] = wide[sym]["cap"]
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
    tech_only = sum(1 for r in rows if r["s"] not in core_set)
    log(f"    {len(rows)} rows, {scored} fully scored, "
        f"{tech_only} technical-only")

    out = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "count": len(rows),
        "sources": {
            "fundamentals": "SEC EDGAR XBRL frames",
            "prices": "Nasdaq historical API",
            "universe": "Wikipedia S&P 500 + Nasdaq-100, widened with the "
                        "Nasdaq screener listing for technical-only rows",
        },
        "rows": rows,
    }
    changes = compute_changes(prev_snapshot, rows)
    if changes:
        out["changes"] = changes

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
