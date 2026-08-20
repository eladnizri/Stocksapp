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
  recent: 'sa_recent'
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

/* Yahoo sets no CORS headers for browsers, so fall through a proxy list and
   remember whichever one worked last. */
function fetchRaw(url, timeoutMs) {
  var order = [bestProxy];
  for (var i = 0; i < PROXIES.length; i++) if (i !== bestProxy) order.push(i);

  var attempt = function (idx) {
    if (idx >= order.length) return Promise.reject(new Error('כל המקורות נכשלו'));
    var pi = order[idx];
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 9000);
    return fetch(PROXIES[pi](url), { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (txt) {
        if (pi !== bestProxy) { bestProxy = pi; store.set(LS.proxy, pi); }
        return txt;
      })
      .catch(function () { clearTimeout(timer); return attempt(idx + 1); });
  };
  return attempt(0);
}

function yahooQuote(sym) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=1d&range=1d';
  return fetchRaw(url, 8000).then(function (txt) {
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
      name: m.longName || m.shortName || ''
    };
  });
}

/* Analyst targets and recommendation counts. Best effort - Yahoo gates this
   behind a crumb for some clients, so the page must render fine without it. */
function yahooTargets(sym) {
  var url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
    encodeURIComponent(sym) +
    '?modules=financialData,recommendationTrend,calendarEvents';
  return fetchRaw(url, 9000).then(function (txt) {
    var d = JSON.parse(txt);
    var r = d && d.quoteSummary && d.quoteSummary.result &&
      d.quoteSummary.result[0];
    if (!r) throw new Error('אין נתוני אנליסטים');
    var fd = r.financialData || {};
    var raw = function (x) { return x && x.raw != null ? x.raw : null; };
    var trend = (r.recommendationTrend && r.recommendationTrend.trend) || [];
    var cur = trend[0] || {};
    var earn = null;
    try {
      var ed = r.calendarEvents.earnings.earningsDate;
      if (ed && ed.length && ed[0].raw) earn = ed[0].raw;
    } catch (e) {}
    return {
      low: raw(fd.targetLowPrice),
      mean: raw(fd.targetMeanPrice),
      high: raw(fd.targetHighPrice),
      n: raw(fd.numberOfAnalystOpinions),
      key: fd.recommendationKey || null,
      buy: (cur.strongBuy || 0) + (cur.buy || 0),
      hold: cur.hold || 0,
      sell: (cur.sell || 0) + (cur.strongSell || 0),
      earnings: earn
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
  for (var i = 0; i < d.rows.length; i++) SNAP_BY_SYM[d.rows[i].s] = d.rows[i];
  renderDataStatus(null, isCache);
  var uc = $('#screenCount');
  if (uc) uc.textContent = d.rows.length + ' מניות';
}

/* ------------------------------------------------------------ navigation */
function goTab(name) {
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) pages[i].classList.remove('on');
  var el = $('#p-' + name);
  if (el) el.classList.add('on');

  var tabs = document.querySelectorAll('.tab');
  for (var j = 0; j < tabs.length; j++) {
    var on = tabs[j].dataset.page === name;
    tabs[j].classList.toggle('on', on);
    if (on) $('#tabbar').style.setProperty('--tab-idx', j);
  }
  $('#pages').scrollTop = 0;

  if (name === 'watch') { renderAlerts(); checkAlerts(false); renderFilters(); }
  if (name === 'market') { loadTickers(); renderBreadth(); }
}

/* The analysis lives in a bottom sheet so it can be opened from anywhere
   without losing the page underneath. */
function openSheet() {
  $('#sheet').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  document.body.style.overflow = '';
  CUR = null;
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('#sheet').classList.contains('hidden')) closeSheet();
});

/* ---------------------------------------------------------------- search */
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

/* -------------------------------------------------------- analysis page */
var CUR = null;

function analyze(sym) {
  sym = (sym || '').trim().toUpperCase();
  if (!sym) return;
  CUR = sym;
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

  yahooTargets(sym).then(function (t) {
    if (CUR === sym) renderAnalysis(sym, row, undefined, t);
  }).catch(function () {});
}

var LIVE = { q: null, t: null };

function renderAnalysis(sym, row, quote, targets) {
  if (quote !== undefined) LIVE.q = quote;
  if (targets !== undefined) LIVE.t = targets;
  if (quote === null && targets === null) LIVE = { q: null, t: null };

  var q = LIVE.q, tg = LIVE.t;
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
    '</div></div>';

  if (!row) {
    html += '<div class="card"><div class="msg">' + esc(sym) +
      ' אינה במדדים הנסרקים (S&P 500 / נאסד״ק 100), ולכן אין לה ניתוח יסוד. ' +
      'המחיר החי מוצג למעלה.</div></div>';
    $('#sheetBody').innerHTML = html;
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
            ' stroke-linecap="round" stroke-dasharray="' + (C * frac) + ' ' + C + '"/>' +
        '</svg>' +
        '<div class="val" style="color:' + col + '">' +
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
        '<span class="bar-track"><i class="bar-fill" style="width:' +
          (v == null ? 0 : v) + '%;background:' + scoreColor(v) + '"></i></span>' +
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
    '<span class="mini"><i style="width:' + (s == null ? 0 : s) + '%;background:' +
      scoreColor(s) + '"></i></span></div>';
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

  var extra = '<div class="q-sub" style="border-top:1px solid var(--line);margin-top:10px">' +
    '<div>הכנסות (12ח)<b class="mono">' + big(f.revTTM) + '</b></div>' +
    '<div>רווח נקי<b class="mono">' + big(f.niTTM) + '</b></div>' +
    '<div>תזרים חופשי<b class="mono">' + big(f.fcf) + '</b></div>' +
    '<div>רווח למניה<b class="mono">' + (f.epsTTM != null ? num(f.epsTTM) : '—') + '</b></div>' +
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
  rows += metricRow('מעל ממוצע 200', t.vma200, '%', -30, 40, 1);
  rows += metricRow('תנודתיות (ATR)', t.atrPct, '%', 8, 1, 1);

  var perf = [['חודש', t.chg1m], ['3 חודשים', t.chg3m],
              ['6 חודשים', t.chg6m], ['שנה', t.chg12m]];

  return '<div class="card">' +
    '<div class="card-h"><span>טכני</span><span class="sub">ללא גרפים</span></div>' +
    '<div class="mtable">' + rows + '</div>' +
    '<div class="q-sub" style="border-top:1px solid var(--line);margin-top:10px">' +
      perf.map(function (p) {
        return '<div>' + p[0] + '<b class="mono ' + cls(p[1]) + '">' +
          pct(p[1], 1) + '</b></div>';
      }).join('') +
    '</div></div>';
}

function renderForecast(tg, price) {
  if (!tg || !tg.mean) {
    return '<div class="card">' +
      '<div class="card-h"><span>תחזית אנליסטים</span></div>' +
      '<div class="msg">נתוני אנליסטים לא זמינים כרגע.</div></div>';
  }
  var up = price ? ((tg.mean - price) / price) * 100 : null;
  var total = (tg.buy || 0) + (tg.hold || 0) + (tg.sell || 0);
  var bar = function (label, n, color) {
    var w = total ? (n / total) * 100 : 0;
    return '<div class="bar-row"><span class="lb">' + label + '</span>' +
      '<span class="bar-track"><i class="bar-fill" style="width:' + w +
        '%;background:' + color + '"></i></span>' +
      '<span class="nv">' + n + '</span></div>';
  };
  var earn = '';
  if (tg.earnings) {
    var d = new Date(tg.earnings * 1000);
    earn = '<div class="mrow" style="grid-template-columns:1fr auto">' +
      '<span class="lb">דוח הבא</span><span class="vl">' +
      d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }) +
      '</span></div>';
  }
  return '<div class="card">' +
    '<div class="card-h"><span>תחזית אנליסטים</span>' +
      '<span class="sub">' + (tg.n || 0) + ' אנליסטים</span></div>' +
    '<div class="mtable">' +
      '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">יעד נמוך</span>' +
        '<span class="vl">' + money(tg.low) + '</span></div>' +
      '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">יעד ממוצע</span>' +
        '<span class="vl" style="color:var(--primary-500)">' + money(tg.mean) +
        (up == null ? '' : ' (' + pct(up, 0) + ')') + '</span></div>' +
      '<div class="mrow" style="grid-template-columns:1fr auto"><span class="lb">יעד גבוה</span>' +
        '<span class="vl">' + money(tg.high) + '</span></div>' + earn +
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
  goTab('alerts');
}

/* ---------------------------------------------------------------- alerts */
function saveAlert(sym, price, dir) {
  var list = store.get(LS.alerts, []);
  list.push({ s: sym, p: price, d: dir, t: Date.now() });
  store.set(LS.alerts, list);
  renderAlerts();
  checkAlerts(true);
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
  saveAlert(sym, price, dir);
  $('#a-sym').value = '';
  $('#a-price').value = '';
}

function removeAlert(i) {
  var list = store.get(LS.alerts, []);
  list.splice(i, 1);
  store.set(LS.alerts, list);
  renderAlerts();
}

/* Last known price per alerted symbol. Seeded from the snapshot so a row
   shows something immediately, then refreshed live. */
var ALERT_PRICES = {};

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
    return;
  }
  box.innerHTML = list.map(function (a, i) {
    var now = ALERT_PRICES[a.s];
    var hit = now != null &&
      ((a.d === 'above' && now >= a.p) || (a.d === 'below' && now <= a.p));
    return '<div class="alert ' + (hit ? 'hit' : '') + '">' +
      '<span class="sym">' + esc(a.s) + '</span>' +
      '<span class="cond">' + (a.d === 'above' ? 'מעל' : 'מתחת ל־') + ' ' +
        money(a.p) + '</span>' +
      (hit ? '<span class="badge">הופעלה</span>' : '') +
      '<span class="pr">' + (now == null ? '…' : money(now)) + '</span>' +
      '<button class="x" onclick="removeAlert(' + i + ')" aria-label="מחק">✕</button>' +
      '</div>';
  }).join('');
  $('#alertCount').textContent = list.length + ' פעילות';
}

function checkAlerts(force) {
  var list = store.get(LS.alerts, []);
  if (!list.length) return;
  var syms = {};
  list.forEach(function (a) { syms[a.s] = 1; });

  Object.keys(syms).forEach(function (sym) {
    if (!force && ALERT_PRICES[sym] != null) return;
    var snap = SNAP_BY_SYM[sym];
    if (snap && snap.t && snap.t.price != null && ALERT_PRICES[sym] == null) {
      ALERT_PRICES[sym] = snap.t.price;
      renderAlerts();
    }
    yahooQuote(sym).then(function (q) {
      if (q && q.price != null) { ALERT_PRICES[sym] = q.price; renderAlerts(); }
    }).catch(function () {});
  });
}

/* -------------------------------------------------------------- screener */
var FILTERS = [
  ['score', 'ציון כולל', 0, 100],
  ['mcapB', 'שווי שוק (מיליארד $)', 0, 5000],
  ['pe', 'מכפיל רווח', 0, 100],
  ['revGrowth', 'צמיחת הכנסות %', -50, 200],
  ['netMargin', 'מרג׳ין נקי %', -50, 100],
  ['roe', 'תשואה על ההון %', -50, 150],
  ['debtToEquity', 'חוב להון %', 0, 500],
  ['rsi', 'RSI', 0, 100],
  ['vma200', 'מעל ממוצע 200 %', -80, 200],
  ['from52High', 'מרחק משיא 52ש׳ %', -90, 0],
  ['chg12m', 'תשואה 12ח %', -90, 500]
];

function renderFilters() {
  var saved = store.get(LS.filters, {});
  $('#filterRows').innerHTML = FILTERS.map(function (f) {
    var v = saved[f[0]] || {};
    return '<div class="frow">' +
      '<span class="lb">' + f[1] + '</span>' +
      '<input id="f-' + f[0] + '-min" inputmode="decimal" placeholder="מ־" value="' +
        (v.min != null ? v.min : '') + '">' +
      '<input id="f-' + f[0] + '-max" inputmode="decimal" placeholder="עד" value="' +
        (v.max != null ? v.max : '') + '">' +
      '</div>';
  }).join('');

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
  renderFilters();
  $('#screenResults').innerHTML = '<div class="msg">הגדר פילטרים ולחץ סרוק.</div>';
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
  var keys = Object.keys(availableIndices());
  var idx = store.get(LS.idx, keys).filter(function (k) {
    return keys.indexOf(k) >= 0;
  });
  if (!idx.length) idx = keys;
  var keys = Object.keys(flt);

  var hits = SNAP.rows.filter(function (r) {
    var inIdx = (r.i || []).some(function (m) { return idx.indexOf(m) >= 0; });
    if (!inIdx) return false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], c = flt[k], v = fieldValue(r, k);
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
    shown.map(function (r) {
      var sc = r.sc ? r.sc.total : null;
      var t = r.t || {};
      return '<button class="hit" onclick="analyze(\'' + r.s + '\')">' +
        '<span class="hit-score" style="background:' + scoreColor(sc) +
          '22;color:' + scoreColor(sc) + '">' + (sc == null ? '—' : sc) + '</span>' +
        '<span><span class="sym">' + r.s + '</span>' +
          '<span class="nm">' + esc(r.n || '') + '</span>' +
          '<span class="nm">' + big(r.mcap) + ' · מכפיל ' +
          (r.pe ? num(r.pe, 1) : '—') + '</span></span>' +
        '<span><span class="pr">' + money(t.price) + '</span>' +
          '<span class="ch ' + cls(t.chg12m) + '">' + pct(t.chg12m, 0) + ' שנה</span></span>' +
        '</button>';
    }).join('');
}

/* ------------------------------------------------------------------ home */
/* Raw Yahoo symbols - yahooQuote() percent-encodes them, so pre-encoding the
   caret here would double-escape it and every index request would 404. */
var TICKERS = [
  ['^GSPC', 'S&P 500', 0],
  ['^IXIC', 'נאסד״ק', 0],
  ['^DJI', 'דאו ג׳ונס', 0],
  ['^RUT', 'ראסל 2000', 0],
  ['^VIX', 'VIX', 2],
  ['BTC-USD', 'ביטקוין', 0]
];
var TICKERS_MINI = [
  ['USDILS=X', 'דולר / שקל', 3],
  ['GC=F', 'זהב', 0],
  ['CL=F', 'נפט', 2]
];

function tkId(sym) { return 'tk-' + sym.replace(/[^A-Za-z0-9]/g, ''); }

function loadTickers() {
  var box = $('#tickers');
  if (box.dataset.loaded) return;
  box.dataset.loaded = '1';

  var tile = function (t, cl) {
    return '<div class="' + cl + '" id="' + tkId(t[0]) + '">' +
      '<span class="nm">' + t[1] + '</span>' +
      '<span class="skel"></span></div>';
  };
  box.innerHTML = TICKERS.map(function (t) { return tile(t, 'tk'); }).join('');
  $('#tickersMini').innerHTML =
    TICKERS_MINI.map(function (t) { return tile(t, 'tk-mini'); }).join('');

  TICKERS.concat(TICKERS_MINI).forEach(function (t) {
    yahooQuote(t[0]).then(function (q) {
      var el = $('#' + tkId(t[0]));
      if (!el) return;
      var sk = el.querySelector('.skel');
      if (sk) sk.remove();
      if (q.price == null) { el.innerHTML += '<span class="val">—</span>'; return; }
      el.innerHTML += '<span class="val">' + num(q.price, t[2]) + '</span>' +
        '<span class="ch ' + cls(q.chgPct) + '">' + pct(q.chgPct, 1) + '</span>';
    }).catch(function () {
      var el = $('#' + tkId(t[0]));
      if (!el) return;
      var sk = el.querySelector('.skel');
      if (sk) sk.remove();
      el.innerHTML += '<span class="val">—</span>';
    });
  });

  $('#mktState').textContent = 'עודכן ' + new Date().toLocaleTimeString('he-IL',
    { hour: '2-digit', minute: '2-digit' });
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
      '<span class="bd-track"><i class="bd-fill" style="width:' +
        v.toFixed(0) + '%;background:' + col + '"></i></span>' +
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
}

function renderDataStatus(err, isCache) {
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
  goTab('watch');
  var el = $('#dataStatus');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function refreshSnapshot() {
  try { localStorage.removeItem(LS.snap); } catch (e) {}
  var box = $('#dataStatus');
  if (box) box.innerHTML = '<div class="msg">טוען…</div>';
  loadSnapshot();
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
function greet() {
  var h = new Date().getHours();
  return h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב'
       : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
}

function boot() {
  $('#greet').textContent = greet();
  renderFilters();
  loadTickers();
  loadSnapshot().then(function () {
    renderBreadth();
    checkAlerts(false);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
