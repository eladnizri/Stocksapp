#!/usr/bin/env python3
"""Can ntfy carry a friend's alert list, not just deliver notifications?

The idea under test: a friend's browser publishes its alert list to an ntfy
topic, and this runner reads it back on the next scheduled check. If that
works there is no server to run, no token to hand out and nobody in the
middle - the notification channel everyone already installs doubles as the
inbox.

Four things have to be true. Each is measured here rather than assumed,
because a wrong assumption about a remote service has already cost this
project two rebuilds:

  1. the runner can read a topic's cached messages back, unauthenticated
  2. a browser is allowed to publish (ntfy must send CORS headers)
  3. messages survive long enough to be useful, and we learn how long
  4. a realistic alert list fits inside one message

Run it from a GitHub runner - a sandbox usually cannot reach ntfy.sh, and the
runner is where the real checker lives anyway.
"""
import json
import time
import uuid

import requests

HOST = "https://ntfy.sh"
TOPIC = "stocksapp-probe-" + uuid.uuid4().hex[:16]
ORIGIN = "https://eladnizri.github.io"


def cors_of(r):
    return r.headers.get("Access-Control-Allow-Origin") or "ABSENT"


def publish(payload, label):
    r = requests.post(HOST, json=payload, headers={"Origin": ORIGIN}, timeout=20)
    print(f"  {label}: HTTP {r.status_code}   CORS: {cors_of(r)}")
    if r.status_code >= 300:
        print(f"    body: {r.text[:200]}")
    return r


def read_back(query, label):
    url = f"{HOST}/{TOPIC}/json?{query}"
    try:
        r = requests.get(url, timeout=20)
    except Exception as e:
        print(f"  {label}: request failed: {type(e).__name__}")
        return []
    lines = [ln for ln in r.text.strip().splitlines() if ln.strip()]
    msgs = []
    for ln in lines:
        try:
            m = json.loads(ln)
        except Exception:
            continue
        if m.get("event") == "message":
            msgs.append(m)
    print(f"  {label}: HTTP {r.status_code}, {len(msgs)} message(s)")
    return msgs


def main():
    print(f"topic: {TOPIC}\n")

    # -- 2. publishing, with the header a browser's request would carry ------
    print("2. can a browser publish? (the CORS header is the whole question)")
    cfg = {"v": 1, "alerts": [{"s": "AAPL", "d": "above", "p": 250}],
           "watch": ["AAPL", "MSFT"]}
    publish({"topic": TOPIC, "title": "cfg", "message": json.dumps(cfg)},
            "POST / (json body)")

    r = requests.options(HOST, headers={
        "Origin": ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    }, timeout=20)
    print(f"  OPTIONS / (preflight): HTTP {r.status_code}   CORS: {cors_of(r)}")
    print(f"    Allow-Methods: {r.headers.get('Access-Control-Allow-Methods') or 'ABSENT'}")
    print(f"    Allow-Headers: {r.headers.get('Access-Control-Allow-Headers') or 'ABSENT'}")
    print("    -> a browser can publish only if both of the above are present\n")

    time.sleep(3)

    # -- 1. reading it back, which is what the checker would do --------------
    print("1. can the runner read it back, with no credentials?")
    msgs = read_back("poll=1", "poll=1")
    got = read_back("poll=1&since=all", "poll=1&since=all")
    if got:
        last = got[-1]
        print(f"    newest title={last.get('title')!r}")
        try:
            back = json.loads(last.get("message") or "{}")
            same = back == cfg
            print(f"    payload round-tripped intact: {same}")
            if not same:
                print(f"      sent: {cfg}")
                print(f"      got : {back}")
        except Exception as e:
            print(f"    payload did NOT parse back: {type(e).__name__}")
    else:
        print("    NOTHING came back - the whole design is dead here\n")
    print()

    # -- 4. how big can one config be? --------------------------------------
    print("4. how large a list fits in one message?")
    for n in (25, 100, 400):
        big = {"v": 1, "alerts": [{"s": f"SYM{i}", "d": "above", "p": 100 + i}
                                  for i in range(n)]}
        body = json.dumps(big)
        r = publish({"topic": TOPIC, "title": f"cfg{n}", "message": body},
                    f"{n} alerts ({len(body):,} bytes)")
        time.sleep(1)
        if r.status_code >= 300:
            print(f"    -> {n} alerts is past the limit")
            break
    print()

    # -- 3. retention -------------------------------------------------------
    print("3. how long are messages kept?")
    try:
        r = requests.get(f"{HOST}/v1/config", timeout=20)
        print(f"  GET /v1/config: HTTP {r.status_code} {r.text[:200]}")
    except Exception as e:
        print(f"  /v1/config: {type(e).__name__}")
    for q in ("since=all", "since=24h", "since=12h"):
        n = len(read_back(f"poll=1&{q}", f"  {q}"))
    print("\n  (ntfy.sh's published default is 12h of cached messages; the app")
    print("   would re-publish on every open, and the checker keeps the last")
    print("   copy it saw, so a quiet week still keeps working.)")


if __name__ == "__main__":
    main()
