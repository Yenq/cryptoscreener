import asyncio
import json
import logging
import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .paths import DATA_DIR

log = logging.getLogger("alerts")

HISTORY_LIMIT = 200

Metric = Literal["price", "ch5m", "ch15m", "ch1h", "ch4h", "ch24h", "natr", "volume",
                 "oi5m", "oi15m", "oi1h", "oi4h", "oi24h",  # изменение ОИ в монетах, %
                 "oiu5m", "oiu15m", "oiu1h", "oiu4h", "oiu24h",  # изменение ОИ в долларах, %
                 "oi_coins", "oi_usd"]  # абсолютный ОИ: в монетах и в $
Op = Literal["gte", "lte", "abs_gte"]

METRIC_SHORT = {
    "price": "цена", "ch5m": "5м", "ch15m": "15м", "ch1h": "1ч", "ch4h": "4ч", "ch24h": "24ч",
    "natr": "NATR", "volume": "объём",
    "oi5m": "ОИ мон. 5м", "oi15m": "ОИ мон. 15м", "oi1h": "ОИ мон. 1ч", "oi4h": "ОИ мон. 4ч", "oi24h": "ОИ мон. 24ч",
    "oiu5m": "ОИ $ 5м", "oiu15m": "ОИ $ 15м", "oiu1h": "ОИ $ 1ч", "oiu4h": "ОИ $ 4ч", "oiu24h": "ОИ $ 24ч",
    "oi_coins": "ОИ, монет", "oi_usd": "ОИ, $",
}
OP_LABEL = {"gte": "≥", "lte": "≤", "abs_gte": "|x| ≥"}
EX_LABEL = {"binance": "Binance", "bybit": "Bybit", "okx": "OKX", "bitget": "Bitget", "hyperliquid": "Hyperliquid"}
MARKET_LABEL = {"futures": "фьючерсы", "spot": "спот"}


class Condition(BaseModel):
    metric: Metric
    op: Op
    value: float

    @model_validator(mode="after")
    def _check(self):
        if self.metric == "price" and self.op == "abs_gte":
            raise ValueError("Для цены условие «по модулю» не имеет смысла")
        return self


def _norm_symbol(v: str) -> str:
    v = v.strip().upper().replace("/", "").replace("-", "").replace("_", "")
    for q in ("USDT", "USDC", "PERP"):
        if v.endswith(q) and len(v) > len(q):
            v = v[: -len(q)]
    return v


class AlertIn(BaseModel):
    """kind=complex — повторяющийся алерт: все условия сразу (И) по списку монет.
    kind=price — разовое пересечение уровня цены на конкретной бирже."""

    kind: Literal["complex", "price"] = "complex"
    name: str = Field("", max_length=80)
    market: Literal["futures", "spot"] = "futures"
    notify_telegram: bool = True

    # complex
    exchanges: list[str] = []  # пусто — любые биржи
    symbols: list[str] = ["*"]  # "*" — любая монета
    conditions: list[Condition] = Field(default_factory=list, max_length=6)
    min_volume: float = Field(0, ge=0)
    cooldown_min: float = Field(15, ge=0, le=7 * 24 * 60)
    once: bool = False

    # price
    exchange: str | None = None
    symbol: str | None = None  # нативный символ биржи (BTCUSDT) или тикер (BTC)
    level: float | None = Field(None, gt=0)

    @field_validator("symbols")
    @classmethod
    def _symbols(cls, v: list[str]) -> list[str]:
        out = []
        for s in v:
            s = _norm_symbol(s)
            if s and s not in out:
                out.append(s)
        return ["*"] if not out or "*" in out else out[:50]

    @model_validator(mode="after")
    def _check(self):
        for ex in self.exchanges + ([self.exchange] if self.exchange else []):
            if ex not in EX_LABEL:
                raise ValueError(f"Неизвестная биржа: {ex}")
        if self.kind == "price":
            if not (self.exchange and self.symbol and self.level):
                raise ValueError("Для алерта по цене нужны биржа, монета и уровень")
        else:
            if not self.conditions:
                raise ValueError("Добавь хотя бы одно условие")
            if self.market == "spot" and any(c.metric.startswith("oi") for c in self.conditions):
                raise ValueError("Открытый интерес есть только у фьючерсов")
            if self.symbols == ["*"] and any(c.metric == "price" for c in self.conditions):
                raise ValueError("Условие по цене нужно привязать к конкретным монетам")
        return self


class Alert(AlertIn):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:10])
    enabled: bool = True
    created: float = Field(default_factory=time.time)
    last_triggered: float | None = None
    trigger_count: int = 0
    # заполняется сервером для kind=price
    base: str | None = None
    op: Literal["gte", "lte"] | None = None
    ref_price: float | None = None


def _check(op: str, x: float | None, v: float) -> bool:
    if x is None:
        return False
    if op == "gte":
        return x >= v
    if op == "lte":
        return x <= v
    return abs(x) >= v


def _fmt_price(p: float) -> str:
    if p >= 1000:
        return f"{p:,.2f}".replace(",", " ")
    if p >= 1:
        return f"{p:.4f}".rstrip("0").rstrip(".")
    return f"{p:.8f}".rstrip("0").rstrip(".")


def _fmt_value(metric: str, x: float, signed: bool = True) -> str:
    if metric == "price":
        return _fmt_price(x)
    if metric in ("volume", "oi_usd"):
        return f"${x / 1e6:,.1f}M"
    if metric == "oi_coins":
        return f"{x:,.0f}".replace(",", " ")
    sign = "+" if signed and x > 0 and metric != "natr" else ""
    return f"{sign}{x:.2f}%"


class AlertEngine:
    def __init__(self, store, telegram):
        self.store = store
        self.telegram = telegram
        self.alerts: dict[str, Alert] = {}
        self.history: list[dict] = []
        self._state: dict[tuple[str, str], bool] = {}  # (alert_id, ticker_key) -> условие выполнялось
        self._last_fire: dict[tuple[str, str], float] = {}
        self._subs: set[asyncio.Queue] = set()
        self._unparsed: list[dict] = []  # алерты, которые эта версия не поняла: храним как есть, чтобы не потерять
        self._load()

    # --- хранение ---------------------------------------------------------
    def _load(self):
        path = DATA_DIR / "alerts.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except Exception:
            # файл повреждён: откладываем копию, чтобы следующее сохранение его не затёрло
            backup = path.with_name(f"alerts.json.bad-{int(time.time())}")
            try:
                path.replace(backup)
                log.error("alerts.json не читается, сохранён как %s", backup.name)
            except OSError:
                log.exception("не удалось прочитать alerts.json")
            return
        for a in data.get("alerts", []):
            try:
                self.alerts[a["id"]] = Alert(**a)
            except Exception:
                self._unparsed.append(a)
                log.warning("алерт %s непонятен этой версии — оставляю в файле нетронутым", a.get("id"))
        self.history = data.get("history", [])

    def _save(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"alerts": [a.model_dump() for a in self.alerts.values()] + self._unparsed, "history": self.history}
        tmp = DATA_DIR / "alerts.json.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(DATA_DIR / "alerts.json")

    # --- CRUD -------------------------------------------------------------
    def create(self, data: AlertIn) -> Alert:
        a = Alert(**data.model_dump())
        if a.kind == "price":
            t = self.store.find(a.exchange, a.market, a.symbol) or self.store.find_by_base(a.exchange, a.market, _norm_symbol(a.symbol))
            if t is None:
                raise ValueError(f"Монета {a.symbol} не найдена на {EX_LABEL[a.exchange]} ({MARKET_LABEL[a.market]})")
            a.symbol, a.base, a.ref_price = t.symbol, t.base, t.price
            if a.level == t.price:
                raise ValueError("Уровень совпадает с текущей ценой")
            a.op = "gte" if a.level > t.price else "lte"  # направление пересечения — от текущей цены
            a.once = True
        self.alerts[a.id] = a
        self._save()
        return a

    def set_enabled(self, alert_id: str, enabled: bool) -> Alert | None:
        a = self.alerts.get(alert_id)
        if a:
            a.enabled = enabled
            if enabled:  # после повторного включения условие должно «пересечься» заново
                self._forget(alert_id)
            self._save()
        return a

    def delete(self, alert_id: str) -> bool:
        if self.alerts.pop(alert_id, None) is None:
            return False
        self._forget(alert_id)
        self._save()
        return True

    def clear_history(self):
        self.history = []
        self._save()

    def _forget(self, alert_id: str):
        for d in (self._state, self._last_fire):
            for k in [k for k in d if k[0] == alert_id]:
                del d[k]

    # --- подписчики SSE ---------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subs.discard(q)

    # --- проверка ---------------------------------------------------------
    async def on_update(self, exchange: str, market: str):
        active = [a for a in self.alerts.values() if a.enabled and a.market == market and (
            a.exchange == exchange if a.kind == "price" else (not a.exchanges or exchange in a.exchanges))]
        if not active:
            return
        now = time.time()
        rows = self.store.rows([exchange], market)
        fired: list[tuple[Alert, dict, str]] = []
        for a in active:
            if a.kind == "price":
                r = next((r for r in rows if r["symbol"] == a.symbol), None)
                if r and _check(a.op, r["price"], a.level):
                    fired.append((a, r, self._price_text(a, r)))
                continue
            wanted = None if a.symbols == ["*"] else set(a.symbols)
            for r in rows:
                if wanted is not None and r["base"] not in wanted:
                    continue
                if r["volume"] < a.min_volume:
                    continue
                cond = all(_check(c.op, r.get(c.metric), c.value) for c in a.conditions)
                sk = (a.id, r["key"])
                prev = self._state.get(sk)
                self._state[sk] = cond
                # срабатываем только на переходе «не выполнялось → выполняется»
                if not cond or prev is not False:
                    continue
                if now - self._last_fire.get(sk, 0) < a.cooldown_min * 60:
                    continue
                self._last_fire[sk] = now
                fired.append((a, r, self._complex_text(a, r)))
        for a, r, text in fired:
            if a.kind == "price" or a.once:
                a.enabled = False
            self._fire(a, r, text, now)
        if fired:
            self._save()

    @staticmethod
    def _where(r: dict) -> str:
        return f"{r['base']} ({EX_LABEL.get(r['exchange'], r['exchange'])} · {MARKET_LABEL[r['market']]})"

    def _price_text(self, a: Alert, r: dict) -> str:
        arrow = "вверх ↑" if a.op == "gte" else "вниз ↓"
        return f"{self._where(r)}: цена пересекла {_fmt_price(a.level)} {arrow} · сейчас {_fmt_price(r['price'])}"

    def _complex_text(self, a: Alert, r: dict) -> str:
        parts = []
        for c in a.conditions:
            thr = _fmt_value(c.metric, c.value, signed=c.op != "abs_gte")
            parts.append(f"{METRIC_SHORT[c.metric]} {_fmt_value(c.metric, r[c.metric])} [{OP_LABEL[c.op]} {thr}]")
        text = f"{self._where(r)}: " + " · ".join(parts)
        if all(c.metric != "price" for c in a.conditions):
            text += f" · цена {_fmt_price(r['price'])}"
        return text

    def _fire(self, a: Alert, r: dict, text: str, now: float):
        event = {
            "id": uuid.uuid4().hex[:10], "ts": now, "alert_id": a.id, "kind": a.kind, "name": a.name,
            "exchange": r["exchange"], "market": r["market"], "symbol": r["symbol"], "base": r["base"],
            "price": r["price"], "text": text, "url": r["url"],
        }
        a.last_triggered = now
        a.trigger_count += 1
        self.history.insert(0, event)
        del self.history[HISTORY_LIMIT:]
        for q in list(self._subs):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass
        log.info("ALERT %s", text)
        if a.notify_telegram:
            self.telegram.enqueue(f"🔔 {a.name + chr(10) if a.name else ''}{text}\n{r['url']}")
