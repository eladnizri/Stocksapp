/* A quote endpoint we control, running on Cloudflare Workers.
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
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}
