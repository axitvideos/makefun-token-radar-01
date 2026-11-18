// Token Launch Radar — dashboard logic. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, filters, a live-token comparison tab and a
// per-protocol detail panel with the model's arithmetic and the protocol's farm plan.
// No network: every byte it shows is in data.js. State can be seeded from the URL hash
// (#detail=<slug>, #cat=<category>, #watch=1, #tab=live, #sort=<key>) so a view is linkable.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var rows = DATA.rows, live = DATA.live;

  var hash = {};
  (location.hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) hash[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  });
  var state = {
    q: hash.q || '', category: hash.cat || 'all', chain: hash.chain || 'all',
    watch: hash.watch === '1', minTvl: +(hash.min || 0), tab: hash.tab === 'live' ? 'live' : 'pre',
    sort: hash.sort || 'implied', selected: hash.detail || null,
  };

  // ---------- formatting ----------
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '<span class="na">n/a</span>';
    return '<span class="' + (n >= 0 ? 'pos' : 'neg') + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return d + 'd';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

  // ---------- derived sets ----------
  var catCount = {}, chainCount = {};
  rows.forEach(function (r) {
    var c = r.category || '(none)'; catCount[c] = (catCount[c] || 0) + 1;
    r.chains.forEach(function (ch) { chainCount[ch] = (chainCount[ch] || 0) + 1; });
  });
  var categories = Object.keys(catCount).sort();
  var chains = Object.keys(chainCount).sort(function (a, b) { return chainCount[b] - chainCount[a]; }).slice(0, 18);
  var maxRatio = 0;
  rows.forEach(function (r) { if (r.implied_per_tvl > maxRatio) maxRatio = r.implied_per_tvl; });
  var boardTotal = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  // ---------- skeleton ----------
  var multChips = DATA.multiples.filter(function (m) { return m.category_peers > 0; })
    .sort(function (a, b) { return b.multiple - a.multiple; })
    .map(function (m) {
      return '<span class="mult">' + esc(m.category) + ' <span class="x">×' + m.multiple.toFixed(2) + '</span> · ' +
        m.category_peers + ' peers</span>';
    }).join('') +
    '<span class="mult">every other category <span class="x">×' + DATA.global_median.toFixed(2) + '</span> · global median</span>';
  app.innerHTML =
    '<div class="wrap">' +
    '<header class="top"><div class="logo" aria-hidden="true"></div><div>' +
    '<h1>TOKEN LAUNCH <span class="thin">RADAR</span></h1>' +
    '<p class="tagline">Every protocol in the snapshot that <b>records no token yet</b>, ranked by what its launch ' +
    'would be worth if its record stayed as it is — and exactly what to do to farm each one. Snapshot as of <b>' +
    esc(DATA.as_of) + '</b> · model <b>' + esc(DATA.model_version) + '</b>. Implied values are this board\'s own ' +
    'model claims, not predictions that a token will launch.</p></div></header>' +
    '<div class="stats">' +
    '<div class="stat"><div class="n">' + DATA.universe_size + '</div><div class="l">protocols scanned</div></div>' +
    '<div class="stat"><div class="n">' + DATA.board_size + '</div><div class="l">pre-token ranked</div></div>' +
    '<div class="stat"><div class="n">' + DATA.watchlist_size + '/' + DATA.watchlist_size + '</div><div class="l">watchlist covered</div></div>' +
    '<div class="stat"><div class="n">' + DATA.early_size + '</div><div class="l">early finds below $50M</div></div>' +
    '<div class="stat"><div class="n">' + fmtUsd(boardTotal) + '</div><div class="l">total implied value</div></div>' +
    '</div>' +
    '<section class="model"><h2>How the ranking works</h2>' +
    '<div class="formula">implied value <span class="op">=</span> TVL <span class="op">×</span> peer multiple ' +
    '<span class="op">×</span> growth <span class="op">×</span> maturity <span class="op">×</span> breadth</div>' +
    '<p><b>Peer multiple:</b> each category is priced off the protocols that already launched — the median ' +
    'market-cap ÷ TVL of the snapshot\'s own live-token protocols in that category, shrunk toward its family ' +
    '(credit, exchange, staking, bridges, allocators, RWA, chain). Global live median is <b>×' +
    DATA.global_median.toFixed(2) + '</b>. <b>Growth:</b> 7-day TVL change, clamped to −50%…+100%, weighted 0.6. ' +
    '<b>Maturity:</b> days tracked with no token, 0.75→1.20 over four years — the longer it has run tokenless, ' +
    'the more proven the launch. <b>Breadth:</b> +1.5% per extra chain, up to ten. No name is special-cased: ' +
    'the function <b>scoreProtocol</b> in the model scores every row from the snapshot\'s figures alone. ' +
    '<b>The screen:</b> every row first passes the snapshot\'s own launch screen — no bridges, liquid staking ' +
    'or restaking, no wrapped or staked products, no exchange products, no versioned pools — so a wrapped ' +
    'product of a traded token (WBTC, USDT0 and their kin) is never ranked as a launch, however large it is.</p>' +
    '<div class="mults">' + multChips + '</div></section>' +
    '<div class="layout"><div class="board-col">' +
    '<div class="controls">' +
    '<input type="search" id="q" placeholder="Search name, slug, category…" aria-label="Search">' +
    '<select id="cat" aria-label="Category"></select>' +
    '<select id="chain" aria-label="Chain"></select>' +
    '<select id="min" aria-label="Minimum TVL"><option value="0">Any TVL</option><option value="50000000">TVL ≥ $50M</option>' +
    '<option value="100000000">TVL ≥ $100M</option><option value="500000000">TVL ≥ $500M</option></select>' +
    '<button class="toggle" id="watch" type="button">★ Watchlist only</button>' +
    '<label>Sort <select id="sort"><option value="implied">Implied value</option><option value="tvl">TVL</option>' +
    '<option value="growth">7d growth</option><option value="age">Age (tokenless)</option>' +
    '<option value="ratio">Implied ÷ TVL</option><option value="name">Name A–Z</option></select></label>' +
    '<div class="tabs"><button class="tab" id="tab-pre" type="button">Pre-token board</button>' +
    '<button class="tab" id="tab-live" type="button">Live tokens</button></div>' +
    '</div>' +
    '<p class="showing" id="showing"></p>' +
    '<div id="tablebox"></div>' +
    '<footer><p><b>How to read this board.</b> Rank is the model\'s claim, highest implied value first. ' +
    '★ marks the snapshot\'s watchlist (TVL ≥ $50M, records no token, not a wrapped or staked product of a ' +
    'traded token); the rest are early finds below that floor — the watchlist is a floor, never a ceiling. ' +
    'Click any row for its value breakdown and its farm plan. The <b>Live tokens</b> tab shows protocols whose ' +
    'token already trades at the market\'s own prices: they are never ranked here — they are the peers the ' +
    'multiples are calibrated from. Data is a frozen DefiLlama snapshot; a protocol "records no token" in that ' +
    'snapshot, which is not proof it has none.</p></footer>' +
    '</div><aside class="detail" id="detail"></aside></div></div>';

  var qEl = document.getElementById('q'), catEl = document.getElementById('cat'),
      chainEl = document.getElementById('chain'), minEl = document.getElementById('min'),
      watchEl = document.getElementById('watch'), sortEl = document.getElementById('sort'),
      showingEl = document.getElementById('showing'), tableEl = document.getElementById('tablebox'),
      detailEl = document.getElementById('detail');
  qEl.value = state.q; minEl.value = String(state.minTvl); sortEl.value = state.sort;
  catEl.innerHTML = '<option value="all">All categories</option>' + categories.map(function (c) {
    return '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + ' (' + catCount[c] + ')</option>';
  }).join('');
  chainEl.innerHTML = '<option value="all">All chains</option>' + chains.map(function (c) {
    return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + ' (' + chainCount[c] + ')</option>';
  }).join('');

  // ---------- filtering / sorting ----------
  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || '(none)') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    out.sort(function (a, b) {
      var d;
      if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'growth') d = (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d);
      else if (key === 'age') d = (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      else if (key === 'ratio') d = b.implied_per_tvl - a.implied_per_tvl;
      else if (key === 'name') d = a.name < b.name ? -1 : 1;
      else d = b.implied_value_usd - a.implied_value_usd;
      return d !== 0 ? d : (a.slug < b.slug ? -1 : 1);
    });
    return out;
  }

  function renderBoard() {
    var list = visible();
    showingEl.innerHTML = 'Showing <b>' + list.length + '</b> of ' + rows.length + ' ranked protocols' +
      (state.watch ? ' · <b>watchlist only</b>' : '') +
      (state.category !== 'all' ? ' · category <b>' + esc(state.category) + '</b>' : '') +
      (state.chain !== 'all' ? ' · chain <b>' + esc(state.chain) + '</b>' : '') +
      ' · sorted by <b>' + sortEl.options[sortEl.selectedIndex].text + '</b>. Click a row for its breakdown and farm plan.';
    var h = '<table><thead><tr><th class="l">#</th><th class="l">Protocol</th><th class="l">Category</th>' +
      '<th class="l col-chains">Chains</th><th>TVL</th><th>7d</th><th>Age</th><th>Peer ×</th><th>Implied value</th></tr></thead><tbody>';
    list.forEach(function (r) {
      var ch = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '');
      h += '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="rank l">' + r.rank + '</td>' +
        '<td class="name l">' + esc(r.name) +
        (r.watchlist ? '<span class="badge watch">★ Watchlist</span>' : '<span class="badge early">Early</span>') +
        '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat l">' + esc(r.category || '—') + '</td>' +
        '<td class="chains l col-chains">' + esc(ch || '—') + '</td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td><td>' + fmtPct(r.change_7d) + '</td>' +
        '<td>' + fmtAge(r.age_days) + '</td><td>×' + r.model.peer_multiple.toFixed(2) + '</td>' +
        '<td class="iv">' + fmtUsd(r.implied_value_usd) +
        '<span class="bar"><i style="width:' + Math.max(3, Math.round(100 * r.implied_per_tvl / maxRatio)) + '%"></i></span></td></tr>';
    });
    h += '</tbody></table>';
    if (list.length === 0) h = '<div class="empty-detail">No protocol matches this filter. Loosen the search, the category or the TVL floor.</div>';
    tableEl.innerHTML = h;
    Array.prototype.forEach.call(tableEl.querySelectorAll('tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { select(tr.getAttribute('data-slug'), true); });
    });
  }

  function renderLive() {
    showingEl.innerHTML = 'Showing <b>' + live.length + '</b> live-token protocols by market cap. These already ' +
      'trade: the board never ranks them — their market-cap ÷ TVL ratios are the peer multiples the pre-token board is priced from.';
    var h = '<table><thead><tr><th class="l">Protocol</th><th class="l">Symbol</th><th class="l">Category</th>' +
      '<th>TVL</th><th>Market cap</th><th>Mcap ÷ TVL</th><th>7d</th></tr></thead><tbody>';
    live.forEach(function (r) {
      h += '<tr><td class="name l">' + esc(r.name) + '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="l">' + esc(r.symbol || '—') + '</td><td class="cat l">' + esc(r.category || '—') + '</td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td><td class="iv">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td>' + (r.mcap_per_tvl === null ? '<span class="na">n/a</span>' : '×' + r.mcap_per_tvl.toFixed(2)) + '</td>' +
        '<td>' + fmtPct(r.change_7d) + '</td></tr>';
    });
    tableEl.innerHTML = h + '</tbody></table>';
  }

  // ---------- detail ----------
  function renderDetail() {
    var r = state.selected ? bySlug[state.selected] : null;
    document.querySelector('.layout').classList.toggle('detail-open', !!r);
    if (!r) {
      // No selection: the aside steps aside so the board takes the full width. The detail view
      // opens on any row click (or a #detail=<slug> link), with the breakdown and farm plan.
      detailEl.style.display = 'none';
      detailEl.innerHTML = '';
      return;
    }
    detailEl.style.display = '';
    var m = r.model;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    detailEl.innerHTML =
      '<div class="detail-card"><button class="close" id="dclose" type="button">Close ✕</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="sub">Rank #' + r.rank + ' of ' + rows.length + ' · ' + esc(r.category || 'Uncategorised') +
      ' · family: ' + esc(r.family) + (r.watchlist ? ' · ★ on the snapshot watchlist' : ' · early find below the $50M floor') + '</div>' +
      '<div class="big-iv"><span class="cap">Implied value if it launched on this record</span>' + fmtUsd(r.implied_value_usd) + '</div>' +
      '<table class="break">' +
      '<tr><td class="l">TVL (snapshot)</td><td>' + fmtUsd(r.tvl_usd) + '</td></tr>' +
      '<tr><td class="l">Peer multiple — ' + esc(r.category || 'uncategorised') + '</td><td>×' + m.peer_multiple.toFixed(2) + '</td></tr>' +
      '<tr><td class="l">Growth — 7d TVL ' + (r.change_7d === null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</td><td>×' + m.growth_multiplier.toFixed(2) + '</td></tr>' +
      '<tr><td class="l">Maturity — ' + fmtAge(r.age_days) + ' tracked with no token</td><td>×' + m.maturity_multiplier.toFixed(2) + '</td></tr>' +
      '<tr><td class="l">Breadth — ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '</td><td>×' + m.breadth_multiplier.toFixed(2) + '</td></tr>' +
      '<tr class="total"><td class="l">Implied value (' + r.implied_per_tvl.toFixed(2) + '× TVL)</td><td>' + fmtUsd(r.implied_value_usd) + '</td></tr></table>' +
      '<div class="facts">' +
      '<div><b>Chains</b>' + esc(r.chains.join(', ') || '—') + '</div>' +
      '<div><b>Tracked since</b>' + esc(r.listed_at || 'unknown') + '</div>' +
      '<div><b>Token status</b>Records no token in this snapshot</div>' +
      '<div><b>Peer set</b>' + m.peer_category_peers + ' live in category · ' + m.peer_family_peers + ' in family</div>' +
      '</div>' +
      '<h3>Farm plan — 7 steps</h3><ol class="steps">' + steps + '</ol>' +
      '<p class="note">Costs and times are the plan\'s own estimates for one wallet on the protocol\'s main chain. ' +
      'The implied value is this board\'s model claim from the frozen snapshot — it is not a promise that ' +
      esc(r.name) + ' will issue a token, or what it would trade at.</p></div>';
    document.getElementById('dclose').addEventListener('click', function () { select(null, true); });
  }

  function select(slug, rerender) {
    state.selected = slug;
    if (rerender) { renderDetail(); if (state.tab === 'pre') renderBoard(); }
  }

  function render() {
    document.getElementById('tab-pre').className = 'tab' + (state.tab === 'pre' ? ' on' : '');
    document.getElementById('tab-live').className = 'tab' + (state.tab === 'live' ? ' on' : '');
    watchEl.className = 'toggle' + (state.watch ? ' on' : '');
    if (state.tab === 'pre') renderBoard(); else renderLive();
    renderDetail();
  }

  qEl.addEventListener('input', function () { state.q = qEl.value; if (state.tab === 'pre') renderBoard(); });
  catEl.addEventListener('change', function () { state.category = catEl.value; state.tab = 'pre'; render(); });
  chainEl.addEventListener('change', function () { state.chain = chainEl.value; state.tab = 'pre'; render(); });
  minEl.addEventListener('change', function () { state.minTvl = +minEl.value; state.tab = 'pre'; render(); });
  sortEl.addEventListener('change', function () { state.sort = sortEl.value; state.tab = 'pre'; render(); });
  watchEl.addEventListener('click', function () { state.watch = !state.watch; state.tab = 'pre'; render(); });
  document.getElementById('tab-pre').addEventListener('click', function () { state.tab = 'pre'; render(); });
  document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; render(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') select(null, true); });

  app.removeAttribute('aria-busy');
  render();
})();
