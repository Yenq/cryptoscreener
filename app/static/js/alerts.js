import { openCoin } from './modal.js';
import { api, esc, EXCHANGES, exLabel, fmtPrice, fmtTime, MARKETS } from './util.js';

const METRICS = {
  ch5m: 'Изменение за 5м, %', ch15m: 'Изменение за 15м, %', ch1h: 'Изменение за 1ч, %', ch4h: 'Изменение за 4ч, %',
  ch24h: 'Изменение за 24ч, %', natr: 'NATR 5/14, %', price: 'Цена', volume: 'Объём 24ч, млн $',
  oi5m: 'Изменение за 5м, %', oi15m: 'Изменение за 15м, %', oi1h: 'Изменение за 1ч, %', oi4h: 'Изменение за 4ч, %', oi24h: 'Изменение за 24ч, %',
  oi_coins: 'Размер ОИ, монет',
  oiu5m: 'Изменение за 5м, %', oiu15m: 'Изменение за 15м, %', oiu1h: 'Изменение за 1ч, %', oiu4h: 'Изменение за 4ч, %', oiu24h: 'Изменение за 24ч, %',
  oi_usd: 'Размер ОИ, млн $',
};
// группы в выпадающем списке метрик
const METRIC_GROUPS = [
  ['Цена и рынок', ['ch5m', 'ch15m', 'ch1h', 'ch4h', 'ch24h', 'natr', 'price', 'volume']],
  ['Открытый интерес — в монетах (фьючерсы)', ['oi5m', 'oi15m', 'oi1h', 'oi4h', 'oi24h', 'oi_coins']],
  ['Открытый интерес — в долларах (фьючерсы)', ['oiu5m', 'oiu15m', 'oiu1h', 'oiu4h', 'oiu24h', 'oi_usd']],
];
const metricOptions = () => METRIC_GROUPS.map(([g, keys]) =>
  `<optgroup label="${g}">${keys.map(k => `<option value="${k}">${METRICS[k]}</option>`).join('')}</optgroup>`).join('');
const METRIC_SHORT = {
  ch5m: '5м', ch15m: '15м', ch1h: '1ч', ch4h: '4ч', ch24h: '24ч', natr: 'NATR', price: 'цена', volume: 'объём',
  oi5m: 'ОИ мон. 5м', oi15m: 'ОИ мон. 15м', oi1h: 'ОИ мон. 1ч', oi4h: 'ОИ мон. 4ч', oi24h: 'ОИ мон. 24ч', oi_coins: 'ОИ, монет',
  oiu5m: 'ОИ $ 5м', oiu15m: 'ОИ $ 15м', oiu1h: 'ОИ $ 1ч', oiu4h: 'ОИ $ 4ч', oiu24h: 'ОИ $ 24ч', oi_usd: 'ОИ, $',
};
const MILLIONS = new Set(['volume', 'oi_usd']); // вводятся в млн $
const OPS = { gte: '≥ (выросло)', lte: '≤ (упало)', abs_gte: 'по модулю ≥' };
const OP_SIGN = { gte: '≥', lte: '≤', abs_gte: '|x| ≥' };

const unit = m => (m === 'price' ? '' : m === 'oi_coins' ? ' мон.' : MILLIONS.has(m) ? 'M$' : '%');
const shown = c => (MILLIONS.has(c.metric) ? c.value / 1e6 : c.value);
const condText = c => `${METRIC_SHORT[c.metric]} ${OP_SIGN[c.op]} ${shown(c)}${unit(c.metric)}`;

function describe(a) {
  const market = MARKETS[a.market];
  if (a.kind === 'price') {
    return {
      title: a.name || `${a.base} ${a.op === 'gte' ? '↑' : '↓'} ${fmtPrice(a.level)}`,
      sub: `${exLabel(a.exchange)} · ${market} · пересечение цены ${fmtPrice(a.level)} (было ${fmtPrice(a.ref_price)})`,
      tag: '<span class="tag once">разовый</span>',
    };
  }
  const coins = a.symbols[0] === '*' ? 'любые монеты' : a.symbols.join(', ');
  const exch = a.exchanges.length ? a.exchanges.map(exLabel).join(', ') : 'любые биржи';
  if (a.kind === 'setup') {
    const s = a.setup;
    return {
      title: a.name || `Пробой ${s.timeframe} ${s.direction === 'long' ? '↑ лонг' : '↓ шорт'} · от ${s.min_touches} касаний`,
      sub: `${coins} · ${exch} · ${market} · разброс ${s.tolerance_pct}% · между касаниями ${s.min_gap}–${s.max_gap} св. · ` +
           `${s.confirm === 'close' ? 'по закрытию свечи' : 'по цене'} · топ-${s.max_symbols} по объёму` +
           (a.min_volume ? ` · объём ≥ ${a.min_volume / 1e6}M$` : '') + ` · пауза ${a.cooldown_min} мин`,
      tag: '<span class="tag rep">сетап</span>',
    };
  }
  const conds = a.conditions.map(condText).join(' И ');
  return {
    title: a.name || `${coins}: ${conds}`,
    sub: `${coins} · ${exch} · ${market} · ${a.name ? conds + ' · ' : ''}` +
         (a.min_volume ? `объём ≥ ${a.min_volume / 1e6}M$ · ` : '') + (a.once ? 'один раз' : `пауза ${a.cooldown_min} мин`),
    tag: `<span class="tag ${a.once ? 'once' : 'rep'}">${a.once ? 'один раз' : 'повторяющийся'}</span>`,
  };
}

export function mount(root, ctx) {
  const pre = ctx.takePrefill();
  const exchangeOptions = EXCHANGES.map(e => `<option value="${e.name}">${e.label}</option>`).join('');
  const marketOptions = Object.entries(MARKETS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');

  root.innerHTML = `
    <div class="page">
      <div class="stack">
        <form class="card form" data-f="price" autocomplete="off">
          <h2>Разовый алерт по цене <small>пересечение уровня</small></h2>
          <div class="row2">
            <label>Биржа <select name="exchange">${exchangeOptions}</select></label>
            <label>Рынок <select name="market">${marketOptions}</select></label>
          </div>
          <div class="row2">
            <label>Монета <input type="text" name="symbol" placeholder="BTC" required></label>
            <label>Цена-уровень <input type="number" name="level" step="any" min="0" required></label>
          </div>
          <label class="check"><input type="checkbox" name="notify_telegram" checked> Отправить в Telegram</label>
          <div class="err-msg" data-f="priceErr"></div>
          <button class="btn" type="submit">Создать</button>
          <p class="hint" style="margin:0">Направление (вверх / вниз) определяется по текущей цене. Быстрее всего — <b>двойной клик ЛКМ по графику</b> в нужной точке (в скринере или в большом графике).</p>
        </form>

        <form class="card form" data-f="setup" autocomplete="off">
          <h2>Авто-сетап: пробой уровня <small>ищется по касаниям</small></h2>
          <label>Биржи <span class="hint">(ничего не выбрано — любые)</span></label>
          <div class="chips" data-f="sChips" style="margin-top:-4px">
            ${EXCHANGES.map(e => `<button type="button" class="chip" data-ex="${e.name}" style="--c:${e.color}"><i></i>${e.label}</button>`).join('')}
          </div>
          <div class="row2">
            <label>Рынок <select name="market">${marketOptions}</select></label>
            <label>Монеты <input type="text" name="symbols" value="*" placeholder="BTC, ETH или *"></label>
          </div>
          <div class="row2">
            <label>Направление
              <select name="direction"><option value="long">Лонг — пробой вверх</option><option value="short">Шорт — пробой вниз</option></select></label>
            <label>Таймфрейм уровня
              <select name="timeframe">${['1m', '5m', '15m', '1h', '4h', '1d'].map(t => `<option value="${t}" ${t === '4h' ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          </div>
          <div class="row2">
            <label>Разброс касаний, % <input type="number" name="tolerance_pct" value="1" step="any" min="0.01" max="10"></label>
            <label>Мин. касаний <input type="number" name="min_touches" value="2" min="2" max="10"></label>
          </div>
          <div class="row2">
            <label>Между касаниями: от, свечей <input type="number" name="min_gap" value="5" min="1"></label>
            <label>Между касаниями: до, свечей <input type="number" name="max_gap" value="500" min="1"></label>
          </div>
          <div class="hint" data-f="gapHint" style="margin-top:-4px"></div>
          <div class="row2">
            <label>Пробой засчитывать
              <select name="confirm"><option value="close">по закрытию свечи</option><option value="price">сразу по цене</option></select></label>
            <label>Пробой, % за уровень <input type="number" name="breakout_pct" value="0.1" step="any" min="0" max="5"></label>
          </div>
          <details class="adv">
            <summary>Дополнительно</summary>
            <div class="row2" style="margin-top:8px">
              <label>Глубина поиска, свечей <input type="number" name="lookback" value="500" min="50" max="1000"></label>
              <label>Сила касания (свечей по бокам) <input type="number" name="pivot" value="2" min="1" max="10"></label>
            </div>
            <div class="row2" style="margin-top:8px">
              <label>Сканировать монет (топ по объёму) <input type="number" name="max_symbols" value="100" min="1" max="500"></label>
              <label>Мин. объём 24ч, млн $ <input type="number" name="min_volume" value="1" step="any" min="0"></label>
            </div>
            <div class="row2" style="margin-top:8px">
              <label>Пауза на монету, мин <input type="number" name="cooldown_min" value="60" min="0"></label>
              <label>Название <input type="text" name="name" maxlength="80"></label>
            </div>
          </details>
          <label class="check"><input type="checkbox" name="notify_telegram" checked> Отправить в Telegram</label>
          <div class="err-msg" data-f="sErr"></div>
          <div class="btn-row">
            <button class="btn" type="submit">Создать алерт</button>
            <button class="btn ghost" type="button" data-act="sScan">Найти сейчас</button>
          </div>
          <div class="list" data-f="sResults"></div>
          <p class="hint" style="margin:0">Касание — локальный экстремум цены (максимум для лонга, минимум для шорта). Уровень засчитывается,
            если касания лежат в пределах разброса, соседние разделены нужным числом свечей, а ни одна свеча после первого касания не закрылась
            за уровнем. «Найти сейчас» показывает, что нашлось по этим параметрам прямо сейчас (пробои и уровни, к которым цена подходит), —
            так удобно подбирать значения. Окно OKX ограничено 300 свечами.</p>
        </form>

        <form class="card form" data-f="complex" autocomplete="off">
          <h2>Повторяющийся алерт <small>несколько условий и монет</small></h2>
          <label>Биржи <span class="hint">(ничего не выбрано — любые)</span></label>
          <div class="chips" data-f="chips" style="margin-top:-4px">
            ${EXCHANGES.map(e => `<button type="button" class="chip" data-ex="${e.name}" style="--c:${e.color}"><i></i>${e.label}</button>`).join('')}
          </div>
          <div class="row2">
            <label>Рынок <select name="market">${marketOptions}</select></label>
            <label>Монеты <input type="text" name="symbols" value="*" placeholder="BTC, ETH, SOL или *"></label>
          </div>
          <label>Условия <span class="hint">(выполнены должны быть все сразу)</span></label>
          <div class="list" data-f="conds" style="margin-top:-4px"></div>
          <button type="button" class="btn ghost small" data-act="addCond" style="justify-self:start">+ условие</button>
          <div class="row2">
            <label>Мин. объём 24ч, млн $ <input type="number" name="min_volume" step="any" min="0" value="1"></label>
            <label>Пауза на монету, мин <input type="number" name="cooldown_min" step="any" min="0" value="15"></label>
          </div>
          <label class="check"><input type="checkbox" name="once"> Сработать один раз и выключиться</label>
          <label class="check"><input type="checkbox" name="notify_telegram" checked> Отправить в Telegram</label>
          <label>Название (необязательно) <input type="text" name="name" maxlength="80"></label>
          <div class="err-msg" data-f="err"></div>
          <button class="btn" type="submit">Создать алерт</button>
          <p class="hint" style="margin:0">Срабатывает в момент, когда все условия <b>становятся</b> истинными (пересечение), и затем снова только после паузы. Проверка идёт на сервере — вкладку можно закрыть.</p>
        </form>

        <div class="card">
          <h2>Шаблоны</h2>
          <div class="list" data-f="examples"></div>
        </div>
      </div>

      <div class="stack">
        <div class="card" data-f="tgCard">
          <h2>Telegram <small>готовые боты, можно несколько</small></h2>
          <div class="list" data-f="tgBots" style="margin-bottom:10px"></div>
          <div class="form">
            <div class="row2">
              <label>Токен бота <input type="password" name="tgToken" placeholder="123456:ABC…" autocomplete="new-password"></label>
              <label>Chat ID <input type="text" name="tgChat" placeholder="пусто — найду сам после Start"></label>
            </div>
            <div class="btn-row">
              <button type="button" class="btn small" data-act="tgAdd">Подключить бота</button>
              <button type="button" class="btn ghost small" data-act="tgTestAll">Тест всем</button>
            </div>
            <div class="err-msg" data-f="tgMsg"></div>
            <p class="hint" style="margin:0">Одного @тега бота мало — Telegram разрешает писать только по <b>токену</b>
              (@BotFather → <code>/mybots</code> → твой бот → <b>API Token</b>); тег бота подтянется сам.
              Chat ID — твой id (узнать у @userinfobot), id группы или <code>@канал</code>. Если оставить пустым — открой бота,
              нажми <b>Start</b> и подключай: найду личный чат сам. Подключённых ботов может быть несколько —
              алерты уходят во все сразу.</p>
          </div>
        </div>
        <div class="card">
          <h2>Активные алерты <small data-f="count"></small></h2>
          <div class="list" data-f="alerts"></div>
        </div>
        <div class="card">
          <h2>История срабатываний
            <button class="btn ghost small" data-act="clear" style="float:right">Очистить</button>
          </h2>
          <div class="list" data-f="history"></div>
        </div>
      </div>
    </div>`;
  const $ = f => root.querySelector(`[data-f="${f}"]`);
  const priceForm = $('price');
  const form = $('complex');
  let tg = { configured: false };
  let wasConfigured = false;

  // --- конструктор условий ---------------------------------------------------
  function addCond(c = { metric: 'ch5m', op: 'gte', value: '' }) {
    const row = document.createElement('div');
    row.className = 'cond';
    row.innerHTML = `
      <select data-c="metric">${metricOptions()}</select>
      <select data-c="op">${Object.entries(OPS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <input type="number" data-c="value" step="any" required placeholder="значение">
      <button type="button" class="x-btn" data-rm title="Убрать условие">✕</button>`;
    const metric = row.querySelector('[data-c=metric]');
    const op = row.querySelector('[data-c=op]');
    const sync = () => {
      op.querySelector('[value=abs_gte]').disabled = metric.value === 'price';
      if (metric.value === 'price' && op.value === 'abs_gte') op.value = 'gte';
    };
    metric.addEventListener('change', sync);
    metric.value = c.metric;
    op.value = c.op;
    row.querySelector('[data-c=value]').value = c.value;
    sync();
    $('conds').appendChild(row);
  }

  function setConditions(list) {
    $('conds').innerHTML = '';
    list.forEach(addCond);
  }

  $('conds').addEventListener('click', e => {
    if (e.target.closest('[data-rm]') && $('conds').children.length > 1) e.target.closest('.cond').remove();
  });
  root.querySelector('[data-act=addCond]').addEventListener('click', () => {
    if ($('conds').children.length < 6) addCond();
  });
  $('chips').addEventListener('click', e => e.target.closest('.chip')?.classList.toggle('on'));

  const TEMPLATES = [
    ['Памп: любая монета +5% за 5м', { symbols: '*', min_volume: 1, cooldown_min: 15, conds: [{ metric: 'ch5m', op: 'gte', value: 5 }] }],
    ['Дамп: любая монета −5% за 5м', { symbols: '*', min_volume: 1, cooldown_min: 15, conds: [{ metric: 'ch5m', op: 'lte', value: -5 }] }],
    ['Памп на высокой волатильности: 5м ≥ +3% и NATR ≥ 1', { symbols: '*', min_volume: 1, cooldown_min: 30, conds: [{ metric: 'ch5m', op: 'gte', value: 3 }, { metric: 'natr', op: 'gte', value: 1 }] }],
    ['ОИ ($) растёт вместе с ценой: ОИ $ 15м ≥ +3% и цена 15м ≥ +1%', { symbols: '*', min_volume: 5, cooldown_min: 30, conds: [{ metric: 'oiu15m', op: 'gte', value: 3 }, { metric: 'ch15m', op: 'gte', value: 1 }] }],
    ['ОИ в монетах растёт, цена стоит: ОИ мон. 15м ≥ +3% и |цена 15м| ≤ 0.5%', { symbols: '*', min_volume: 5, cooldown_min: 30, conds: [{ metric: 'oi15m', op: 'gte', value: 3 }, { metric: 'ch15m', op: 'lte', value: 0.5 }] }],
    ['Движение ±10% за 1ч', { symbols: '*', min_volume: 5, cooldown_min: 60, conds: [{ metric: 'ch1h', op: 'abs_gte', value: 10 }] }],
  ];
  $('examples').innerHTML = TEMPLATES.map(([t], i) =>
    `<button type="button" class="btn ghost" data-tpl="${i}" style="text-align:left">${esc(t)}</button>`).join('');
  $('examples').addEventListener('click', e => {
    const i = e.target.closest('[data-tpl]')?.dataset.tpl;
    if (i === undefined) return;
    const t = TEMPLATES[i][1];
    form.symbols.value = t.symbols;
    form.min_volume.value = t.min_volume;
    form.cooldown_min.value = t.cooldown_min;
    form.once.checked = false;
    setConditions(t.conds);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  setConditions([{ metric: 'ch5m', op: 'gte', value: '' }]);

  if (pre) {
    priceForm.exchange.value = pre.exchange;
    priceForm.market.value = pre.market;
    priceForm.symbol.value = pre.symbol;
    priceForm.level.value = pre.level;
    priceForm.level.focus();
  }

  // --- создание ------------------------------------------------------------------
  const post = body => api('/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  priceForm.addEventListener('submit', async e => {
    e.preventDefault();
    $('priceErr').textContent = '';
    const f = priceForm.elements;
    try {
      await post({
        kind: 'price', exchange: f.exchange.value, market: f.market.value, symbol: f.symbol.value.trim(),
        level: Number(f.level.value), notify_telegram: f.notify_telegram.checked,
      });
      f.level.value = '';
      await refresh();
    } catch (err) {
      $('priceErr').textContent = err.message;
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    $('err').textContent = '';
    const f = form.elements;
    const conditions = [...$('conds').children].map(r => {
      const metric = r.querySelector('[data-c=metric]').value;
      return {
        metric, op: r.querySelector('[data-c=op]').value,
        value: Number(r.querySelector('[data-c=value]').value) * (MILLIONS.has(metric) ? 1e6 : 1),
      };
    });
    try {
      await post({
        kind: 'complex', name: f.name.value.trim(), market: f.market.value,
        exchanges: [...$('chips').querySelectorAll('.chip.on')].map(c => c.dataset.ex),
        symbols: f.symbols.value.split(/[\s,;]+/).filter(Boolean),
        conditions, min_volume: Number(f.min_volume.value || 0) * 1e6, cooldown_min: Number(f.cooldown_min.value || 0),
        once: f.once.checked, notify_telegram: f.notify_telegram.checked,
      });
      await refresh();
    } catch (err) {
      $('err').textContent = err.message;
    }
  });

  // --- авто-сетап ----------------------------------------------------------------------------
  const sForm = $('setup');
  const TF_HOURS = { '1m': 1 / 60, '5m': 5 / 60, '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 };
  const span = (candles, tf) => {
    const h = candles * TF_HOURS[tf];
    return h < 1 ? `${Math.round(h * 60)} мин` : h < 48 ? `${+h.toFixed(1)} ч` : `${+(h / 24).toFixed(1)} дн`;
  };
  const syncGapHint = () => {
    const f = sForm.elements;
    $('gapHint').textContent = `между касаниями: от ≈ ${span(+f.min_gap.value, f.timeframe.value)} до ≈ ${span(+f.max_gap.value, f.timeframe.value)}`;
  };
  ['min_gap', 'max_gap', 'timeframe'].forEach(n => sForm.elements[n].addEventListener('input', syncGapHint));
  syncGapHint();
  $('sChips').addEventListener('click', e => e.target.closest('.chip')?.classList.toggle('on'));

  function setupBody() {
    const f = sForm.elements;
    return {
      exchanges: [...$('sChips').querySelectorAll('.chip.on')].map(c => c.dataset.ex),
      market: f.market.value,
      symbols: f.symbols.value.split(/[\s,;]+/).filter(Boolean),
      min_volume: Number(f.min_volume.value || 0) * 1e6,
      setup: {
        direction: f.direction.value, timeframe: f.timeframe.value, tolerance_pct: Number(f.tolerance_pct.value),
        min_gap: Number(f.min_gap.value), max_gap: Number(f.max_gap.value), min_touches: Number(f.min_touches.value),
        pivot: Number(f.pivot.value), lookback: Number(f.lookback.value), breakout_pct: Number(f.breakout_pct.value),
        confirm: f.confirm.value, max_symbols: Number(f.max_symbols.value),
      },
    };
  }

  let scanResults = [];
  sForm.querySelector('[data-act=sScan]').addEventListener('click', async () => {
    $('sErr').textContent = '';
    const box = $('sResults');
    box.innerHTML = '<div class="hint">Проверяю самые ликвидные монеты…</div>';
    try {
      const body = setupBody();
      const r = await api('/setups/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      scanResults = r.results.map(x => ({ ...x, setup: body.setup }));
      box.innerHTML = scanResults.length ? scanResults.map((x, i) => {
        const brk = x.status === 'breakout';
        const dist = brk ? `${Math.abs(x.distance_pct).toFixed(2)}% за уровнем` : `до уровня ${Math.abs(x.distance_pct).toFixed(2)}%`;
        return `<div class="item" data-i="${i}">
          <div class="grow"><div class="title">${esc(x.row.base)} <span class="tag ${brk ? 'once' : 'rep'}">${brk ? 'пробой' : 'формируется'}</span></div>
            <div class="sub">${esc(exLabel(x.row.exchange))} · уровень ${fmtPrice(x.level)} · касаний ${x.touches.length} · цена ${fmtPrice(x.price)} (${dist})</div></div>
          <button type="button" class="btn ghost small" data-open>График</button>
        </div>`;
      }).join('') : `<div class="hint">Сейчас ничего не найдено среди ${r.checked} самых ликвидных монет. Ослабь параметры: больше разброс, меньше касаний, другой таймфрейм.</div>`;
    } catch (err) {
      box.innerHTML = '';
      $('sErr').textContent = err.message;
    }
  });
  $('sResults').addEventListener('click', e => {
    const i = e.target.closest('[data-open]') && e.target.closest('[data-i]')?.dataset.i;
    if (i === undefined || i === false) return;
    const x = scanResults[Number(i)];
    openCoin(x.row, ctx, { tf: x.setup.timeframe, setup: { tf: x.setup.timeframe, level: x.level, direction: x.setup.direction, touches: x.touches } });
  });

  sForm.addEventListener('submit', async e => {
    e.preventDefault();
    $('sErr').textContent = '';
    const f = sForm.elements;
    const b = setupBody();
    try {
      await post({
        kind: 'setup', name: f.name.value.trim(), market: b.market, exchanges: b.exchanges, symbols: b.symbols,
        min_volume: b.min_volume, cooldown_min: Number(f.cooldown_min.value || 0), notify_telegram: f.notify_telegram.checked, setup: b.setup,
      });
      await refresh();
    } catch (err) {
      $('sErr').textContent = err.message;
    }
  });

  // --- список алертов ---------------------------------------------------------------
  $('alerts').addEventListener('change', async e => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id && e.target.type === 'checkbox') {
      await api(`/alerts/${id}?enabled=${e.target.checked}`, { method: 'PATCH' });
      refresh();
    }
  });
  $('alerts').addEventListener('click', async e => {
    if (!e.target.closest('[data-del]')) return;
    await api(`/alerts/${e.target.closest('[data-id]').dataset.id}`, { method: 'DELETE' });
    refresh();
  });
  root.querySelector('[data-act=clear]').addEventListener('click', async () => {
    await api('/alerts/history', { method: 'DELETE' });
    ctx.clearUnread();
    refresh();
  });

  async function refresh() {
    try {
      const [a, h] = await Promise.all([api('/alerts'), api('/alerts/history'), loadTelegram()]);
      ctx.refreshAlerts();
      $('count').textContent = a.alerts.length ? `(${a.alerts.length})` : '';
      $('alerts').innerHTML = a.alerts.length ? a.alerts.map(x => {
        const d = describe(x);
        return `<div class="item ${x.enabled ? '' : 'off'}" data-id="${x.id}">
          <label class="switch" title="Включить / выключить"><input type="checkbox" ${x.enabled ? 'checked' : ''}><span></span></label>
          <div class="grow"><div class="title">${esc(d.title)} ${d.tag}</div><div class="sub">${esc(d.sub)}</div></div>
          <span class="sub">сработал: ${x.trigger_count}</span>
          <button class="x-btn" data-del title="Удалить">✕</button>
        </div>`;
      }).join('') : '<div class="hint">Алертов пока нет — создай первый слева.</div>';
      $('history').innerHTML = h.events.length ? h.events.map(ev => `
        <div class="item">
          <div class="grow"><div class="title">${esc(ev.name ? ev.name + ' — ' : '')}${esc(ev.base)}</div><div class="sub">${esc(ev.text)}</div></div>
          <a class="btn ghost small" href="${esc(ev.url)}" target="_blank" rel="noopener">↗</a>
          <time>${fmtTime(ev.ts)}</time>
        </div>`).join('') : '<div class="hint">Пока ничего не срабатывало.</div>';
    } catch (e) {
      $('alerts').innerHTML = `<div class="err-msg">${esc(e.message)}</div>`;
    }
  }

  // --- Telegram ---------------------------------------------------------------------------
  async function loadTelegram() {
    tg = await api('/telegram');
    const bots = tg.destinations;
    $('tgBots').innerHTML = bots.length ? bots.map(b => `
      <div class="item ${b.enabled ? '' : 'off'}" data-bot="${esc(b.id)}">
        <label class="switch" title="Включить / выключить"><input type="checkbox" ${b.enabled ? 'checked' : ''} ${b.from_env ? 'disabled' : ''}><span></span></label>
        <div class="grow">
          <div class="title">@${esc(b.bot || '?')}</div>
          <div class="sub">${b.chat_id ? `chat ${esc(b.chat_id)}${b.chat_name ? ' · ' + esc(b.chat_name) : ''}` : '<span style="color:var(--accent)">chat id не задан</span>'}
            · токен ${esc(b.token_hint)}${b.from_env ? ' · из переменных окружения' : ''}</div>
        </div>
        ${b.chat_id ? '' : '<button type="button" class="btn ghost small" data-act="tgDetect">Найти chat id</button>'}
        <button type="button" class="btn ghost small" data-act="tgTest">Тест</button>
        ${b.from_env ? '' : '<button type="button" class="x-btn" data-act="tgDel" title="Отключить бота">✕</button>'}
      </div>`).join('') : '<div class="hint">Ботов пока нет — подключи готового ниже.</div>';
    root.querySelectorAll('[name=notify_telegram]').forEach(c => {
      c.disabled = !tg.configured;
      if (!tg.configured) c.checked = false;
      else if (!wasConfigured) c.checked = true; // только что подключили — по умолчанию отправляем
    });
    wasConfigured = tg.configured;
  }

  async function tgAction(fn, okText) {
    const box = $('tgMsg');
    box.className = 'err-msg';
    box.textContent = '…';
    try {
      await fn();
      box.className = 'ok-msg';
      box.textContent = okText;
      await loadTelegram();
    } catch (e) {
      box.className = 'err-msg';
      box.textContent = e.message;
    }
  }
  const jsonPost = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  $('tgCard').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = e.target.closest('[data-bot]')?.dataset.bot;
    const token = root.querySelector('[name=tgToken]');
    const chat = root.querySelector('[name=tgChat]');
    if (act === 'tgAdd') {
      tgAction(async () => {
        await api('/telegram/bots', jsonPost({ token: token.value, chat_id: chat.value }));
        token.value = '';
        chat.value = '';
      }, 'Бот подключён — проверь кнопкой «Тест»');
    } else if (act === 'tgTestAll') {
      tgAction(async () => {
        const r = (await api('/telegram/test', { method: 'POST' })).results;
        const bad = r.filter(x => !x.ok);
        if (bad.length) throw new Error(bad.map(x => `${x.id}: ${x.error}`).join('; '));
      }, 'Тестовое сообщение отправлено всем');
    } else if (act === 'tgTest' && id) {
      tgAction(() => api(`/telegram/bots/${id}/test`, { method: 'POST' }), 'Тестовое сообщение отправлено');
    } else if (act === 'tgDetect' && id) {
      tgAction(() => api(`/telegram/bots/${id}/detect`, { method: 'POST' }), 'Chat id найден');
    } else if (act === 'tgDel' && id) {
      tgAction(() => api(`/telegram/bots/${id}`, { method: 'DELETE' }), 'Бот отключён');
    }
  });
  $('tgCard').addEventListener('change', e => {
    const id = e.target.closest('[data-bot]')?.dataset.bot;
    if (id && e.target.type === 'checkbox') {
      tgAction(() => api(`/telegram/bots/${id}?enabled=${e.target.checked}`, { method: 'PATCH' }), e.target.checked ? 'Бот включён' : 'Бот выключен');
    }
  });

  refresh();
  ctx.clearUnread();
  const off = ctx.onAlertEvent(() => refresh());
  const timer = setInterval(refresh, 10000);
  return () => { clearInterval(timer); off(); };
}
