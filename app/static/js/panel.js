import { CandleChart, enableRuler, onChartDblClick } from './chart.js';
import { OiPane } from './oi.js';
import { api, exLabel, fmtPrice, qs, MARKETS } from './util.js';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const RELOAD_MS = 30000;

/**
 * Панель с графиком одной монеты и своим переключателем таймфрейма.
 * Умеет: алерт двойным кликом, удаление алерта ПКМ по линии, линейку (Shift+СКМ), ОИ под графиком (withOi).
 */
export class ChartPanel {
  constructor(el, ctx, { tf, onTf, withOi = false }) {
    this.el = el;
    this.ctx = ctx;
    this.tf = tf;
    this.onTf = onTf;
    this.withOi = withOi;
    this.row = null;
    this.oi = null;
    this.seq = 0;
    el.classList.add('cp');
    el.innerHTML = `
      <div class="cp-head">
        <b class="cp-sym"></b><span class="pill ex cp-ex"></span><span class="cp-price"></span>
        <a class="cp-link" target="_blank" rel="noopener" title="Открыть на бирже" hidden>↗</a>
        <span class="spacer"></span>
        <div class="group cp-tfs">${TFS.map(t => `<button data-tf="${t}">${t}</button>`).join('')}</div>
      </div>
      <div class="cp-chart"></div>
      <div class="cp-oi"></div>`;
    this.q = s => el.querySelector(s);
    this.chart = new CandleChart(this.q('.cp-chart'), tf, { scaleWidth: 74 });

    const chartEl = this.q('.cp-chart');
    onChartDblClick(chartEl, this.chart, price => this.row && ctx.addPriceAlert(this.row, price));
    enableRuler(chartEl, this.chart);
    chartEl.addEventListener('contextmenu', e => {
      const id = this.chart.alertAt(chartEl, e);
      if (id && this.row) { e.preventDefault(); ctx.deleteAlert(id, this.row); }
    });
    this.q('.cp-tfs').addEventListener('click', e => {
      const t = e.target.closest('[data-tf]')?.dataset.tf;
      if (!t || t === this.tf) return;
      this.tf = t;
      this.chart.setInterval(t);
      this.markTf();
      this.onTf?.(t);
      this.load(true);
    });
    this.markTf();
    this.offAlerts = ctx.onAlertsChanged(() => this.drawLines());
    this.timer = setInterval(() => this.load(false), RELOAD_MS);
  }

  markTf() {
    this.el.querySelectorAll('[data-tf]').forEach(b => b.classList.toggle('on', b.dataset.tf === this.tf));
  }

  drawLines() {
    this.chart.setAlertLines(this.row ? this.ctx.priceAlerts(this.row) : []);
  }

  /** Показать другую монету. */
  setRow(row) {
    this.row = row;
    this.chart.last = null; // не рисуем новую цену на свечах прошлой монеты
    this.chart.setAlertLines([]);
    this.q('.cp-sym').textContent = row.base;
    this.q('.cp-ex').textContent = `${exLabel(row.exchange)} · ${MARKETS[row.market]}`;
    const link = this.q('.cp-link');
    link.href = row.url;
    link.hidden = false;
    this.q('.cp-price').textContent = fmtPrice(row.price);
    if (this.withOi && row.market === 'futures') {
      this.oi ??= new OiPane(this.q('.cp-oi'), this.chart);
      this.oi.clear();
      this.oi.setNow(row);
    } else if (this.oi) {
      this.oi.destroy();
      this.oi = null;
    }
    this.load(true);
  }

  /** Свежие данные по той же монете (раз в несколько секунд). */
  update(row) {
    this.row = row;
    this.q('.cp-price').textContent = fmtPrice(row.price);
    this.chart.tick(row.price);
    this.drawLines();
    this.oi?.setNow(row);
  }

  async load(fit) {
    const row = this.row;
    if (!row) return;
    const my = ++this.seq;
    const tf = this.tf;
    try {
      const data = await api('/klines?' + qs({ exchange: row.exchange, market: row.market, symbol: row.symbol, interval: tf, limit: 300 }));
      if (my !== this.seq || this.row !== row && this.row?.key !== row.key) return;
      this.chart.setInterval(tf);
      this.chart.setData(data);
      if (fit) this.chart.chart.timeScale().fitContent();
      this.drawLines();
      this.oi?.render();
      this.oi?.refresh(row);
    } catch { /* повторим через RELOAD_MS */ }
  }

  destroy() {
    clearInterval(this.timer);
    this.offAlerts();
    this.oi?.destroy();
    this.chart.destroy();
  }
}
