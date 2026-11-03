import { CandleChart, enableRuler, onChartDblClick } from './chart.js';
import { OiPane } from './oi.js';
import { api, esc, exLabel, fmtPct, fmtPrice, fmtVol, qs, sign, MARKETS } from './util.js';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** Большой график монеты. Двойной клик по графику ставит разовый алерт на цену. */
export function openCoin(row, ctx, { tf = '5m', setup = null } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog">
      <div class="modal-head">
        <h3>${esc(row.base)}</h3>
        <span class="pill ex">${esc(exLabel(row.exchange))} · ${MARKETS[row.market]}</span>
        <span class="price" data-f="price"></span>
        <span class="pill" data-f="ch24h"></span>
        <div class="group" data-f="tfs">${TFS.map(t => `<button data-tf="${t}">${t}</button>`).join('')}</div>
        <span class="spacer"></span>
        <span class="hint" title="Двойной клик ЛКМ — алерт на цену. ПКМ по линии 🔔 — удалить. Shift + средняя кнопка мыши (зажать и вести) — линейка">2×ЛКМ — алерт · Shift+СКМ — линейка</span>
        <button class="btn ghost small" data-act="alert" title="Открыть страницу алертов">🔔</button>
        <a class="btn ghost small" target="_blank" rel="noopener" href="${esc(row.url)}">Открыть на бирже ↗</a>
        <button class="x-btn" data-act="close" title="Закрыть (Esc)">✕</button>
      </div>
      <div class="modal-chart"></div>
      <div class="modal-oi"></div>
      <div class="modal-stats" data-f="stats"></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = f => ov.querySelector(`[data-f="${f}"]`);
  const chartEl = ov.querySelector('.modal-chart');
  const chart = new CandleChart(chartEl, tf, { logo: true, scaleWidth: 74 });
  const oi = row.market === 'futures' ? new OiPane(ov.querySelector('.modal-oi'), chart) : null;
  let dead = false;
  const drawLines = () => chart.setAlertLines(ctx.priceAlerts(row));
  const offAlerts = ctx.onAlertsChanged(drawLines);
  onChartDblClick(chartEl, chart, price => ctx.addPriceAlert(row, price));
  enableRuler(chartEl, chart);
  chartEl.addEventListener('contextmenu', e => {
    const id = chart.alertAt(chartEl, e);
    if (id) { e.preventDefault(); ctx.deleteAlert(id, row); }
  });

  const markTf = () => $('tfs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf));

  async function loadKlines() {
    try {
      const data = await api('/klines?' + qs({ exchange: row.exchange, market: row.market, symbol: row.symbol, interval: tf, limit: 300 }));
      if (dead) return;
      chart.setData(data);
      chart.setSetup(setup && tf === setup.tf ? setup : null); // уровень и касания — только на таймфрейме сетапа
      drawLines();
      oi?.render();
    } catch (e) { console.error('klines', e); /* повторим на следующем тике */ }
  }

  async function loadTicker() {
    try {
      const r = await api('/ticker?' + qs({ exchange: row.exchange, market: row.market, symbol: row.symbol }));
      if (dead) return;
      row = { ...row, ...r };
      $('price').textContent = fmtPrice(r.price);
      const p = $('ch24h');
      p.textContent = '24ч ' + fmtPct(r.ch24h);
      p.className = 'pill ' + sign(r.ch24h);
      const cell = (l, v, c = '') => `<div><span>${l}</span><b class="${c}">${v}</b></div>`;
      $('stats').innerHTML =
        cell('5м', fmtPct(r.ch5m), sign(r.ch5m)) + cell('15м', fmtPct(r.ch15m), sign(r.ch15m)) +
        cell('1ч', fmtPct(r.ch1h), sign(r.ch1h)) + cell('4ч', fmtPct(r.ch4h), sign(r.ch4h)) +
        cell('24ч', fmtPct(r.ch24h), sign(r.ch24h)) + cell('NATR 5/14', r.natr === null ? '—' : r.natr.toFixed(2) + '%') +
        cell('Объём 24ч', '$' + fmtVol(r.volume)) +
        (r.high ? cell('Макс. 24ч', fmtPrice(r.high)) + cell('Мин. 24ч', fmtPrice(r.low)) : '');
      chart.tick(r.price);
      oi?.setNow(r);
    } catch { /* ignore */ }
  }

  const close = () => {
    dead = true;
    clearInterval(timer);
    clearInterval(reload);
    offAlerts();
    oi?.destroy();
    document.removeEventListener('keydown', onKey);
    chart.destroy();
    ov.remove();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  ov.addEventListener('click', e => {
    if (e.target === ov) return close();
    const t = e.target.closest('[data-tf]');
    if (t) {
      tf = t.dataset.tf;
      chart.setInterval(tf);
      markTf();
      loadKlines();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'alert') { close(); ctx.createAlertFor(row); }
  });

  markTf();
  loadKlines();
  loadTicker();
  oi?.refresh(row);
  let n = 0;
  const timer = setInterval(() => { loadTicker(); if (++n % 5 === 0) oi?.refresh(row); }, 3000);
  const reload = setInterval(loadKlines, 30000);
  return close;
}
