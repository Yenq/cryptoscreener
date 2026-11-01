export async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === 'string' ? j.detail : j.detail?.map(d => d.msg.replace(/^Value error, /, '')).join('; ') || msg;
    } catch { /* тело не JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

export const qs = o =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const EXCHANGES = [
  { name: 'binance', label: 'Binance', color: '#f0b90b' },
  { name: 'bybit', label: 'Bybit', color: '#f7a600' },
  { name: 'okx', label: 'OKX', color: '#e8e8e8' },
  { name: 'bitget', label: 'Bitget', color: '#00d4c4' },
  { name: 'hyperliquid', label: 'Hyperliquid', color: '#6ef0d0' },
];
export const exLabel = n => EXCHANGES.find(e => e.name === n)?.label ?? n;

export function priceDecimals(p) {
  if (!p || p <= 0) return 2;
  return Math.min(10, Math.max(2, 5 - Math.ceil(Math.log10(p))));
}

export function fmtPrice(p) {
  if (p === null || p === undefined) return '—';
  return p.toLocaleString('ru-RU', { minimumFractionDigits: priceDecimals(p), maximumFractionDigits: priceDecimals(p) });
}

export function fmtVol(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

export function fmtPct(x, signed = true) {
  if (x === null || x === undefined) return '—';
  return (signed && x > 0 ? '+' : '') + x.toFixed(2) + '%';
}

export const sign = x => (x === null || x === undefined ? '' : x >= 0 ? 'up' : 'down');

export function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const MARKETS = { futures: 'Фьючерсы', spot: 'Спот' };

/** Настройки интерфейса в localStorage (может быть недоступен — тогда просто дефолты). */
export const prefs = {
  data: {},
  load(defaults) {
    try { this.data = { ...defaults, ...JSON.parse(localStorage.getItem('vs-prefs') || '{}') }; }
    catch { this.data = { ...defaults }; }
    return this.data;
  },
  save() {
    try { localStorage.setItem('vs-prefs', JSON.stringify(this.data)); } catch { /* ignore */ }
  },
};

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
