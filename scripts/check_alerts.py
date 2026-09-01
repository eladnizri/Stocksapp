#!/usr/bin/env python3
"""Check price alerts and push the ones that fired to ntfy.

The app keeps alerts in localStorage, where nothing outside the phone can see
them, so an alert could only ever fire while the app was open. This reads the
same alerts from data/alerts.json - committed to the repo, so the runner can
see them - and runs on a schedule. That is the whole difference: an alert can
now arrive when the app is closed.

The ntfy topic is a shared secret. Anyone who knows it can read the
notifications and publish their own, so it comes in through NTFY_TOPIC and is
never written to the repo or to the log.

State lives in data/alert_state.json so an alert fires once rather than every
fifteen minutes for as long as the condition holds. It re-arms only after the
price moves back past the threshold by REARM_PCT, so a price sitting exactly
on the line cannot flap.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
ALERTS = os.path.join(DATA, "alerts.json")
STATE = os.path.join(DATA, "alert_state.json")
TICKERS = os.path.join(DATA, "tickers.json")

# build_tickers.py runs immediately before this in the same job and has
# already priced every watched symbol. Reusing that instead of asking Nasdaq
# again halves the requests and, more importantly, means the number an alert
# fires on is the same number the app is showing.
TICKERS_MAX_AGE = 20 * 60      # seconds; older than this and it is refetched

MOVE_PCT = 3.0                 # a day's move worth interrupting someone for
REPORT_HOUR = 17               # local Israel time
REPORT_TZ = "Asia/Jerusalem"

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 "
              "Safari/537.36")

def ntfy_host():
    """Base URL for ntfy, defaulting when the variable is unset OR empty.

    An undefined repository variable reaches the job as an empty string, not
    as a missing key, so os.environ.get(name, default) hands back "" and the
    default never applies - which posted every notification to an empty URL.
    A bare hostname also gets a scheme, since requests rejects it otherwise.
    """
    host = (os.environ.get("NTFY_HOST") or "").strip().rstrip("/")
    if not host:
        return "https://ntfy.sh"
    if "://" not in host:
        host = "https://" + host
    return host


NTFY_HOST = ntfy_host()
REARM_PCT = 1.0     # how far back past the line before it can fire again
FETCH_DELAY = 0.15  # polite spacing between quote requests


def log(msg):
    print(msg, flush=True)


def session():
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA,
                      "Accept": "application/json, text/plain, */*"})
    return s


def parse_money(s):
    if s is None:
        return None
    s = str(s).replace("$", "").replace(",", "").strip()
    if not s or s in ("N/A", "--"):
        return None
    try:
        return float(s.strip("()"))
    except ValueError:
        return None


ASSET_CLASSES = ("stocks", "etf")   # IBIT and friends answer under etf, not stocks


def quote_live(sess, symbol, assetclass="stocks"):
    """Last sale from Nasdaq. None if the endpoint will not answer."""
    url = (f"https://api.nasdaq.com/api/quote/{symbol}/info"
           f"?assetclass={assetclass}")
    try:
        r = sess.get(url, timeout=20)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        pd = ((r.json().get("data") or {}).get("primaryData") or {})
    except Exception:
        return None
    return parse_money(pd.get("lastSalePrice"))


def quote_close(sess, symbol, assetclass="stocks"):
    """Most recent daily close, as a fallback.

    This is the endpoint the nightly snapshot already relies on, so it is the
    one known to work from a runner. During a session it lags by a day, which
    is worth saying out loud rather than passing off as a live price.
    """
    end = dt.date.today()
    start = end - dt.timedelta(days=10)
    url = (f"https://api.nasdaq.com/api/quote/{symbol}/historical"
           f"?assetclass={assetclass}&fromdate={start}&todate={end}&limit=5")
    try:
        r = sess.get(url, timeout=25)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        rows = (((r.json().get("data") or {}).get("tradesTable") or {})
                .get("rows") or [])
    except Exception:
        return None
    for row in rows:                      # newest first in their response
        c = parse_money(row.get("close"))
        if c is not None:
            return c
    return None


def get_price(sess, symbol):
    """(price, source). Live if the quote endpoint answers, else last close.

    Nasdaq's quote API partitions by asset class and answers nothing at all
    for the wrong one - IBIT (an ETF) got "unavailable" forever because every
    request asked for it as a stock. Try stocks first, since that covers most
    of what gets alerted on, then etf.
    """
    for assetclass in ASSET_CLASSES:
        p = quote_live(sess, symbol, assetclass)
        if p is not None:
            return p, "live"
    for assetclass in ASSET_CLASSES:
        p = quote_close(sess, symbol, assetclass)
        if p is not None:
            return p, "close"
    return None, None


def load_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


def alert_key(a):
    return f"{a['s']}|{a['d']}|{a['p']}"


def watch_list(raw):
    """Symbols the phone is watching, written into alerts.json as a hint."""
    out = []
    for w in (raw.get("watch") or []) if isinstance(raw, dict) else []:
        sym = str(w or "").strip().upper()
        if sym and sym not in out:
            out.append(sym)
    return out


def positions(raw):
    """Open trades, enough of each to report a running P&L."""
    out = []
    for pos in (raw.get("positions") or []) if isinstance(raw, dict) else []:
        if not isinstance(pos, dict):
            continue
        sym = str(pos.get("s") or "").strip().upper()
        try:
            entry = float(pos.get("entry"))
        except (TypeError, ValueError):
            continue
        if not sym or entry <= 0:
            continue
        try:
            qty = float(pos.get("qty")) if pos.get("qty") else None
        except (TypeError, ValueError):
            qty = None
        out.append({"s": sym, "entry": entry, "qty": qty})
    return out


def prebuilt_quotes():
    """{symbol: (price, pct)} from data/tickers.json, if it is fresh enough."""
    raw = load_json(TICKERS, {})
    if not isinstance(raw, dict) or not raw.get("quotes"):
        return {}
    try:
        built = dt.datetime.fromisoformat(raw["generated"])
    except Exception:
        return {}
    if built.tzinfo is None:
        built = built.replace(tzinfo=dt.timezone.utc)
    age = (dt.datetime.now(dt.timezone.utc) - built).total_seconds()
    if age > TICKERS_MAX_AGE:
        log(f"    tickers.json is {age / 60:.0f}m old - refetching instead")
        return {}
    out = {}
    for sym, q in raw["quotes"].items():
        if isinstance(q, dict) and q.get("p") is not None:
            out[str(sym).upper()] = (q["p"], q.get("c"))
    return out


def normalise(raw):
    """Accept either {"alerts": [...]} or a bare list, and drop bad rows."""
    items = raw.get("alerts") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    out = []
    for a in items:
        if not isinstance(a, dict):
            continue
        sym = str(a.get("s") or "").strip().upper()
        d = a.get("d")
        try:
            p = float(a.get("p"))
        except (TypeError, ValueError):
            continue
        if not sym or d not in ("above", "below") or p <= 0:
            continue
        out.append({"s": sym, "d": d, "p": p})
    return out


def fired(alert, price):
    if alert["d"] == "above":
        return price >= alert["p"]
    return price <= alert["p"]


def rearmed(alert, price):
    """Far enough back on the other side that firing again means something."""
    margin = alert["p"] * (REARM_PCT / 100.0)
    if alert["d"] == "above":
        return price < alert["p"] - margin
    return price > alert["p"] + margin


def israel_now():
    """Local time in Israel, which is what 17:00 means to the person reading.

    Doing this by a fixed UTC offset would drift by an hour every time the
    clocks change; zoneinfo gets it right in both directions.
    """
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo(REPORT_TZ))
    except Exception:
        # No tz database on the runner: fall back to UTC+3 and accept being an
        # hour early in winter rather than skipping the report entirely.
        return dt.datetime.now(dt.timezone(dt.timedelta(hours=3)))


def report_key(when=None):
    return f"report|{(when or israel_now()).date().isoformat()}"


def report_due(state, dry_run):
    """True inside the 17:00 hour, once a day.

    The checker runs every fifteen minutes, so this fires on whichever run
    lands first in that hour and then stays quiet - the state key is the day,
    not the run.
    """
    now = israel_now()
    if now.hour != REPORT_HOUR:
        return False
    if dry_run:
        return True
    return report_key(now) not in state


EARNINGS_WINDOW = 2   # days out; 0/1/2 all count as "coming up"


def earnings_calendar(sess, symbols):
    """{symbol: {"d": date, "eps": str|None, "t": "pre"|"post"|None}} for
    whichever of `symbols` report within EARNINGS_WINDOW days from today.

    Nasdaq's calendar is keyed by day and lists every company reporting that
    day, so three requests - today, tomorrow, the day after - cover the whole
    watchlist regardless of how many symbols are in it. This is the same
    endpoint build_snapshot.py already trusts for the nightly scan; the only
    difference is the horizon, three days instead of eighty, because a heads
    up further out than that is not yet actionable.
    """
    wanted = set(symbols)
    if not wanted:
        return {}
    out = {}
    today = dt.date.today()
    for offset in range(EARNINGS_WINDOW + 1):
        day = today + dt.timedelta(days=offset)
        try:
            r = sess.get(
                "https://api.nasdaq.com/api/calendar/earnings"
                f"?date={day.isoformat()}", timeout=20)
            if r.status_code != 200:
                continue
            rows = ((r.json().get("data") or {}).get("rows")) or []
        except Exception:
            continue
        for row in rows:
            sym = str(row.get("symbol", "")).upper().replace(".", "-")
            if sym not in wanted or sym in out:   # keep the soonest date
                continue
            rec = {"d": day.isoformat()}
            eps = (row.get("epsForecast") or "").strip()
            if eps:
                rec["eps"] = eps
            when = row.get("time") or ""
            if "pre" in when:
                rec["t"] = "pre"
            elif "after" in when:
                rec["t"] = "post"
            out[sym] = rec
        time.sleep(FETCH_DELAY)
    return out


def earnings_when(iso_date):
    """'היום' / 'מחר' / 'בעוד יומיים', so the notification reads naturally
    rather than making the person do date arithmetic in their head."""
    delta = (dt.date.fromisoformat(iso_date) - dt.date.today()).days
    if delta <= 0:
        return "היום"
    if delta == 1:
        return "מחר"
    return f"בעוד {delta} ימים"


def money(v):
    return f"{'+' if v >= 0 else '−'}${abs(v):,.2f}"


def report_text(open_pos, prices, pcts):
    """The 17:00 summary: how the positions stand, and how the market moved."""
    lines = []

    if open_pos:
        total = 0.0
        counted = False
        for pos in open_pos:
            price = prices.get(pos["s"])
            if price is None:
                lines.append(f"{pos['s']}: אין מחיר")
                continue
            per = price - pos["entry"]
            pct = (per / pos["entry"]) * 100
            if pos["qty"]:
                dollars = per * pos["qty"]
                total += dollars
                counted = True
                lines.append(f"{pos['s']}: {money(dollars)} ({pct:+.1f}%)")
            else:
                lines.append(f"{pos['s']}: {pct:+.1f}% למניה")
        if counted and len(open_pos) > 1:
            lines.append(f"סה״כ {money(total)}")
    else:
        lines.append("אין עסקאות פתוחות")

    market = []
    for sym, label in (("SPY", "S&P"), ("QQQ", "נאסד״ק")):
        pct = pcts.get(sym)
        if pct is not None:
            market.append(f"{label} {pct:+.1f}%")
        elif prices.get(sym) is not None:
            market.append(f"{label} ${prices[sym]:,.2f}")
    if market:
        lines.append(" · ".join(market))

    return f"סיכום {israel_now().strftime('%H:%M')}", "\n".join(lines)


def notify(topic, title, message, tags, dry_run):
    """Publish through ntfy's JSON API.

    The header-based API cannot carry Hebrew cleanly - headers are latin-1 -
    so the JSON body is the only form that keeps the text intact.
    """
    if dry_run:
        log(f"    [dry-run] {title} :: {message}")
        return True
    try:
        r = requests.post(ntfy_host(), json={
            "topic": topic,
            "title": title,
            "message": message,
            "tags": tags,
            "priority": 4,
        }, timeout=20)
        if r.status_code >= 300:
            log(f"    ntfy rejected it: HTTP {r.status_code} {r.text[:200]}")
            return False
        return True
    except Exception as e:
        log(f"    ntfy request failed: {type(e).__name__}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="check and report, but send nothing and save nothing")
    ap.add_argument("--probe", metavar="SYMBOL", default="",
                    help="fetch one price, report which source answered, and "
                         "exit - a health check for the quote endpoints")
    args = ap.parse_args()

    # Worth having on its own: the runner can reach Nasdaq but a sandbox often
    # cannot, so whether the live endpoint answers is only ever knowable here.
    if args.probe:
        sym = args.probe.strip().upper()
        sess = session()
        log(f"probe {sym}")
        live = close = None
        for assetclass in ASSET_CLASSES:
            live = quote_live(sess, sym, assetclass)
            log(f"    live  (quote/info, {assetclass:6}) : "
                f"{live if live is not None else 'NO ANSWER'}")
            if live is not None:
                break
        for assetclass in ASSET_CLASSES:
            close = quote_close(sess, sym, assetclass)
            log(f"    close (quote/historical, {assetclass:6}): "
                f"{close if close is not None else 'NO ANSWER'}")
            if close is not None:
                break
        if live is None and close is None:
            log("    neither endpoint answered - alerts cannot run")
            return 1
        if live is None:
            log("    live quotes unavailable; alerts will use the last close "
                "and say so in the message")
        return 0

    topic = (os.environ.get("NTFY_TOPIC") or "").strip()
    if not topic and not args.dry_run:
        log("NTFY_TOPIC is not set. Add it as a repository secret - see "
            "docs/alerts.md.")
        return 1

    raw = load_json(ALERTS, {})
    alerts = normalise(raw)
    watched = watch_list(raw)
    open_pos = positions(raw)
    if not alerts and not watched and not open_pos:
        log("Nothing defined - no alerts, no watchlist, no positions.")
        return 0
    log(f"{len(alerts)} alert(s), {len(watched)} watched, "
        f"{len(open_pos)} position(s)")

    state = load_json(STATE, {})
    if not isinstance(state, dict):
        state = {}

    sess = session()
    # Prices come from the file build_tickers.py just wrote wherever possible,
    # so the number an alert fires on is the number the app is showing.
    prebuilt = prebuilt_quotes()
    if prebuilt:
        log(f"    reusing {len(prebuilt)} quote(s) from tickers.json")

    prices, sources, pcts = {}, {}, {}
    need = sorted({a["s"] for a in alerts}
                  | set(watched)
                  | {p["s"] for p in open_pos}
                  | {"SPY", "QQQ"})          # the report always names these
    for sym in need:
        if sym in prebuilt:
            prices[sym], pcts[sym] = prebuilt[sym]
            sources[sym] = "live"
            continue
        price, src = get_price(sess, sym)
        prices[sym], sources[sym] = price, src
        log(f"    {sym}: {price if price is not None else 'unavailable'}"
            f"{' (' + src + ')' if src else ''}")
        time.sleep(FETCH_DELAY)

    stale = [s for s, v in sources.items() if v == "close"]
    if stale:
        log(f"    note: {len(stale)} symbol(s) fell back to the last daily "
            f"close, which lags during a session: {', '.join(stale)}")

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    live_keys = {alert_key(a) for a in alerts}
    changed = False
    sent = 0
    failed = 0

    for a in alerts:
        key = alert_key(a)
        price = prices.get(a["s"])
        if price is None:
            continue

        if key in state:
            if rearmed(a, price):
                del state[key]
                changed = True
                log(f"    {a['s']} re-armed at {price}")
            continue

        if not fired(a, price):
            continue

        word = "עלתה מעל" if a["d"] == "above" else "ירדה מתחת ל־"
        tag = ("chart_with_upwards_trend" if a["d"] == "above"
               else "chart_with_downwards_trend")
        note = ""
        if sources.get(a["s"]) == "close":
            note = "\n(מחיר סגירה אחרון — לא ציטוט חי)"
        ok = notify(
            topic,
            f"{a['s']} {a['p']:g}$",
            f"{a['s']} {word} ${a['p']:g}\nכעת ${price:,.2f}{note}",
            [tag],
            args.dry_run,
        )
        if ok:
            sent += 1
            state[key] = {"fired": now, "price": price}
            changed = True
            log(f"    FIRED {a['s']} {a['d']} {a['p']} at {price}")
        else:
            # Deliberately not recorded as fired, so the next run tries again
            # rather than treating an undelivered alert as delivered.
            failed += 1

    # --- a big day, for anything on the watchlist -------------------------
    today = dt.date.today().isoformat()
    for sym in watched:
        pct = pcts.get(sym)
        price = prices.get(sym)
        if pct is None or price is None:
            continue
        if abs(pct) < MOVE_PCT:
            continue
        # Keyed by the day, so one move is one notification however many times
        # the checker runs afterwards while the stock stays up there.
        key = f"move|{sym}|{today}"
        if key in state:
            continue
        up = pct >= 0
        ok = notify(
            topic,
            f"{sym} {pct:+.1f}%",
            f"{sym} {'זינקה' if up else 'צנחה'} {abs(pct):.1f}% היום\n"
            f"כעת ${price:,.2f}",
            ["chart_with_upwards_trend" if up else "chart_with_downwards_trend"],
            args.dry_run,
        )
        if ok:
            sent += 1
            state[key] = {"fired": now, "pct": pct}
            changed = True
            log(f"    MOVED {sym} {pct:+.2f}%")
        else:
            failed += 1

    # --- earnings coming up, for anything held or watched -----------------
    er_syms = {a["s"] for a in alerts} | set(watched) | {p["s"] for p in open_pos}
    for sym, er in earnings_calendar(sess, er_syms).items():
        # Keyed by the report date itself, not by how many days out it is, so
        # this fires exactly once per report - whichever run first sees it
        # inside the window - rather than once a day as it counts down.
        key = f"earnings|{sym}|{er['d']}"
        if key in state:
            continue
        when_word = earnings_when(er["d"])
        session_word = {"pre": " (לפני הפתיחה)", "post": " (אחרי הנעילה)"}.get(er.get("t"), "")
        eps_line = f"\nתחזית EPS: {er['eps']}" if er.get("eps") else ""
        held = sym in {p["s"] for p in open_pos}
        ok = notify(
            topic,
            f"{sym} מדווחת {when_word}",
            f"{sym} מדווחת רבעון {when_word}{session_word}\n"
            f"{'יש לך פוזיציה פתוחה' if held else 'ברשימת המעקב שלך'}{eps_line}",
            ["loudspeaker"],
            args.dry_run,
        )
        if ok:
            sent += 1
            state[key] = {"fired": now, "d": er["d"]}
            changed = True
            log(f"    EARNINGS {sym} on {er['d']}")
        else:
            failed += 1

    # --- the daily report -------------------------------------------------
    if report_due(state, args.dry_run):
        title, body = report_text(open_pos, prices, pcts)
        if notify(topic, title, body, ["bar_chart"], args.dry_run):
            sent += 1
            state[report_key()] = {"sent": now}
            changed = True
            log("    daily report sent")
        else:
            failed += 1

    # An alert deleted from alerts.json should not leave its state behind.
    # Only alert keys are pruned: the move, report and earnings keys are
    # dated, not tied to any alert, and wiping them would re-send today's
    # notifications on the next run.
    for key in [k for k in state
                if "|" in k and not k.startswith(("move|", "report|", "earnings|"))
                and k not in live_keys]:
        del state[key]
        changed = True

    # Dated keys are pruned by age instead, so the file cannot grow forever.
    cutoff = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    for key in [k for k in state
                if k.startswith(("move|", "report|", "earnings|"))
                and k.rsplit("|", 1)[-1] < cutoff]:
        del state[key]
        changed = True

    if changed and not args.dry_run:
        os.makedirs(DATA, exist_ok=True)
        with open(STATE, "w") as fh:
            json.dump(state, fh, indent=1, sort_keys=True)
            fh.write("\n")
        log("    state updated")

    log(f"Done. {sent} notification(s) sent, {len(state)} alert(s) armed.")
    # Signals to the workflow whether there is anything to commit.
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")

    if failed:
        # A green run that quietly delivered nothing is the worst outcome
        # here: the alert looks handled and never arrives. Fail loudly.
        log(f"ERROR: {failed} notification(s) could not be delivered.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
