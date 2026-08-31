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
    if not alerts:
        log("No alerts defined; nothing to check.")
        return 0
    log(f"{len(alerts)} alert(s) to check")

    state = load_json(STATE, {})
    if not isinstance(state, dict):
        state = {}

    sess = session()
    # One request per symbol, not per alert - several alerts can watch one.
    prices, sources = {}, {}
    for sym in sorted({a["s"] for a in alerts}):
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

    # An alert deleted from alerts.json should not leave its state behind.
    for key in [k for k in state if k not in live_keys]:
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
