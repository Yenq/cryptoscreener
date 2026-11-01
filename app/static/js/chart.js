import { priceDecimals } from './util.js';

const UP = '#2ebd85';
const DOWN = '#f6465d';
export const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

// lightweight-charts рисует время как UTC — сдвигаем на пояс пользователя
export const tzShift = () => -new Date().getTimezoneOffset() * 60;

/** Свечной график с объёмами; последнюю свечу можно двигать по живой цене. */
export class CandleChart {
  constructor(el, interval, { logo = false, scaleWidth = 0 } = {}) {
    this.interval = interval;
    this.last = null;
    this.chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b929c', fontSize: 11, attributionLogo: logo },
      grid: { vertLines: { color: 'rgba(255,255,255,.035)' }, horzLines: { color: 'rgba(255,255,255,.035)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.2 }, minimumWidth: scaleWidth },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: 0 },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    });
    this.volume = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
  }

  setInterval(iv) { this.interval = iv; }

  setData(data) {
    if (!data.length) return;
    this.raw = data;
    const off = tzShift();
    const bars = data.map(c => ({ time: c.time + off, open: c.open, high: c.high, low: c.low, close: c.close }));
    this.candles.setData(bars);
    this.volume.setData(data.map(c => ({
      time: c.time + off, value: c.volume,
      color: c.close >= c.open ? 'rgba(46,189,133,.35)' : 'rgba(246,70,93,.35)',
    })));
    this.last = { ...bars[bars.length - 1] };
    const d = priceDecimals(this.last.close);
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: Math.pow(10, -d) } });
  }

  /** Подтягивает последнюю свечу к живой цене (между перезагрузками истории). */
  tick(price) {
    if (!this.last || !price) return;
    const iv = IV_SEC[this.interval];
    const now = Date.now() / 1000 + tzShift();
    const n = Math.floor((now - this.last.time) / iv);
    if (n >= 1) {
      this.last = { time: this.last.time + n * iv, open: this.last.close, high: price, low: price, close: price };
    } else {
      this.last.high = Math.max(this.last.high, price);
      this.last.low = Math.min(this.last.low, price);
      this.last.close = price;
    }
    this.candles.update(this.last);
  }

  /** Горизонтальные линии активных ценовых алертов: [{id, level}]. */
  setAlertLines(levels) {
    this.lines ??= new Map();
    const want = new Map(levels.map(l => [l.id, l.level]));
    for (const [id, e] of [...this.lines]) {
      if (want.get(id) !== e.level) {
        this.candles.removePriceLine(e.line);
        this.lines.delete(id);
      }
    }
    for (const [id, level] of want) {
      if (this.lines.has(id)) continue;
      const line = this.candles.createPriceLine({
        price: level, color: '#f0b90b', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '🔔',
      });
      this.lines.set(id, { level, line });
    }
  }

  /** Цена закрытия свечи, в которую попадает момент timeSec (UTC, секунды); до первой свечи — её open. */
  priceAt(timeSec) {
    const d = this.raw;
    if (!d?.length) return null;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d[mid].time <= timeSec) lo = mid; else hi = mid - 1;
    }
    return d[lo].time <= timeSec ? d[lo].close : d[0].open;
  }

  /** id алерта, чья линия находится под курсором (допуск по вертикали), или null. */
  alertAt(el, e, tolerance = 9) {
    if (!this.lines?.size) return null;
    const y = e.clientY - el.getBoundingClientRect().top;
    let best = null;
    let bestDist = tolerance + 1;
    for (const [id, { level }] of this.lines) {
      const ly = this.candles.priceToCoordinate(level);
      if (ly === null) continue;
      const d = Math.abs(ly - y);
      if (d < bestDist) { best = id; bestDist = d; }
    }
    return best;
  }

  destroy() {
    this.chart.remove();
  }
}

/** Двойной клик по области графика → цена в точке клика (оси и кнопки игнорируются). */
export function onChartDblClick(el, chart, handler) {
  el.addEventListener('dblclick', e => {
    if (e.target.closest('button, a')) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x > rect.width - chart.chart.priceScale('right').width()) return;
    if (y > rect.height - chart.chart.timeScale().height()) return;
    const price = chart.candles.coordinateToPrice(y);
    if (price === null || !(price > 0)) return;
    handler(Number(price.toFixed(priceDecimals(price))));
  });
}

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d}д`, h && `${h}ч`, (m || (!d && !h)) && `${m}м`].filter(Boolean).join(' ');
}

/**
 * Линейка: зажать Shift + среднюю кнопку мыши и вести — показывает изменение цены в %, разницу,
 * число свечей и время между точками. Отпустил кнопку — линейка исчезла.
 */
export function enableRuler(el, chart) {
  el.addEventListener('mousedown', e => {
    if (e.button !== 1 || !e.shiftKey || e.target.closest('button, a')) return;
    e.preventDefault(); // иначе Windows включает автопрокрутку по средней кнопке
    e.stopPropagation(); // график не должен считать это своим перетаскиванием

    const rect = el.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    const p0 = chart.candles.coordinateToPrice(y0);
    const l0 = chart.chart.timeScale().coordinateToLogical(x0);
    if (p0 === null || l0 === null) return;

    const root = document.createElement('div');
    root.className = 'ruler';
    root.innerHTML = '<svg><line/><circle r="4"/><circle r="4"/></svg><div class="ruler-label"></div>';
    el.appendChild(root);
    const line = root.querySelector('line');
    const [dot0, dot1] = root.querySelectorAll('circle');
    const label = root.querySelector('.ruler-label');
    dot0.setAttribute('cx', x0);
    dot0.setAttribute('cy', y0);

    const move = ev => {
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(ev.clientX - r.left, 0), r.width);
      const y = Math.min(Math.max(ev.clientY - r.top, 0), r.height);
      const p1 = chart.candles.coordinateToPrice(y);
      const l1 = chart.chart.timeScale().coordinateToLogical(x);
      if (p1 === null || l1 === null) return;
      const pct = (p1 / p0 - 1) * 100;
      const bars = Math.round(l1 - l0);
      const dir = pct >= 0 ? 'up' : 'down';
      line.setAttribute('x1', x0); line.setAttribute('y1', y0);
      line.setAttribute('x2', x); line.setAttribute('y2', y);
      dot1.setAttribute('cx', x); dot1.setAttribute('cy', y);
      root.className = `ruler ${dir}`;
      label.innerHTML = `<b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>` +
        `<span>${(p1 >= p0 ? '+' : '−') + Math.abs(p1 - p0).toFixed(priceDecimals(p0))}</span>` +
        `<span>${Math.abs(bars)} св. · ${fmtDuration(Math.abs(bars) * IV_SEC[chart.interval])}</span>`;
      // подпись рядом с курсором, но не за краем графика
      const w = label.offsetWidth;
      const h = label.offsetHeight;
      label.style.left = Math.min(Math.max(x + 14, 4), r.width - w - 4) + 'px';
      label.style.top = (y + 14 + h > r.height ? y - h - 14 : y + 14) + 'px';
    };
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      root.remove();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
    move(e);
  }, true);
}
