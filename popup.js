/* "Probably Correct" Fix — production popup logic.
 *
 * Pure search: region / country / type filters, phonetic + fuzzy matching,
 * nearby-country expansion, copy ident to clipboard. No Entry tab, no
 * cloud sync. Theme toggle (light / dark) is the only state we persist.
 *
 * Data layer
 *   The dataset lives in four CSV files plus a countries.json index, all
 *   shipped inside the extension under data/. The popup fetches them in
 *   parallel on open and builds the in-memory indices once.
 *
 * Record shapes after parsing
 *   waypoint: [ident, cc]
 *   navaid:   [ident, name, type, cc]
 *   airport:  [ident, type, name, cc, iata, icao]
 *   vfr:      [ident, name, cc, airport]
 */

(function () {
  'use strict';

  // --------------------------------------------------------------
  // STORAGE — only used for theme persistence. Falls back to a tiny
  // in-memory store when chrome.storage isn't available (e.g. when
  // viewing the popup HTML directly during development).
  // --------------------------------------------------------------
  const THEME_KEY = 'pcf:theme';
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const memStore = {};
  function storageGet(keys) {
    if (!hasChromeStorage) {
      const out = {}, ks = Array.isArray(keys) ? keys : [keys];
      for (const k of ks) if (k in memStore) out[k] = memStore[k];
      return Promise.resolve(out);
    }
    return chrome.storage.local.get(keys);
  }
  function storageSet(obj) {
    if (!hasChromeStorage) { Object.assign(memStore, obj); return Promise.resolve(); }
    return chrome.storage.local.set(obj);
  }

  // --------------------------------------------------------------
  // RFC 4180-ish CSV parser. Handles quoted fields with embedded
  // commas and escaped quotes ("" → "). Assumes UTF-8 and no
  // embedded newlines inside fields (our datasets don't use them).
  // --------------------------------------------------------------
  function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    if (!lines.length) return { header: [], rows: [] };

    function parseLine(line) {
      const out = [];
      let i = 0, n = line.length;
      while (i <= n) {
        let field = '';
        if (line[i] === '"') {
          i++;
          while (i < n) {
            if (line[i] === '"') {
              if (line[i + 1] === '"') { field += '"'; i += 2; }
              else { i++; break; }
            } else { field += line[i++]; }
          }
        } else {
          while (i < n && line[i] !== ',') field += line[i++];
        }
        out.push(field);
        if (i >= n) break;
        if (line[i] === ',') i++;
      }
      return out;
    }

    const header = parseLine(lines[0]);
    const rows = [];
    for (let l = 1; l < lines.length; l++) {
      if (!lines[l]) continue;
      rows.push(parseLine(lines[l]));
    }
    return { header, rows };
  }

  // --------------------------------------------------------------
  // DATA LOADERS
  // --------------------------------------------------------------
  function dataURL(name) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL('data/' + name);
    }
    return 'data/' + name;
  }
  async function fetchText(name) {
    const res = await fetch(dataURL(name));
    if (!res.ok) throw new Error('Failed to load ' + name + ': ' + res.status);
    return res.text();
  }
  async function fetchJSON(name) {
    const res = await fetch(dataURL(name));
    if (!res.ok) throw new Error('Failed to load ' + name + ': ' + res.status);
    return res.json();
  }

  // --------------------------------------------------------------
  // PHONETIC + FUZZY HELPERS
  // --------------------------------------------------------------
  function soundex(s) {
    if (!s) return '';
    s = s.toUpperCase();
    let out = s[0];
    const map = { B:1,F:1,P:1,V:1, C:2,G:2,J:2,K:2,Q:2,S:2,X:2,Z:2,
                  D:3,T:3, L:4, M:5,N:5, R:6 };
    let prev = map[s[0]] || 0;
    for (let i = 1; i < s.length && out.length < 4; i++) {
      const ch = s[i]; const code = map[ch] || 0;
      if (code !== 0 && code !== prev) out += code;
      if (code !== 0) prev = code;
      else if (ch !== 'H' && ch !== 'W') prev = 0;
    }
    return (out + '0000').slice(0, 4);
  }

  function levenshtein(a, b, maxDist) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > maxDist) return maxDist + 1;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1), curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let minInRow = i;
      const ac = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
        const ins = curr[j - 1] + 1, del = prev[j] + 1, sub = prev[j - 1] + cost;
        const v = ins < del ? (ins < sub ? ins : sub) : (del < sub ? del : sub);
        curr[j] = v;
        if (v < minInRow) minInRow = v;
      }
      if (minInRow > maxDist) return maxDist + 1;
      const t = prev; prev = curr; curr = t;
    }
    return prev[n];
  }

  // --------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------
  const state = {
    region: '',
    country: '',
    type: '',
    query: '',
  };

  let WP = [], NV = [], AP = [], VF = [];
  let WP_BY_C = {}, NV_BY_C = {}, AP_BY_C = {}, VF_BY_C = {};
  let WP_SOUNDEX = [], NV_SOUNDEX = [], AP_SOUNDEX = [], VF_SOUNDEX = [];
  const COUNTRY_NAME = new Map();
  const COUNTRY_REGION = new Map();
  const NEARBY_COUNTRIES = new Map();

  // --------------------------------------------------------------
  // ELEMENT REFS
  // --------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const regionSel = $('region-select');
  const countryInput = $('country-input');
  const countryCombobox = $('country-combobox');
  const countryDropdown = $('country-dropdown');
  const typePills = $('type-pills');
  const searchInput = $('search');
  const searchWrap = document.querySelector('.search-wrap');
  const resultsEl = $('results');
  const metaEl = $('results-meta');
  const factTextEl = $('fact-text');
  const toastEl = $('toast');
  const themeToggle = $('theme-toggle');

  // --------------------------------------------------------------
  // SCORING
  // --------------------------------------------------------------
  function scoreWaypointAt(i, q, qS) {
    if (!q) return 1;
    const ident = WP[i][0];
    if (ident === q) return 1000;
    if (ident.startsWith(q)) return 500 - ident.length;
    if (ident.includes(q)) return 200;
    if (qS && WP_SOUNDEX[i] === qS) return 80;
    if (Math.abs(ident.length - q.length) <= 2) {
      const d = levenshtein(ident, q, 2);
      if (d === 1) return 60;
      if (d === 2) return 40;
    }
    return 0;
  }
  function scoreNavaidAt(i, q, qS) {
    if (!q) return 1;
    const n = NV[i];
    const ident = n[0], name = n[1] || '';
    if (ident === q) return 1000;
    if (ident.startsWith(q)) return 500 - ident.length;
    const nameUp = name.toUpperCase();
    if (nameUp === q) return 950;
    if (nameUp.startsWith(q)) return 250;
    if (ident.includes(q)) return 200;
    if (nameUp.includes(q)) return 100;
    if (qS && NV_SOUNDEX[i] === qS) return 80;
    if (Math.abs(ident.length - q.length) <= 2) {
      const d = levenshtein(ident, q, 2);
      if (d === 1) return 60;
      if (d === 2) return 40;
    }
    return 0;
  }
  function scoreAirportAt(i, q, qS) {
    if (!q) return 1;
    const a = AP[i];
    const ident = a[0], iata = a[4] || '', icao = a[5] || '', name = a[2] || '';
    if (icao === q || iata === q || ident === q) return 1000;
    if (ident.startsWith(q)) return 500 - ident.length;
    if (icao.startsWith(q)) return 480;
    if (iata.startsWith(q)) return 460;
    const nameUp = name.toUpperCase();
    if (nameUp.startsWith(q)) return 250;
    if (nameUp.includes(q)) return 100;
    if (ident.includes(q)) return 80;
    if (qS && AP_SOUNDEX[i] === qS) return 75;
    const primary = icao || ident;
    if (Math.abs(primary.length - q.length) <= 2) {
      const d = levenshtein(primary, q, 2);
      if (d === 1) return 55;
      if (d === 2) return 35;
    }
    return 0;
  }
  function scoreVfrAt(i, q, qS) {
    if (!q) return 1;
    const v = VF[i];
    const ident = v[0], name = v[1] || '', airport = v[3] || '';
    if (ident === q) return 1000;
    if (ident.startsWith(q)) return 500 - ident.length;
    const nameUp = name.toUpperCase();
    if (nameUp === q) return 950;
    if (nameUp.startsWith(q)) return 250;
    if (airport && airport === q) return 700;
    if (ident.includes(q)) return 200;
    if (nameUp.includes(q)) return 100;
    if (qS && VF_SOUNDEX[i] === qS) return 80;
    if (Math.abs(ident.length - q.length) <= 2) {
      const d = levenshtein(ident, q, 2);
      if (d === 1) return 60;
      if (d === 2) return 40;
    }
    return 0;
  }

  // --------------------------------------------------------------
  // SEARCH
  // --------------------------------------------------------------
  const MAX_RESULTS = 80;

  function runSearch() {
    const q = state.query.trim().toUpperCase();
    const qS = q ? soundex(q) : '';
    const region = state.region, country = state.country, typeFilter = state.type;
    const collected = [];
    const wantWP = !typeFilter || typeFilter === 'wp';
    const wantNV = !typeFilter || typeFilter === 'nv';
    const wantAP = !typeFilter || typeFilter === 'ap';
    const wantVF = !typeFilter || typeFilter === 'vf';

    let targetCountries = null, nearbySet = null;
    if (country) {
      const nearby = NEARBY_COUNTRIES.get(country) || [];
      targetCountries = [country, ...nearby];
      nearbySet = new Set(nearby);
    }

    function scanCG(byC, scorer, type) {
      for (const cc of targetCountries) {
        const indices = byC[cc] || [];
        const isNearby = nearbySet.has(cc);
        for (let k = 0; k < indices.length; k++) {
          const i = indices[k];
          let s = scorer(i, q, qS);
          if (s > 0) {
            if (isNearby) s = Math.max(1, s - 30);
            collected.push({ score: s, type, idx: i, nearby: isNearby });
          }
        }
      }
    }
    function scanAll(arr, scorer, type, ccGetter) {
      for (let i = 0; i < arr.length; i++) {
        if (region && COUNTRY_REGION.get(ccGetter(arr[i])) !== region) continue;
        const s = scorer(i, q, qS);
        if (s > 0) collected.push({ score: s, type, idx: i, nearby: false });
      }
    }

    if (wantWP) targetCountries ? scanCG(WP_BY_C, scoreWaypointAt, 'wp') : scanAll(WP, scoreWaypointAt, 'wp', w => w[1]);
    if (wantNV) targetCountries ? scanCG(NV_BY_C, scoreNavaidAt,  'nv') : scanAll(NV, scoreNavaidAt,  'nv', n => n[3]);
    if (wantAP) targetCountries ? scanCG(AP_BY_C, scoreAirportAt, 'ap') : scanAll(AP, scoreAirportAt, 'ap', a => a[3]);
    if (wantVF) targetCountries ? scanCG(VF_BY_C, scoreVfrAt,     'vf') : scanAll(VF, scoreVfrAt,     'vf', v => v[2]);

    collected.sort((x, y) => y.score - x.score);
    return {
      rows: collected.slice(0, MAX_RESULTS),
      totalMatches: collected.length,
      nearbyExpanded: !!country,
    };
  }

  function shouldShowEmptyState() {
    return !state.query && !state.region && !state.country && !state.type;
  }

  function renderResults() {
    if (shouldShowEmptyState()) {
      metaEl.textContent = '';
      resultsEl.innerHTML =
        '<div class="empty-state">' +
          '<div class="hint-icon">🔍</div>' +
          'Type to search, or pick a region or country to start browsing.' +
        '</div>';
      return;
    }
    const { rows, totalMatches, nearbyExpanded } = runSearch();
    if (totalMatches === 0) {
      metaEl.textContent = '';
      resultsEl.innerHTML =
        '<div class="empty-state">' +
          '<div class="hint-icon">∅</div>' +
          'No matches. Try widening your filters or different keywords.' +
        '</div>';
      return;
    }
    let metaText = 'Showing ' + Math.min(rows.length, totalMatches).toLocaleString() +
      ' of ' + totalMatches.toLocaleString() +
      (totalMatches === 1 ? ' match' : ' matches');
    if (nearbyExpanded) metaText += ' (incl. nearby countries)';
    metaEl.textContent = metaText;
    resultsEl.innerHTML = rows.map(rowHtml).join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function metaCountry(cc) {
    const cname = COUNTRY_NAME.get(cc) || '';
    if (cc && cname) return escapeHtml(cc) + ' · ' + escapeHtml(cname);
    if (cc) return escapeHtml(cc);
    if (cname) return escapeHtml(cname);
    return '<span class="country-missing">—</span>';
  }

  function rowHtml(r) {
    const nt = r.nearby ? '<span class="near-tag">Nearby</span>' : '';
    if (r.type === 'wp') {
      const w = WP[r.idx];
      const cv = w[0].toUpperCase();
      return '<div class="row' + (r.nearby ? ' is-nearby' : '') + '">' +
        '<div class="info">' +
          '<div class="line1">' +
            '<span class="ident">' + escapeHtml(w[0]) + '</span>' +
            '<span class="type-tag wp">Waypoint</span>' +
          '</div>' +
          '<div class="meta">' +
            '<span class="country">' + metaCountry(w[1]) + '</span>' +
            nt +
          '</div>' +
        '</div>' +
        '<button class="copy-btn" data-copy="' + escapeHtml(cv) + '" title="Copy ident">Copy</button>' +
      '</div>';
    } else if (r.type === 'nv') {
      const n = NV[r.idx];
      const cv = n[0].toUpperCase();
      const navTypePill = n[2] ? '<span class="navaid-type">' + escapeHtml(n[2]) + '</span>' : '';
      const nameLine = n[1] ? '<div class="name">' + escapeHtml(n[1]) + '</div>' : '';
      return '<div class="row' + (r.nearby ? ' is-nearby' : '') + '">' +
        '<div class="info">' +
          '<div class="line1">' +
            '<span class="ident navaid">' + escapeHtml(n[0]) + '</span>' +
            navTypePill +
            '<span class="type-tag nv">Navaid</span>' +
          '</div>' +
          nameLine +
          '<div class="meta">' +
            '<span class="country">' + metaCountry(n[3]) + '</span>' +
            nt +
          '</div>' +
        '</div>' +
        '<button class="copy-btn" data-copy="' + escapeHtml(cv) + '" title="Copy ident">Copy</button>' +
      '</div>';
    } else if (r.type === 'vf') {
      const v = VF[r.idx];
      const cv = v[0].toUpperCase();
      const nameLine = v[1] ? '<div class="name">' + escapeHtml(v[1]) + '</div>' : '';
      const apTag = v[3] ? '<span class="vfr-airport">' + escapeHtml(v[3]) + '</span>' : '';
      return '<div class="row' + (r.nearby ? ' is-nearby' : '') + '">' +
        '<div class="info">' +
          '<div class="line1">' +
            '<span class="ident vfr">' + escapeHtml(v[0]) + '</span>' +
            apTag +
            '<span class="type-tag vf">VFR</span>' +
          '</div>' +
          nameLine +
          '<div class="meta">' +
            '<span class="country">' + metaCountry(v[2]) + '</span>' +
            nt +
          '</div>' +
        '</div>' +
        '<button class="copy-btn" data-copy="' + escapeHtml(cv) + '" title="Copy ident">Copy</button>' +
      '</div>';
    } else {
      const a = AP[r.idx];
      const primary = a[5] || a[0];
      const cv = primary.toUpperCase();
      const iata = a[4] ? '<span class="iata">' + escapeHtml(a[4]) + '</span>' : '';
      const nameLine = a[2] ? '<div class="name">' + escapeHtml(a[2]) + '</div>' : '';
      return '<div class="row' + (r.nearby ? ' is-nearby' : '') + '">' +
        '<div class="info">' +
          '<div class="line1">' +
            '<span class="ident airport">' + escapeHtml(primary) + '</span>' +
            iata +
            '<span class="type-tag ap">Airport</span>' +
          '</div>' +
          nameLine +
          '<div class="meta">' +
            '<span class="country">' + metaCountry(a[3]) + '</span>' +
            nt +
          '</div>' +
        '</div>' +
        '<button class="copy-btn" data-copy="' + escapeHtml(cv) + '" title="Copy ident">Copy</button>' +
      '</div>';
    }
  }

  // --------------------------------------------------------------
  // COUNTRY COMBOBOX
  // --------------------------------------------------------------
  function listCountriesFor(query, regionFilter) {
    const q = query.trim().toUpperCase();
    const out = [];
    for (const [cc, name] of COUNTRY_NAME) {
      const r = COUNTRY_REGION.get(cc) || '';
      if (regionFilter && r !== regionFilter) continue;
      if (!q) { out.push({ cc, name, score: 0 }); continue; }
      const nameUp = name.toUpperCase();
      let s = 0;
      if (cc === q) s = 1000;
      else if (nameUp === q) s = 900;
      else if (cc.startsWith(q)) s = 500;
      else if (nameUp.startsWith(q)) s = 400;
      else if (nameUp.includes(q)) s = 100;
      if (s > 0) out.push({ cc, name, score: s });
    }
    out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return out.slice(0, 50);
  }

  function renderCountryDropdown() {
    const items = listCountriesFor(countryInput.value, state.region);
    if (items.length === 0) {
      countryDropdown.innerHTML = '<div class="item empty">No countries match</div>';
      countryDropdown.classList.add('open');
      return;
    }
    countryDropdown.innerHTML = items.map(({ cc, name }) => {
      const w = (WP_BY_C[cc] || []).length;
      const a = (AP_BY_C[cc] || []).length;
      const n = (NV_BY_C[cc] || []).length;
      const v = (VF_BY_C[cc] || []).length;
      const parts = [];
      if (w) parts.push(w.toLocaleString() + ' wp');
      if (n) parts.push(n.toLocaleString() + ' navaids');
      if (a) parts.push(a.toLocaleString() + ' airports');
      if (v) parts.push(v.toLocaleString() + ' VFR');
      const meta = parts.length ? parts.join(' · ') : 'no entries';
      return '<div class="item" data-cc="' + escapeHtml(cc) + '">' +
        '<span class="code">' + escapeHtml(cc) + '</span>' + escapeHtml(name) +
        '<div class="meta">' + meta + '</div>' +
      '</div>';
    }).join('');
    countryDropdown.classList.add('open');
  }

  function selectCountry(cc) {
    state.country = cc;
    countryInput.value = COUNTRY_NAME.get(cc) || cc;
    countryCombobox.classList.add('has-value');
    countryDropdown.classList.remove('open');
    renderResults();
  }
  function clearCountry() {
    state.country = '';
    countryInput.value = '';
    countryCombobox.classList.remove('has-value');
    countryDropdown.classList.remove('open');
    renderResults();
  }

  // --------------------------------------------------------------
  // EVENT WIRING
  // --------------------------------------------------------------
  regionSel.addEventListener('change', () => {
    state.region = regionSel.value;
    if (state.country) {
      const r = COUNTRY_REGION.get(state.country);
      if (state.region && r !== state.region) clearCountry();
    }
    renderResults();
  });

  countryInput.addEventListener('focus', renderCountryDropdown);
  countryInput.addEventListener('input', () => {
    countryCombobox.classList.toggle('has-value', countryInput.value.length > 0);
    if (state.country && countryInput.value !== COUNTRY_NAME.get(state.country)) {
      state.country = '';
      renderResults();
    }
    renderCountryDropdown();
  });
  countryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      countryDropdown.classList.remove('open');
      countryInput.blur();
    } else if (e.key === 'Enter') {
      const first = countryDropdown.querySelector('.item[data-cc]');
      if (first) { e.preventDefault(); selectCountry(first.dataset.cc); }
    }
  });
  countryDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.item[data-cc]');
    if (item) selectCountry(item.dataset.cc);
  });
  document.addEventListener('click', (e) => {
    if (!countryCombobox.contains(e.target)) countryDropdown.classList.remove('open');
  });

  typePills.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    state.type = pill.dataset.type;
    typePills.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === pill));
    renderResults();
  });

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    searchWrap.classList.toggle('has-value', searchInput.value.length > 0);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(renderResults, 80);
  });

  document.querySelectorAll('.clear-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const which = btn.dataset.clear;
      if (which === 'country') {
        clearCountry();
        countryInput.focus();
      } else if (which === 'search') {
        searchInput.value = '';
        state.query = '';
        searchWrap.classList.remove('has-value');
        renderResults();
        searchInput.focus();
      }
    });
  });

  resultsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✓ Copied'; btn.classList.add('copied');
      showToast('Copied: ' + text);
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    } catch { showToast('Copy failed'); }
  });

  // --------------------------------------------------------------
  // THEME (light / dark)
  // --------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  async function initTheme() {
    const stored = await storageGet([THEME_KEY]);
    let theme = stored[THEME_KEY];
    if (theme !== 'light' && theme !== 'dark') {
      theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    applyTheme(theme);
  }
  themeToggle.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await storageSet({ [THEME_KEY]: next });
  });

  // --------------------------------------------------------------
  // TOAST
  // --------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // --------------------------------------------------------------
  // FACTS — rotating "Did you know?" footer
  // --------------------------------------------------------------
  const FACTS = [
    "The Wright Brothers' first powered flight in 1903 lasted just 12 seconds and covered 120 feet — shorter than the wingspan of a Boeing 747.",
    "KLM, founded in 1919 in the Netherlands, is the world's oldest airline still operating under its original name.",
    "The Concorde crossed the Atlantic in under 3 hours, cruising at Mach 2.04 — more than twice the speed of sound.",
    "The first commercial jet airliner was the de Havilland Comet, which entered service in 1952 — three years before the Boeing 707.",
    "Charles Lindbergh's 1927 solo Atlantic crossing took 33.5 hours; modern jets do the trip in about 7.",
    "A Boeing 747's wings flex up to 26 feet during flight, absorbing turbulence like a diving board.",
    "The 'black box' flight recorder is actually bright orange — designed to be easy to spot after an accident.",
    "Lightning strikes commercial aircraft about once a year on average, but modern airframes safely route the current away.",
    "The tiny hole in your aircraft window is a 'breather hole' — it balances pressure between the two window panes.",
    "Most commercial jets cruise at about Mach 0.85 — roughly 85% of the speed of sound at altitude.",
    "A typical commercial airliner has over 6 million parts, and roughly half of them are fasteners.",
    "ICAO waypoint names are five letters, pronounceable, unique worldwide, and deliberately not real words in any major language.",
    "A 'fix' in aviation is any defined geographic position used for navigation — five-letter waypoints, navaids, and intersections all qualify.",
    "Modern GPS-based RNAV (Area Navigation) lets aircraft fly direct routes between any two points instead of zig-zagging between ground beacons.",
    "RNP (Required Navigation Performance) standards specify how accurately an aircraft must hold its course — RNP 0.1 means within 0.1 nautical miles.",
    "VORs (VHF Omnidirectional Range stations) have been the backbone of airway navigation since the 1940s — many are still in use today.",
    "An NDB (Non-Directional Beacon) is one of the oldest navaids in service, requiring only an ADF receiver in the cockpit.",
    "ILS (Instrument Landing System) provides both lateral (localizer) and vertical (glideslope) guidance to a runway in low visibility.",
    "DME (Distance Measuring Equipment) measures slant-range distance using radar pulses between aircraft and ground station.",
    "TACAN (Tactical Air Navigation) is the military equivalent of VOR-DME, combining both functions into a single beacon.",
    "VFR reporting points are named visual landmarks — towns, bridges, lakes — that pilots flying under Visual Flight Rules use to navigate and report position to ATC.",
    "Mandatory VFR reporting points appear on aeronautical charts as solid magenta triangles; non-mandatory points are open triangles.",
    "Many busy VFR airports publish 'visual circuit' routes via reporting points, so pilots can self-separate without radar coverage.",
    "Aviation uses UTC — 'Zulu time' — worldwide, so a flight plan reads the same in Tokyo and Toronto.",
    "The ICAO phonetic alphabet runs Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet…",
    "A runway's number is its magnetic heading divided by ten: runway 27 points roughly 270°, or due west.",
    "Squawk codes 7500, 7600 and 7700 mean hijacking, lost communications and general emergency — pilots avoid them in routine use.",
    "SIDs (Standard Instrument Departures) and STARs (Standard Terminal Arrival Routes) are pre-planned procedures connecting airways to airports.",
    "ATIS (Automatic Terminal Information Service) broadcasts current weather and runway info on a continuous loop, freeing controllers from repeating it.",
    "PAPI (Precision Approach Path Indicator) lights show pilots their glideslope: four reds means too low, four whites means too high, two-and-two is just right.",
    "Cabin air at cruising altitude is pressurised to the equivalent of about 8,000 feet — roughly the elevation of Aspen, Colorado.",
    "Dry cabin air and low pressure dull your taste buds by around 30%, which is why airline tomato juice tastes unexpectedly good.",
    "Contrails form when hot, humid engine exhaust meets cold, low-pressure air at cruising altitude — instant cloud-making.",
    "The tropopause — the boundary between troposphere and stratosphere — sits at about 36,000 feet, conveniently the cruising altitude of most jets.",
    "'Coffin corner' describes the high-altitude squeeze where stall speed and Mach buffet speed converge — the higher you go, the narrower the safe envelope.",
    "Pilots and co-pilots eat different meals before a flight — a safeguard against both being affected by food poisoning at the same time.",
    "The shortest scheduled flight, between Westray and Papa Westray in Scotland, averages under 90 seconds in the air.",
    "The longest non-stop commercial flight is Singapore to New York, covering roughly 9,500 miles in about 18½ hours.",
    "Every aircraft registered in the United States has a tail number starting with the letter 'N'.",
    "The Mach number is named after Austrian physicist Ernst Mach, who first described how shock waves form around fast-moving objects.",
    "V1 is the takeoff 'decision speed' — past V1 the pilot is committed to taking off; below it, an abort on the runway is still safe.",
    "Wake turbulence categories — light, medium, heavy, super — determine how far apart aircraft must space themselves on approach.",
    "Class A airspace covers 18,000 to 60,000 feet over the continental US and is reserved for IFR (instrument) flight only.",
  ];
  let factTimer = null;
  function startFacts() {
    let factIdx = Math.floor(Math.random() * FACTS.length);
    factTextEl.textContent = FACTS[factIdx];
    clearInterval(factTimer);
    factTimer = setInterval(() => {
      factTextEl.classList.add('fade-out');
      setTimeout(() => {
        let next = Math.floor(Math.random() * FACTS.length);
        if (next === factIdx) next = (next + 1) % FACTS.length;
        factIdx = next;
        factTextEl.textContent = FACTS[factIdx];
        factTextEl.classList.remove('fade-out');
      }, 400);
    }, 10000);
  }

  // --------------------------------------------------------------
  // BOOT
  // --------------------------------------------------------------
  function showLoading() {
    metaEl.textContent = '';
    resultsEl.innerHTML =
      '<div class="empty-state">' +
        '<div class="hint-icon">⏳</div>' +
        'Loading aviation database…' +
      '</div>';
  }
  function showLoadError(err) {
    metaEl.textContent = '';
    resultsEl.innerHTML =
      '<div class="empty-state">' +
        '<div class="hint-icon">⚠️</div>' +
        'Could not load data: ' + escapeHtml(err.message || String(err)) +
      '</div>';
  }

  function buildByCountry(arr, ccGetter) {
    const out = {};
    for (let i = 0; i < arr.length; i++) {
      const cc = ccGetter(arr[i]);
      if (!cc) continue;
      (out[cc] = out[cc] || []).push(i);
    }
    return out;
  }

  async function boot() {
    showLoading();
    startFacts();
    initTheme();

    try {
      const [countriesJson, wpText, nvText, apText, vfText] = await Promise.all([
        fetchJSON('countries.json'),
        fetchText('waypoints.csv'),
        fetchText('navaids.csv'),
        fetchText('airports.csv'),
        fetchText('vfr.csv'),
      ]);

      for (const [cc, info] of Object.entries(countriesJson)) {
        COUNTRY_NAME.set(cc, info.name || cc);
        COUNTRY_REGION.set(cc, info.region || '');
        NEARBY_COUNTRIES.set(cc, info.nearby || []);
      }

      {
        const { rows } = parseCSV(wpText);
        WP = rows.map(r => [r[0], r[1]]);
        WP_BY_C = buildByCountry(WP, w => w[1]);
        WP_SOUNDEX = new Array(WP.length);
        for (let i = 0; i < WP.length; i++) WP_SOUNDEX[i] = soundex(WP[i][0]);
      }
      {
        const { rows } = parseCSV(nvText);
        NV = rows.map(r => [r[0], r[1], r[2], r[3]]);
        NV_BY_C = buildByCountry(NV, n => n[3]);
        NV_SOUNDEX = new Array(NV.length);
        for (let i = 0; i < NV.length; i++) NV_SOUNDEX[i] = soundex(NV[i][0]);
      }
      {
        const { rows } = parseCSV(apText);
        AP = rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5]]);
        AP_BY_C = buildByCountry(AP, a => a[3]);
        AP_SOUNDEX = new Array(AP.length);
        for (let i = 0; i < AP.length; i++) {
          AP_SOUNDEX[i] = soundex(AP[i][5] || AP[i][0]);
        }
      }
      {
        const { rows } = parseCSV(vfText);
        VF = rows.map(r => [r[0], r[1], r[2], r[3]]);
        VF_BY_C = buildByCountry(VF, v => v[2]);
        VF_SOUNDEX = new Array(VF.length);
        for (let i = 0; i < VF.length; i++) VF_SOUNDEX[i] = soundex(VF[i][0]);
      }

      searchInput.focus();
      renderResults();
    } catch (err) {
      console.error('[PCF] data load failed', err);
      showLoadError(err);
    }
  }

  boot();
})();
