import * as screener from './screener.js';
import * as market from './market.js';
import * as alerts from './alerts.js';
import { api, esc, EXCHANGES, exLabel, fmtPrice, prefs } from './util.js';

const ROUTES = { screener, market, alerts };

prefs.load({
  sMarket: 'futures', sExchanges: EXCHANGES.map(e => e.name), sWindow: '5m', sDir: 'up', sTf: '1m', sGrid: '3x3', sMinVol: 1e6, sDedupe: true, sBy: 'price',
  mExchange: 'binance', mMarket: 'futures', mSort: 'volume', mDir: -1, mMinVol: 0,
  mTf0: '5m', mTf1: '1h', mTf2: '1d', mListW: null, mSide: 'right', mSel: null,
  sound: true,
});

const view = document.getElementById('view');
let unmount = null;
let prefill = null;
let unread = 0;
const alertListeners = new Set();

// --- контекст, доступный страницам -----------------------------------------
const alertsState = { list: [], listeners: new Set() };

async function refreshAlerts() {
  try {
    alertsState.list = (await api('/alerts')).alerts;
    alertsState.listeners.forEach(fn => fn());
  } catch { /* сервер недоступен — оставим прошлое состояние */ }
}

const ctx = {
  /** Открывает страницу алертов с формой «разовый алерт по цене», заполненной для этой монеты. */
  createAlertFor(row) {
    prefill = { exchange: row.exchange, market: row.market, symbol: row.symbol, level: row.price };
    if (location.hash.startsWith('#/alerts')) route(); else location.hash = '#/alerts';
  },
  /** Разовый алерт на пересечение цены (двойной клик по графику). */
  async addPriceAlert(row, level) {
    try {
      const a = await api('/alerts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'price', exchange: row.exchange, market: row.market, symbol: row.symbol, level }),
      });
      await refreshAlerts();
      showToast({
        title: `🔔 ${row.base} ${a.op === 'gte' ? '↑' : '↓'} ${fmtPrice(a.level)}`,
        text: `Разовый алерт · ${exLabel(row.exchange)}`,
        ttl: 7000,
        action: { label: 'Отменить', fn: async () => { await api(`/alerts/${a.id}`, { method: 'DELETE' }); await refreshAlerts(); } },
      });
    } catch (e) {
      showToast({ title: 'Алерт не создан', text: e.message, error: true });
    }
  },
  /** ПКМ по линии алерта на графике. В тосте можно вернуть алерт. */
  async deleteAlert(id, row) {
    const a = alertsState.list.find(x => x.id === id);
    try {
      await api(`/alerts/${id}`, { method: 'DELETE' });
      await refreshAlerts();
      showToast({
        title: `🗑 Алерт удалён${a ? ` · ${row.base} ${fmtPrice(a.level)}` : ''}`,
        text: exLabel(row.exchange),
        ttl: 6000,
        action: a ? { label: 'Вернуть', fn: () => ctx.addPriceAlert(row, a.level) } : undefined,
      });
    } catch (e) {
      showToast({ title: 'Не удалось удалить', text: e.message, error: true });
    }
  },
  refreshAlerts,
  /** Активные ценовые алерты монеты — для линий на графике. */
  priceAlerts: row => alertsState.list
    .filter(a => a.kind === 'price' && a.enabled && a.exchange === row.exchange && a.market === row.market && a.symbol === row.symbol)
    .map(a => ({ id: a.id, level: a.level })),
  onAlertsChanged(fn) { alertsState.listeners.add(fn); return () => alertsState.listeners.delete(fn); },
  takePrefill() { const p = prefill; prefill = null; return p; },
  clearUnread() { unread = 0; renderBadge(); },
  onAlertEvent(fn) { alertListeners.add(fn); return () => alertListeners.delete(fn); },
};

// --- роутер ------------------------------------------------------------------
function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const key = ROUTES[name] ? name : 'screener';
  if (unmount) { try { unmount(); } catch (e) { console.error(e); } unmount = null; }
  view.innerHTML = '';
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === key));
  unmount = ROUTES[key].mount(view, ctx) || null;
}
window.addEventListener('hashchange', route);

// --- алерты: SSE, тосты, звук ---------------------------------------------------
const badge = document.getElementById('alert-badge');
function renderBadge() {
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? '99+' : unread;
}

let audio;
function beep() {
  if (!prefs.data.sound) return;
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    [880, 1175].forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.15);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.16);
      o.stop(t + i * 0.16 + 0.16);
    });
  } catch { /* звук недоступен */ }
}

function showToast({ title, text, url, action, error, ttl = 12000 }) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>` +
    (action ? `<button class="btn ghost small" data-act>${esc(action.label)}</button>` : '');
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-act]')) { el.remove(); await action.fn(); return; }
    if (url) window.open(url, '_blank', 'noopener');
    el.remove();
  });
  box.appendChild(el);
  while (box.children.length > 5) box.firstChild.remove(); // при шторме алертов не заваливаем экран
  setTimeout(() => el.remove(), ttl);
}

function onAlert(ev) {
  showToast({ title: '🔔 ' + (ev.name || ev.base), text: ev.text, url: ev.url });
  refreshAlerts(); // сработавший разовый алерт выключился — уберём его линию с графиков
  beep();
  if (location.hash.startsWith('#/alerts')) alertListeners.forEach(fn => fn(ev));
  else { unread++; renderBadge(); }
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Vibescreener · ' + (ev.name || ev.base), { body: ev.text });
  }
}

const es = new EventSource('/api/alerts/stream');
es.onmessage = e => { try { onAlert(JSON.parse(e.data)); } catch (err) { console.error(err); } };

const soundBtn = document.getElementById('btn-sound');
const syncSound = () => { soundBtn.classList.toggle('off', !prefs.data.sound); soundBtn.title = prefs.data.sound ? 'Звук алертов: вкл' : 'Звук алертов: выкл'; };
soundBtn.addEventListener('click', () => {
  prefs.data.sound = !prefs.data.sound;
  prefs.save();
  syncSound();
  if (prefs.data.sound) {
    beep();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
});
syncSound();

// --- статус бирж ---------------------------------------------------------------------
async function updateStatus() {
  try {
    const meta = await api('/meta');
    const now = Date.now() / 1000;
    document.getElementById('status').innerHTML = meta.exchanges.map(ex => {
      const ms = Object.values(ex.markets);
      const worst = Math.min(...ms.map(m => m.updated ?? 0));
      const err = ms.find(m => m.error)?.error;
      const cls = now - worst > 40 ? 'bad' : err ? 'warn' : '';
      const tip = `${exLabel(ex.name)}: ` + Object.entries(ex.markets)
        .map(([k, m]) => `${k} — ${m.count} монет, свечи: ${m.with_candles}`).join('; ') + (err ? ` | ${err}` : '');
      return `<span title="${esc(tip)}"><i class="${cls}"></i>${esc(ex.label)}</span>`;
    }).join('');
  } catch {
    document.getElementById('status').innerHTML = '<span><i class="bad"></i>нет связи с сервером</span>';
  }
}

async function showVersion() {
  try {
    const v = await api('/version');
    const el = document.getElementById('version');
    el.hidden = false;
    el.classList.toggle('new', v.update_available);
    if (v.update_available) {
      el.textContent = `⬆ Доступна v${v.latest} — скачать`;
      el.href = v.url;
      el.title = `Установлена v${v.current}. Распакуй новую версию поверх старой — алерты и настройки (папка data) сохранятся.`;
    } else {
      el.textContent = `v${v.current}`;
      el.removeAttribute('href');
      el.title = v.error ? `Проверка обновлений не удалась: ${v.error}` : v.latest ? 'Установлена последняя версия' : 'Проверка обновлений отключена';
    }
  } catch { /* не критично */ }
}

updateStatus();
setInterval(updateStatus, 10000);
showVersion();
setInterval(showVersion, 300_000);
refreshAlerts();
setInterval(refreshAlerts, 15000);
route();
