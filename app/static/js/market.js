import { ChartPanel } from './panel.js';
import { api, debounce, esc, EXCHANGES, exLabel, fmtPct, fmtPrice, fmtVol, prefs, qs, sign, MARKETS } from './util.js';

// колонки «m» появляются, когда список шире 400px, «x» — шире 560px (иначе в узком списке была бы прокрутка)
const COLUMNS = [
  { key: 'base', label: 'Монета' },
  { key: 'price', label: 'Цена', m: true },
  { key: 'ch24h', label: '24ч %' },
  { key: 'volume', label: 'Объём' },
  { key: 'natr', label: 'NATR' },
  { key: 'ch5m', label: '5м', x: true },
  { key: 'ch15m', label: '15м', x: true },
  { key: 'ch1h', label: '1ч', x: true },
  { key: 'ch4h', label: '4ч', x: true },
  { key: 'oi_usd', label: 'ОИ $', x: true, fut: true },
  { key: 'oiu1h', label: 'ОИ $ 1ч', x: true, fut: true },
  { key: 'oiu24h', label: 'ОИ $ 24ч', x: true, fut: true },
  { key: 'oi1h', label: 'ОИ мон. 1ч', x: true, fut: true },
  { key: 'oi24h', label: 'ОИ мон. 24ч', x: true, fut: true },
];
const MIN_VOLS = [[0, 'Любой'], [1e5, '≥ 100K'], [1e6, '≥ 1M'], [1e7, '≥ 10M'], [1e8, '≥ 100M']];
const PAGE = 150;
const REFRESH_MS = 5000;
const MIN_LIST = 180;

export function mount(root, ctx) {
  const p = prefs.data;
  root.innerHTML = `
    <div class="toolbar">
      <div class="group" data-f="exchange">${EXCHANGES.map(e => `<button data-v="${e.name}">${e.label}</button>`).join('')}</div>
      <div class="group" data-f="market">${Object.entries(MARKETS).map(([k, l]) => `<button data-v="${k}">${l}</button>`).join('')}</div>
      <input type="search" data-f="q" placeholder="Поиск монеты" style="width:140px">
      <select data-f="minvol" title="Минимальный оборот за 24ч">${MIN_VOLS.map(([v, l]) => `<option value="${v}">Объём ${l}</option>`).join('')}</select>
      <span class="spacer"></span>
      <span class="hint" data-f="info"></span>
      <button class="icon-btn" data-f="side" title="Список слева / справа">⇄</button>
    </div>
    <div class="mkt" data-f="mkt">
      <div class="mkt-charts">
        <div data-f="p0" class="p0"></div><div data-f="p1" class="p1"></div><div data-f="p2" class="p2"></div>
      </div>
      <div class="mkt-resizer" data-f="resizer" title="Потяни, чтобы изменить ширину списка"></div>
      <div class="mkt-list" data-f="list">
        <div class="table-wrap" data-f="wrap">
          <table class="coins compact"><thead data-f="head"></thead><tbody data-f="body"></tbody></table>
          <div class="more" data-f="more" hidden></div>
        </div>
      </div>
    </div>`;
  const $ = f => root.querySelector(`[data-f="${f}"]`);
  const mkt = $('mkt');

  // --- три графика одной монеты, у каждого свой таймфрейм ------------------------------
  const tfKeys = ['mTf0', 'mTf1', 'mTf2'];
  const panels = ['p0', 'p1', 'p2'].map((id, i) => new ChartPanel($(id), ctx, {
    tf: p[tfKeys[i]], withOi: i === 0, onTf: tf => { p[tfKeys[i]] = tf; prefs.save(); },
  }));

  // --- ширина списка ------------------------------------------------------------------------
  const clampW = w => Math.round(Math.min(Math.max(w, MIN_LIST), mkt.clientWidth * 0.6));
  $('list').style.width = clampW(p.mListW ?? mkt.clientWidth * 0.2) + 'px';
  mkt.classList.toggle('left', p.mSide === 'left');

  $('resizer').addEventListener('pointerdown', e => {
    e.preventDefault();
    const rz = $('resizer');
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    const move = ev => {
      const r = mkt.getBoundingClientRect();
      const w = clampW(p.mSide === 'left' ? ev.clientX - r.left : r.right - ev.clientX);
      $('list').style.width = w + 'px';
      p.mListW = w;
    };
    const up = () => {
      rz.classList.remove('drag');
      rz.removeEventListener('pointermove', move);
      rz.removeEventListener('pointerup', up);
      prefs.save();
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up);
  });
  $('side').addEventListener('click', () => {
    p.mSide = p.mSide === 'left' ? 'right' : 'left';
    prefs.save();
    mkt.classList.toggle('left', p.mSide === 'left');
  });

  // --- список ------------------------------------------------------------------------------------
  let rows = [];
  let sorted = [];
  let shown = PAGE;
  let selKey = p.mSel || null;

  const cols = () => COLUMNS.filter(c => !c.fut || p.mMarket === 'futures');

  function syncControls() {
    $('exchange').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === p.mExchange));
    $('market').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === p.mMarket));
    $('minvol').value = String(p.mMinVol);
    if (!cols().some(c => c.key === p.mSort)) p.mSort = 'volume';
    $('head').innerHTML = '<tr>' + cols().map(c =>
      `<th data-k="${c.key}" class="sortable ${c.x ? 'x' : ''} ${c.m ? 'm' : ''} ${c.key === p.mSort ? 'sorted' : ''}">${c.label}<span class="arr">${c.key === p.mSort ? (p.mDir > 0 ? '▲' : '▼') : ''}</span></th>`).join('') + '</tr>';
  }

  function applyFilters() {
    const q = $('q').value.trim().toUpperCase();
    const key = p.mSort;
    sorted = rows.filter(r => r.volume >= p.mMinVol && (!q || r.base.includes(q)));
    sorted.sort((a, b) => {
      if (key === 'base') return p.mDir * a.base.localeCompare(b.base);
      const x = a[key], y = b[key];
      const xn = x === null || x === undefined, yn = y === null || y === undefined;
      if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1; // пустые всегда внизу
      return p.mDir * (x - y);
    });
  }

  const cell = (r, c) => {
    const v = r[c.key];
    const cls = (c.x ? 'x ' : '') + (c.m ? 'm ' : '');
    switch (c.key) {
      case 'base': return `<td class="${cls}name">${esc(r.base)}</td>`;
      case 'price': return `<td class="${cls}">${fmtPrice(r.price)}</td>`;
      case 'volume': return `<td>$${fmtVol(v)}</td>`;
      case 'oi_usd': return `<td class="${cls}">${v === null ? '—' : '$' + fmtVol(v)}</td>`;
      case 'natr': return `<td>${v === null ? '—' : v.toFixed(2) + '%'}</td>`;
      default: return `<td class="${cls}${sign(v)}">${fmtPct(v)}</td>`;
    }
  };

  function renderList() {
    applyFilters();
    syncControls();
    const cs = cols();
    $('body').innerHTML = sorted.slice(0, shown).map(r =>
      `<tr data-key="${esc(r.key)}" class="${r.key === selKey ? 'sel' : ''}">${cs.map(c => cell(r, c)).join('')}</tr>`).join('');
    const more = $('more');
    more.hidden = sorted.length <= shown;
    more.textContent = `Показано ${shown} из ${sorted.length}`;
    $('info').textContent = `${exLabel(p.mExchange)} · ${MARKETS[p.mMarket]}: ${rows.length} монет`;
  }

  function select(key, { scroll = false } = {}) {
    const row = rows.find(r => r.key === key);
    if (!row) return;
    const changed = key !== selKey || !panels[0].row;
    selKey = key;
    p.mSel = key;
    prefs.save();
    $('body').querySelectorAll('tr.sel').forEach(tr => tr.classList.remove('sel'));
    const tr = [...$('body').children].find(t => t.dataset.key === key);
    tr?.classList.add('sel');
    if (scroll) tr?.scrollIntoView({ block: 'nearest' });
    if (changed) panels.forEach(pl => pl.setRow(row));
  }

  let seq = 0;
  async function load() {
    const my = ++seq;
    try {
      const data = await api('/tickers?' + qs({ exchange: p.mExchange, market: p.mMarket }));
      if (my !== seq) return;
      rows = data.rows;
      renderList();
      const sel = rows.find(r => r.key === selKey);
      if (sel) {
        if (panels[0].row?.key === selKey) panels.forEach(pl => pl.update(sel));
        else select(selKey);
      } else if (sorted.length) {
        select(sorted[0].key);
      }
    } catch (e) {
      if (my === seq) $('info').textContent = 'Ошибка загрузки: ' + e.message;
    }
  }

  const change = (key, value, reload) => {
    p[key] = value;
    prefs.save();
    shown = PAGE;
    if (reload) { rows = []; sorted = []; selKey = null; $('body').innerHTML = ''; load(); }
    renderList();
  };
  $('exchange').addEventListener('click', e => { const v = e.target.dataset.v; if (v) change('mExchange', v, true); });
  $('market').addEventListener('click', e => { const v = e.target.dataset.v; if (v) change('mMarket', v, true); });
  $('minvol').addEventListener('change', e => change('mMinVol', Number(e.target.value)));
  $('q').addEventListener('input', debounce(() => { shown = PAGE; $('wrap').scrollTop = 0; renderList(); }, 120));

  $('head').addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const k = th.dataset.k;
    if (p.mSort === k) p.mDir = -p.mDir;
    else { p.mSort = k; p.mDir = k === 'base' ? 1 : -1; }
    prefs.save();
    $('wrap').scrollTop = 0;
    shown = PAGE;
    renderList();
  });
  $('body').addEventListener('click', e => {
    const key = e.target.closest('tr')?.dataset.key;
    if (key) select(key);
  });
  $('wrap').addEventListener('scroll', () => {
    const w = $('wrap');
    if (shown < sorted.length && w.scrollTop + w.clientHeight > w.scrollHeight - 300) { shown += PAGE; renderList(); }
  });

  // стрелки вверх/вниз — переключение монеты
  const onKey = e => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || document.querySelector('.overlay')) return;
    const i = sorted.findIndex(r => r.key === selKey);
    const next = sorted[Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), sorted.length - 1)];
    if (next) { e.preventDefault(); if (sorted.indexOf(next) >= shown) { shown += PAGE; renderList(); } select(next.key, { scroll: true }); }
  };
  document.addEventListener('keydown', onKey);

  syncControls();
  load();
  const timer = setInterval(load, REFRESH_MS);
  return () => {
    clearInterval(timer);
    seq++;
    document.removeEventListener('keydown', onKey);
    panels.forEach(pl => pl.destroy());
  };
}
