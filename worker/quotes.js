/* The app's server side, running on Cloudflare Workers.
 *
 * Two jobs in one file, because the Cloudflare dashboard editor deploys a
 * single file and one deploy is easier to keep straight than two:
 *
 *   1. GET /q?s=...  - live quotes the browser is allowed to read (below).
 *   2. A cron trigger that checks price alerts and sends them to ntfy, which
 *      is the second half of this file.
 *
 * ---------------------------------------------------------------------------
 * 1. Quotes
 *
 * Why this exists. The page needs live prices, and every way of getting them
 * straight from the browser is closed:
 *
 *   - Yahoo sends no Access-Control-Allow-Origin, so the browser refuses to
 *     hand its answer to JavaScript.
 *   - Nasdaq is the same: it answers a server perfectly and sends no CORS
 *     header, so the page can never read it either.
 *   - The public CORS proxies that used to bridge that gap failed together -
 *     two timed out, corsproxy.io moved to a paid key - and they flap in and
 *     out hour to hour.
 *   - Fetching on a GitHub runner and committing the result works, but only
 *     as often as the cron actually fires, and that has been delivering about
 *     one run every four hours instead of four an hour.
 *
 * A Worker fixes the root cause rather than routing around it: it runs
 * server-side, so no CORS applies to its own upstream calls, and it can put a
 * real Access-Control-Allow-Origin on what it returns. One hop, ours, no
 * schedule involved - the price is fetched when the phone asks for it.
 *
 * Deliberately not an open proxy: the caller passes symbols, never URLs, and
 * each symbol is filtered down to the characters a ticker can contain. There
 * is no input that makes this fetch anything but Yahoo or Nasdaq.
 *
 *   GET /q?s=SPY,QQQ,^VIX
 *   -> { "ts": 1234567890, "quotes": {
 *          "SPY":  { "p": 767.34, "c": 0.04, "n": "SPDR S&P 500", "src": "yahoo" },
 *          "^VIX": { "p": 15.2,  "c": -1.1,  "src": "yahoo" } } }
 *
 * Deploy: see docs/quotes.md.
 */

const MAX_SYMBOLS = 25;      // also keeps us under the subrequest limit
const EDGE_TTL = 20;         // seconds a quote may be reused from the edge
const UPSTREAM_TIMEOUT = 6000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/* A ticker, and nothing that could steer a request somewhere else.
   Carets, dots, dashes and equals cover indices (^VIX), classes (BRK.B),
   crypto (BTC-USD) and forex (USDILS=X). */
function cleanSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9.^=-]{1,12}$/.test(s) ? s : null;
}

function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/* Yahoo first: one call returns the price, the previous close, the name and
   whether the market is open, and it covers indices, forex and futures that
   Nasdaq has no listing for at all. */
async function fromYahoo(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=1d&range=1d';
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: withTimeout(UPSTREAM_TIMEOUT),
  });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const d = await r.json();
  const m = d?.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error('yahoo empty');
  const prev = m.chartPreviousClose ?? m.previousClose;
  return {
    p: m.regularMarketPrice,
    c: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
    n: m.longName || m.shortName || '',
    st: m.marketState || '',
    src: 'yahoo',
  };
}

/* Nasdaq as the second opinion. It only knows stocks and ETFs, and it
   partitions by asset class - asking for the wrong one returns nothing at
   all rather than an error, which is why both are tried. */
async function fromNasdaq(sym) {
  for (const assetclass of ['stocks', 'etf']) {
    const url = 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(sym) +
      '/info?assetclass=' + assetclass;
    let d;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: withTimeout(UPSTREAM_TIMEOUT),
      });
      if (!r.ok) continue;
      d = await r.json();
    } catch (e) {
      continue;
    }
    const pd = d?.data?.primaryData;
    const p = num(pd?.lastSalePrice);
    if (p == null) continue;
    return {
      p,
      c: num(pd?.percentageChange),
      n: d?.data?.companyName || '',
      st: d?.data?.marketStatus || '',
      src: 'nasdaq',
    };
  }
  throw new Error('nasdaq empty');
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

async function quote(sym) {
  try {
    return await fromYahoo(sym);
  } catch (e) {
    // Indices, forex and futures have no Nasdaq listing, so there is nothing
    // to fall back to and the failure stands.
    if (/[\^=]/.test(sym)) throw e;
    return await fromNasdaq(sym);
  }
}

export default {
  // Workers hand the module form three arguments; ctx is the third, and
  // getting that wrong is how waitUntil silently stops caching anything.
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET only' }, 405);
    }

    const url = new URL(request.url);

    /* Setup check: one page that says whether every piece the scheduled
       alert run depends on is actually wired up. Without it a missing KV
       binding or secret is invisible until an alert silently fails to
       arrive, which is the one failure mode that looks like success. */
    if (url.pathname === '/health') {
      return json({
        ok: true,
        quotes: true,
        alertsUrl: alertsUrl(env),
        kv: !!env.ALERTS,
        ntfyTopic: !!(env.NTFY_TOPIC || '').trim(),
        ntfyHost: ntfyHost(env),
        israelTime: israelParts().date + ' ' +
          String(israelParts().hour).padStart(2, '0') + ':' +
          String(israelParts().minute).padStart(2, '0'),
      });
    }

    /* Manual exercise of the scheduled run. ?dry=1 checks and reports
       without sending or saving; ?ping=1 sends one real notification so
       ntfy itself can be proven end to end. The ping is rate limited in KV
       because this URL is public - knowing it should not let anyone flood
       the phone. */
    if (url.pathname === '/alerts') {
      if (url.searchParams.get('ping')) {
        return json(await ping(env));
      }
      return json(await runAlerts(env, { dry: !!url.searchParams.get('dry') }));
    }

    const symbols = [...new Set((url.searchParams.get('s') || '')
      .split(',').map(cleanSymbol).filter(Boolean))].slice(0, MAX_SYMBOLS);

    if (!symbols.length) {
      return json({ error: 'pass ?s=SYM,SYM' }, 400);
    }

    /* Answer from Cloudflare's own cache when the same set was asked for
       moments ago, so a phone polling every minute - or several devices -
       cannot turn into repeated upstream traffic. */
    const cacheKey = new Request(url.origin + url.pathname + '?s=' +
      symbols.join(','), request);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const results = await Promise.all(symbols.map(async (s) => {
      try {
        return [s, await quote(s)];
      } catch (e) {
        return [s, null];      // one bad symbol must not sink the request
      }
    }));

    const quotes = {};
    for (const [s, q] of results) if (q) quotes[s] = q;

    const res = json({ ts: Date.now(), quotes }, 200, {
      'Cache-Control': 'public, max-age=' + EDGE_TTL,
    });
    // Cache a partial answer only briefly; a wholly empty one not at all, so
    // a passing upstream outage cannot be served back for twenty seconds.
    if (Object.keys(quotes).length) {
      ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
    }
    return res;
  },

  /* The cron trigger. Same checks the GitHub workflow used to run, on a
     scheduler that actually fires - which was the whole problem: GitHub was
     delivering roughly one tick every four hours instead of four an hour,
     and an alert that arrives four hours late is not an alert. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env, { dry: false }).then(
      (r) => console.log('alerts:', JSON.stringify(r)),
      (e) => console.log('alerts failed:', e && e.stack || String(e)),
    ));
  },
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

/* ---------------------------------------------------------------------------
 * Alerts, on a schedule that fires.
 *
 * This is a port of scripts/check_alerts.py, which ran on GitHub Actions. The
 * checks are identical - the same thresholds, the same re-arm margin, the same
 * once-a-day keys, the same Hebrew wording - and only two things changed:
 *
 *   - The scheduler. GitHub's cron went quiet for three days straight with the
 *     workflow reporting healthy, and afterwards settled at about one tick
 *     every four hours instead of four an hour. Cloudflare's runs on time.
 *   - Where state lives. A repo file cannot be written from here, so the fired
 *     set sits in KV instead. Same shape, same keys, same pruning.
 *
 * The alert definitions still come from data/alerts.json in the repo, which is
 * what the app already syncs to. Nothing about how alerts are created changes.
 * ------------------------------------------------------------------------- */

const MOVE_PCT = 3.0;          // a day's move worth interrupting someone for
const REPORT_HOUR = 17;        // local Israel time
const REPORT_TZ = 'Asia/Jerusalem';
const REARM_PCT = 1.0;         // how far back past the line before it re-fires
const STATE_KEY = 'alert_state';
const PING_GAP = 10 * 60 * 1000;   // least time between two manual pings

/* Every upstream call on the scheduled path comes out of one budget. A free
   Worker gets 50 subrequests per invocation, and a symbol can cost three when
   Yahoo fails and both Nasdaq asset classes are tried - so a long watchlist
   could quietly run out partway and drop the symbols at the end. Spending a
   declared budget, alert symbols first, makes what gets dropped a decision
   rather than an accident. Left smaller than the ceiling on purpose: the
   alerts.json fetch, the earnings calendar (up to three days) and the
   notifications themselves all draw from the same 50, outside this budget. */
const CALL_BUDGET = 40;
const EARNINGS_WINDOW = 2;   // days out; 0/1/2 all count as "coming up"

function alertsUrl(env) {
  return (env && env.ALERTS_URL || '').trim() ||
    'https://raw.githubusercontent.com/eladnizri/Stocksapp/main/data/alerts.json';
}

function ntfyHost(env) {
  let h = ((env && env.NTFY_HOST) || '').trim().replace(/\/+$/, '');
  if (!h) return 'https://ntfy.sh';
  if (!/:\/\//.test(h)) h = 'https://' + h;
  return h;
}

/* Local time in Israel, which is what 17:00 means to the person reading it.
   A fixed UTC offset would drift by an hour twice a year; the timezone
   database gets it right in both directions. h23 rather than hour12:false
   because the latter can hand back "24" at midnight. */
function israelParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of f.formatToParts(d || new Date())) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

function normaliseAlerts(raw) {
  const items = Array.isArray(raw) ? raw : (raw && raw.alerts);
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const a of items) {
    if (!a || typeof a !== 'object') continue;
    const s = cleanSymbol(a.s);
    const p = Number(a.p);
    if (!s || (a.d !== 'above' && a.d !== 'below') || !(p > 0)) continue;
    out.push({ s, d: a.d, p });
  }
  return out;
}

function watchList(raw) {
  const out = [];
  for (const w of (raw && raw.watch) || []) {
    const s = cleanSymbol(w);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function openPositions(raw) {
  const out = [];
  for (const pos of (raw && raw.positions) || []) {
    if (!pos || typeof pos !== 'object') continue;
    const s = cleanSymbol(pos.s);
    const entry = Number(pos.entry);
    if (!s || !(entry > 0)) continue;
    const qty = Number(pos.qty);
    out.push({ s, entry, qty: qty > 0 ? qty : null });
  }
  return out;
}

const alertKey = (a) => `${a.s}|${a.d}|${a.p}`;

function hasFired(a, price) {
  return a.d === 'above' ? price >= a.p : price <= a.p;
}

/* Far enough back on the other side that firing again means something. A
   price resting exactly on the line would otherwise flap every run. */
function rearmed(a, price) {
  const margin = a.p * (REARM_PCT / 100);
  return a.d === 'above' ? price < a.p - margin : price > a.p + margin;
}

function money(v) {
  const abs = Math.abs(v).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v >= 0 ? '+' : '−') + '$' + abs;
}

const dollars = (v) => '$' + v.toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pctStr = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/* {symbol: {d, eps?, t?}} for whichever of `symbols` report within
   EARNINGS_WINDOW days from today. Nasdaq's calendar is keyed by day and
   lists every company reporting that day, so three requests - today,
   tomorrow, the day after - cover the whole watchlist regardless of how many
   symbols are in it. Same endpoint scripts/build_snapshot.py already trusts
   for the nightly scan; the horizon here is three days instead of eighty,
   because a heads-up further out than that is not yet actionable. */
async function earningsCalendar(symbols) {
  const wanted = new Set(symbols);
  if (!wanted.size) return {};
  const out = {};
  const base = new Date();
  for (let offset = 0; offset <= EARNINGS_WINDOW; offset++) {
    const day = isoDate(addDays(base, offset));
    try {
      const r = await fetch(
        'https://api.nasdaq.com/api/calendar/earnings?date=' + day,
        { headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: withTimeout(UPSTREAM_TIMEOUT) });
      if (!r.ok) continue;
      const d = await r.json();
      const rows = (d && d.data && d.data.rows) || [];
      for (const row of rows) {
        const sym = String(row.symbol || '').toUpperCase().replace(/\./g, '-');
        if (!wanted.has(sym) || out[sym]) continue;   // keep the soonest date
        const rec = { d: day };
        const eps = String(row.epsForecast || '').trim();
        if (eps) rec.eps = eps;
        const when = String(row.time || '');
        if (when.includes('pre')) rec.t = 'pre';
        else if (when.includes('after')) rec.t = 'post';
        out[sym] = rec;
      }
    } catch (e) { /* one bad day must not stop the rest */ }
  }
  return out;
}

/* 'היום' / 'מחר' / 'בעוד N ימים', so the notification reads naturally rather
   than making the person do date arithmetic in their head. */
function earningsWhen(iso) {
  const today = isoDate(new Date());
  const delta = Math.round(
    (new Date(iso + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  if (delta <= 0) return 'היום';
  if (delta === 1) return 'מחר';
  return `בעוד ${delta} ימים`;
}

/* The 17:00 summary: how the open positions stand, and how the market moved. */
function reportText(open, prices, pcts) {
  const lines = [];
  if (open.length) {
    let total = 0, counted = false;
    for (const pos of open) {
      const price = prices[pos.s];
      if (price == null) { lines.push(`${pos.s}: אין מחיר`); continue; }
      const per = price - pos.entry;
      const pct = (per / pos.entry) * 100;
      if (pos.qty) {
        total += per * pos.qty;
        counted = true;
        lines.push(`${pos.s}: ${money(per * pos.qty)} (${pctStr(pct)})`);
      } else {
        lines.push(`${pos.s}: ${pctStr(pct)} למניה`);
      }
    }
    if (counted && open.length > 1) lines.push(`סה״כ ${money(total)}`);
  } else {
    lines.push('אין עסקאות פתוחות');
  }

  const market = [];
  for (const [sym, label] of [['SPY', 'S&P'], ['QQQ', 'נאסד״ק']]) {
    if (pcts[sym] != null) market.push(`${label} ${pctStr(pcts[sym])}`);
    else if (prices[sym] != null) market.push(`${label} ${dollars(prices[sym])}`);
  }
  if (market.length) lines.push(market.join(' · '));

  const t = israelParts();
  return {
    title: `סיכום ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
    message: lines.join('\n'),
  };
}

/* ntfy's JSON API rather than its header API: headers are latin-1, so Hebrew
   cannot survive them intact. */
async function notify(env, topic, title, message, tags, dry) {
  if (dry) return true;
  try {
    const r = await fetch(ntfyHost(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, tags, priority: 4 }),
      signal: withTimeout(UPSTREAM_TIMEOUT),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function readState(env) {
  if (!env || !env.ALERTS) return null;
  try {
    const raw = await env.ALERTS.get(STATE_KEY, 'json');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    return null;
  }
}

/* A quote that spends from a shared budget, so a long watchlist cannot run
   the invocation out of subrequests before the alerts have been priced. */
async function budgetedQuote(sym, budget) {
  if (budget.left <= 0) return null;
  budget.left -= 1;
  try {
    return await fromYahoo(sym);
  } catch (e) {
    if (/[\^=]/.test(sym) || budget.left < 2) return null;
    budget.left -= 2;
    try {
      return await fromNasdaq(sym);
    } catch (e2) {
      return null;
    }
  }
}

async function ping(env) {
  const topic = ((env && env.NTFY_TOPIC) || '').trim();
  if (!topic) return { ok: false, why: 'NTFY_TOPIC is not set' };
  if (!env.ALERTS) return { ok: false, why: 'no KV namespace bound as ALERTS' };
  const last = Number(await env.ALERTS.get('ping_at')) || 0;
  if (Date.now() - last < PING_GAP) {
    return { ok: false, why: 'rate limited', retryInSec:
      Math.ceil((PING_GAP - (Date.now() - last)) / 1000) };
  }
  await env.ALERTS.put('ping_at', String(Date.now()));
  const sent = await notify(env, topic, 'בדיקה',
    'שרת ההתראות מחובר ושולח.', ['white_check_mark'], false);
  return { ok: sent, sent };
}

/* An alert deleted in the app should not leave its state behind. Only alert
   keys are pruned by liveness: the move, report and earnings keys are dated
   rather than tied to any alert, and wiping those would re-send today's
   notifications on the very next run. They age out instead, so the store
   cannot grow forever. */
function pruneState(state, alerts) {
  const live = new Set(alerts.map(alertKey));
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let changed = false;
  for (const k of Object.keys(state)) {
    const dated = k.startsWith('move|') || k.startsWith('report|') || k.startsWith('earnings|');
    const stale = dated ? k.split('|').pop() < cutoff
                        : k.includes('|') && !live.has(k);
    if (stale) { delete state[k]; changed = true; }
  }
  return changed;
}

async function runAlerts(env, opt) {
  const dry = !!(opt && opt.dry);
  const out = { dry, sent: 0, failed: 0, fired: [], moved: [], report: false,
                notes: [] };

  const topic = ((env && env.NTFY_TOPIC) || '').trim();
  if (!topic && !dry) {
    out.notes.push('NTFY_TOPIC is not set - nothing can be delivered');
    return out;
  }

  /* No KV means no memory of what already fired, and an alert that re-sends
     every fifteen minutes is worse than one that never arrives. Refuse to
     send rather than turn the phone into an alarm clock. */
  let state = await readState(env);
  if (state === null) {
    out.notes.push('no KV namespace bound as ALERTS - refusing to send, ' +
                   'since every alert would repeat on every run');
    if (!dry) return out;
    state = {};
  }

  let raw;
  try {
    const r = await fetch(alertsUrl(env) + '?t=' + Date.now(), {
      headers: { Accept: 'application/json' },
      signal: withTimeout(UPSTREAM_TIMEOUT),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    raw = await r.json();
  } catch (e) {
    out.notes.push('could not read alerts.json: ' + String(e.message || e));
    return out;
  }

  const alerts = normaliseAlerts(raw);
  const watched = watchList(raw);
  const open = openPositions(raw);
  out.counts = { alerts: alerts.length, watched: watched.length,
                 positions: open.length };
  /* Prune first, so it happens even on the runs that stop early below. An
     alert deleted in the app would otherwise leave its key behind forever,
     and deleting every alert is exactly the case that stops early. */
  let changed = pruneState(state, alerts);

  /* Nothing configured and nothing to report: stop before spending any
     upstream calls. The report hour is the exception - "how did SPY and QQQ
     move today" is worth sending on its own, even with an empty watchlist and
     no open trades. */
  if (!alerts.length && !watched.length && !open.length &&
      israelParts().hour !== REPORT_HOUR) {
    if (changed && !dry && env.ALERTS) {
      await env.ALERTS.put(STATE_KEY, JSON.stringify(state));
    }
    out.armed = Object.keys(state).length;
    return out;
  }

  /* Order matters once the budget is finite: an alert the person set by hand
     outranks a watchlist entry, and the report needs SPY and QQQ. Whatever
     falls off the end is the least consequential thing on the list. */
  const need = [];
  const push = (s) => { if (s && !need.includes(s)) need.push(s); };
  alerts.forEach((a) => push(a.s));
  open.forEach((p) => push(p.s));
  push('SPY'); push('QQQ');
  watched.forEach(push);
  const budget = { left: CALL_BUDGET };
  const priced = need.slice(0, 40);
  if (need.length > priced.length) {
    out.notes.push(`priced ${priced.length} of ${need.length} symbols`);
  }

  const prices = {}, pcts = {};
  const got = await Promise.all(priced.map(async (s) => [s, await budgetedQuote(s, budget)]));
  for (const [s, q] of got) {
    if (!q) continue;
    prices[s] = q.p;
    if (q.c != null) pcts[s] = q.c;
  }

  const now = new Date().toISOString();
  const today = israelParts().date;

  for (const a of alerts) {
    const key = alertKey(a);
    const price = prices[a.s];
    if (price == null) continue;

    if (state[key]) {
      if (rearmed(a, price)) { delete state[key]; changed = true; }
      continue;
    }
    if (!hasFired(a, price)) continue;

    const word = a.d === 'above' ? 'עלתה מעל' : 'ירדה מתחת ל־';
    const tag = a.d === 'above' ? 'chart_with_upwards_trend'
                                : 'chart_with_downwards_trend';
    const sent = await notify(env, topic, `${a.s} ${a.p}$`,
      `${a.s} ${word} $${a.p}\nכעת ${dollars(price)}`, [tag], dry);
    if (sent) {
      out.sent += 1;
      out.fired.push({ s: a.s, d: a.d, p: a.p, at: price });
      state[key] = { fired: now, price };
      changed = true;
    } else {
      // Deliberately not recorded as fired, so the next run tries again
      // rather than treating an undelivered alert as delivered.
      out.failed += 1;
    }
  }

  // A big day, for anything on the watchlist.
  for (const sym of watched) {
    const pct = pcts[sym], price = prices[sym];
    if (pct == null || price == null || Math.abs(pct) < MOVE_PCT) continue;
    // Keyed by the day, so one move is one notification however many times
    // the checker runs while the stock stays up there.
    const key = `move|${sym}|${today}`;
    if (state[key]) continue;
    const up = pct >= 0;
    const sent = await notify(env, topic, `${sym} ${pctStr(pct)}`,
      `${sym} ${up ? 'זינקה' : 'צנחה'} ${Math.abs(pct).toFixed(1)}% היום\n` +
      `כעת ${dollars(price)}`,
      [up ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'], dry);
    if (sent) {
      out.sent += 1;
      out.moved.push({ s: sym, pct });
      state[key] = { fired: now, pct };
      changed = true;
    } else {
      out.failed += 1;
    }
  }

  // Earnings coming up, for anything held or watched.
  const erSyms = new Set([...alerts.map((a) => a.s), ...open.map((p) => p.s),
                          ...watched]);
  const heldSet = new Set(open.map((p) => p.s));
  for (const [sym, er] of Object.entries(await earningsCalendar(erSyms))) {
    // Keyed by the report date itself, not by how many days out it is, so
    // this fires exactly once per report - whichever run first sees it
    // inside the window - rather than once a day as it counts down.
    const key = `earnings|${sym}|${er.d}`;
    if (state[key]) continue;
    const whenWord = earningsWhen(er.d);
    const sessionWord = er.t === 'pre' ? ' (לפני הפתיחה)'
                       : er.t === 'post' ? ' (אחרי הנעילה)' : '';
    const epsLine = er.eps ? `\nתחזית EPS: ${er.eps}` : '';
    const held = heldSet.has(sym);
    const sent = await notify(env, topic, `${sym} מדווחת ${whenWord}`,
      `${sym} מדווחת רבעון ${whenWord}${sessionWord}\n` +
      `${held ? 'יש לך פוזיציה פתוחה' : 'ברשימת המעקב שלך'}${epsLine}`,
      ['loudspeaker'], dry);
    if (sent) {
      out.sent += 1;
      out.earnings = out.earnings || [];
      out.earnings.push({ s: sym, d: er.d });
      state[key] = { fired: now, d: er.d };
      changed = true;
    } else {
      out.failed += 1;
    }
  }

  /* The daily report. The checker runs every fifteen minutes, so this lands
     on whichever run falls first inside the 17:00 hour and then stays quiet -
     the key is the day, not the run. */
  const rKey = `report|${today}`;
  if (israelParts().hour === REPORT_HOUR && (dry || !state[rKey])) {
    const { title, message } = reportText(open, prices, pcts);
    out.reportText = { title, message };
    if (await notify(env, topic, title, message, ['bar_chart'], dry)) {
      out.sent += 1;
      out.report = true;
      state[rKey] = { sent: now };
      changed = true;
    } else {
      out.failed += 1;
    }
  }

  if (changed && !dry && env.ALERTS) {
    await env.ALERTS.put(STATE_KEY, JSON.stringify(state));
  }
  out.armed = Object.keys(state).length;
  return out;
}
