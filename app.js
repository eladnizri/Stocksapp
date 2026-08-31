/* Stock analysis app.
 *
 * Two data planes, because each source only works from one place:
 *   - data/screener.json  : built nightly on a runner from SEC EDGAR filings
 *                           and Nasdaq price history. Covers ~600 companies.
 *   - Yahoo, live         : fetched from the device. Yahoo blocks datacenter
 *                           IPs, so this only works here, on the phone.
 * The snapshot carries the analysis; Yahoo refreshes the price and supplies
 * analyst targets on top.
 */
'use strict';

/* The previous version of this app installed a service worker that cached the
   whole site. It is still registered on any device that opened the old app and
   would keep serving those files over these ones. Tear it down on every start
   - unregistering is idempotent, so this costs nothing once it is gone. */
(function purgeOldServiceWorker() {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) { caches.delete(k); });
      }).catch(function () {});
    }
  } catch (e) {}
})();

var $ = function (s) { return document.querySelector(s); };

var LS = {
  alerts: 'sa_alerts',
  filters: 'sa_filters',
  idx: 'sa_idx',
  snap: 'sa_snap',
  proxy: 'sa_proxy',
  recent: 'sa_recent',
  screens: 'sa_screens',
  sectors: 'sa_sectors',
  /* A GitHub token, so the app can write the alert list into the repo the
     scheduled checker reads. It stays on this device and is never sent
     anywhere but api.github.com. */
  gh: 'sa_gh',
  /* Set the moment an alert changes and cleared once the change reaches
     GitHub. Without it a copy that failed to push would silently adopt the
     older remote list on the next open and lose the change. */
  dirty: 'sa_dirty',
  trades: 'sa_trades',
  risk: 'sa_risk',
  watch: 'sa_watch',
  compare: 'sa_compare',
  folds: 'sa_folds',
  /* Last known index/mini-ticker quotes, so a reload during a proxy outage
     paints real numbers instead of a bare skeleton. */
  tk: 'sa_tk'
};

var store = {
  get: function (k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
    catch (e) { return d; }
  },
  set: function (k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
};

/* ------------------------------------------------------------ formatting */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function num(v, d) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', {
    minimumFractionDigits: d == null ? 2 : d,
    maximumFractionDigits: d == null ? 2 : d
  });
}
function pct(v, d) {
  if (v == null || isNaN(v)) return '—';
  return (v > 0 ? '+' : '') + num(v, d == null ? 2 : d) + '%';
}
function money(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + num(v);
}
function big(v) {
  if (v == null || isNaN(v)) return '—';
  var a = Math.abs(v);
  if (a >= 1e12) return '$' + num(v / 1e12, 2) + 'T';
  if (a >= 1e9) return '$' + num(v / 1e9, 1) + 'B';
  if (a >= 1e6) return '$' + num(v / 1e6, 0) + 'M';
  return '$' + num(v, 0);
}
function cls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; }

/* Colour ramp for 0..100 scores: red -> brass -> green. */
function scoreColor(v) {
  if (v == null) return 'var(--muted)';
  if (v >= 70) return 'var(--gain)';
  if (v >= 50) return '#7E9A3C';
  if (v >= 30) return 'var(--watch)';
  return 'var(--loss)';
}
function scoreVerdict(v) {
  if (v == null) return 'אין מספיק נתונים';
  if (v >= 80) return 'חזק מאוד';
  if (v >= 65) return 'חזק';
  if (v >= 50) return 'סביר';
  if (v >= 35) return 'חלש';
  return 'חלש מאוד';
}

/* ------------------------------------------------------------- transport */
var PROXIES = [
  function (u) { return u; },
  function (u) { return 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u); },
  function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
  function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); }
];
var bestProxy = parseInt(store.get(LS.proxy, 0), 10) || 0;

/* How long a candidate proxy gets before the next one starts alongside it,
   without waiting to see whether the first one fails. */
var HEDGE_MS = 1500;

/* Yahoo sets no CORS headers for browsers, so this goes through a public
   CORS proxy. Trying them one at a time - wait out the full timeout, then
   try the next - was the actual cause of a two-minute wait for one number:
   any proxy having a slow day (overloaded, rate-limiting, just far away)
   made every request behind it in the queue pay that same timeout before
   getting a turn. Racing them instead - start the next candidate on a timer
   regardless of whether the current one has answered, take whichever
   responds first, abort the rest - bounds the wait to whichever proxy is
   actually fastest right now, not the sum of every dead one tried first. */
function fetchRaw(url, timeoutMs) {
  timeoutMs = timeoutMs || 6000;
  var order = [bestProxy];
  for (var i = 0; i < PROXIES.length; i++) if (i !== bestProxy) order.push(i);

  return new Promise(function (resolve, reject) {
    var settled = false;
    var controllers = [];
    var started = {};
    var pending = order.length;

    function tryAt(idx) {
      if (idx >= order.length || settled || started[idx]) return;
      started[idx] = true;
      var pi = order[idx];
      var ctrl = new AbortController();
      controllers.push(ctrl);
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);

      fetch(PROXIES[pi](url), { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (txt) {
          if (settled) return;
          settled = true;
          if (pi !== bestProxy) { bestProxy = pi; store.set(LS.proxy, pi); }
          controllers.forEach(function (c) { c.abort(); });   // stop the losers
          resolve(txt);
        })
        .catch(function () {
          clearTimeout(timer);
          pending--;
          if (settled) return;
          if (pending === 0) { reject(new Error('כל המקורות נכשלו')); return; }
          tryAt(idx + 1);   // this one is done failing - no reason to also wait out its hedge timer
        });

      if (idx + 1 < order.length) {
        setTimeout(function () { tryAt(idx + 1); }, HEDGE_MS);
      }
    }
    tryAt(0);
  });
}

function yahooQuote(sym) {
  /* The _ param is not for Yahoo, it is for the proxies in front of it.
     fetchRaw asks the browser for no-store, but that only governs our hop to
     the proxy - codetabs and allorigins cache by target URL, and with a fixed
     URL they will happily replay this morning's quote all afternoon. */
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=1d&range=1d&_=' + Date.now();
  /* Shorter than fetchRaw's own default: this chain tries up to four proxies
     in sequence on failure, so a slow one should be abandoned quickly rather
     than making every caller wait 8s per hop before the next gets a turn. */
  return fetchRaw(url, 6000).then(function (txt) {
    var d = JSON.parse(txt);
    var r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r || !r.meta) throw new Error('אין נתונים');
    var m = r.meta;
    var price = m.regularMarketPrice;
    var prev = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
    return {
      price: price,
      prev: prev,
      chg: price != null && prev ? price - prev : null,
      chgPct: price != null && prev ? ((price - prev) / prev) * 100 : null,
      cur: m.currency || 'USD',
      state: m.marketState || '',
      name: m.longName || m.shortName || ''
    };
  });
}

/* --------------------------------------------------------------- snapshot */
var SNAP = null;
var SNAP_BY_SYM = {};

function loadSnapshot() {
  var cached = store.get(LS.snap, null);
  if (cached && cached.rows) useSnapshot(cached, true);

  return fetch('data/screener.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      if (!d || !d.rows || !d.rows.length) throw new Error('קובץ ריק');
      if (!cached || cached.generated !== d.generated) {
        try { store.set(LS.snap, d); } catch (e) {}
      }
      useSnapshot(d, false);
      return d;
    })
    .catch(function (e) {
      if (!SNAP) renderDataStatus(e.message);
      return null;
    });
}

function useSnapshot(d, isCache) {
  SNAP = d;
  SNAP_BY_SYM = {};
  SECTOR_MED = null;      // recomputed against the new rows on next use
  for (var i = 0; i < d.rows.length; i++) SNAP_BY_SYM[d.rows[i].s] = d.rows[i];
  renderDataStatus(null, isCache);
  var uc = $('#screenCount');
  if (uc) uc.textContent = d.rows.length + ' מניות';
}

/* ------------------------------------------------------------ navigation */
var TAB_ORDER = ['home', 'market', 'watch', 'trades'];

function reduced() {
  try {
    return window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { return false; }
}

/* A short tick on navigation and on a fired alert. Absent on iOS Safari, which
   simply has no vibrate - the guard makes that a no-op rather than a throw. */
function haptic(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) {}
}

/* Replays the card stagger on the page being entered. The class has to come
   off first and the reflow has to be forced, or re-entering the same tab
   re-adds a class that is already there and nothing animates. */
function playEnter(el) {
  if (!el || reduced()) return;
  el.classList.remove('enter');
  void el.offsetWidth;
  el.classList.add('enter');
}

/* Bars render at zero width carrying their target in data-w, then get it
   applied a frame later so the CSS width transition has two values to move
   between. Painting the final width straight into the markup gives the
   transition nothing to do and the bar simply appears. */
function paintBars(root, animate) {
  if (!root) return;
  var bars = root.querySelectorAll('[data-w]');
  if (!bars.length) return;
  var apply = function () {
    for (var i = 0; i < bars.length; i++) {
      bars[i].style.width = bars[i].getAttribute('data-w') + '%';
    }
  };
  if (!animate || reduced()) { apply(); return; }
  requestAnimationFrame(function () { requestAnimationFrame(apply); });
}

function animateCount(el, to, dur) {
  if (!el || to == null || isNaN(to)) return;
  if (reduced()) { el.textContent = Math.round(to); return; }
  var t0 = 0;
  var step = function (now) {
    if (!t0) t0 = now;
    var p = Math.min(1, (now - t0) / (dur || 850));
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function goTab(name, opts) {
  var idx = TAB_ORDER.indexOf(name);
  if (idx < 0) return;
  var silent = opts && opts.silent;
  var was = currentTab();

  var track = $('#track');
  if (track) {
    /* Clearing the drag state here makes goTab authoritative: an interrupted
       gesture leaves an inline transform behind that outranks the stylesheet,
       and without this a tab tap afterwards would move the index but not the
       track, stranding the view between pages. */
    track.classList.remove('dragging');
    track.style.transform = '';
    track.style.setProperty('--page-idx', idx);
  }

  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.toggle('on', pages[i].id === 'p-' + name);
  }

  var tabs = document.querySelectorAll('.tab');
  for (var j = 0; j < tabs.length; j++) {
    var on = tabs[j].dataset.page === name;
    tabs[j].classList.toggle('on', on);
    if (on) $('#tabbar').style.setProperty('--tab-idx', j);
  }

  if (was !== name) {
    if (!silent) haptic(8);
    /* Skipped when a drag brought us here: the page was already on screen and
       being pulled in, so replaying its entrance would flash content the eye
       has been tracking the whole way. A tab tap has no such lead-in. */
    if (!(opts && opts.noEnter)) playEnter($('#p-' + name));
  }

  if (name === 'watch') {
    renderWatchlist(); renderAlerts(); checkAlerts(false); renderFilters();
  }
  if (name === 'trades') { renderTrades(); }
  if (name === 'home') { renderHome(); }
  if (name === 'market') {
    renderBreadth(); renderSectors();
    renderChanges(); renderEarningsSoon(); renderCompare();
  }
}

function currentTab() {
  var on = document.querySelector('.tab.on');
  return on ? on.dataset.page : TAB_ORDER[0];
}

/* The analysis lives in a bottom sheet so it can be opened from anywhere
   without losing the page underneath. */
var sheetTimer = null;

function openSheet() {
  var m = $('#sheet');
  if (sheetTimer) { clearTimeout(sheetTimer); sheetTimer = null; }
  m.classList.remove('hidden', 'dragging');
  var sh = $('.modal-sheet');
  sh.style.transform = '';
  // Force a frame at translateY(100%) before .open, or the browser collapses
  // both styles into one paint and the sheet appears with no travel.
  void m.offsetWidth;
  m.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  var m = $('#sheet');
  if (m.classList.contains('hidden')) return;
  var sh = $('.modal-sheet');
  m.classList.remove('dragging', 'open');
  sh.style.transform = '';
  document.body.style.overflow = '';
  CUR = null;
  if (sheetTimer) clearTimeout(sheetTimer);
  // Kept in step with the .modal-sheet transition duration in the stylesheet.
  sheetTimer = setTimeout(function () {
    m.classList.add('hidden');
    sheetTimer = null;
  }, reduced() ? 0 : 380);
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('#sheet').classList.contains('hidden')) closeSheet();
});


function onSearch(term) {
  var box = $('#results');
  term = (term || '').trim().toUpperCase();
  if (!term) { box.innerHTML = ''; renderRecent(); return; }
  if (!SNAP) { box.innerHTML = '<div class="msg">טוען נתונים…</div>'; return; }

  /* Rank exact ticker prefixes first, then company-name matches, so typing
     "MU" surfaces Micron before every company with "mu" in its name. */
  var hits = [];
  var seen = {};
  var push = function (r) {
    if (!seen[r.s]) { seen[r.s] = 1; hits.push(r); }
  };
  var rows = SNAP.rows;
  var i;
  for (i = 0; i < rows.length && hits.length < 25; i++) {
    if (rows[i].s.indexOf(term) === 0) push(rows[i]);
  }
  for (i = 0; i < rows.length && hits.length < 25; i++) {
    if ((rows[i].n || '').toUpperCase().indexOf(term) === 0) push(rows[i]);
  }
  for (i = 0; i < rows.length && hits.length < 25; i++) {
    if ((rows[i].n || '').toUpperCase().indexOf(term) > 0) push(rows[i]);
  }
  if (!hits.length) {
    box.innerHTML = '<div class="msg">לא נמצא. אפשר לנתח כל סימבול —' +
      ' <button class="chip" onclick="analyze(\'' + esc(term) + '\')">' +
      'נתח ' + esc(term) + '</button></div>';
    return;
  }
  box.innerHTML = hits.map(function (r) {
    var sc = (r.sc && r.sc.total != null) ? r.sc.total : null;
    return '<button class="hit" onclick="analyze(\'' + r.s + '\')">' +
      '<span class="sym">' + r.s + '</span>' +
      '<span class="nm">' + esc(r.n || (r.i || []).map(idxLabel).join(' · ')) + '</span>' +
      '<span class="sc" style="color:' + scoreColor(sc) + '">' +
        (sc == null ? '—' : sc) + '</span></button>';
  }).join('');
}

function idxLabel(i) { return i === 'sp500' ? 'S&P 500' : i === 'ndx' ? 'נאסד״ק 100' : i; }

function renderRecent() {
  var rec = store.get(LS.recent, []);
  var box = $('#recentWrap');
  if (!box) return '';
  box.innerHTML = rec.length
    ? '<div class="chips">' + rec.slice(0, 8).map(function (s) {
        return '<button class="chip" onclick="analyze(\'' + esc(s) + '\')">' +
          esc(s) + '</button>';
      }).join('') + '</div>'
    : '';
  return '';
}

function pushRecent(sym) {
  var rec = store.get(LS.recent, []).filter(function (s) { return s !== sym; });
  rec.unshift(sym);
  store.set(LS.recent, rec.slice(0, 10));
}

/* ============================================================ watchlist ==
 * Symbols you are following but have neither an alert nor a position on.
 * Deliberately separate from both: an alert is a level you want to be told
 * about, a trade is money at stake, and this is neither. */
function watchlist() { return store.get(LS.watch, []); }

function addWatch(sym) {
  var el = $('#w-sym');
  sym = (sym || (el && el.value) || '').trim().toUpperCase();
  if (!sym) return;
  var list = watchlist();
  if (list.indexOf(sym) < 0) list.unshift(sym);
  store.set(LS.watch, list.slice(0, 40));
  if (el) el.value = '';
  renderWatchlist();
  checkAlerts(false);
  queueSync();          // the runner prices whatever is on this list
  haptic(10);
}

function removeWatch(sym) {
  store.set(LS.watch, watchlist().filter(function (s) { return s !== sym; }));
  renderWatchlist();
  queueSync();
}

function inWatchlist(sym) { return watchlist().indexOf(sym) >= 0; }

function toggleWatch(sym) {
  if (inWatchlist(sym)) removeWatch(sym); else addWatch(sym);
  if (CUR === sym) analyze(sym);      // refresh the sheet's star
}

function renderWatchlist() {
  var box = $('#watchlist');
  if (!box) return;
  var list = watchlist();
  var c = $('#wlCount');
  if (c) c.textContent = list.length ? list.length + ' מניות' : '';
  if (!list.length) {
    box.innerHTML = '<div class="msg">אין מניות במעקב. הוסף כאן, או מכוכב ' +
      'בראש הניתוח של כל מניה.</div>';
    return;
  }
  box.innerHTML = list.map(function (sym) {
    var row = SNAP_BY_SYM[sym];
    var t = (row && row.t) || {};
    var price = ALERT_PRICES[sym] != null ? ALERT_PRICES[sym] : t.price;
    var sc = row && row.sc ? row.sc.total : null;
    return '<div class="wl">' +
      '<button class="wl-id" onclick="analyze(\'' + esc(sym) + '\')">' +
        '<span class="sym">' + esc(sym) + '</span>' +
        '<span class="nm">' + esc((row && row.n) || '') + '</span>' +
      '</button>' +
      '<span class="wl-px">' +
        '<span class="pr">' + (price == null ? '…' : money(price)) + '</span>' +
        '<span class="d ' + cls(t.chg1d) + '">' + pct(t.chg1d, 1) + '</span>' +
      '</span>' +
      '<span class="wl-sc" style="color:' + scoreColor(sc) + '">' +
        (sc == null ? '—' : sc) + '</span>' +
      '<button class="tr-x" onclick="removeWatch(\'' + esc(sym) +
        '\')" aria-label="הסר">✕</button>' +
      '</div>';
  }).join('');
}

/* ============================================================== compare ==
 * The snapshot already holds every number here; the only thing missing was
 * seeing two of them at once. */
var CMP_ROWS = [
  ['ציון', function (r) { return r.sc && r.sc.total; }, 0, 'score'],
  ['מחיר', function (r) { return r.t && r.t.price; }, 2, 'money'],
  ['שווי שוק', function (r) { return r.mcap; }, 0, 'big'],
  ['מכפיל רווח', function (r) { return r.pe; }, 1, 'hi-lo'],
  ['מכפיל מכירות', function (r) { return r.ps; }, 1, 'hi-lo'],
  ['צמיחת הכנסות %', function (r) { return r.f && r.f.revGrowth; }, 1, 'lo-hi'],
  ['מרג׳ין נקי %', function (r) { return r.f && r.f.netMargin; }, 1, 'lo-hi'],
  ['תשואה על ההון %', function (r) { return r.f && r.f.roe; }, 1, 'lo-hi'],
  ['חוב להון %', function (r) { return r.f && r.f.debtToEquity; }, 0, 'hi-lo'],
  ['RSI', function (r) { return r.t && r.t.rsi; }, 0, 'none'],
  ['מעל ממוצע 200 %', function (r) { return r.t && r.t.vma200; }, 1, 'lo-hi'],
  ['תשואה 12ח %', function (r) { return r.t && r.t.chg12m; }, 1, 'lo-hi'],
  ['תנודתיות ATR %', function (r) { return r.t && r.t.atrPct; }, 1, 'hi-lo']
];

function compareList() { return store.get(LS.compare, []); }

function addCompare(sym) {
  var el = $('#c-sym');
  sym = (sym || (el && el.value) || '').trim().toUpperCase();
  if (!sym) return;
  var list = compareList();
  if (list.indexOf(sym) < 0) list.push(sym);
  store.set(LS.compare, list.slice(0, 3));
  if (el) el.value = '';
  renderCompare();
}

function removeCompare(sym) {
  store.set(LS.compare, compareList().filter(function (s) { return s !== sym; }));
  renderCompare();
}

function renderCompare() {
  var box = $('#compare');
  if (!box) return;
  var syms = compareList().filter(function (s) { return SNAP_BY_SYM[s]; });
  if (!syms.length) {
    box.innerHTML = '<div class="msg" style="margin-top:10px">הוסף שתיים או ' +
      'שלוש מניות כדי לראות אותן זו מול זו.</div>';
    return;
  }
  var rows = syms.map(function (s) { return SNAP_BY_SYM[s]; });

  var head = '<div class="cmp-row head">' +
    '<span class="cmp-lb"></span>' + syms.map(function (s) {
      return '<span class="cmp-c"><button class="cmp-sym" onclick="analyze(\'' +
        esc(s) + '\')">' + esc(s) + '</button>' +
        '<button class="cmp-x" onclick="removeCompare(\'' + esc(s) +
        '\')" aria-label="הסר">✕</button></span>';
    }).join('') + '</div>';

  var body = CMP_ROWS.map(function (def) {
    var vals = rows.map(function (r) {
      var v = def[1](r);
      return (v == null || isNaN(v)) ? null : v;
    });
    var have = vals.filter(function (v) { return v != null; });
    // Highlight the better side only where "better" has a direction.
    var best = null;
    if (have.length > 1 && def[3] === 'lo-hi') best = Math.max.apply(null, have);
    if (have.length > 1 && def[3] === 'hi-lo') best = Math.min.apply(null, have);
    if (have.length > 1 && def[3] === 'score') best = Math.max.apply(null, have);

    return '<div class="cmp-row">' +
      '<span class="cmp-lb">' + def[0] + '</span>' +
      vals.map(function (v) {
        var txt = v == null ? '—'
          : def[3] === 'big' ? big(v)
          : def[3] === 'money' ? money(v)
          : num(v, def[2]);
        var win = best != null && v === best;
        return '<span class="cmp-c' + (win ? ' win' : '') + '">' + txt + '</span>';
      }).join('') + '</div>';
  }).join('');

  box.innerHTML = '<div class="cmp" style="--cmp-n:' + syms.length + '">' +
    head + body + '</div>';
}

/* --------------------------------------------------- relative strength -- */
/* Median return per sector, from the snapshot. Cached because the analysis
   sheet asks for it on every render and it is a full pass over 500 rows. */
var SECTOR_MED = null;

function sectorMedians() {
  if (SECTOR_MED) return SECTOR_MED;
  SECTOR_MED = {};
  if (!SNAP) return SECTOR_MED;
  var by = {};
  SNAP.rows.forEach(function (r) {
    if (!r.sec || !r.t) return;
    var b = (by[r.sec] = by[r.sec] || { m: [], y: [] });
    if (r.t.chg1m != null) b.m.push(r.t.chg1m);
    if (r.t.chg12m != null) b.y.push(r.t.chg12m);
  });
  var med = function (xs) {
    if (!xs.length) return null;
    var a = xs.slice().sort(function (x, y) { return x - y; });
    var i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  };
  Object.keys(by).forEach(function (k) {
    SECTOR_MED[k] = { m: med(by[k].m), y: med(by[k].y), n: by[k].m.length };
  });
  return SECTOR_MED;
}

/* A stock up 8% in a sector up 10% is lagging, not winning. */
function renderRelStrength(row) {
  if (!row || !row.sec || !row.t) return '';
  var med = sectorMedians()[row.sec];
  if (!med || med.n < 5) return '';

  var line = function (label, v, m) {
    if (v == null || m == null) return '';
    var d = v - m;
    return '<div class="mrow" style="grid-template-columns:1fr auto">' +
      '<span class="lb">' + label + '</span>' +
      '<span class="vl ' + cls(d) + '">' + (d > 0 ? '+' : '') + num(d, 1) +
      '%</span></div>';
  };
  var body = line('חודש מול הסקטור', row.t.chg1m, med.m) +
             line('שנה מול הסקטור', row.t.chg12m, med.y);
  if (!body) return '';

  return '<div class="card">' +
    '<div class="card-h"><span>חוזק יחסי</span>' +
      '<span class="sub">' + esc(row.sec) + ' · ' + med.n + ' מניות</span></div>' +
    '<div class="mtable">' + body + '</div>' +
    '<div class="score-note" style="margin-top:9px">כמה המניה מעל או מתחת ' +
      'לחציון הסקטור שלה. עלייה של 8% בסקטור שעלה 10% היא פיגור, לא הצלחה.' +
      '</div></div>';
}

/* -------------------------------------------------------- analysis page */
var CUR = null;
/* True only for the first paint of a symbol. The live quote arriving a second
   later re-renders the same sheet, and replaying the entrance then would look
   like the panel had reloaded itself. */
var SHEET_FRESH = false;

/* Reveals the sheet's rings, counters and bars. */
function runSheetIntro(animate) {
  var body = $('#sheetBody');
  var sh = $('.modal-sheet');
  if (sh) sh.classList.toggle('quiet', !animate);
  if (!body) return;

  paintBars(body, animate);

  var ring = body.querySelector('.score-ring circle[data-dash]');
  if (ring) {
    var d = ring.getAttribute('data-dash');
    if (!animate || reduced()) ring.setAttribute('stroke-dasharray', d);
    else requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        ring.setAttribute('stroke-dasharray', d);
      });
    });
  }

  var val = body.querySelector('.score-ring .val[data-to]');
  if (val) {
    var to = parseFloat(val.getAttribute('data-to'));
    if (animate) animateCount(val, to, 850);
    else if (!isNaN(to)) val.textContent = Math.round(to);
  }
}

function analyze(sym) {
  sym = (sym || '').trim().toUpperCase();
  if (!sym) return;
  CUR = sym;
  SHEET_FRESH = true;
  haptic(8);
  pushRecent(sym);
  renderRecent();
  $('#results').innerHTML = '';
  $('#q').blur();
  openSheet();
  $('.modal-sheet').scrollTop = 0;

  var row = SNAP_BY_SYM[sym] || null;
  renderAnalysis(sym, row, null, null);

  yahooQuote(sym).then(function (q) {
    if (CUR === sym) renderAnalysis(sym, row, q, undefined);
  }).catch(function () {});

}

var LIVE = { q: null, t: null };

function renderAnalysis(sym, row, quote, targets) {
  if (quote !== undefined) LIVE.q = quote;
  if (quote === null) LIVE = { q: null, t: null };

  var q = LIVE.q;
  var tg = (row && row.an) || null;
  var f = (row && row.f) || {};
  var t = (row && row.t) || {};
  var sc = (row && row.sc) || {};
  var price = (q && q.price != null) ? q.price : t.price;
  // Yahoo's name is richer when present; the snapshot's SEC name always is.
  var name = (q && q.name) || (row && row.n) || '';

  var html = '';

  /* ---- header ---- */
  var chgPct = q ? q.chgPct : t.chg1d;
  html += '<div class="card">' +
    '<div class="q-head">' +
      '<div style="display:flex;align-items:flex-start;gap:10px">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="q-name">' + esc(sym) + '</div>' +
          '<div class="q-sub">' + (name ? esc(name) + ' · ' : '') +
            ((row && row.i && row.i.length) ? row.i.map(idxLabel).join(' · ')
                                            : 'מחוץ למדדים הנסרקים') + '</div>' +
        '</div>' +
        '<button class="icon-btn star' + (inWatchlist(sym) ? ' on' : '') +
          '" onclick="toggleWatch(\'' + esc(sym) + '\')" aria-label="מעקב">' +
          '<svg viewBox="0 0 24 24"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5' +
          'L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>' +
        '</button>' +
        '<button class="icon-btn" onclick="closeSheet()" aria-label="סגור">' +
          '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="q-price">' +
        (price == null ? '<span class="skel" style="width:120px;height:30px"></span>'
                       : money(price)) + '</div>' +
      '<div class="q-chg ' + cls(chgPct) + '">' + pct(chgPct) + '</div>' +
      '<div class="q-meta">' +
        '<div class="d"><span class="lb">שווי שוק</span>' +
          '<span class="vl">' + big(row && row.mcap) + '</span></div>' +
        '<div class="d"><span class="lb">מכפיל רווח</span>' +
          '<span class="vl">' + (row && row.pe ? num(row.pe, 1) : '—') + '</span></div>' +
        '<div class="d"><span class="lb">תשואה 12ח</span>' +
          '<span class="vl ' + cls(t.chg12m) + '">' + pct(t.chg12m, 1) + '</span></div>' +
      '</div>' +
      earningsLine(row && row.er) +
    '</div></div>';

  if (!row) {
    html += '<div class="card"><div class="msg">' + esc(sym) +
      ' אינה במדדים הנסרקים (S&P 500 / נאסד״ק 100), ולכן אין לה ניתוח יסוד. ' +
      'המחיר החי מוצג למעלה.</div></div>';
    $('#sheetBody').innerHTML = html;
    runSheetIntro(SHEET_FRESH);
    SHEET_FRESH = false;
    return;
  }

  /* ---- score ---- */
  html += renderScoreCard(sc);

  /* ---- valuation ---- */
  html += renderValuation(row, price, tg);

  /* ---- key levels ---- */
  html += renderLevels(t, price);

  /* ---- fundamentals ---- */
  html += renderFundamentals(row);

  /* ---- technicals ---- */
  html += renderTechnicals(t, price);

  /* ---- relative strength vs the sector ---- */
  html += renderRelStrength(row);

  /* ---- analyst forecast ---- */
  html += renderForecast(tg, price);

  /* ---- alert shortcut ---- */
  html += renderAlertBox(sym, price);

  html += '<div class="disc">הציונים והשווי ההוגן הם חישוב היוריסטי מתוך ' +
    'דוחות שהוגשו ל-SEC ומחירי שוק. מידע בלבד, לא ייעוץ השקעות.</div>';

  if (SNAP && SNAP.generated) {
    html += '<div class="stamp">נתוני יסוד מעודכנים ל־' +
      esc(SNAP.generated.slice(0, 10)) + '</div>';
  }

  $('#sheetBody').innerHTML = html;
  runSheetIntro(SHEET_FRESH);
  SHEET_FRESH = false;
}

/* Next scheduled report. Nasdaq gives a date and, usually, the consensus EPS
   for that quarter. Shown relative as well as absolute, because "in 3 days"
   is what actually matters when deciding whether to open a position. */
function earningsLine(er) {
  /* Nasdaq publishes report dates only a few weeks out, so between earnings
     seasons most companies genuinely have none. Say so rather than omitting
     the row, which reads as a missing feature instead of a missing date. */
  var d = er && er.d ? new Date(er.d + 'T12:00:00') : null;
  if (!d || isNaN(d)) {
    return '<div class="earn"><span class="earn-k">דוח הבא</span>' +
      '<span class="earn-v" style="color:var(--muted);font-weight:600">' +
      'טרם פורסם</span></div>';
  }
  // Measured from midnight, not from now, so "מחר" does not become "היום"
  // late in the evening or "בעוד יומיים" early in the morning.
  var midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  var days = Math.floor((d - midnight) / 86400000);
  var when = days < 0 ? '' : days === 0 ? 'היום'
    : days === 1 ? 'מחר' : 'בעוד ' + days + ' ימים';
  var slot = er.t === 'pre' ? 'לפני הפתיחה'
    : er.t === 'post' ? 'אחרי הנעילה' : '';
  var soon = days >= 0 && days <= 7;
  return '<div class="earn' + (soon ? ' soon' : '') + '">' +
    '<span class="earn-k">דוח הבא</span>' +
    '<span class="earn-v">' +
      d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }) +
      (when ? ' · ' + when : '') + '</span>' +
    (slot || er.eps
      ? '<span class="earn-m">' + slot +
        (slot && er.eps ? ' · ' : '') +
        (er.eps ? 'צפי ' + esc(er.eps) : '') + '</span>'
      : '') +
    '</div>';
}

function renderScoreCard(sc) {
  var total = sc.total;
  var C = 2 * Math.PI * 32;
  var frac = total == null ? 0 : total / 100;
  var col = scoreColor(total);

  var parts = [
    ['תמחור', sc.value], ['צמיחה', sc.growth], ['רווחיות', sc.profit],
    ['איתנות', sc.health], ['מומנטום', sc.momentum]
  ];

  return '<div class="card">' +
    '<div class="card-h"><span>ציון כולל</span><span class="sub mono">0–100</span></div>' +
    '<div class="score-top">' +
      '<div class="score-ring">' +
        '<svg width="74" height="74">' +
          '<circle cx="37" cy="37" r="32" fill="none" stroke="var(--surface-2)" stroke-width="7"/>' +
          '<circle cx="37" cy="37" r="32" fill="none" stroke="' + col + '" stroke-width="7"' +
            ' stroke-linecap="round" stroke-dasharray="0 ' + C + '"' +
            ' data-dash="' + (C * frac) + ' ' + C + '"/>' +
        '</svg>' +
        '<div class="val" style="color:' + col + '"' +
          (total == null ? '' : ' data-to="' + total + '"') + '>' +
          (total == null ? '—' : total) + '</div>' +
      '</div>' +
      '<div><div class="score-verdict" style="color:' + col + '">' +
        scoreVerdict(total) + '</div>' +
        '<div class="score-note">משוקלל מחמישה ממדים. כל אחד מחושב ' +
        'מהדוחות ומהמחיר, ומוצג במלואו למטה.</div></div>' +
    '</div>' +
    '<div class="bars">' + parts.map(function (p) {
      var v = p[1];
      return '<div class="bar-row">' +
        '<span class="lb">' + p[0] + '</span>' +
        '<span class="bar-track"><i class="bar-fill" data-w="' +
          (v == null ? 0 : v) + '" style="width:0;background:' +
          scoreColor(v) + '"></i></span>' +
        '<span class="vl" style="color:' + scoreColor(v) + '">' +
          (v == null ? '—' : v) + '</span></div>';
    }).join('') + '</div></div>';
}

/* Fair value blends three independent anchors so no single one dominates:
   analyst consensus, the company's own earnings power, and its book value. */
function renderValuation(row, price, tg) {
  var f = row.f || {};
  var anchors = [];

  if (tg && tg.mean) anchors.push({ k: 'יעד אנליסטים', v: tg.mean });

  if (f.epsTTM && f.epsTTM > 0) {
    // A market-typical multiple, nudged by the company's growth rate.
    var g = f.epsGrowth != null ? Math.max(-10, Math.min(35, f.epsGrowth)) : 5;
    var fairPE = 15 + g * 0.5;
    anchors.push({ k: 'לפי רווחיות', v: f.epsTTM * fairPE });
  }
  if (f.fcf && f.fcf > 0 && f.shares) {
    var fcfPS = f.fcf / f.shares;
    var gf = f.revGrowth != null ? Math.max(-5, Math.min(25, f.revGrowth)) : 4;
    anchors.push({ k: 'לפי תזרים', v: fcfPS * (16 + gf * 0.4) });
  }

  if (!anchors.length || price == null) {
    return '<div class="card">' +
      '<div class="card-h"><span>תמחור לפי מודל</span></div>' +
      '<div class="msg">אין מספיק נתונים לחישוב שווי הוגן.</div></div>';
  }

  /* Anchors can disagree enormously - a company in a heavy capex cycle earns
     well but generates almost no free cash, so the earnings and cash anchors
     can sit 30x apart. Averaging those produces a confident-looking number
     that means nothing, so use the median, drop anchors far away from it, and
     say plainly when what is left still does not agree. */
  var median = function (xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  var med0 = median(anchors.map(function (a) { return a.v; }));
  anchors.forEach(function (a) {
    a.out = a.v > med0 * 3 || a.v < med0 / 3;
  });
  var kept = anchors.filter(function (a) { return !a.out; });
  if (!kept.length) kept = anchors.slice();

  var vals = kept.map(function (a) { return a.v; })
                 .sort(function (a, b) { return a - b; });
  var lo = vals[0], hi = vals[vals.length - 1];
  var mid = median(vals);
  var spread = lo > 0 ? hi / lo : Infinity;
  /* One surviving anchor trivially agrees with itself. That is only good
     enough when it was the only method available to begin with - if the others
     were thrown out as outliers, the methods disagreed, and the survivor is
     not evidence of a consensus. */
  var agreed = spread <= 3 && (anchors.length === 1 || kept.length >= 2);
  var gap = ((mid - price) / price) * 100;

  // Place the current price on a scale spanning half to double fair value.
  var sLo = mid * 0.5, sHi = mid * 1.5;
  var posPrice = Math.max(2, Math.min(98, ((price - sLo) / (sHi - sLo)) * 100));
  var posFair = Math.max(2, Math.min(98, ((mid - sLo) / (sHi - sLo)) * 100));

  var verdict = gap > 25 ? 'זול משמעותית' : gap > 8 ? 'זול' :
    gap > -8 ? 'קרוב לשווי הוגן' : gap > -25 ? 'יקר' : 'יקר משמעותית';
  var vcol = gap > 8 ? 'var(--gain)' : gap > -8 ? 'var(--watch)' : 'var(--loss)';
  if (!agreed) {
    verdict = 'השיטות לא מסכימות';
    vcol = 'var(--ink-2)';
  }

  return '<div class="card">' +
    '<div class="card-h"><span>תמחור לפי מודל</span>' +
      '<span class="sub">' + kept.length + ' מתוך ' + anchors.length +
      ' עוגנים</span></div>' +
    // Drawing a definite "fair value" marker would contradict the warning, so
    // the gauge only appears when the methods actually converge.
    (agreed ?
      '<div class="val-gauge">' +
        // The gradient runs cheap-to-expensive left-to-right in physical space,
        // and CSS gradients ignore RTL, so these must be placed from the left.
        '<div class="val-scale">' +
          '<i class="val-mark" style="left:' + posFair + '%;background:var(--primary-500)" data-l="הוגן"></i>' +
          '<i class="val-mark" style="left:' + posPrice + '%" data-l="מחיר"></i>' +
        '</div>' +
        '<div class="val-ends"><span>יקר</span><span>זול</span></div>' +
      '</div>' : '') +
    '<div class="val-verdict" style="color:' + vcol + '">' + verdict +
      (agreed ? ' · ' + pct(gap, 0) : '') + '</div>' +
    '<div class="val-range">' +
      (agreed ? 'טווח ' + money(lo) + ' – ' + money(hi) + ' · אמצע ' + money(mid)
              : 'ההערכות נעות בין ' +
                money(Math.min.apply(null, anchors.map(function (a) { return a.v; }))) +
                ' ל־' +
                money(Math.max.apply(null, anchors.map(function (a) { return a.v; })))) +
    '</div>' +
    '<div class="mtable" style="margin-top:11px">' +
      anchors.map(function (a) {
        return '<div class="mrow" style="grid-template-columns:1fr auto">' +
          '<span class="lb"' + (a.out ? ' style="opacity:.5"' : '') + '>' +
            a.k + (a.out ? ' · חריג, לא נכלל' : '') + '</span>' +
          '<span class="vl"' + (a.out ? ' style="opacity:.5"' : '') + '>' +
            money(a.v) + '</span></div>';
      }).join('') +
    '</div>' +
    (agreed ? '' : '<div class="score-note" style="margin-top:9px">' +
      'שיטות ההערכה מגיעות לתוצאות רחוקות מדי זו מזו כדי לקבוע שווי הוגן. ' +
      'זה קורה כשרווח חשבונאי ותזרים מזומנים חופשי מתפצלים — למשל בחברה ' +
      'בעיצומן של השקעות הון כבדות.</div>') +
    '</div>';
}

function renderLevels(t, price) {
  if (!t.hi52 || price == null) return '';
  var rows = [];
  var add = function (label, val, kind) {
    if (val == null) return;
    rows.push({ l: label, v: val, k: kind });
  };
  add('שיא 52 שבועות', t.hi52, 'res');
  add('ממוצע 200 יום', t.ma200, null);
  add('ממוצע 150 יום', t.ma150, null);
  add('ממוצע 50 יום', t.ma50, null);
  add('שפל 52 שבועות', t.lo52, 'sup');

  rows.forEach(function (r) {
    if (r.k === null) r.k = r.v > price ? 'res' : 'sup';
  });
  rows.push({ l: 'מחיר נוכחי', v: price, k: 'cur' });
  rows.sort(function (a, b) { return b.v - a.v; });

  return '<div class="card">' +
    '<div class="card-h"><span>רמות מפתח</span></div>' +
    '<div class="levels">' + rows.map(function (r) {
      var d = ((r.v - price) / price) * 100;
      return '<div class="lvl ' + r.k + '">' +
        '<span class="lb">' + r.l + '</span>' +
        '<span><span class="pr">' + money(r.v) + '</span>' +
        (r.k === 'cur' ? '' : ' <span class="dt">' + pct(d, 1) + '</span>') +
        '</span></div>';
    }).join('') + '</div></div>';
}

/* Each fundamental gets a 0-100 bar so the reader can judge it at a glance
   without knowing what a "good" gross margin is. */
var FUND_ROWS = [
  ['מכפיל רווח', 'pe', 'x', 45, 8, 1],
  ['מכפיל מכירות', 'ps', 'x', 15, 1, 1],
  ['מכפיל הון', 'pb', 'x', 12, 1, 1],
  ['מכפיל תזרים', 'pfcf', 'x', 40, 8, 1]
];
var FUND_F_ROWS = [
  ['מרג׳ין גולמי', 'grossMargin', '%', 10, 70, 1],
  ['מרג׳ין תפעולי', 'opMargin', '%', 0, 35, 1],
  ['מרג׳ין נקי', 'netMargin', '%', 0, 30, 1],
  ['תשואה על ההון', 'roe', '%', 0, 35, 1],
  ['תשואה על הנכסים', 'roa', '%', 0, 20, 1],
  ['צמיחת הכנסות', 'revGrowth', '%', -10, 40, 1],
  ['צמיחת רווח', 'niGrowth', '%', -20, 60, 1],
  ['צמיחת רווח למניה', 'epsGrowth', '%', -20, 60, 1],
  ['מרג׳ין תזרים חופשי', 'fcfMargin', '%', -5, 30, 1],
  ['חוב להון', 'debtToEquity', '%', 200, 0, 0],
  ['יחס שוטף', 'currentRatio', 'x', 0.6, 3, 2]
];

function bandPct(v, lo, hi) {
  if (v == null) return null;
  var x = (v - lo) / (hi - lo);
  return Math.round(Math.max(0, Math.min(1, x)) * 100);
}

function metricRow(label, v, unit, lo, hi, dec) {
  var s = bandPct(v, lo, hi);
  var txt = v == null ? '—' :
    (unit === '%' ? num(v, dec) + '%' : num(v, dec) + (unit === 'x' ? '' : ''));
  return '<div class="mrow">' +
    '<span class="lb">' + label + '</span>' +
    '<span class="vl">' + txt + '</span>' +
    '<span class="mini"><i data-w="' + (s == null ? 0 : s) +
      '" style="width:0;background:' + scoreColor(s) + '"></i></span></div>';
}

function renderFundamentals(row) {
  var f = row.f || {};
  var out = '';
  FUND_ROWS.forEach(function (r) {
    out += metricRow(r[0], row[r[1]], r[2], r[3], r[4], r[5]);
  });
  FUND_F_ROWS.forEach(function (r) {
    var v = f[r[1]];
    if (v == null && r[1] === 'debtToEquity' && f.liabToEquity != null) {
      out += metricRow('התחייבויות להון', f.liabToEquity, '%', 400, 0, 0);
      return;
    }
    out += metricRow(r[0], v, r[2], r[3], r[4], r[5]);
  });

  var extra = '<div class="mtable" style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px">' +
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">הכנסות (12ח)</span>' +
      '<span class="vl">' + big(f.revTTM) + '</span></div>' +
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">רווח נקי</span>' +
      '<span class="vl">' + big(f.niTTM) + '</span></div>' +
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">תזרים חופשי</span>' +
      '<span class="vl">' + big(f.fcf) + '</span></div>' +
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">רווח למניה</span>' +
      '<span class="vl">' + (f.epsTTM != null ? num(f.epsTTM) : '—') + '</span></div>' +
    '</div>';

  return '<div class="card">' +
    '<div class="card-h"><span>נתוני יסוד</span><span class="sub">מדוחות SEC</span></div>' +
    '<div class="mtable">' + out + '</div>' + extra + '</div>';
}

function renderTechnicals(t, price) {
  if (!t.price) return '';
  var rows = '';
  rows += metricRow('RSI (14)', t.rsi, '', 20, 80, 0);
  rows += metricRow('מרחק משיא 52ש׳', t.from52High, '%', -60, 0, 1);
  rows += metricRow('מעל ממוצע 50', t.vma50, '%', -20, 20, 1);
  rows += metricRow('מעל ממוצע 150', t.vma150, '%', -30, 40, 1);
  rows += metricRow('מעל ממוצע 200', t.vma200, '%', -30, 40, 1);
  rows += metricRow('תנודתיות (ATR)', t.atrPct, '%', 8, 1, 1);

  var perf = [['חודש', t.chg1m], ['3 חודשים', t.chg3m],
              ['6 חודשים', t.chg6m], ['שנה', t.chg12m]];

  return '<div class="card">' +
    '<div class="card-h"><span>טכני</span><span class="sub">ללא גרפים</span></div>' +
    '<div class="mtable">' + rows + '</div>' +
    '<div class="mtable" style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px">' +
      perf.map(function (p) {
        return '<div class="mrow" style="grid-template-columns:1fr auto">' +
          '<span class="lb">' + p[0] + '</span>' +
          '<span class="vl ' + cls(p[1]) + '">' + pct(p[1], 1) + '</span></div>';
      }).join('') +
    '</div></div>';
}

function renderForecast(tg, price) {
  if (!tg || !tg.mean) {
    return '<div class="card">' +
      '<div class="card-h"><span>תחזית אנליסטים</span></div>' +
      '<div class="msg">אין כיסוי אנליסטים למניה הזו במאגר.</div></div>';
  }
  var up = price ? ((tg.mean - price) / price) * 100 : null;
  var total = (tg.buy || 0) + (tg.hold || 0) + (tg.sell || 0);
  var bar = function (label, n, color) {
    var w = total ? ((n || 0) / total) * 100 : 0;
    return '<div class="bar-row"><span class="lb">' + label + '</span>' +
      '<span class="bar-track"><i class="bar-fill" data-w="' + w.toFixed(1) +
        '" style="width:0;background:' + color + '"></i></span>' +
      '<span class="vl">' + (n || 0) + '</span></div>';
  };
  var earn = '';
  return '<div class="card">' +
    '<div class="card-h"><span>תחזית אנליסטים</span>' +
      '<span class="sub">' + total + ' אנליסטים</span></div>' +
    '<div class="mtable">' +
      '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">יעד נמוך</span>' +
        '<span class="vl">' + money(tg.lo) + '</span></div>' +
      '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">יעד ממוצע</span>' +
        '<span class="vl" style="color:var(--primary-500)">' + money(tg.mean) +
        (up == null ? '' : ' (' + pct(up, 0) + ')') + '</span></div>' +
      '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">יעד גבוה</span>' +
        '<span class="vl">' + money(tg.hi) + '</span></div>' + earn +
    '</div>' +
    (total ? '<div class="bars" style="margin-top:11px">' +
      bar('קנייה', tg.buy, 'var(--gain)') +
      bar('החזקה', tg.hold, 'var(--watch)') +
      bar('מכירה', tg.sell, 'var(--loss)') + '</div>' : '') +
    '</div>';
}

function renderAlertBox(sym, price) {
  if (price == null) return '';
  var mk = function (p) {
    return '<button class="chip" onclick="quickAlert(\'' + sym + '\',' +
      p.toFixed(2) + ')">' + money(p) + '</button>';
  };
  return '<div class="card">' +
    '<div class="card-h"><span>התראת מחיר</span></div>' +
    '<div class="chips">' +
      mk(price * 0.9) + mk(price * 0.95) + mk(price * 1.05) + mk(price * 1.1) +
    '</div>' +
    '<div class="score-note" style="margin-top:9px">בחר מחיר יעד, או הגדר ' +
      'מחיר מדויק בלשונית ההתראות.</div></div>';
}

function quickAlert(sym, price) {
  var live = LIVE.q && LIVE.q.price;
  var dir = (live && price > live) ? 'above' : 'below';
  saveAlert(sym, price, dir);
  haptic(12);
  // 'alerts' is not a page - the alert list lives on the watch tab. Sending
  // the old name here removed .on from every page and left a blank screen.
  closeSheet();
  goTab('watch');
}

/* ---------------------------------------------------------------- alerts */
function saveAlert(sym, price, dir) {
  var list = store.get(LS.alerts, []);
  list.push({ s: sym, p: price, d: dir, t: Date.now() });
  store.set(LS.alerts, list);
  renderAlerts();
  checkAlerts(true);
  queueSync();
}

function addAlert() {
  var sym = ($('#a-sym').value || '').trim().toUpperCase();
  var price = parseFloat($('#a-price').value);
  var dir = $('#a-dir').value;
  var note = $('#alertCount');
  if (!sym || !price || isNaN(price)) {
    note.textContent = 'צריך סימבול ומחיר';
    return;
  }
  // The same level twice would just fire twice.
  var dup = store.get(LS.alerts, []).some(function (a) {
    return a.s === sym && a.d === dir && Math.abs(a.p - price) < 1e-9;
  });
  if (dup) { note.textContent = 'ההתראה הזו כבר קיימת'; return; }

  saveAlert(sym, price, dir);
  $('#a-sym').value = '';
  $('#a-price').value = '';
}

function removeAlert(i) {
  var list = store.get(LS.alerts, []);
  list.splice(i, 1);
  store.set(LS.alerts, list);
  renderAlerts();
  queueSync();
}

/* Last known price per alerted symbol. Seeded from the snapshot so a row
   shows something immediately, then refreshed live. */
var ALERT_PRICES = {};
/* When each of those was fetched. Without this a price was fetched once and
   then never again - every later check saw a cached value and skipped - so an
   open trade's price, R and rail froze at whatever loaded first. */
var PRICE_AT = {};
var PRICE_TTL = 60000;

function seedAlertPrices(list) {
  list.forEach(function (a) {
    if (ALERT_PRICES[a.s] != null) return;
    var snap = SNAP_BY_SYM[a.s];
    if (snap && snap.t && snap.t.price != null) ALERT_PRICES[a.s] = snap.t.price;
  });
}

function renderAlerts() {
  var list = store.get(LS.alerts, []);
  seedAlertPrices(list);
  var box = $('#alertsList');
  if (!list.length) {
    box.innerHTML = '<div class="msg">אין התראות עדיין.</div>';
    $('#alertCount').textContent = '';
    applyFold('alerts', false);
    return;
  }
  box.innerHTML = list.map(function (a, i) {
    var now = ALERT_PRICES[a.s];
    var hit = now != null &&
      ((a.d === 'above' && now >= a.p) || (a.d === 'below' && now <= a.p));
    /* An alert belonging to a trade is that trade's stop or target. Deleting
       it here used to remove the protection silently and nothing put it back,
       so it is shown as owned and is removed by closing the trade instead. */
    var owned = !!a.tid;
    var kind = a.kind === 'stop' ? 'סטופ' : a.kind === 'target' ? 'יעד' : '';
    return '<div class="alert ' + (hit ? 'on' : '') + '">' +
      '<div class="a-main">' +
        '<div class="a-top">' +
          '<span class="sym">' + esc(a.s) + '</span>' +
          (owned ? '<span class="badge own">' + kind + ' עסקה</span>' : '') +
          (hit ? '<span class="badge">הופעלה</span>' : '') +
          '<span class="pr">' + (now == null ? '…' : money(now)) + '</span>' +
        '</div>' +
        '<div class="cond">' + (a.d === 'above' ? 'מעל' : 'מתחת ל־') + ' ' +
          money(a.p) + '</div>' +
      '</div>' +
      (owned
        ? '<button class="x" onclick="goTab(\'trades\')" ' +
          'aria-label="לעסקאות">›</button>'
        : '<button class="x" onclick="removeAlert(' + i +
          ')" aria-label="מחק">✕</button>') +
      '</div>';
  }).join('');
  $('#alertCount').textContent = list.length + ' פעילות';
  applyFold('alerts', false);
}

/* Symbols worth a live price: everything alerted, plus every open trade even
   if its alerts were removed by hand. */
function watchedSymbols() {
  var syms = {};
  store.get(LS.alerts, []).forEach(function (a) { syms[a.s] = 1; });
  openTrades().forEach(function (t) { syms[t.s] = 1; });
  watchlist().forEach(function (s) { syms[s] = 1; });
  return Object.keys(syms);
}

function checkAlerts(force) {
  var syms = watchedSymbols();
  if (!syms.length) return;

  /* The runner prices every watched symbol into data/tickers.json, so the
     same same-origin file that feeds the home tiles feeds these too. This is
     the reliable path: no CORS, no third-party proxy that can be down. The
     Yahoo attempt below is only a chance at something fresher than the file's
     fifteen minutes, and it is fine for it to fail. */
  loadTickerFile(force).then(function () { freshenWatched(force); })
    .catch(function () { freshenWatched(force); });
}

/* Whatever the file could not supply, asked for the old way. */
function freshenWatched(force) {
  var now = Date.now();
  watchedSymbols().forEach(function (sym) {
    var fresh = PRICE_AT[sym] && (now - PRICE_AT[sym]) < PRICE_TTL;
    if (!force && ALERT_PRICES[sym] != null && fresh) return;

    var snap = SNAP_BY_SYM[sym];
    if (snap && snap.t && snap.t.price != null && ALERT_PRICES[sym] == null) {
      ALERT_PRICES[sym] = snap.t.price;   // shown until a real one lands
      renderAlerts();
      paintTrades();
    }
    yahooQuote(sym).then(function (q) {
      if (q && q.price != null) {
        ALERT_PRICES[sym] = q.price;
        PRICE_AT[sym] = Date.now();
        renderAlerts();
        // The same price drives the trade cards and the watchlist rows.
        paintTrades();
        renderWatchlist();
      }
    }).catch(function () {});
  });
}

/* Keeps the open trades moving while the app is on screen. Paused when it is
   not, so a backgrounded tab is not quietly burning requests. */
function startPricePolling() {
  setInterval(function () {
    if (document.hidden) return;
    /* The indices were never in this loop at all - only symbols you had put
       on a list were. That is why the home screen sat still through the
       opening bell while the trade cards moved. */
    if (currentTab() === 'home') loadTickers(false);
    if (watchedSymbols().length) checkAlerts(false);
  }, PRICE_TTL);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    /* The case that matters most on iOS: a PWA put down before the open and
       picked up after it. The interval above does not run while the app is
       suspended, so without this it would show whatever it had at the moment
       it went to sleep. */
    loadTickers(false);
    checkAlerts(false);
  });
}

/* The freshest of the watched prices, for the "updated HH:MM" stamp. */
function lastPriceAt() {
  var best = 0;
  watchedSymbols().forEach(function (s) {
    if (PRICE_AT[s] && PRICE_AT[s] > best) best = PRICE_AT[s];
  });
  return best || null;
}

/* ================================================================ trades ==
 * A setup you are actually in, rather than a stock you are looking at.
 *
 * The numbers are kept in R - one R is the distance from entry to stop, the
 * money at risk per share. "+1.8R" compares across trades of different sizes
 * and different stocks; "+$340" does not say whether that was a good trade.
 */
var TRADE_ATR_STOP = 2;    // stop this many ATR from entry
var TRADE_RR = 2;          // and a target this many R away

function trades() { return store.get(LS.trades, []); }
function setTrades(v) { store.set(LS.trades, v); }
function openTrades() {
  return trades().filter(function (t) { return t.status !== 'closed'; });
}

function riskCfg() {
  return store.get(LS.risk, { acct: null, pct: 1 });
}

function saveRisk() {
  var a = parseFloat(($('#r-acct') || {}).value);
  var p = parseFloat(($('#r-pct') || {}).value);
  store.set(LS.risk, {
    acct: isNaN(a) ? null : a,
    pct: isNaN(p) ? null : p
  });
  paintRiskNote();
}

function paintRiskNote() {
  var c = riskCfg();
  var el = $('#riskNote');
  if (!el) return;
  el.textContent = (c.acct && c.pct)
    ? 'סיכון לעסקה ' + money(c.acct * c.pct / 100)
    : '';
}

/* The suggestion, from the ATR in the nightly snapshot. A stop closer than
   one ATR sits inside a normal day's range, so it gets hit by noise rather
   than by the setup failing. */
function suggestLevels(sym, entry) {
  var row = SNAP_BY_SYM[sym];
  var atr = row && row.t && row.t.atr;
  if (!atr || !entry) return null;
  var stop = entry - TRADE_ATR_STOP * atr;
  if (stop <= 0) return null;
  return {
    atr: atr,
    stop: stop,
    target: entry + TRADE_RR * (entry - stop)
  };
}

function touchField(el) { el.dataset.touched = '1'; }

/* Tags already used, offered as completions so the same setup keeps the same
   name - the journal's per-setup breakdown is only as good as that. */
function paintTagList() {
  var el = $('#setupTags');
  if (!el) return;
  var seen = {};
  trades().forEach(function (t) { if (t.tag) seen[t.tag] = 1; });
  el.innerHTML = Object.keys(seen).sort().map(function (t) {
    return '<option value="' + esc(t) + '">';
  }).join('');
}

function resetTradeForm() {
  ['t-sym', 't-entry', 't-stop', 't-target', 't-qty', 't-tag', 't-note']
    .forEach(function (id) {
      var el = $('#' + id);
      if (el) { el.value = ''; delete el.dataset.touched; }
    });
  $('#t-guard').innerHTML = '';
  $('#tSugNote').textContent = '';
}

/* Fills the stop and target once the symbol and entry are known, but never
   overwrites a value the user typed. */
function onTradeInput() {
  var sym = ($('#t-sym').value || '').trim().toUpperCase();
  var entry = parseFloat($('#t-entry').value);
  var note = $('#tSugNote');

  if (!sym || isNaN(entry) || entry <= 0) {
    note.textContent = '';
    $('#t-guard').innerHTML = '';
    return;
  }
  var s = suggestLevels(sym, entry);
  if (!s) {
    note.textContent = SNAP_BY_SYM[sym] ? 'אין ATR' : 'לא במאגר';
  } else {
    note.textContent = 'ATR ' + money(s.atr);
    var st = $('#t-stop'), tg = $('#t-target');
    if (!st.dataset.touched) st.value = s.stop.toFixed(2);
    if (!tg.dataset.touched) tg.value = s.target.toFixed(2);
  }
  paintGuard();
}

function suggestSize() {
  var c = riskCfg();
  var entry = parseFloat($('#t-entry').value);
  var stop = parseFloat($('#t-stop').value);
  var note = $('#tSugNote');
  if (!c.acct || !c.pct) { note.textContent = 'מלא גודל תיק וסיכון'; return; }
  if (isNaN(entry) || isNaN(stop) || entry <= stop) {
    note.textContent = 'צריך כניסה וסטופ תקינים';
    return;
  }
  var perShare = entry - stop;
  var qty = Math.floor((c.acct * c.pct / 100) / perShare);
  $('#t-qty').value = qty > 0 ? qty : '';
  note.textContent = qty > 0
    ? qty + ' מניות · סיכון ' + money(qty * perShare)
    : 'הסיכון למניה גדול מהתקציב';
}

/* Everything worth being told before committing, from data already held. */
function tradeGuard(sym, entry, stop, target) {
  var out = [];
  var row = SNAP_BY_SYM[sym];
  if (isNaN(entry) || isNaN(stop) || entry <= 0) return out;

  if (stop >= entry) {
    out.push(['bad', 'הסטופ מעל הכניסה — לונג צריך סטופ נמוך יותר']);
    return out;
  }
  var risk = entry - stop;

  if (!isNaN(target)) {
    if (target <= entry) {
      out.push(['bad', 'היעד מתחת לכניסה']);
    } else {
      var rr = (target - entry) / risk;
      if (rr < 1.5) {
        out.push(['bad', 'יחס סיכוי/סיכון ' + num(rr, 1) +
          ':1 — נמוך מדי כדי להצדיק את העסקה']);
      } else if (rr < 2) {
        out.push(['warn', 'יחס סיכוי/סיכון ' + num(rr, 1) + ':1 — גבולי']);
      }
    }
  }

  if (!row) {
    out.push(['warn', sym + ' לא במאגר הנסרק — אין בדיקות טכניות']);
    return out;
  }
  var t = row.t || {};

  if (t.atr) {
    var inAtr = risk / t.atr;
    if (inAtr < 1) {
      out.push(['bad', 'הסטופ במרחק ' + num(inAtr, 1) +
        ' ATR — צר מתנועה יומית רגילה, ייצא מרעש']);
    } else if (inAtr > 4) {
      out.push(['warn', 'הסטופ במרחק ' + num(inAtr, 1) +
        ' ATR — רחב, הפוזיציה תצא קטנה']);
    }
  }

  // The classic way a technical swing gets gapped through its stop.
  if (row.er && row.er.d) {
    var d = new Date(row.er.d + 'T12:00:00');
    var mid = new Date(); mid.setHours(0, 0, 0, 0);
    var days = Math.floor((d - mid) / 86400000);
    if (days >= 0 && days <= 10) {
      out.push([days <= 4 ? 'bad' : 'warn', 'דוח בעוד ' + days +
        ' ימים — גאפ יכול לדלג מעל הסטופ']);
    }
  }

  if (t.rsi != null && t.rsi > 75) {
    out.push(['warn', 'RSI ' + num(t.rsi, 0) + ' — קנוי־יתר']);
  }
  if (t.vma50 != null && t.vma50 < 0) {
    out.push(['warn', 'המחיר מתחת לממוצע 50 — כניסה נגד המגמה הקצרה']);
  }
  if (t.vma200 != null && t.vma200 < 0) {
    out.push(['warn', 'המחיר מתחת לממוצע 200 — מגמה ארוכת טווח יורדת']);
  }
  return out;
}

function guardHtml(list) {
  if (!list.length) return '';
  return '<div class="guard">' + list.map(function (g) {
    return '<div class="g-row ' + g[0] + '"><span class="g-i">' +
      (g[0] === 'bad' ? '!' : 'i') + '</span><span>' + esc(g[1]) +
      '</span></div>';
  }).join('') + '</div>';
}

function paintGuard() {
  var sym = ($('#t-sym').value || '').trim().toUpperCase();
  var g = tradeGuard(sym, parseFloat($('#t-entry').value),
                     parseFloat($('#t-stop').value),
                     parseFloat($('#t-target').value));
  $('#t-guard').innerHTML = guardHtml(g);
}

function addTrade() {
  var sym = ($('#t-sym').value || '').trim().toUpperCase();
  var entry = parseFloat($('#t-entry').value);
  var stop = parseFloat($('#t-stop').value);
  var target = parseFloat($('#t-target').value);
  var qty = parseFloat($('#t-qty').value);
  var note = $('#tSugNote');

  if (!sym || isNaN(entry) || isNaN(stop)) {
    note.textContent = 'צריך סימבול, כניסה וסטופ';
    return;
  }
  if (stop >= entry) { note.textContent = 'הסטופ חייב להיות מתחת לכניסה'; return; }

  var list = trades();
  list.unshift({
    id: Date.now(),
    s: sym,
    entry: entry,
    stop: stop,
    target: isNaN(target) ? null : target,
    qty: isNaN(qty) ? null : qty,
    opened: new Date().toISOString().slice(0, 10),
    status: 'open',
    tag: ($('#t-tag').value || '').trim(),
    note: ($('#t-note').value || '').trim(),
    // High-water mark, for the trailing stop. Seeded at entry so a trade that
    // never goes green cannot suggest a trail above where it started.
    hi: entry
  });
  setTrades(list);
  syncTradeAlerts();
  resetTradeForm();
  renderTrades();
  haptic(12);
}

/* Every open trade keeps a stop alert and a target alert, so the levels reach
   the phone through the checker that already runs. Rebuilt wholesale rather
   than patched, so closing a trade cannot leave its alerts behind. */
function syncTradeAlerts() {
  var manual = store.get(LS.alerts, []).filter(function (a) { return !a.tid; });
  var made = [];
  openTrades().forEach(function (t) {
    made.push({ s: t.s, d: 'below', p: t.stop, t: t.id, tid: t.id, kind: 'stop' });
    if (t.target) {
      made.push({ s: t.s, d: 'above', p: t.target, t: t.id, tid: t.id, kind: 'target' });
    }
  });
  store.set(LS.alerts, manual.concat(made));
  renderAlerts();
  queueSync();
}

function closeTrade(id) {
  var list = trades();
  var t = null;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) t = list[i];
  if (!t) return;
  var live = ALERT_PRICES[t.s];
  var val = prompt('מחיר יציאה ל־' + t.s + ':',
                   live != null ? live.toFixed(2) : '');
  if (val === null) return;
  var exit = parseFloat(val);
  if (isNaN(exit)) return;
  t.status = 'closed';
  t.exit = exit;
  t.closed = new Date().toISOString().slice(0, 10);
  setTrades(list);
  syncTradeAlerts();
  renderTrades();
}

/* Selling part of a position: take something off at a target and let the rest
   run, which is the whole reason a target and a trailing stop coexist. */
function sellPart(id) {
  var list = trades();
  var t = null;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) t = list[i];
  if (!t) return;

  var left = openQty(t);
  if (!t.qty) {
    alert('כדי למכור חלק צריך שתהיה כמות מניות בעסקה. ערוך אותה והוסף כמות.');
    return;
  }
  if (left <= 0) return;

  var half = Math.floor(left / 2) || left;   // one share left sells whole
  var qv = prompt('כמה מניות למכור מתוך ' + left + '?', String(half));
  if (qv === null) return;
  var qty = parseFloat(qv);
  if (isNaN(qty) || qty <= 0) return;
  if (qty > left) qty = left;

  var live = ALERT_PRICES[t.s];
  var pv = prompt('מחיר מכירה ל־' + t.s + ':',
                  live != null ? live.toFixed(2) : '');
  if (pv === null) return;
  var price = parseFloat(pv);
  if (isNaN(price) || price <= 0) return;

  t.exits = (t.exits || []).concat([{
    qty: qty, price: price, date: new Date().toISOString().slice(0, 10)
  }]);

  // Selling the last share is a close, not a partial - otherwise the trade
  // would sit open with nothing in it.
  if (openQty(t) <= 0) {
    t.status = 'closed';
    t.exit = price;
    t.closed = new Date().toISOString().slice(0, 10);
  }
  setTrades(list);
  syncTradeAlerts();
  renderTrades();
  haptic(12);
}

function deleteTrade(id) {
  setTrades(trades().filter(function (t) { return t.id !== id; }));
  syncTradeAlerts();
  renderTrades();
}

/* ------------------------------------------------- stop management ----- */
var TRAIL_ATR = 3;   // chandelier distance below the high since entry

/* Tracks the highest price seen while a trade has been open. The app only
   sees prices while it is running, so this is "the highest this app has
   observed", not the true session high - which is why the trail is offered as
   a suggestion to accept rather than applied on its own. */
function trackHighs() {
  var list = trades();
  var moved = false;
  list.forEach(function (t) {
    if (t.status === 'closed') return;
    var p = ALERT_PRICES[t.s];
    if (p == null) return;
    var hi = t.hi != null ? t.hi : t.entry;
    if (p > hi) { t.hi = p; moved = true; }
  });
  if (moved) setTrades(list);
  return moved;
}

/* What the stop could become, given where price has been. Never loosens a
   stop: a suggestion only appears when it would sit higher than the current
   one, because moving a stop down turns a defined risk into an open one. */
function stopMoves(t) {
  var out = [];
  if (t.status === 'closed') return out;
  var price = tradePrice(t);
  var r = tradeR(t, price);

  // Breakeven once the trade has paid for its own risk.
  if (r != null && r >= 1 && t.stop < t.entry) {
    out.push({ k: 'be', to: t.entry, label: 'העבר לאיזון' });
  }

  var row = SNAP_BY_SYM[t.s];
  var atr = row && row.t && row.t.atr;
  var hi = t.hi != null ? t.hi : t.entry;
  if (atr) {
    var trail = hi - TRAIL_ATR * atr;
    // Only worth offering if it is both above the current stop and not above
    // the price itself, which would stop the trade out on the spot.
    if (trail > t.stop && (price == null || trail < price)) {
      out.push({ k: 'trail', to: trail,
                 label: 'סטופ נגרר ' + money(trail) });
    }
  }
  return out;
}

function applyStop(id, to) {
  var list = trades();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      if (to <= list[i].stop) return;    // never loosen
      list[i].stop = Math.round(to * 100) / 100;
    }
  }
  setTrades(list);
  syncTradeAlerts();
  renderTrades();
  haptic(12);
}

/* ------------------------------------------------------- open exposure -- */
/* What would be lost if every open stop were hit from here. A trade whose
   stop has been raised past its entry contributes nothing - it is protected -
   so it is counted separately rather than as negative risk. */
function openRisk() {
  var money_ = 0, rSum = 0, protectedCount = 0, sized = 0;
  openTrades().forEach(function (t) {
    var price = tradePrice(t);
    var risk = t.entry - t.stop;
    if (t.stop >= t.entry) protectedCount++;
    if (price == null || !t.qty) return;
    sized++;
    var perShare = Math.max(0, price - t.stop);
    money_ += perShare * t.qty;
    if (risk > 0) rSum += perShare / risk;
  });
  return { money: money_, r: rSum, protected: protectedCount, sized: sized };
}

/* What a closed trade actually made or lost. Per share when no size was
   recorded, which is still an answer. */
/* Scaling out.
 *
 * t.qty stays the size the position was opened at, so the entry, the risk and
 * every R figure keep meaning what they meant on day one. What was sold along
 * the way lives in t.exits, and the remainder is derived. Storing the
 * remaining quantity instead would quietly rewrite the trade's own history
 * every time a piece was sold. */
function soldQty(t) {
  return (t.exits || []).reduce(function (a, e) { return a + e.qty; }, 0);
}

function realisedMoney(t) {
  return (t.exits || []).reduce(function (a, e) {
    return a + (e.price - t.entry) * e.qty;
  }, 0);
}

/* Shares still in the market. null when the trade carries no quantity at all,
   where everything is quoted per share and there is nothing to divide. */
function openQty(t) {
  if (!t.qty) return null;
  return Math.max(0, t.qty - soldQty(t));
}

function tradeResult(t) {
  var got = realisedMoney(t);
  if (t.exit == null) return (t.exits && t.exits.length) ? got : null;
  // The closing price applies only to whatever was left.
  var remain = t.qty ? Math.max(0, t.qty - soldQty(t)) : 1;
  return got + (t.exit - t.entry) * remain;
}

function tradeR(t, price) {
  var risk = t.entry - t.stop;
  if (!risk || price == null) return null;
  return (price - t.entry) / risk;
}

/* R for a finished trade, measured on the money actually made rather than on
   the last price alone - otherwise a position sold half at the target and
   half at breakeven would be filed under whichever half happened to close it.
   Identical to (exit-entry)/risk when nothing was scaled out. */
function closedR(t) {
  var risk = t.entry - t.stop;
  var got = tradeResult(t);
  if (!risk || got == null) return null;
  return got / (risk * (t.qty || 1));
}

function tradePrice(t) {
  var price = ALERT_PRICES[t.s];
  if (price == null) {
    var snap = SNAP_BY_SYM[t.s];
    if (snap && snap.t) price = snap.t.price;
  }
  return price;
}

/* The three numbers a trade is actually asking about, all measured the same
   way: what this trade will have made or lost when it is over. Quoting the
   live one from entry and the other two from the current price would have
   made them look unrelated. Without a size they are per share, which is still
   an answer rather than a dash. */
function tradeMoney(t) {
  var price = tradePrice(t);
  // Only what is still open can still gain or lose; what was already sold is
  // banked and reported separately.
  var per = t.qty ? openQty(t) : 1;
  return {
    perShare: !t.qty,
    open: t.qty ? openQty(t) : null,
    sold: soldQty(t),
    realised: realisedMoney(t),
    now: price == null ? null : (price - t.entry) * per,
    ifStopped: (t.stop - t.entry) * per,
    ifTarget: t.target == null ? null : (t.target - t.entry) * per
  };
}

/* One card, rendered the same on the home screen and on the trades tab. */
function tradeCardHtml(t) {
  var price = tradePrice(t);
  var risk = t.entry - t.stop;
  var m = tradeMoney(t);
  var pl = m.now;

  // Position on the stop..target rail, in physical left-to-right space.
  var lo = t.stop, hi = t.target || (t.entry + risk * TRADE_RR);
  var pos = price == null ? null
    : Math.max(0, Math.min(100, ((price - lo) / (hi - lo)) * 100));
  var entryPos = Math.max(0, Math.min(100, ((t.entry - lo) / (hi - lo)) * 100));

  var toStop = price != null ? ((t.stop - price) / price) * 100 : null;
  var toTgt = (price != null && t.target)
    ? ((t.target - price) / price) * 100 : null;

  var bad = tradeGuard(t.s, t.entry, t.stop, t.target)
    .filter(function (x) { return x[0] === 'bad'; });

  if (EDITING === t.id) return tradeEditHtml(t);

  // A minus sign rather than a hyphen, so a loss reads as a number and not as
  // a stray dash next to the currency symbol.
  var dollars = function (v) {
    return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + money(Math.abs(v));
  };

  var moves = stopMoves(t);
  var movesHtml = moves.length
    ? '<div class="tr-moves">' + moves.map(function (m) {
        return '<button class="chip ' + (m.k === 'be' ? 'be' : '') +
          '" onclick="applyStop(' + t.id + ',' + m.to + ')">' +
          esc(m.label) + '</button>';
      }).join('') + '</div>'
    : '';

  return '<div class="trade">' +
    '<div class="tr-top">' +
      '<button class="tr-sym" onclick="analyze(\'' + esc(t.s) + '\')">' +
        esc(t.s) + '</button>' +
      (t.tag ? '<span class="tr-tag">' + esc(t.tag) + '</span>' : '') +
      '<span class="tr-r ' + cls(pl) + '">' + dollars(pl) + '</span>' +
      '<button class="tr-x" onclick="editTrade(' + t.id +
        ')" aria-label="ערוך">✎</button>' +
    '</div>' +
    '<div class="tr-now">' +
      '<span class="pr">' + (price == null ? '…' : money(price)) + '</span>' +
      (m.perShare
        ? '<span class="pl" style="color:var(--muted)">סכומים למניה — ' +
          'הוסף כמות</span>' : '') +
    '</div>' +
    '<div class="rail">' +
      '<i class="rail-fill" style="width:' + (pos == null ? 0 : pos) + '%"></i>' +
      '<i class="rail-entry" style="left:' + entryPos + '%"></i>' +
      (pos == null ? '' : '<i class="rail-now" style="left:' + pos + '%"></i>') +
    '</div>' +
    '<div class="rail-lb">' +
      '<span>סטופ ' + money(t.stop) +
        (toStop != null ? ' · ' + num(toStop, 1) + '%' : '') + '</span>' +
      '<span>' + (t.target ? 'יעד ' + money(t.target) +
        (toTgt != null ? ' · +' + num(toTgt, 1) + '%' : '') : 'ללא יעד') +
      '</span>' +
    '</div>' +
    '<div class="mny">' +
      '<div class="mny-c"><span class="mk">כעת</span>' +
        '<span class="mv ' + cls(pl) + '">' + dollars(pl) + '</span></div>' +
      '<div class="mny-c"><span class="mk">אם ייעצר</span>' +
        '<span class="mv ' + cls(m.ifStopped) + '">' +
        dollars(m.ifStopped) + '</span></div>' +
      '<div class="mny-c"><span class="mk">אם יגיע ליעד</span>' +
        '<span class="mv ' + cls(m.ifTarget) + '">' +
        dollars(m.ifTarget) + '</span></div>' +
    '</div>' +
    (m.sold ? '<div class="tr-part">נמכרו ' + m.sold + ' מתוך ' + t.qty +
      ' · מומש <b class="' + cls(m.realised) + '">' + dollars(m.realised) +
      '</b></div>' : '') +
    '<div class="tr-meta">כניסה ' + money(t.entry) +
      (t.qty ? ' · ' + (m.sold ? m.open + ' מתוך ' + t.qty : t.qty) +
        ' מניות' : '') +
      ' · ' + esc(t.opened) +
      (t.stop >= t.entry ? ' · <b class="safe">מוגנת</b>' : '') + '</div>' +
    (t.note ? '<div class="tr-note">' + esc(t.note) + '</div>' : '') +
    movesHtml +
    (bad.length ? guardHtml(bad) : '') +
    '<div class="frow" style="margin-top:9px">' +
      (t.qty ? '<button class="btn ghost" onclick="sellPart(' + t.id +
        ')">מכור חלק</button>' : '') +
      '<button class="btn ghost" onclick="closeTrade(' + t.id +
        ')">סגור עסקה</button>' +
    '</div>' +
    '</div>';
}

/* Editing an open trade.
 *
 * Without this a stop could never be moved, only deleted along with the whole
 * trade - which made a trailing stop impossible and lost the trade's history
 * every time you wanted to adjust a level. */
var EDITING = null;

function editTrade(id) { EDITING = id; paintTrades(); }
function cancelEdit() { EDITING = null; paintTrades(); }

function tradeEditHtml(t) {
  var f = function (id, ph, val) {
    return '<input id="e-' + id + '" inputmode="decimal" placeholder="' + ph +
      '" value="' + (val == null ? '' : val) + '">';
  };
  return '<div class="trade editing">' +
    '<div class="tr-top">' +
      '<span class="tr-sym">' + esc(t.s) + '</span>' +
      '<span class="tr-r" style="color:var(--ink-2);font-size:.78rem">עריכה</span>' +
    '</div>' +
    '<div class="frow" style="margin-top:9px">' +
      f('stop', 'סטופ', t.stop) + f('target', 'יעד', t.target) +
    '</div>' +
    '<div class="frow">' +
      f('entry', 'כניסה', t.entry) + f('qty', 'כמות', t.qty) +
    '</div>' +
    '<div class="frow">' +
      '<input id="e-tag" placeholder="סוג סטאפ" value="' + esc(t.tag || '') + '">' +
    '</div>' +
    '<div class="frow">' +
      '<input id="e-note" placeholder="למה נכנסת" value="' + esc(t.note || '') + '">' +
    '</div>' +
    '<div class="score-note" id="e-err" style="margin-bottom:8px"></div>' +
    '<div class="frow">' +
      '<button class="btn" onclick="saveEdit(' + t.id + ')">שמור</button>' +
      '<button class="btn ghost" style="max-width:80px" onclick="cancelEdit()">בטל</button>' +
      '<button class="btn ghost" style="max-width:64px;color:var(--alert)" ' +
        'onclick="deleteTrade(' + t.id + ')">מחק</button>' +
    '</div>' +
    '</div>';
}

function saveEdit(id) {
  var stop = parseFloat($('#e-stop').value);
  var target = parseFloat($('#e-target').value);
  var entry = parseFloat($('#e-entry').value);
  var qty = parseFloat($('#e-qty').value);
  var err = $('#e-err');

  if (isNaN(entry) || isNaN(stop)) {
    err.textContent = 'צריך כניסה וסטופ'; err.style.color = 'var(--alert)';
    return;
  }
  /* A stop above the entry is the whole point of trailing one - it locks in
     profit - so the rule here is only that it must sit below where the trade
     would actually exit. Requiring it below entry, as creation does, made a
     protected trade impossible to trail any further. */
  var list = trades();
  var cur = null;
  for (var j = 0; j < list.length; j++) if (list[j].id === id) cur = list[j];
  var price = cur ? tradePrice(cur) : null;
  var ceiling = price != null ? price : entry;
  if (stop >= ceiling) {
    err.textContent = price != null
      ? 'הסטופ מעל המחיר הנוכחי — העסקה תיסגר מיד'
      : 'הסטופ חייב להיות מתחת לכניסה';
    err.style.color = 'var(--alert)';
    return;
  }
  for (var i = 0; i < list.length; i++) {
    if (list[i].id !== id) continue;
    list[i].entry = entry;
    list[i].stop = stop;
    list[i].target = isNaN(target) ? null : target;
    list[i].qty = isNaN(qty) ? null : qty;
    list[i].tag = ($('#e-tag').value || '').trim();
    list[i].note = ($('#e-note').value || '').trim();
    if (list[i].hi == null || list[i].hi < entry) list[i].hi = entry;
  }
  setTrades(list);
  EDITING = null;
  syncTradeAlerts();     // the stop and target alerts follow the new levels
  renderTrades();
  haptic(12);
}

/* Paints both lists and nothing else.
 *
 * Kept free of side effects on purpose: a live quote arriving has to repaint
 * the cards, and if painting also fetched, that would loop. */
function paintTrades() {
  trackHighs();          // before rendering, so a new high can offer a trail
  var open = openTrades();
  var cards = open.length ? open.map(tradeCardHtml).join('') : null;
  var risk = openRisk();
  var cfg = riskCfg();
  var riskHtml = '';
  if (open.length) {
    var pctOfAcct = (cfg.acct && risk.money)
      ? ' · ' + num((risk.money / cfg.acct) * 100, 1) + '% מהתיק' : '';
    riskHtml = '<div class="expo">' +
      '<span class="ex-k">אם כל הסטופים ייפגעו</span>' +
      '<span class="ex-v">' + (risk.sized ? '−' + money(risk.money) : '—') +
        '</span>' +
      '<span class="ex-n">' +
        (risk.protected ? risk.protected + ' מוגנות' : '') +
        (risk.sized < open.length
          ? (risk.protected ? ' · ' : '') +
            (open.length - risk.sized) + ' ללא כמות' : '') +
        pctOfAcct + '</span>' +
      '</div>';
  }

  var hb = $('#homeTrades');
  if (hb) {
    hb.innerHTML = cards
      ? riskHtml + cards
      : '<div class="msg">אין עסקאות פתוחות. ' +
        '<button class="chip" style="margin-top:8px" onclick="goTab(\'trades\')">' +
        'פתח סטאפ</button></div>';
  }
  // The stamp matters here: a frozen price is invisible without it, and this
  // card is the one you would act on.
  var at = lastPriceAt();
  var stamp = (open.length && at)
    ? ' · ' + new Date(at).toLocaleTimeString('he-IL',
        { hour: '2-digit', minute: '2-digit' })
    : '';
  var hc = $('#homeTradeCount');
  if (hc) hc.textContent = open.length ? open.length + ' פתוחות' + stamp : '';

  var tb = $('#tradesList');
  if (tb) {
    tb.innerHTML = cards
      ? riskHtml + cards
      : '<div class="msg">אין עסקאות פתוחות. הזן סימבול ומחיר כניסה למעלה — ' +
        'הסטופ והיעד יוצעו לפי ATR.</div>';
  }
  var tc = $('#tradeCount');
  if (tc) tc.textContent = open.length ? open.length + ' פתוחות' + stamp : '';
}

/* The home screen: indices and the trades you are in, nothing else. */
function renderHome() {
  loadTickers();
  paintTrades();
  if (openTrades().length) checkAlerts(false);
}

function renderTrades() {
  paintRiskNote();
  paintTagList();
  var c = riskCfg();
  if ($('#r-acct') && !$('#r-acct').value && c.acct) $('#r-acct').value = c.acct;
  if ($('#r-pct') && !$('#r-pct').value && c.pct != null) $('#r-pct').value = c.pct;

  paintTrades();
  renderJournal();
  // Open trades need a live price even when the alerts card is not on screen.
  checkAlerts(false);
}

function renderJournal() {
  var done = trades().filter(function (t) { return t.status === 'closed'; });
  var box = $('#journalList');
  var stat = $('#journalStat');
  if (!done.length) {
    box.innerHTML = '<div class="msg">עסקאות שתסגור יופיעו כאן, עם התוצאה ' +
      'ב־R.</div>';
    if (stat) stat.textContent = '';
    return;
  }
  var rs = done.map(function (t) { return closedR(t); })
               .filter(function (v) { return v != null; });
  var wins = rs.filter(function (v) { return v > 0; }).length;
  var total = rs.reduce(function (a, v) { return a + v; }, 0);
  if (stat) {
    var netMoney = done.reduce(function (a, t) {
      var v = tradeResult(t); return a + (v == null ? 0 : v);
    }, 0);
    stat.textContent = done.length + ' · ' +
      Math.round((wins / rs.length) * 100) + '% מוצלחות · ' +
      (netMoney > 0 ? '+' : netMoney < 0 ? '−' : '') + money(Math.abs(netMoney));
  }
  /* Per-setup expectancy. This is the number that says which setup is
     actually paying, and it only exists because trades carry a tag. */
  var byTag = {};
  done.forEach(function (t) {
    var r = closedR(t);
    if (r == null || !t.tag) return;
    (byTag[t.tag] = byTag[t.tag] || []).push(r);
  });
  var tags = Object.keys(byTag).sort(function (a, b) {
    var av = byTag[a].reduce(function (x, y) { return x + y; }, 0) / byTag[a].length;
    var bv = byTag[b].reduce(function (x, y) { return x + y; }, 0) / byTag[b].length;
    return bv - av;
  });
  var moneyByTag = {};
  done.forEach(function (t) {
    if (!t.tag) return;
    var v = tradeResult(t);
    if (v == null) return;
    moneyByTag[t.tag] = (moneyByTag[t.tag] || 0) + v;
  });
  // Ordered by money made, since that is the column being read.
  tags.sort(function (a, b) {
    return (moneyByTag[b] || 0) - (moneyByTag[a] || 0);
  });

  var tagHtml = tags.length ? '<div class="tagstats">' + tags.map(function (k) {
    var rs2 = byTag[k];
    var w = rs2.filter(function (v) { return v > 0; }).length;
    var sum = moneyByTag[k] || 0;
    return '<div class="tstat">' +
      '<span class="tk-name">' + esc(k) + '</span>' +
      '<span class="tk-n">' + rs2.length + ' עסקאות · ' +
        Math.round((w / rs2.length) * 100) + '% מוצלחות</span>' +
      '<span class="tk-r ' + cls(sum) + '">' +
        (sum > 0 ? '+' : sum < 0 ? '−' : '') + money(Math.abs(sum)) + '</span>' +
      '</div>';
  }).join('') + '<div class="score-note" style="margin-top:7px">סך הרווח או ' +
    'ההפסד לפי סוג סטאפ. אחרי כמה עשרות עסקאות זה מראה איזה סטאפ באמת ' +
    'מרוויח לך כסף.</div></div>' : '';

  box.innerHTML = tagHtml + done.slice(0, 30).map(function (t) {
    var r = closedR(t);
    var got = tradeResult(t);
    return '<div class="jrow">' +
      '<span class="sym">' + esc(t.s) + '</span>' +
      '<span class="dt">' + (t.tag ? esc(t.tag) + ' · ' : '') +
        esc(t.closed || t.opened) + '</span>' +
      '<span class="r ' + cls(got) + '">' +
        (got == null ? '—'
          : (got > 0 ? '+' : got < 0 ? '−' : '') + money(Math.abs(got))) +
        '</span>' +
      '<button class="tr-x" onclick="deleteTrade(' + t.id +
        ')" aria-label="מחק">✕</button>' +
      '</div>';
  }).join('');
}

/* -------------------------------------------------------------- screener */
var FILTERS = [
  ['score', 'ציון כולל', 0, 100,
   'הציון שלנו, 0 עד 100, משוקלל מחמישה ממדים: תמחור, צמיחה, רווחיות, ' +
   'איתנות פיננסית ומומנטום. גבוה = החברה נראית טוב יותר בכל הממדים יחד.'],
  ['mcapB', 'שווי שוק (מיליארד $)', 0, 5000,
   'שווי כל החברה בבורסה — מחיר המניה כפול מספר המניות. מסנן לפי גודל: ' +
   'חברות גדולות בדרך כלל יציבות יותר, קטנות תנודתיות יותר.'],
  ['pe', 'מכפיל רווח', 0, 100,
   'מחיר המניה חלקי הרווח השנתי למניה — כמה שנים של רווח נוכחי משלמים ' +
   'עליה. נמוך נחשב זול, אבל לפעמים משקף ציפייה שהרווח עומד לרדת. ' +
   'חברות בהפסד לא מקבלות מכפיל כלל.'],
  ['revGrowth', 'צמיחת הכנסות %', -50, 200,
   'בכמה אחוזים גדלו ההכנסות לעומת השנה הקודמת. מודד אם העסק מתרחב.'],
  ['netMargin', 'מרג׳ין נקי %', -50, 100,
   'איזה אחוז מההכנסות נשאר כרווח אחרי כל ההוצאות, הריבית והמסים. ' +
   'גבוה = החברה שומרת יותר מכל שקל מכירות.'],
  ['roe', 'תשואה על ההון %', -50, 150,
   'כמה רווח החברה מייצרת על כל שקל של הון עצמי. מודד עד כמה ההנהלה ' +
   'מנצלת ביעילות את כספי בעלי המניות.'],
  ['debtToEquity', 'חוב להון %', 0, 500,
   'היחס בין החוב הפיננסי להון העצמי. גבוה = מינוף גדול יותר, כלומר ' +
   'רגישות גבוהה יותר לריבית ולהאטה.'],
  ['rsi', 'RSI', 0, 100,
   'מדד תנופה טכני, 0 עד 100, שמשווה ימי עליות לימי ירידות בחודש וחצי ' +
   'האחרונים. מעל 70 נחשב קנוי־יתר, מתחת ל־30 מכור־יתר.'],
  ['vma150', 'מעל ממוצע 150 %', -80, 200,
   'בכמה אחוזים המחיר מעל או מתחת לממוצע 150 הימים. ממוצע ביניים — ' +
   'מעליו = מגמת ביניים חיובית, מתחתיו = שלילית.'],
  ['vma200', 'מעל ממוצע 200 %', -80, 200,
   'בכמה אחוזים המחיר מעל או מתחת לממוצע 200 הימים. מעל = מגמה ארוכת ' +
   'טווח עולה, מתחת = יורדת.'],
  ['from52High', 'מרחק משיא 52ש׳ %', -90, 0,
   'כמה אחוזים המחיר רחוק מהשיא של 12 החודשים האחרונים. תמיד אפס או ' +
   'שלילי — אפס אומר שהמניה בשיא.'],
  ['chg12m', 'תשואה 12ח %', -90, 500,
   'שינוי המחיר ב־12 החודשים האחרונים, בלי דיבידנדים.']
];

/* iOS shows no minus key on the decimal keypad, so seven of the filters -
   and "מרחק משיא", whose range is entirely negative - could not be given a
   valid value at all. The toggle sits inside the field's own padding rather
   than beside it, so it costs no width on a narrow screen. */
function numField(id, ph, val, signed) {
  var v = val != null ? val : '';
  if (!signed) {
    return '<input id="' + id + '" inputmode="decimal" placeholder="' +
      esc(ph) + '" value="' + v + '">';
  }
  return '<span class="numf">' +
    '<button type="button" class="sgn" onclick="flipSign(\'' + id + '\')" ' +
      'aria-label="חיובי או שלילי">\u00b1</button>' +
    '<input id="' + id + '" inputmode="decimal" placeholder="' + esc(ph) +
      '" value="' + v + '" oninput="paintSigns()">' +
    '</span>';
}

function flipSign(id) {
  var el = $('#' + id);
  if (!el) return;
  var v = (el.value || '').trim();
  if (v === '' ) el.value = '-';          // ready for the digits that follow
  else if (v === '-') el.value = '';
  else if (v.charAt(0) === '-') el.value = v.slice(1);
  else el.value = '-' + v;
  paintSigns();
  haptic(6);
}

/* The button shows the sign the field currently carries, so a minus is
   visible without reading the number. */
function paintSigns() {
  var els = document.querySelectorAll('.numf');
  for (var i = 0; i < els.length; i++) {
    var inp = els[i].querySelector('input');
    var btn = els[i].querySelector('.sgn');
    if (!inp || !btn) continue;
    var neg = (inp.value || '').trim().charAt(0) === '-';
    btn.classList.toggle('on', neg);
    btn.textContent = neg ? '\u2212' : '\u00b1';
  }
}

function renderFilters() {
  renderScreens();
  renderSectorChips();
  var saved = store.get(LS.filters, {});
  $('#filterRows').innerHTML = FILTERS.map(function (f) {
    var v = saved[f[0]] || {};
    // Only where a negative value is actually in range.
    var signed = f[2] < 0 || f[3] < 0;
    return '<div class="frow">' +
      '<span class="lb"><span class="lb-t">' + f[1] + '</span>' +
        (f[4] ? '<button class="info" onclick="toggleHelp(\'' + f[0] +
          '\')" aria-label="הסבר על ' + f[1] + '">i</button>' : '') +
      '</span>' +
      /* Just "from" and "to": the bounds are stated in the info panel below,
         and repeating them here clipped to nonsense once the sign button took
         part of the field. */
      numField('f-' + f[0] + '-min', 'מ־', v.min, signed) +
      numField('f-' + f[0] + '-max', 'עד', v.max, signed) +
      '</div>' +
      (f[4] ? '<div class="fhelp" id="h-' + f[0] + '">' +
        '<b class="rng">טווח בנתונים: ' + f[2] + ' עד ' + f[3] + '</b>' +
        f[4] + '</div>' : '');
  }).join('');

  // Before the early return below, so saved negatives show their sign either way.
  paintSigns();

  /* Build the index chips from what the snapshot actually contains, so an
     index that failed to scrape never shows up as a filter matching nothing. */
  var counts = availableIndices();
  var keys = Object.keys(counts);
  if (!keys.length) {
    $('#idxChips').innerHTML = '<span class="score-note">אין נתוני מדדים.</span>';
    return;
  }
  var idx = store.get(LS.idx, keys).filter(function (k) {
    return keys.indexOf(k) >= 0;
  });
  if (!idx.length) idx = keys.slice();
  $('#idxChips').innerHTML = keys.map(function (k) {
    return '<button class="chip ' + (idx.indexOf(k) >= 0 ? 'on' : '') +
      '" onclick="toggleIdx(\'' + k + '\')">' + idxLabel(k) +
      ' <span style="opacity:.6">· ' + counts[k] + '</span></button>';
  }).join('');
}

function availableSectors() {
  var counts = {};
  if (!SNAP) return counts;
  SNAP.rows.forEach(function (r) {
    if (r.sec) counts[r.sec] = (counts[r.sec] || 0) + 1;
  });
  return counts;
}

function renderSectorChips() {
  var box = $('#secChips');
  if (!box) return;
  var counts = availableSectors();
  var keys = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });
  if (!keys.length) { box.innerHTML = ''; return; }
  /* Empty selection means "all", so the screener does not start out excluding
     everything and reporting no matches. */
  var on = store.get(LS.sectors, []).filter(function (k) {
    return keys.indexOf(k) >= 0;
  });
  box.innerHTML = keys.map(function (k) {
    return '<button class="chip ' + (on.indexOf(k) >= 0 ? 'on' : '') +
      '" onclick="toggleSector(\'' + k + '\')">' + k +
      ' <span style="opacity:.6">· ' + counts[k] + '</span></button>';
  }).join('');
}

function toggleSector(k) {
  var on = store.get(LS.sectors, []);
  var i = on.indexOf(k);
  if (i >= 0) on.splice(i, 1); else on.push(k);
  store.set(LS.sectors, on);
  renderSectorChips();
}

function availableIndices() {
  var counts = {};
  if (!SNAP) return counts;
  SNAP.rows.forEach(function (r) {
    (r.i || []).forEach(function (k) { counts[k] = (counts[k] || 0) + 1; });
  });
  return counts;
}

function toggleIdx(k) {
  var keys = Object.keys(availableIndices());
  var idx = store.get(LS.idx, keys);
  var i = idx.indexOf(k);
  if (i >= 0) idx.splice(i, 1); else idx.push(k);
  if (!idx.length) idx = keys.slice();
  store.set(LS.idx, idx);
  renderFilters();
}

function resetFilters() {
  store.set(LS.filters, {});
  store.set(LS.idx, Object.keys(availableIndices()));
  store.set(LS.sectors, []);
  renderFilters();
  $('#screenResults').innerHTML = '<div class="msg">הגדר פילטרים ולחץ סרוק.</div>';
}

/* -------------------------------------------------------- saved screens */
function savedScreens() { return store.get(LS.screens, []); }

function renderScreens() {
  var box = $('#savedScreens');
  if (!box) return;
  var list = savedScreens();
  if (!list.length) {
    box.innerHTML = '<span class="score-note">אין סינונים שמורים. הגדר ' +
      'פילטרים ולחץ שמור.</span>';
    return;
  }
  box.innerHTML = '<div class="chips">' + list.map(function (sv, i) {
    return '<span class="chip saved">' +
      '<button onclick="loadScreen(' + i + ')">' + esc(sv.name) + '</button>' +
      '<button class="del" onclick="deleteScreen(' + i + ')" ' +
        'aria-label="מחק ' + esc(sv.name) + '">✕</button></span>';
  }).join('') + '</div>';
}

function saveScreen() {
  var flt = readFilters();
  if (!Object.keys(flt).length) {
    $('#screenCount').textContent = 'אין פילטרים לשמור';
    return;
  }
  var name = (prompt('שם לסינון:') || '').trim();
  if (!name) return;
  var list = savedScreens();
  var entry = { name: name, f: flt, i: store.get(LS.idx, []),
                sec: store.get(LS.sectors, []) };
  var at = -1;
  for (var i = 0; i < list.length; i++) if (list[i].name === name) at = i;
  if (at >= 0) list[at] = entry; else list.push(entry);
  store.set(LS.screens, list.slice(0, 12));
  renderScreens();
}

function loadScreen(i) {
  var sv = savedScreens()[i];
  if (!sv) return;
  store.set(LS.filters, sv.f || {});
  if (sv.i && sv.i.length) store.set(LS.idx, sv.i);
  store.set(LS.sectors, sv.sec || []);
  renderFilters();
  runScreen();
}

function deleteScreen(i) {
  var list = savedScreens();
  list.splice(i, 1);
  store.set(LS.screens, list);
  renderScreens();
}

/* Class rather than the hidden attribute, so the panel can expand into place
   instead of the rows below it jumping by its full height in one frame. */
function toggleHelp(key) {
  var el = $('#h-' + key);
  if (el) el.classList.toggle('open');
}

function readFilters() {
  var out = {};
  FILTERS.forEach(function (f) {
    var mn = parseFloat(($('#f-' + f[0] + '-min') || {}).value);
    var mx = parseFloat(($('#f-' + f[0] + '-max') || {}).value);
    var o = {};
    if (!isNaN(mn)) o.min = mn;
    if (!isNaN(mx)) o.max = mx;
    if (o.min != null || o.max != null) out[f[0]] = o;
  });
  store.set(LS.filters, out);
  return out;
}

/* Where each filter key reads from in a snapshot row. */
function fieldValue(row, key) {
  switch (key) {
    case 'score': return row.sc ? row.sc.total : null;
    case 'mcapB': return row.mcap != null ? row.mcap / 1e9 : null;
    case 'pe': return row.pe;
    default:
      if (row.f && row.f[key] != null) return row.f[key];
      if (row.t && row.t[key] != null) return row.t[key];
      return null;
  }
}

function runScreen() {
  var box = $('#screenResults');
  if (!SNAP) { box.innerHTML = '<div class="msg">הנתונים עדיין נטענים…</div>'; return; }

  var flt = readFilters();
  var idxKeys = Object.keys(availableIndices());
  var idx = store.get(LS.idx, idxKeys).filter(function (k) {
    return idxKeys.indexOf(k) >= 0;
  });
  if (!idx.length) idx = idxKeys;

  // No sector selected means no sector constraint, not "exclude everything".
  var secKeys = Object.keys(availableSectors());
  var sectors = store.get(LS.sectors, []).filter(function (k) {
    return secKeys.indexOf(k) >= 0;
  });

  var fields = Object.keys(flt);

  var hits = SNAP.rows.filter(function (r) {
    var inIdx = (r.i || []).some(function (m) { return idx.indexOf(m) >= 0; });
    if (!inIdx) return false;
    if (sectors.length && sectors.indexOf(r.sec) < 0) return false;
    for (var i = 0; i < fields.length; i++) {
      var k = fields[i], c = flt[k], v = fieldValue(r, k);
      if (v == null) return false;
      if (c.min != null && v < c.min) return false;
      if (c.max != null && v > c.max) return false;
    }
    return true;
  });

  hits.sort(function (a, b) {
    var sa = (a.sc && a.sc.total) || 0, sb = (b.sc && b.sc.total) || 0;
    return sb - sa;
  });

  if (!hits.length) {
    box.innerHTML = '<div class="card-h"><span>תוצאות</span></div>' +
      '<div class="msg">אף מניה לא עברה את הסינון. נסה להרחיב את הטווחים.</div>';
    return;
  }

  var shown = hits.slice(0, 60);
  box.innerHTML = '<div class="card-h"><span>תוצאות</span>' +
    '<span class="sub">' + hits.length + ' מניות' +
    (hits.length > shown.length ? ' · מוצגות ' + shown.length : '') + '</span></div>' +
    shown.map(function (r, n) {
      var sc = r.sc ? r.sc.total : null;
      var t = r.t || {};
      // Capped so a 60-row result set does not trail in for four seconds.
      var delay = Math.min(n, 14) * 28;
      return '<button class="hit" style="animation-delay:' + delay +
        'ms" onclick="analyze(\'' + r.s + '\')">' +
        '<span class="hit-score" style="background:' + scoreColor(sc) +
          '22;color:' + scoreColor(sc) + '">' + (sc == null ? '—' : sc) + '</span>' +
        '<span class="hit-id">' +
          '<span class="sym">' + r.s + '</span>' +
          '<span class="nm">' + esc(r.n || '') + '</span>' +
          '<span class="mini">' + big(r.mcap) + ' · מכפיל ' +
            (r.pe ? num(r.pe, 1) : '—') + '</span>' +
        '</span>' +
        '<span class="hit-px">' +
          '<span class="pr">' + money(t.price) + '</span>' +
          '<span class="d ' + cls(t.chg12m) + '">' + pct(t.chg12m, 0) +
            ' שנה</span>' +
        '</span></button>';
    }).join('');
}

/* ------------------------------------------------------------------ home */
/* Where these numbers come from, after measuring rather than assuming:

   - Yahoo sets no CORS headers, so the page can only reach it through public
     CORS proxies. All three failed at once (two timed out, corsproxy.io now
     wants a paid key) and they flap in and out hour to hour.
   - Nasdaq answers a server perfectly but also sends no CORS header, so a
     browser is never allowed to read its response. Reachable and readable are
     different things; assuming otherwise is what made the tiles sit blank.

   So the five tiles that have a liquid ETF tracking them are fetched on a
   runner by scripts/build_tickers.py, committed as data/tickers.json, and
   read from there - same origin, no CORS, the shape data/screener.json has
   always used. They refresh with the alert check, every 15 minutes while the
   market is open. The price shown is the fund's, not the index level, which
   is why each label carries its ETF ticker.

   VIX and USD/ILS have no such ETF and no server-side source that answers a
   runner either, so they stay on the Yahoo path and show nothing whenever the
   proxies are down - an honest "no source" rather than a wrong number.

   Row shape: [symbol, label, decimals, source], source 'file' (data/tickers.json)
   or 'yahoo' (through fetchRaw's proxy chain). */
var TICKERS = [
  ['SPY', 'S&P 500 (SPY)', 2, 'file'],
  ['QQQ', 'נאסד״ק (QQQ)', 2, 'file'],
  ['^VIX', 'VIX', 2, 'yahoo'],
  ['IBIT', 'ביטקוין (IBIT)', 2, 'file']
];
var TICKERS_MINI = [
  ['USDILS=X', 'דולר / שקל', 3, 'yahoo'],
  ['GLD', 'זהב (GLD)', 2, 'file'],
  ['USO', 'נפט (USO)', 2, 'file']
];

function tkId(sym) { return 'tk-' + sym.replace(/[^A-Za-z0-9]/g, ''); }

/* The indices used to be fetched exactly once and latched behind
   dataset.loaded, so an app left open across the opening bell showed
   pre-market numbers for the rest of the day. The tiles are still built once;
   the quotes behind them now refresh. */
var TICKERS_TTL = 60000;
var TICKERS_AT = 0;    // when the last round went out, for the TTL
var TICKERS_OK = 0;    // when a quote last actually landed, for the stamp
var MKT_STATE = '';
/* Last quote seen for each symbol, kept past a reload. Yahoo is reached only
   through public CORS proxies (codetabs, allorigins, corsproxy.io) that can
   all be down at once - when that happens, a fresh page load should still
   show the last real numbers instead of a blank skeleton. */
var TK_CACHE = store.get(LS.tk, {});

/* Yahoo reports state as an all-caps enum (REGULAR, PRE, POST, CLOSED, ...);
   Nasdaq reports it as a capitalized phrase ("Open", "Closed", ...). Match
   both by substring on the lowercased value instead of keeping two lookup
   tables in sync with whichever source happens to answer this round. */
function marketStateLabel(raw) {
  var s = String(raw || '').toLowerCase();
  if (!s) return '';
  /* Checked before the plain pre/post match below: Yahoo's PREPRE and
     POSTPOST mean the market is fully closed, outside even the extended
     session - not "still in pre-market"/"still after hours". */
  if (s === 'prepre' || s === 'postpost' || s.indexOf('closed') >= 0) {
    return 'השוק סגור';
  }
  if (s.indexOf('pre') >= 0) return 'טרום מסחר';
  if (s.indexOf('after') >= 0 || s.indexOf('post') >= 0) return 'אחרי הנעילה';
  if (s.indexOf('open') >= 0 || s === 'regular') return 'השוק פתוח';
  return '';
}

function buildTickers() {
  var box = $('#tickers');
  if (!box) return false;
  if (box.dataset.built) return true;
  var tile = function (t, cl) {
    return '<div class="' + cl + '" id="' + tkId(t[0]) + '">' +
      '<span class="nm">' + t[1] + '</span>' +
      '<span class="skel"></span></div>';
  };
  box.innerHTML = TICKERS.map(function (t) { return tile(t, 'tk'); }).join('');
  $('#tickersMini').innerHTML =
    TICKERS_MINI.map(function (t) { return tile(t, 'tk tk-mini'); }).join('');
  box.dataset.built = '1';

  /* Paint whatever was cached before the network round even starts. A page
     opened while every proxy happens to be down should show the last real
     numbers, not a bare skeleton - loadTickers corrects them moments later
     if the network is fine. */
  var newest = 0;
  TICKERS.concat(TICKERS_MINI).forEach(function (t) {
    var c = TK_CACHE[t[0]];
    if (!c) return;
    paintTicker(t, { price: c.p, chgPct: c.c });
    if (c.t > newest) newest = c.t;
  });
  if (newest) markFresh(newest);
  return true;
}

/* Replaces the tile outright. The old code appended to innerHTML, which was
   only safe because it ran once - on a refresh it would have stacked a second
   price alongside the first. */
function paintTicker(t, q) {
  var el = $('#' + tkId(t[0]));
  if (!el) return;
  var had = el.querySelector('.val');
  var name = '<span class="nm">' + t[1] + '</span>';

  if (!q || q.price == null) {
    /* Keep the last good number rather than blanking a tile that was working:
       a failed refresh is not the same as no data, and the stamp above the
       grid is what tells the user the numbers have stopped moving. */
    if (!had) el.innerHTML = name + '<span class="val">—</span>';
    return;
  }

  var was = had ? parseFloat(had.textContent.replace(/[^\d.-]/g, '')) : NaN;
  el.innerHTML = name +
    '<span class="val">' + num(q.price, t[2]) + '</span>' +
    '<span class="ch ' + cls(q.chgPct) + '">' + pct(q.chgPct, 1) + '</span>';
  if (!isNaN(was) && Math.abs(was - q.price) > 1e-9) tickFlash(el, q.price > was);
}

/* A tick you can see. Without it there is no way to tell a live number that
   happened to land on the same digits from a frozen one. */
function tickFlash(el, up) {
  el.classList.remove('tick-up', 'tick-dn');
  void el.offsetWidth;                       // restart the animation
  el.classList.add(up ? 'tick-up' : 'tick-dn');
}

function loadTickers(force) {
  if (!buildTickers()) return;
  var now = Date.now();
  if (!force && TICKERS_AT && now - TICKERS_AT < TICKERS_TTL) return;
  TICKERS_AT = now;                          // claim the slot before awaiting

  /* One request covers every file-backed tile, so the whole S&P/Nasdaq/
     bitcoin/gold/oil row costs a single same-origin GET that cannot be
     blocked by CORS or refused by somebody else's proxy. */
  loadTickerFile(true);   // loadTickers has already applied its own TTL

  /* Only the tiles with no server-side source left - VIX and USD/ILS - still
     go out through the proxy chain, spread apart so a proxy that does answer
     is not rate-limited by our own burst. */
  var live = TICKERS.concat(TICKERS_MINI).filter(function (t) {
    return t[3] === 'yahoo';
  });
  var ok = 0, done = 0;
  live.forEach(function (t, i) {
    setTimeout(function () {
      yahooQuote(t[0]).then(function (q) {
        paintTicker(t, q);
        if (q && q.price != null) {
          ok++;
          TK_CACHE[t[0]] = { p: q.price, c: q.chgPct, t: Date.now() };
          try { store.set(LS.tk, TK_CACHE); } catch (e) {}
          markFresh();
        }
      }).catch(function () { paintTicker(t, null); }).then(function () {
        done++;
        if (done < live.length) return;
        /* Every proxy failed for every symbol - in practice a passing hiccup
           rather than a lasting outage. Retry well before the normal 60s TTL
           rather than leaving stale numbers up for the rest of the minute. */
        if (!ok) { TICKERS_AT = 0; setTimeout(function () { loadTickers(false); }, 15000); }
      });
    }, i * 220);
  });
  paintMktState();
}

/* Records that a quote landed, without ever moving the stamp backwards: the
   file's own timestamp and a live proxy quote can arrive in either order, and
   the stamp should always report the freshest thing on screen. */
function markFresh(at) {
  var t = at || Date.now();
  if (t > TICKERS_OK) TICKERS_OK = t;
  paintMktState();
}

/* Every symbol a runner prices for us. Same origin, so this is the one
   request on the home screen that no proxy outage and no CORS policy can
   break.

   checkAlerts calls this too, and it is called on every tab change, poll and
   wake - so repeated calls inside FILE_TTL share one download rather than
   each starting their own. */
var FILE_TTL = 30000;
var FILE_AT = 0;
var FILE_PENDING = null;

function loadTickerFile(force) {
  if (!force) {
    if (FILE_PENDING) return FILE_PENDING;
    if (FILE_AT && Date.now() - FILE_AT < FILE_TTL) return Promise.resolve(null);
  }
  FILE_PENDING = loadTickerFileNow().then(function (d) {
    FILE_PENDING = null;
    FILE_AT = Date.now();
    return d;
  }, function (e) {
    FILE_PENDING = null;
    throw e;
  });
  return FILE_PENDING;
}

function loadTickerFileNow() {
  return fetch('data/tickers.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      var quotes = (d && d.quotes) || {};
      /* The file's own timestamp, not the moment it was downloaded: it is
         rebuilt every fifteen minutes, so reporting the fetch time would
         claim a freshness the numbers do not have. */
      var at = d && d.generated ? Date.parse(d.generated) : NaN;
      if (isNaN(at)) at = Date.now();

      TICKERS.concat(TICKERS_MINI).forEach(function (t) {
        if (t[3] !== 'file') return;
        var q = quotes[t[0]];
        if (!q || q.p == null) { paintTicker(t, null); return; }
        paintTicker(t, { price: q.p, chgPct: q.c });
        TK_CACHE[t[0]] = { p: q.p, c: q.c, t: at };
      });
      try { store.set(LS.tk, TK_CACHE); } catch (e) {}

      /* The file carries the watchlist and open trades as well, so the same
         download that paints the tiles also prices everything else on screen.
         Only filled in where a live quote has not already beaten it, since a
         proxy that happens to be working is fresher than a file rebuilt every
         fifteen minutes. */
      var painted = false;
      watchedSymbols().forEach(function (sym) {
        var q = quotes[sym];
        if (!q || q.p == null) return;
        if (PRICE_AT[sym] && PRICE_AT[sym] > at) return;
        ALERT_PRICES[sym] = q.p;
        PRICE_AT[sym] = at;
        painted = true;
      });
      if (painted) { renderAlerts(); paintTrades(); renderWatchlist(); }

      if (d && d.marketStatus) MKT_STATE = d.marketStatus;
      markFresh(at);
      return d;
    })
    .catch(function () {
      /* Nothing to repaint: whatever the cache put on screen at build time
         stays, and the stamp keeps reporting its real age. */
      return null;
    });
}

/* The old stamp was written the moment the requests went out, so it read
   "updated 16:31" beside numbers that had never arrived - a fresh-looking
   time next to stale prices. It now reports when a quote last landed, and
   says plainly when that has stopped happening. */
function paintMktState() {
  var el = $('#mktState');
  if (!el) return;
  if (!TICKERS_OK) { el.textContent = 'טוען…'; return; }
  var txt = marketStateLabel(MKT_STATE);
  txt += (txt ? ' · ' : '') + 'עודכן ' +
    new Date(TICKERS_OK).toLocaleTimeString('he-IL',
      { hour: '2-digit', minute: '2-digit' });
  if (Date.now() - TICKERS_OK > 4 * TICKERS_TTL) txt += ' · לא מתעדכן';
  el.textContent = txt;
}

/* Market breadth, derived from the nightly snapshot.
   How many of the ~500 companies are above their own moving averages says more
   about the market's health than the index level does, because a handful of
   very large companies can carry an index while most of it falls. Costs
   nothing: every input is already in the snapshot. */
function renderBreadth() {
  var el = $('#breadth');
  if (!el) return;
  if (!SNAP || !SNAP.rows.length) {
    el.innerHTML = '<div class="msg">אין נתונים.</div>';
    return;
  }
  var rows = SNAP.rows.filter(function (r) { return r.t && r.t.price != null; });
  $('#bdCount').textContent = rows.length;

  var share = function (test) {
    var have = rows.filter(function (r) { return test(r) !== null; });
    if (!have.length) return null;
    var yes = have.filter(function (r) { return test(r) === true; });
    return (yes.length / have.length) * 100;
  };
  var above = function (key) {
    return function (r) {
      if (r.t[key] == null || r.t.price == null) return null;
      return r.t.price > r.t[key];
    };
  };

  var m50 = share(above('ma50'));
  var m200 = share(above('ma200'));
  var up = share(function (r) {
    return r.t.chg1d == null ? null : r.t.chg1d > 0;
  });
  var near = share(function (r) {
    return r.t.from52High == null ? null : r.t.from52High > -2;
  });

  var bar = function (label, v, note) {
    if (v == null) return '';
    var col = v >= 60 ? 'var(--ok)' : v >= 40 ? 'var(--watch)' : 'var(--alert)';
    return '<div class="bd-row">' +
      '<span class="bd-lb">' + label + '</span>' +
      '<span class="bd-track"><i class="bd-fill" data-w="' + v.toFixed(0) +
        '" style="width:0;background:' + col + '"></i></span>' +
      '<span class="bd-vl">' + v.toFixed(0) + '%</span></div>';
  };

  var tone = m200 == null ? null
    : m200 >= 60 ? ['רחב וחיובי', 'רוב המניות מעל הממוצע ארוך הטווח שלהן.']
    : m200 >= 40 ? ['מעורב', 'השוק חצוי בין מגמה עולה ליורדת.']
    : ['צר ושלילי', 'רוב המניות מתחת לממוצע ארוך הטווח שלהן.'];

  el.innerHTML =
    bar('מעל ממוצע 50', m50) +
    bar('מעל ממוצע 200', m200) +
    bar('עלו היום', up) +
    bar('קרוב לשיא שנתי', near) +
    (tone ? '<div class="bd-sum"><b>' + tone[0] + '</b> · ' + tone[1] + '</div>' : '');
  paintBars(el, true);
}

/* What moved since the previous nightly run.

   The diff itself is computed by the build job, which is the only place that
   ever holds two snapshots at once - the device only has today's. */
function renderChanges() {
  var el = $('#changes');
  var since = $('#chgSince');
  if (!el) return;
  if (!SNAP) { el.innerHTML = '<div class="msg">טוען…</div>'; return; }

  var c = SNAP.changes;
  if (!c) {
    if (since) since.textContent = '';
    el.innerHTML = '<div class="msg">ההשוואה תופיע אחרי הסריקה הבאה — ' +
      'צריך שתי סריקות כדי לדעת מה השתנה.</div>';
    return;
  }
  if (since && c.since) {
    since.textContent = 'מאז ' + new Date(c.since).toLocaleDateString('he-IL',
      { day: 'numeric', month: 'short' });
  }

  var chips = function (list) {
    return '<div class="chips">' + list.map(function (s) {
      return '<button class="chip" onclick="analyze(\'' + esc(s) + '\')">' +
        esc(s) + '</button>';
    }).join('') + '</div>';
  };

  var block = function (title, body, tone) {
    return '<div class="chg-b' + (tone ? ' ' + tone : '') + '">' +
      '<div class="chg-t">' + title + '</div>' + body + '</div>';
  };

  var out = '';

  if (c.score && c.score.length) {
    out += block('שינויי ציון', '<div class="chg-rows">' +
      c.score.map(function (m) {
        var d = m.b - m.a;
        return '<button class="chg-r" onclick="analyze(\'' + esc(m.s) + '\')">' +
          '<span class="sym">' + esc(m.s) + '</span>' +
          // The span is direction:ltr, so these lay out old, arrow, new from
          // the left - the arrow has to point right to read old -> new.
          '<span class="mv"><span class="a">' + m.a + '</span>' +
            '<span class="ar">→</span>' +
            '<span class="b" style="color:' + scoreColor(m.b) + '">' + m.b +
            '</span></span>' +
          '<span class="dl ' + cls(d) + '">' + (d > 0 ? '+' : '') + d +
          '</span></button>';
      }).join('') + '</div>');
  }

  if (c.maUp && c.maUp.length) {
    out += block('חצו מעל ממוצע 200', chips(c.maUp), 'up');
  }
  if (c.maDown && c.maDown.length) {
    out += block('חצו מתחת לממוצע 200', chips(c.maDown), 'down');
  }
  if (c.hi52 && c.hi52.length) {
    out += block('שיא 52 שבועות חדש', chips(c.hi52), 'up');
  }
  if (c.lo52 && c.lo52.length) {
    out += block('שפל 52 שבועות חדש', chips(c.lo52), 'down');
  }

  el.innerHTML = out ||
    '<div class="msg">אין שינויים בולטים מאז הסריקה הקודמת.</div>';
}

/* ---------------------------------------------------------- folding ---- */
/* Sections that are reference material rather than something you read every
   time. Collapsed by default and remembered, so the page stays short. */
function foldOpen(key, dflt) {
  var f = store.get(LS.folds, {});
  return f[key] === undefined ? !!dflt : !!f[key];
}

function toggleFold(key) {
  var el = $('#fold-' + key);
  if (!el) return;
  var open = !el.classList.contains('open');
  el.classList.toggle('open', open);
  var btn = document.querySelector('[data-fold="' + key + '"]');
  if (btn) btn.classList.toggle('open', open);
  var f = store.get(LS.folds, {});
  f[key] = open;
  store.set(LS.folds, f);
}

/* Applies the remembered state to a fold that has just been rendered. */
function applyFold(key, dflt) {
  var el = $('#fold-' + key);
  var btn = document.querySelector('[data-fold="' + key + '"]');
  var open = foldOpen(key, dflt);
  if (el) el.classList.toggle('open', open);
  if (btn) btn.classList.toggle('open', open);
}

/* Reports due in the next week, from dates already in the snapshot. */
function renderEarningsSoon(days) {
  var el = $('#earnSoon');
  if (!el) return;
  if (!SNAP) { el.innerHTML = '<div class="msg">טוען…</div>'; return; }
  days = days || 7;

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var list = [];
  SNAP.rows.forEach(function (r) {
    if (!r.er || !r.er.d) return;
    var d = new Date(r.er.d + 'T12:00:00');
    if (isNaN(d)) return;
    // The report date is anchored at noon to dodge DST, so the gap from
    // midnight today is always X.5 days - rounding turns tomorrow into two
    // days away. Floor is what counts whole days here.
    var n = Math.floor((d - today) / 86400000);
    if (n < 0 || n > days) return;
    list.push({ r: r, d: d, n: n });
  });

  if (!list.length) {
    el.innerHTML = '<div class="msg">אין דוחות מתוכננים בשבוע הקרוב ' +
      'מבין המניות הנסרקות.</div>';
    return;
  }
  list.sort(function (a, b) {
    if (a.n !== b.n) return a.n - b.n;
    return (b.r.mcap || 0) - (a.r.mcap || 0);
  });

  var when = function (n) {
    return n === 0 ? 'היום' : n === 1 ? 'מחר' : 'בעוד ' + n + ' ימים';
  };
  var slot = function (t) {
    return t === 'pre' ? 'לפני הפתיחה' : t === 'post' ? 'אחרי הנעילה' : '';
  };

  /* Grouped by day and folded away. A flat list of thirty companies pushed
     everything below it off the page, for something that gets looked up
     rather than read. */
  var order = [];
  var byDay = {};
  list.forEach(function (x) {
    if (!byDay[x.n]) { byDay[x.n] = []; order.push(x.n); }
    byDay[x.n].push(x);
  });

  el.innerHTML = order.map(function (n) {
    var group = byDay[n];
    var d = group[0].d;
    var key = 'ern' + n;
    return '<div class="day">' +
      '<button class="day-h' + (n <= 1 ? ' soon' : '') + '" data-fold="' +
        key + '" onclick="toggleFold(\'' + key + '\')">' +
        '<span class="day-n">' + when(n) + '</span>' +
        '<span class="day-d">' +
          d.toLocaleDateString('he-IL', { weekday: 'long' }) + ' · ' +
          d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }) +
        '</span>' +
        '<span class="day-c">' + group.length + '</span>' +
        '<i class="chev"></i>' +
      '</button>' +
      '<div class="fold" id="fold-' + key + '"><div>' +
        group.map(function (x) {
          var r = x.r, sl = slot(r.er.t);
          return '<button class="ern" onclick="analyze(\'' + esc(r.s) + '\')">' +
            '<span class="ern-id">' +
              '<span class="sym">' + esc(r.s) + '</span>' +
              '<span class="nm">' + esc(r.n || '') + '</span>' +
              '<span class="mini">' + (sl || '—') +
                (r.er.eps ? ' · צפי ' + esc(r.er.eps) : '') + '</span>' +
            '</span>' +
            '<span class="ern-sc" style="color:' +
              scoreColor(r.sc && r.sc.total) + '">' +
              ((r.sc && r.sc.total != null) ? r.sc.total : '—') +
            '</span>' +
            '</button>';
        }).join('') +
      '</div></div>' +
      '</div>';
  }).join('');

  // Closed unless opened before; today and tomorrow start open.
  order.forEach(function (n) { applyFold('ern' + n, n <= 1); });
}

/* Kept as the single place that reports snapshot trouble. The card it used to
   write into moved into the settings sheet, so it only renders when that sheet
   is open; a load error is also surfaced on the market page below. */
function renderDataStatus(err, isCache) {
  if (err) {
    var bd = $('#breadth');
    if (bd) {
      bd.innerHTML = '<div class="msg err">לא הצלחנו לטעון את בסיס הנתונים: ' +
        esc(err) + '<br><button class="chip" style="margin-top:8px" ' +
        'onclick="refreshSnapshot()">נסה שוב</button></div>';
    }
  }
  var box = $('#dataStatus');
  if (!box) return;
  if (err) {
    box.innerHTML = '<div class="msg err">לא הצלחנו לטעון את בסיס הנתונים: ' +
      esc(err) + '</div>';
    return;
  }
  var gen = SNAP && SNAP.generated ? SNAP.generated.replace('T', ' ').slice(0, 16) : '—';
  var scored = SNAP ? SNAP.rows.filter(function (r) {
    return r.sc && r.sc.total != null;
  }).length : 0;
  box.innerHTML =
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">מניות במאגר</span>' +
      '<span class="vl">' + (SNAP ? SNAP.rows.length : 0) + '</span></div>' +
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">עם ציון מלא</span>' +
      '<span class="vl">' + scored + '</span></div>' +
    '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">עודכן</span>' +
      '<span class="vl">' + esc(gen) + '</span></div>' +
    (isCache ? '<div class="score-note" style="margin-top:8px">מוצג מהמטמון המקומי.</div>' : '');
}

function openSettings() {
  CUR = null;
  var gen = SNAP && SNAP.generated
    ? SNAP.generated.replace('T', ' ').slice(0, 16) : '—';
  var scored = SNAP ? SNAP.rows.filter(function (r) {
    return r.sc && r.sc.total != null;
  }).length : 0;
  var sectors = SNAP ? SNAP.rows.filter(function (r) { return r.sec; }).length : 0;

  // The asset version is worth surfacing: a stale copy is the failure mode
  // this app has hit most, and it is invisible otherwise.
  var ver = '—';
  try {
    var src = document.querySelector('script[src*="app.js"]');
    var m = src && /[?&]v=([0-9a-f]+)/.exec(src.getAttribute('src'));
    if (m) ver = m[1];
  } catch (e) {}

  var row = function (k, v) {
    return '<div class="mrow" style="grid-template-columns:1fr auto">' +
      '<span class="lb">' + k + '</span><span class="vl">' + v + '</span></div>';
  };

  $('#sheetBody').innerHTML =
    '<div class="card">' +
      '<div class="card-h"><span>הגדרות</span>' +
        '<button class="icon-btn" onclick="closeSheet()" aria-label="סגור">' +
        '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        '</button></div>' +
      '<div class="mtable">' +
        row('מניות במאגר', SNAP ? SNAP.rows.length : 0) +
        row('עם ציון מלא', scored) +
        row('עם סקטור', sectors) +
        row('המאגר עודכן', esc(gen)) +
        row('גרסת האפליקציה', esc(ver)) +
      '</div>' +
      '<div class="score-note" style="margin-top:10px">המאגר נבנה כל לילה ' +
        'מדוחות שהוגשו ל־SEC. המחירים החיים נמשכים מהמכשיר.</div>' +
    '</div>' +
    renderAlertsSync() +
    '<div class="card">' +
      '<div class="card-h"><span>פעולות</span></div>' +
      '<button class="btn" onclick="refreshSnapshot()">רענן את המאגר</button>' +
      '<div class="score-note" style="margin:8px 0 14px">מוריד מחדש את ' +
        'נתוני הסריקה האחרונים.</div>' +
      '<button class="btn ghost" onclick="clearCache()">נקה מטמון וטען מחדש</button>' +
      '<div class="score-note" style="margin-top:8px">אם האפליקציה נראית ' +
        'ישנה אחרי עדכון — זה מה שפותר.</div>' +
    '</div>';
  openSheet();
  $('.modal-sheet').scrollTop = 0;
  // Clears the .quiet flag a previous analysis render may have left behind,
  // which would otherwise suppress this sheet's card stagger.
  runSheetIntro(true);
  paintSync();
}

/* Getting the alerts off the phone.
 *
 * Alerts live in localStorage, so the scheduled checker on the runner cannot
 * see them - it reads data/alerts.json in the repo instead. There is no server
 * to sync through and no way to hold a write token in a public page, so the
 * handoff is a copy and a paste. Only needed when the alert list changes. */
var REPO_EDIT_URL =
  'https://github.com/eladnizri/Stocksapp/edit/main/data/alerts.json';

function alertsSyncJson() {
  var list = store.get(LS.alerts, []).map(function (a) {
    var o = { s: a.s, d: a.d, p: a.p };
    // Carried through so the trade an alert belongs to survives a round trip
    // to GitHub and back. The checker reads only s, d and p and ignores these.
    if (a.tid) { o.tid = a.tid; o.kind = a.kind; }
    return o;
  });

  /* Everything below this line is a one-way hint to the runner, never read
     back by pullAlerts: the phone stays authoritative for its own watchlist
     and trades, which are far richer locally (notes, tags, high-water marks)
     than anything worth round-tripping. The runner needs only enough to know
     which symbols to price and what to say in the daily report. */
  var positions = openTrades().map(function (t) {
    return { s: t.s, entry: t.entry, qty: t.qty || null, stop: t.stop,
             target: t.target == null ? null : t.target };
  });

  return JSON.stringify({
    alerts: list,
    watch: watchlist(),
    positions: positions
  }, null, 2);
}

function copyAlertsJson() {
  var txt = alertsSyncJson();
  var note = $('#syncNote');
  var done = function (okMsg) {
    if (note) {
      note.textContent = okMsg;
      note.style.color = 'var(--primary-500)';
    }
    haptic(12);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(function () {
      done('הועתק. עכשיו הדבק בקובץ ב־GitHub.');
    }).catch(function () { selectAlertsJson(); });
  } else {
    selectAlertsJson();
  }
}

/* Clipboard access can be refused (an insecure context, or a browser that
   simply says no). Selecting the text leaves the user one long-press from
   copying it by hand rather than stranded. */
function selectAlertsJson() {
  var el = $('#syncBox');
  var note = $('#syncNote');
  if (!el) return;
  try {
    var r = document.createRange();
    r.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (e) {}
  if (note) {
    note.textContent = 'סומן — לחץ ארוך והעתק.';
    note.style.color = 'var(--watch)';
  }
}

/* ------------------------------------------------- automatic sync ------ */
/* With a token present the app writes data/alerts.json itself, so adding an
   alert is the whole job and nothing has to be pasted anywhere. The token is
   the user's own, lives only in this browser, and is never committed - a
   public page cannot hold a shared secret, so a per-device token is the only
   shape this can take without a server. */
var GH_REPO = 'eladnizri/Stocksapp';
var GH_PATH = 'data/alerts.json';
var GH_REPO_API = 'https://api.github.com/repos/' + GH_REPO;
var GH_API = GH_REPO_API + '/contents/' + GH_PATH;
var GH_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

function ghToken() { return store.get(LS.gh, '') || ''; }

/* btoa is byte-oriented and throws on anything outside latin-1. The payload
   is ASCII today, but a symbol is user input and need not stay that way. */
function b64encode(str) {
  var bytes = new TextEncoder().encode(str);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out);
}
function b64decode(b64) {
  var bin = atob((b64 || '').replace(/\s/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/* GitHub's status codes each mean something specific and actionable here, so
   they are translated rather than surfaced as a bare number. */
function ghError(status) {
  var m =
    status === 401 ? 'הטוקן לא תקף או שפג תוקפו' :
    status === 403 ? 'לטוקן אין הרשאת כתיבה (Contents: read and write)' :
    status === 404 ? 'ה־repo לא נמצא — ודא שהטוקן משויך ל־Stocksapp' :
    status === 409 ? 'הקובץ השתנה בינתיים' :
    status === 422 ? 'GitHub דחה את התוכן' :
    'שגיאה מ־GitHub (' + status + ')';
  var e = new Error(m);
  e.status = status;
  return e;
}

function ghGet(token) {
  return fetch(GH_API + '?t=' + Date.now(),
               { headers: ghHeaders(token), cache: 'no-store' })
    .then(function (r) {
      // A missing file is a normal first-run state, not a failure.
      if (r.status === 404) return { sha: null, text: null, missing: true };
      if (!r.ok) throw ghError(r.status);
      return r.json().then(function (d) {
        return { sha: d.sha, text: b64decode(d.content || '') };
      });
    });
}

/* Checks a token against the repository itself rather than the alerts file.
   GitHub answers 404 both for a file that does not exist yet and for a repo
   the token cannot see, so verifying against the file would accept a token
   scoped to the wrong repository. The repo endpoint has no such ambiguity. */
function ghVerify(token) {
  return fetch(GH_REPO_API + '?t=' + Date.now(),
               { headers: ghHeaders(token), cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw ghError(r.status);
      return r.json();
    })
    .then(function (d) {
      // Present for fine-grained tokens; absent rather than false when the
      // API does not report it, so this only rejects a definite "no".
      if (d && d.permissions && d.permissions.push === false) {
        throw ghError(403);
      }
      return true;
    });
}

function ghPut(token, text, sha) {
  var body = { message: 'Update alerts from the app', content: b64encode(text) };
  if (sha) body.sha = sha;
  return fetch(GH_API, {
    method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) throw ghError(r.status);
    return r.json();
  });
}

var SYNC = { state: 'none', msg: '' };   // none | syncing | ok | err

function paintSync() {
  var map = {
    none: ['', ''],
    syncing: ['מסנכרן…', 'var(--ink-2)'],
    ok: [SYNC.msg || 'מסונכרן', 'var(--primary-500)'],
    err: [SYNC.msg || 'הסנכרון נכשל', 'var(--alert)']
  };
  var v = map[SYNC.state] || ['', ''];
  ['#syncState', '#syncStateWatch'].forEach(function (sel) {
    var el = $(sel);
    if (!el) return;
    el.textContent = v[0];
    el.style.color = v[1];
  });
}

/* Writes the current alert list to the repo. Resolves false when there is no
   token, which is the signal to fall back to copy and paste. */
function syncAlerts() {
  var token = ghToken();
  if (!token) { SYNC = { state: 'none' }; paintSync(); return Promise.resolve(false); }

  var want = alertsSyncJson() + '\n';
  SYNC = { state: 'syncing' }; paintSync();

  var attempt = function (isRetry) {
    return ghGet(token).then(function (cur) {
      // Nothing to say to GitHub if the file already matches; this also keeps
      // a re-opened settings sheet from making an empty commit.
      if (cur.text != null && cur.text.trim() === want.trim()) {
        store.set(LS.dirty, false);
        SYNC = { state: 'ok', msg: 'מסונכרן' };
        paintSync();
        return true;
      }
      return ghPut(token, want, cur.sha).then(function () {
        store.set(LS.dirty, false);
        SYNC = { state: 'ok', msg: 'סונכרן ' + nowHM() };
        paintSync();
        return true;
      });
    }).catch(function (e) {
      // Someone else wrote the file between the read and the write; the
      // second pass picks up the new sha.
      if (e.status === 409 && !isRetry) return attempt(true);
      SYNC = { state: 'err', msg: e.message };
      paintSync();
      return false;
    });
  };
  return attempt(false);
}

function nowHM() {
  return new Date().toLocaleTimeString('he-IL',
    { hour: '2-digit', minute: '2-digit' });
}

/* Adopts the list from the repo.
 *
 * This runs on open, and pushing there instead was a real bug: any copy of the
 * app that opened holding an older list would overwrite the repo with it, so
 * an alert added on one device was reverted seconds later by another. The repo
 * is the shared copy and the one the checker reads, so it wins - which also
 * means an alert added on the phone now shows up everywhere else. A local
 * change that has not reached GitHub yet is marked dirty and pushed instead,
 * so nothing made offline is thrown away. */
function pullAlerts() {
  var token = ghToken();
  if (!token) return Promise.resolve(false);

  SYNC = { state: 'syncing' }; paintSync();
  return ghGet(token).then(function (cur) {
    if (cur.text == null) {          // no file yet: local is all there is
      return syncAlerts();
    }
    var remote;
    try { remote = JSON.parse(cur.text); }
    catch (e) { throw new Error('הקובץ ב־GitHub לא תקין'); }

    var list = (remote && remote.alerts) || [];
    var clean = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.s) continue;
      var p = parseFloat(a.p);
      if (isNaN(p) || p <= 0) continue;
      if (a.d !== 'above' && a.d !== 'below') continue;
      var row = { s: String(a.s).toUpperCase(), d: a.d, p: p, t: Date.now() };
      if (a.tid) { row.tid = a.tid; row.kind = a.kind; }
      clean.push(row);
    }

    var before = alertsSyncJson();
    store.set(LS.alerts, clean);
    store.set(LS.dirty, false);
    if (alertsSyncJson() !== before) {
      renderAlerts();
      checkAlerts(false);
    }
    SYNC = { state: 'ok', msg: 'מסונכרן' };
    paintSync();
    return true;
  }).catch(function (e) {
    SYNC = { state: 'err', msg: e.message };
    paintSync();
    return false;
  });
}

/* Adding three alerts in a row should be one commit, not three. */
var syncTimer = null;
function queueSync() {
  if (!ghToken()) return;
  // Marked before the debounce, so a copy closed mid-wait still knows on the
  // next open that it holds a change GitHub has not seen.
  store.set(LS.dirty, true);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { syncAlerts(); }, 1200);
}

function saveGhToken() {
  var el = $('#ghTok');
  var note = $('#ghNote');
  var v = (el && el.value || '').trim();
  if (!v) return;
  if (note) { note.textContent = 'בודק את הטוקן…'; note.style.color = 'var(--ink-2)'; }
  // Verified before it is stored, so a bad paste is caught here rather than
  // silently failing on the next alert.
  ghVerify(v).then(function () {
    store.set(LS.gh, v);
    haptic(12);
    return syncAlerts();
  }).then(function () {
    openSettings();
  }).catch(function (e) {
    if (note) { note.textContent = e.message; note.style.color = 'var(--alert)'; }
  });
}

function clearGhToken() {
  store.set(LS.gh, '');
  SYNC = { state: 'none' };
  openSettings();
}

function renderAlertsSync() {
  var n = store.get(LS.alerts, []).length;
  var connected = !!ghToken();

  var head = '<div class="card-h"><span>סנכרון התראות</span>' +
    '<span class="sub" id="syncState"></span></div>';

  if (connected) {
    return '<div class="card">' + head +
      '<div class="score-note" style="margin-bottom:11px">מחובר ל־GitHub. ' +
        n + ' התראות נכתבות אוטומטית ל־<b>data/alerts.json</b> בכל שינוי, ' +
        'ונבדקות כל 15 דקות בשעות המסחר — גם כשהאפליקציה סגורה.</div>' +
      '<div class="frow">' +
        '<button class="btn" onclick="syncAlerts()">סנכרן עכשיו</button>' +
        '<button class="btn ghost" style="max-width:110px" ' +
          'onclick="clearGhToken()">נתק</button>' +
      '</div>' +
      '<div class="score-note" style="margin-top:9px">הטוקן שמור במכשיר הזה ' +
        'בלבד. ניתוק מוחק אותו מכאן — לביטול מלא בטל אותו גם ב־GitHub.</div>' +
      '</div>';
  }

  return '<div class="card">' + head +
    '<div class="score-note" style="margin-bottom:10px">כרגע ההתראות נשמרות ' +
      'במכשיר בלבד, ולכן נבדקות רק כשהאפליקציה פתוחה. חבר טוקן פעם אחת ' +
      'והרשימה תיכתב ל־GitHub לבד בכל שינוי.</div>' +
    '<div class="frow" style="margin-bottom:4px">' +
      '<input id="ghTok" type="password" autocomplete="off" ' +
        'autocapitalize="off" autocorrect="off" spellcheck="false" ' +
        'placeholder="github_pat_…">' +
    '</div>' +
    '<div class="frow">' +
      '<button class="btn" onclick="saveGhToken()">חבר</button>' +
      '<a class="btn ghost" href="' + GH_TOKEN_URL + '" target="_blank" ' +
        'rel="noopener" style="text-align:center">צור טוקן</a>' +
    '</div>' +
    '<div class="score-note" id="ghNote" style="margin-top:8px"></div>' +
    '<div class="fhelp open" style="margin-top:11px">' +
      '<b class="rng">איך מייצרים</b>' +
      'ב־GitHub: Fine-grained token ← Repository access ← <b>Only select ' +
      'repositories</b> ← Stocksapp ← Permissions ← Repository permissions ← ' +
      '<b>Contents: Read and write</b>. הטוקן נשמר במכשיר הזה בלבד ואפשר ' +
      'לבטל אותו ב־GitHub בכל רגע.</div>' +
    '<div class="score-note" style="margin:13px 0 8px">או ידנית, בלי טוקן:</div>' +
    '<pre class="sync-box" id="syncBox">' + esc(alertsSyncJson()) + '</pre>' +
    '<div class="frow" style="margin-top:11px">' +
      '<button class="btn ghost" onclick="copyAlertsJson()">העתק</button>' +
      '<a class="btn ghost" href="' + REPO_EDIT_URL + '" target="_blank" ' +
        'rel="noopener" style="text-align:center">פתח ב־GitHub</a>' +
    '</div>' +
    '<div class="score-note" id="syncNote" style="margin-top:8px"></div>' +
    '</div>';
}

function refreshSnapshot() {
  try { localStorage.removeItem(LS.snap); } catch (e) {}
  var box = $('#dataStatus');
  if (box) box.innerHTML = '<div class="msg">טוען…</div>';
  loadSnapshot().then(function () {
    if (!$('#sheet').classList.contains('hidden')) openSettings();
  }).catch(function () {});
}

/* Drops the cached snapshot only. Alerts, saved filters and anything the
   previous app stored are left alone. */
function clearCache() {
  try {
    localStorage.removeItem(LS.snap);
    localStorage.removeItem(LS.proxy);
  } catch (e) {}
  if (window.caches && caches.keys) {
    caches.keys().then(function (keys) {
      keys.forEach(function (k) { caches.delete(k); });
    }).catch(function () {});
  }
  location.reload();
}

/* ------------------------------------------------------------------ boot */
/* Sector strength, from the snapshot. Ranks sectors by the median 1-month
   return of their members - median rather than mean so one runaway stock does
   not carry a whole sector. */
function renderSectors() {
  var el = $('#sectors');
  if (!el) return;
  if (!SNAP || !SNAP.rows.length) {
    el.innerHTML = '<div class="msg">אין נתונים.</div>';
    return;
  }
  var by = {};
  SNAP.rows.forEach(function (r) {
    if (!r.sec || !r.t || r.t.chg1m == null) return;
    (by[r.sec] = by[r.sec] || []).push(r.t.chg1m);
  });
  var names = Object.keys(by).filter(function (k) { return by[k].length >= 5; });
  if (!names.length) {
    el.innerHTML = '<div class="msg">נתוני הסקטורים יתווספו בסריקה הבאה.</div>';
    return;
  }
  var median = function (xs) {
    var a = xs.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  var rows = names.map(function (k) {
    return { k: k, v: median(by[k]), n: by[k].length };
  }).sort(function (a, b) { return b.v - a.v; });

  var span = Math.max.apply(null, rows.map(function (r) {
    return Math.abs(r.v);
  })) || 1;

  el.innerHTML = rows.map(function (r) {
    var w = Math.max(3, (Math.abs(r.v) / span) * 100);
    var col = r.v >= 0 ? 'var(--ok)' : 'var(--alert)';
    return '<div class="bd-row">' +
      '<span class="bd-lb">' + r.k + '</span>' +
      '<span class="bd-track"><i class="bd-fill" data-w="' + w.toFixed(0) +
        '" style="width:0;background:' + col + '"></i></span>' +
      '<span class="bd-vl" style="color:' + col + '">' + pct(r.v, 1) +
      '</span></div>';
  }).join('') +
  '<div class="bd-sum">חציון תשואת חודש בכל סקטור. ' +
    '<b>' + rows[0].k + '</b> מוביל, <b>' + rows[rows.length - 1].k +
    '</b> נחלש.</div>';
  paintBars(el, true);
}

/* Swipe between pages.
 *
 * The pages sit side by side on a track. In RTL the flex row starts at the
 * right edge, so page 0 is in view and page 1 waits off-screen to the LEFT.
 * Bringing it in means moving the track rightward - so dragging right advances
 * and dragging left goes back. The earlier version chose the tab on the side
 * you flicked toward, which is the opposite of this and read as inverted.
 *
 * The track follows the finger the whole way, so the direction is not
 * something to remember: the page you are pulling in is already visible. */
function enableSwipe() {
  var el = $('#pages');
  var track = $('#track');
  if (!el || !track) return;

  var x0 = 0, y0 = 0, t0 = 0;
  var axis = null;   // null until the gesture commits to one direction
  var active = false;
  var w = 1;

  var idx = function () { return TAB_ORDER.indexOf(currentTab()); };

  var settle = function (i) {
    track.classList.remove('dragging');
    track.style.transform = '';
    goTab(TAB_ORDER[i], { noEnter: true });
  };

  el.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1 || sheetOpen()) { active = false; return; }
    active = true; axis = null;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
    w = el.clientWidth || 1;
  }, { passive: true });

  el.addEventListener('touchmove', function (e) {
    if (!active || e.touches.length !== 1) return;
    var dx = e.touches[0].clientX - x0;
    var dy = e.touches[0].clientY - y0;

    if (axis === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Vertical scrolling is the common case, so it wins ties.
      axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
      if (axis === 'x') track.classList.add('dragging');
    }
    if (axis !== 'x') return;

    // Holds the page still instead of letting it scroll under the drag.
    if (e.cancelable) e.preventDefault();

    var i = idx();
    var at = (i === 0 && dx < 0) || (i === TAB_ORDER.length - 1 && dx > 0);
    // Past the ends there is nowhere to go, so the track resists rather than
    // sliding into blank space.
    var travel = at ? dx * 0.28 : dx;
    track.style.transform =
      'translateX(calc(' + (i * 100) + '% + ' + travel.toFixed(1) + 'px))';
  }, { passive: false });

  var end = function (e) {
    if (!active) return;
    active = false;
    if (axis !== 'x') { axis = null; return; }
    axis = null;

    var dx = e.changedTouches[0].clientX - x0;
    var dt = Date.now() - t0;
    var i = idx();
    // Either far enough, or fast enough that intent is obvious at any distance.
    var far = Math.abs(dx) > w * 0.28;
    var flick = dt < 320 && Math.abs(dx) > 46;
    var next = i;
    if (far || flick) next = dx > 0 ? i + 1 : i - 1;
    if (next < 0 || next >= TAB_ORDER.length) next = i;
    settle(next);
  };

  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
}

function sheetOpen() {
  var m = $('#sheet');
  return !!m && !m.classList.contains('hidden');
}

/* Drag the sheet down to dismiss it. The sheet tracks the finger and the
   backdrop fades with it, so you can see how far you are from letting go -
   and pull back if you change your mind, which a release-threshold check
   could not offer. */
function enableSheetSwipe() {
  var modal = $('#sheet');
  var sheet = document.querySelector('.modal-sheet');
  var back = document.querySelector('.modal-backdrop');
  if (!modal || !sheet) return;

  var y0 = 0, t0 = 0, dragging = false, armed = false, fromGrip = false;

  sheet.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { armed = false; return; }
    y0 = e.touches[0].clientY;
    t0 = Date.now();
    fromGrip = !!(e.target.closest && e.target.closest('.sheet-grip'));
    // Anywhere else, the content has to be scrolled to the top first, or the
    // gesture would fight the sheet's own scrolling.
    armed = fromGrip || sheet.scrollTop <= 0;
    dragging = false;
  }, { passive: true });

  sheet.addEventListener('touchmove', function (e) {
    if (!armed || e.touches.length !== 1) return;
    var dy = e.touches[0].clientY - y0;

    if (!dragging) {
      if (dy < 6) return;                          // upward or too small yet
      if (!fromGrip && sheet.scrollTop > 0) { armed = false; return; }
      dragging = true;
      modal.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();

    // Upward past the top is resisted; the sheet has nowhere higher to go.
    var travel = dy < 0 ? dy * 0.2 : dy;
    sheet.style.transform = 'translateY(' + travel.toFixed(1) + 'px)';
    if (back) {
      var h = sheet.offsetHeight || 1;
      back.style.opacity = Math.max(0, 1 - (travel / h) * 1.1).toFixed(3);
    }
  }, { passive: false });

  var end = function (e) {
    if (!armed) return;
    armed = false;
    if (!dragging) return;
    dragging = false;
    modal.classList.remove('dragging');
    if (back) back.style.opacity = '';

    var dy = e.changedTouches[0].clientY - y0;
    var dt = Date.now() - t0;
    var h = sheet.offsetHeight || 1;
    if (dy > h * 0.3 || (dt < 300 && dy > 70)) {
      closeSheet();
    } else {
      sheet.style.transform = '';                  // springs back
    }
  };

  sheet.addEventListener('touchend', end, { passive: true });
  sheet.addEventListener('touchcancel', end, { passive: true });
}

function greet() {
  var h = new Date().getHours();
  return h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב'
       : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
}

/* Notice a new build and load it.

   Stamping app.js and style.css only helps once index.html is fresh, and
   index.html is cacheable too - a stale page keeps requesting the old stamped
   URLs forever. So compare the hash this page is running against what the
   server publishes, and if they differ, re-request the page under a URL the
   cache has never seen. Self-healing from here on: every future deploy lands
   without anyone clearing anything. */
function checkForUpdate() {
  var el = document.querySelector('script[src*="app.js"]');
  var m = el && /[?&]v=([0-9a-f]+)/.exec(el.getAttribute('src') || '');
  var running = m ? m[1] : null;
  if (!running) return;

  fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) {
      if (!v || !v.app || v.app === running) return;
      // Keyed on the target build, so a server that lags cannot cause a loop.
      var tried = null;
      try { tried = sessionStorage.getItem('sa_updated_to'); } catch (e) {}
      if (tried === v.app) return;
      try { sessionStorage.setItem('sa_updated_to', v.app); } catch (e) {}
      location.replace(location.pathname + '?build=' + v.app);
    })
    .catch(function () {});
}

function boot() {
  checkForUpdate();
  $('#greet').textContent = greet();
  enableSwipe();
  enableSheetSwipe();
  startPricePolling();
  goTab('home', { silent: true });
  playEnter($('#p-home'));
  renderFilters();
  renderHome();
  loadSnapshot().then(function () {
    renderBreadth();
    renderSectors();
    renderChanges();
    renderEarningsSoon();
    // Needs the snapshot: an open trade falls back to the snapshot price
    // until a live quote lands, and the guard reads ATR and earnings from it.
    renderHome();
    renderWatchlist();
    renderCompare();
    checkAlerts(false);
  });
  // Pull, not push: pushing here let a copy holding an older list overwrite
  // the repo on open. Only an unsent local change pushes instead.
  if (ghToken()) {
    if (store.get(LS.dirty, false)) syncAlerts();
    else pullAlerts();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
