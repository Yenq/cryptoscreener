import { tzShift } from './chart.js';
import { api, esc, fmtPct, fmtVol, qs, sign } from './util.js';

/** Маленький график открытого интереса под основным (в монетах или в долларах). Двигается вместе с основным. */
export class OiPane {
  constructor(parent, main) {
    this.main = main;
    this.mode = 'coins';
    this.points = [];
    this.el = document.createElement('div');
    this.el.className = 'oi-pane';
    this.el.innerHTML = `
      <div class="oi-head">
        <b>Открытый интерес</b>
        <div class="group"><button data-oi="coins" class="on">Монеты</button><button data-oi="usd">$</button></div>
        <span class="oi-now"></span>
        <span class="hint" style="margin-left:auto" title="ОИ копится с момента запуска + история бирж (Binance ~25ч, Bybit ~25ч, OKX ~48ч)">≈ 26ч</span>
      </div>
      <div class="oi-chart"></div>`;
    parent.appendChild(this.el);
    this.el.addEventListener('click', e => {
      const b = e.target.closest('[data-oi]');
      if (!b) return;
      this.mode = b.dataset.oi;
      this.el.querySelectorAll('[data-oi]').forEach(x => x.classList.toggle('on', x === b));
      this.render();
      if (this.row) this.setNow(this.row);
    });
    this.chart = LightweightCharts.createChart(this.el.querySelector('.oi-chart'), {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b929c', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,.035)' }, horzLines: { color: 'rgba(255,255,255,.035)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.1 }, minimumWidth: 74 },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: 0 },
    });
    this.series = this.chart.addAreaSeries({
      lineColor: '#b48cf2', topColor: 'rgba(180,140,242,.28)', bottomColor: 'rgba(180,140,242,0)', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true,
    });
    this._sync = r => {
      if (!r) return;
      try { this.chart.timeScale().setVisibleRange(r); } catch { /* данных ОИ в этом диапазоне ещё нет */ }
    };
    main.chart.timeScale().subscribeVisibleTimeRangeChange(this._sync);
  }

  /** Текущий ОИ и его изменение за окна — из строки тикера; в монетах или в долларах — как выбрано переключателем. */
  setNow(r) {
    this.row = r;
    const pre = this.mode === 'usd' ? 'oiu' : 'oi';
    const ch = (w, l) => `<span class="${sign(r[pre + w])}">${l} ${fmtPct(r[pre + w])}</span>`;
    this.el.querySelector('.oi-now').innerHTML = r.oi === null || r.oi === undefined ? '<span class="muted">данных пока нет</span>'
      : `<b>${fmtVol(r.oi)} ${esc(r.base)}</b> · <b>$${fmtVol(r.oi_usd)}</b> ` +
        [ch('5m', '5м'), ch('15m', '15м'), ch('1h', '1ч'), ch('4h', '4ч'), ch('24h', '24ч')].join(' ');
  }

  async refresh(row) {
    try {
      const r = await api('/oi?' + qs({ exchange: row.exchange, symbol: row.symbol }));
      this.points = r.points;
      this.render();
    } catch { /* повторим на следующем тике */ }
  }

  clear() {
    this.points = [];
    this.series.setData([]);
  }

  render() {
    const off = tzShift();
    const usd = this.mode === 'usd';
    const data = [];
    let prev = -1;
    for (const p of this.points) {
      const price = usd ? this.main.priceAt(p.time) : 1;
      if (price === null || p.time + off <= prev) continue;
      prev = p.time + off;
      data.push({ time: p.time + off, value: p.coins * price });
    }
    this.series.applyOptions({
      priceFormat: { type: 'custom', minMove: 0.0001, formatter: v => (usd ? '$' : '') + fmtVol(v) },
    });
    this.series.setData(data);
    const r = this.main.chart.timeScale().getVisibleRange();
    if (r) this._sync(r);
  }

  destroy() {
    this.main.chart.timeScale().unsubscribeVisibleTimeRangeChange(this._sync);
    this.chart.remove();
    this.el.remove();
  }
}
