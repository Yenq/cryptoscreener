import { CandleChart, enableRuler, onChartDblClick } from './chart.js';
import { openCoin } from './modal.js';
import { api, debounce, esc, EXCHANGES, exLabel, fmtPct, fmtVol, prefs, qs, sign, MARKETS } from './util.js';

const WINDOWS = [
  ['5m', 'За 5м'], ['15m', 'За 15м'], ['1h', 'За 1ч'], ['4h', 'За 4ч'], ['24h', 'За 24ч'],
];
const FIELD = { '5m': 'ch5m', '15m': 'ch15m', '1h': 'ch1h', '4h': 'ch4h', '24h': 'ch24h' };
const OI_FIELD = { '5m': 'oi5m', '15m': 'oi15m', '1h': 'oi1h', '4h': 'oi4h', '24h': 'oi24h' };
const DIRS = [['up', 'Рост ▲'], ['down', 'Падение ▼'], ['abs', 'Движение ±']];
const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const GRIDS = [['2x2', '4 (2×2)'], ['3x2', '6 (3×2)'], ['3x3', '9 (3×3)'], ['4x3', '12 (4×3)'], ['4x4', '16 (4×4)']];
const MIN_VOLS = [[0, 'Любой'], [1e5, '≥ 100K'], [5e5, '≥ 500K'], [1e6, '≥ 1M'], [5e6, '≥ 5M'], [1e7, '≥ 10M'], [5e7, '≥ 50M']];

const REFRESH_MS = 4000;
const KLINE_REFRESH_MS = 30000;

export function mount(root, ctx) {
  const p = prefs.data;
  root.innerHTML = `
    <div class="toolbar">
      <div class="group" data-f="market">${Object.entries(MARKETS).map(([k, l]) => `<button data-v="${k}">${l}</button>`).join('')}</div>
      <div data-f="exchanges" style="display:flex;gap:6px;flex-wrap:wrap">
        ${EXCHANGES.map(e => `<button class="chip" data-ex="${e.name}" style="--c:${e.color}"><i></i>${e.label}</button>`).join('')}
        <button class="chip" data-f="dedupe" style="--c:var(--up)" title="Показывать каждую монету один раз — с той биржи, где у неё больше оборот"><i></i>Без дублей</button>
      </div>
      <span class="sep"></span>
      <select data-f="by" title="Что сортировать: изменение цены или изменение открытого интереса (только фьючерсы)">
        <option value="price">Цена</option><option value="oi">Открытый интерес</option>
      </select>
      <select data-f="window" title="За какой период считать изменение">${WINDOWS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <select data-f="dir">${DIRS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <select data-f="minvol" title="Минимальный оборот за 24ч">${MIN_VOLS.map(([v, l]) => `<option value="${v}">Объём ${l}</option>`).join('')}</select>
      <input type="search" data-f="q" placeholder="Поиск монеты" style="width:130px">
      <span class="spacer"></span>
      <span class="hint" title="ПКМ по плитке — большой график (ПКМ по линии 🔔 — удалить алерт). Двойной клик ЛКМ по графику — разовый алерт на цену в этой точке. Shift + средняя кнопка мыши (зажать и вести) — линейка." style="cursor:help;font-size:15px">ⓘ</span>
      <div class="group" data-f="tf" title="Таймфрейм графиков">${TFS.map(t => `<button data-v="${t}">${t}</button>`).join('')}</div>
      <select data-f="grid" title="Сколько графиков показывать">${GRIDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    </div>
    <div class="tiles" data-f="tiles"></div>`;
  const $ = f => root.querySelector(`[data-f="${f}"]`);
  const tilesEl = $('tiles');

  // --- состояние контролов ----------------------------------------------
  const syncControls = () => {
    $('market').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === p.sMarket));
    $('tf').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === p.sTf));
    $('exchanges').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', p.sExchanges.includes(b.dataset.ex)));
    $('dedupe').classList.toggle('on', p.sDedupe);
    if (p.sMarket === 'spot' && p.sBy === 'oi') p.sBy = 'price'; // ОИ есть только у фьючерсов
    $('by').querySelector('[value=oi]').disabled = p.sMarket === 'spot';
    $('by').value = p.sBy;
    $('window').value = p.sWindow;
    $('dir').value = p.sDir;
    $('minvol').value = String(p.sMinVol);
    $('grid').value = p.sGrid;
    tilesEl.style.setProperty('--cols', p.sGrid.split('x')[0]);
  };
  syncControls();

  // --- плитки -------------------------------------------------------------
  const tiles = new Map(); // key -> tile
  const queue = [];
  let active = 0;
  const enqueue = fn => { queue.push(fn); pump(); };
  function pump() {
    while (active < 4 && queue.length) {
      const fn = queue.shift();
      active++;
      fn().finally(() => { active--; pump(); });
    }
  }

  function createTile(row) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = `
      <div class="tile-wm">${esc(row.base)}</div>
      <div class="tile-chart"></div>
      <div class="tile-badges"></div>
      <div class="tile-actions">
        <button data-act="alert" title="Создать алерт">🔔</button>
        <a data-act="open" target="_blank" rel="noopener" href="${esc(row.url)}" title="Открыть на бирже">↗</a>
      </div>`;
    const tile = { key: row.key, row, el, loading: false, lastLoad: 0, dead: false,
                   chart: new CandleChart(el.querySelector('.tile-chart'), p.sTf), tf: p.sTf };
    // ПКМ — большой график, двойной ЛКМ — разовый алерт на цену в точке клика
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const alertId = tile.chart.alertAt(el, e); // ПКМ по линии алерта удаляет его
      if (alertId) ctx.deleteAlert(alertId, tile.row);
      else openCoin(tile.row, ctx, { tf: p.sTf });
    });
    el.addEventListener('click', e => {
      if (e.target.closest('[data-act=alert]')) ctx.createAlertFor(tile.row);
    });
    onChartDblClick(el, tile.chart, price => ctx.addPriceAlert(tile.row, price));
    enableRuler(el, tile.chart);
    enqueue(() => loadKlines(tile));
    return tile;
  }

  async function loadKlines(tile) {
    if (tile.dead || tile.loading) return;
    tile.loading = true;
    const tf = p.sTf;
    try {
      const { exchange, market, symbol } = tile.row;
      const data = await api('/klines?' + qs({ exchange, market, symbol, interval: tf, limit: 120 }));
      if (tile.dead || tf !== p.sTf) return;
      tile.chart.setInterval(tf);
      tile.chart.setData(data);
      tile.el.classList.remove('err');
    } catch {
      if (!tile.chart.last) tile.el.classList.add('err');
    } finally {
      tile.lastLoad = Date.now();
      tile.loading = false;
    }
  }

  function updateTile(tile, row) {
    tile.row = row;
    const f = FIELD[p.sWindow];
    const pricePill = `<span class="pill ${sign(row[f])}">${fmtPct(row[f])}</span>`;
    const oiPill = row.market === 'futures'
      ? `<span class="pill ${sign(row[OI_FIELD[p.sWindow]])}" title="Изменение открытого интереса за период">ОИ ${fmtPct(row[OI_FIELD[p.sWindow]])}</span>` : '';
    tile.el.querySelector('.tile-badges').innerHTML =
      (p.sBy === 'oi' ? oiPill + pricePill : pricePill + oiPill) +
      (p.sWindow !== '24h' ? `<span class="pill ${sign(row.ch24h)}" title="За 24ч">24ч ${fmtPct(row.ch24h)}</span>` : '') +
      `<span class="pill natr" title="NATR 5/14">${row.natr === null ? '—' : row.natr.toFixed(2)}</span>` +
      `<span class="pill vol" title="Оборот за 24ч">${fmtVol(row.volume)}</span>` +
      `<span class="pill ex">${esc(exLabel(row.exchange))}</span>`;
    tile.chart.tick(row.price);
    tile.chart.setAlertLines(ctx.priceAlerts(row));
    if (!tile.loading && Date.now() - tile.lastLoad > KLINE_REFRESH_MS) enqueue(() => loadKlines(tile));
  }

  function destroyTile(tile) {
    tile.dead = true;
    tile.chart.destroy();
    tile.el.remove();
    tiles.delete(tile.key);
  }

  function clearTiles() {
    [...tiles.values()].forEach(destroyTile);
  }

  function showEmpty(text) {
    clearTiles();
    tilesEl.innerHTML = `<div class="empty">${text}</div>`;
  }

  function reconcile(rows) {
    tilesEl.querySelector('.empty')?.remove();
    const want = new Set(rows.map(r => r.key));
    for (const t of [...tiles.values()]) if (!want.has(t.key)) destroyTile(t);
    rows.forEach((row, i) => {
      let tile = tiles.get(row.key);
      if (!tile) {
        tile = createTile(row);
        tiles.set(row.key, tile);
      }
      if (tilesEl.children[i] !== tile.el) tilesEl.insertBefore(tile.el, tilesEl.children[i] || null);
      updateTile(tile, row);
    });
  }

  // --- загрузка данных -----------------------------------------------------
  let seq = 0;
  async function refresh() {
    const mySeq = ++seq;
    if (!p.sExchanges.length) return showEmpty('Выбери хотя бы одну биржу');
    const [cols, rows] = p.sGrid.split('x').map(Number);
    try {
      const data = await api('/screener?' + qs({
        market: p.sMarket, exchanges: p.sExchanges.join(','), window: p.sWindow, direction: p.sDir, by: p.sBy,
        limit: cols * rows, min_volume: p.sMinVol, q: $('q').value, dedupe: p.sDedupe,
      }));
      if (mySeq !== seq) return;
      if (!data.rows.length) {
        showEmpty('Нет монет под эти фильтры.<br><span class="hint">Если сервис только что запущен — подожди минуту-две: минутные свечи для расчёта 5м/15м/1ч/4ч подгружаются по очереди.</span>');
      } else {
        reconcile(data.rows);
      }
    } catch (e) {
      if (mySeq === seq && !tiles.size) showEmpty('Не удалось получить данные: ' + esc(e.message));
    }
  }

  const refreshSoon = debounce(refresh, 150);
  const change = (key, value, { reset = false, reload = false } = {}) => {
    p[key] = value;
    prefs.save();
    syncControls();
    if (reset) clearTiles();
    if (reload) tiles.forEach(t => { t.lastLoad = 0; enqueue(() => loadKlines(t)); });
    refreshSoon();
  };

  // --- события -------------------------------------------------------------
  $('market').addEventListener('click', e => { const v = e.target.dataset.v; if (v) change('sMarket', v, { reset: true }); });
  $('tf').addEventListener('click', e => { const v = e.target.dataset.v; if (v) change('sTf', v, { reload: true }); });
  $('exchanges').addEventListener('click', e => {
    const ex = e.target.closest('.chip')?.dataset.ex;
    if (!ex) return;
    const set = new Set(p.sExchanges);
    set.has(ex) ? set.delete(ex) : set.add(ex);
    change('sExchanges', EXCHANGES.map(x => x.name).filter(n => set.has(n)));
  });
  $('dedupe').addEventListener('click', () => change('sDedupe', !p.sDedupe, { reset: true }));
  $('by').addEventListener('change', e => change('sBy', e.target.value));
  $('window').addEventListener('change', e => change('sWindow', e.target.value));
  $('dir').addEventListener('change', e => change('sDir', e.target.value));
  $('minvol').addEventListener('change', e => change('sMinVol', Number(e.target.value)));
  $('grid').addEventListener('change', e => change('sGrid', e.target.value));
  $('q').addEventListener('input', refreshSoon);

  const offAlerts = ctx.onAlertsChanged(() => tiles.forEach(t => t.chart.setAlertLines(ctx.priceAlerts(t.row))));
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  return () => {
    clearInterval(timer);
    offAlerts();
    seq++;
    clearTiles();
  };
}
