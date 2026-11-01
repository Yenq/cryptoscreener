import time
from array import array
from bisect import bisect_right

from . import oi as oimod
from .exchanges import Exchange, Ticker

# окна для изменения цены, мин
WINDOWS = {"ch5m": 5, "ch15m": 15, "ch1h": 60, "ch4h": 240}
NATR_PERIOD = 14
NATR_BUCKET_MS = 5 * 60_000  # NATR 5/14: 5-минутные свечи, период 14
MIN_OI_VOLUME = 300_000  # ОИ копим только по монетам с заметным оборотом


class Series:
    """Минутные свечи монеты: из них считаются изменения за 5м/15м/1ч/4ч и NATR."""

    __slots__ = ("ts", "open", "close", "natr", "updated")

    def __init__(self, candles, now: float):
        self.ts = array("q", (c[0] for c in candles))
        self.open = array("d", (c[1] for c in candles))
        self.close = array("d", (c[4] for c in candles))
        self.natr = _natr(candles)
        self.updated = now

    def price_at(self, ref_ms: int) -> float | None:
        i = bisect_right(self.ts, ref_ms) - 1
        if i < 0:
            return None  # свечей не хватает, чтобы покрыть окно
        # внутри минутной свечи берём её open, после неё — close (на случай пропусков без сделок)
        return self.open[i] if ref_ms < self.ts[i] + 60_000 else self.close[i]


def _natr(candles) -> float | None:
    """Normalized ATR (Wilder) по 5-минутным свечам, собранным из минуток, в % от цены."""
    buckets: dict[int, list[float]] = {}
    for ts, o, h, l, c, _v in candles:
        b = ts // NATR_BUCKET_MS
        cur = buckets.get(b)
        if cur is None:
            buckets[b] = [o, h, l, c]
        else:
            cur[1] = max(cur[1], h)
            cur[2] = min(cur[2], l)
            cur[3] = c
    bars = [buckets[k] for k in sorted(buckets)]
    if len(bars) < NATR_PERIOD + 1:
        return None
    trs = []
    for prev, cur in zip(bars, bars[1:]):
        trs.append(max(cur[1] - cur[2], abs(cur[1] - prev[3]), abs(cur[2] - prev[3])))
    atr = sum(trs[:NATR_PERIOD]) / NATR_PERIOD
    for tr in trs[NATR_PERIOD:]:
        atr = (atr * (NATR_PERIOD - 1) + tr) / NATR_PERIOD
    last = bars[-1][3]
    return atr / last * 100 if last else None


class Store:
    def __init__(self, exchanges: dict[str, Exchange]):
        self.exchanges = exchanges
        self.tickers: dict[tuple[str, str], dict[str, Ticker]] = {}
        self.series: dict[str, Series] = {}
        self.status: dict[tuple[str, str], dict] = {}
        self.oi: dict[str, oimod.OiSeries] = {}

    # --- запись -----------------------------------------------------------
    def set_tickers(self, exchange: str, market: str, tickers: list[Ticker]):
        self.tickers[(exchange, market)] = {t.symbol: t for t in tickers}
        now_ms = int(time.time() * 1000)
        for t in tickers:  # ОИ, который биржа отдаёт прямо в тикерах, копим минутными точками
            if t.oi is not None and t.volume >= MIN_OI_VOLUME:
                self.oi.setdefault(t.key, oimod.OiSeries()).add(now_ms, t.oi)
        self.status[(exchange, market)] = {"updated": time.time(), "count": len(tickers), "error": None}

    def set_error(self, exchange: str, market: str, err: str):
        st = self.status.setdefault((exchange, market), {"updated": None, "count": 0, "error": None})
        st["error"] = err

    def set_candles(self, key: str, candles):
        if candles:
            self.series[key] = Series(candles, time.time())

    def touch_series(self, key: str):
        """Не долбим повторно символ, по которому свечи не получились."""
        s = self.series.get(key)
        if s:
            s.updated = time.time()
        else:
            self.series[key] = Series([], time.time())

    # --- чтение -----------------------------------------------------------
    def row(self, t: Ticker, now_ms: int) -> dict:
        ex = self.exchanges[t.exchange]
        s = self.series.get(t.key)
        r = {
            "key": t.key,
            "exchange": t.exchange,
            "market": t.market,
            "symbol": t.symbol,
            "base": t.base,
            "price": t.price,
            "ch24h": round(t.change24h, 2),
            "volume": t.volume,
            "high": t.high,
            "low": t.low,
            "natr": None,
            "url": ex.url(t.market, t.symbol, t.base),
        }
        for k, minutes in WINDOWS.items():
            ref = s.price_at(now_ms - minutes * 60_000) if s and s.ts else None
            r[k] = round((t.price / ref - 1) * 100, 2) if ref else None
        if s and s.natr is not None:
            r["natr"] = round(s.natr, 2)
        r["oi"] = r["oi_usd"] = None
        for k in oimod.WINDOWS:
            r[k] = None
        o = self.oi.get(t.key) if t.market == "futures" else None
        if o and o.v:
            r["oi"] = o.latest()
            r["oi_usd"] = r["oi"] * t.price
            for k, minutes in oimod.WINDOWS.items():
                ch = o.change(minutes, now_ms)
                r[k] = round(ch, 2) if ch is not None else None
        return r

    def rows(self, exchanges=None, market: str | None = None) -> list[dict]:
        now_ms = int(time.time() * 1000)
        out = []
        for (ex, mk), tickers in self.tickers.items():
            if exchanges is not None and ex not in exchanges:
                continue
            if market and mk != market:
                continue
            for t in tickers.values():
                out.append(self.row(t, now_ms))
        return out

    def all_tickers(self, exchange: str):
        for (ex, _mk), tickers in self.tickers.items():
            if ex == exchange:
                yield from tickers.values()

    def find(self, exchange: str, market: str, symbol: str) -> Ticker | None:
        return self.tickers.get((exchange, market), {}).get(symbol)

    def set_oi_history(self, key: str, points):
        if points:
            self.oi.setdefault(key, oimod.OiSeries()).merge(points)

    def oi_points(self, key: str) -> list[tuple[int, float]]:
        o = self.oi.get(key)
        return list(zip(o.ts, o.v)) if o else []

    def oi_save(self, path):
        data = oimod.dump(self.oi)
        tmp = path.with_suffix(".tmp")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data)
        tmp.replace(path)

    def oi_load(self, path):
        try:
            self.oi = oimod.load(path.read_bytes(), int(time.time() * 1000))
        except FileNotFoundError:
            pass
        except Exception:
            self.oi = {}  # битый/старый файл — просто начнём копить заново

    def find_by_base(self, exchange: str, market: str, base: str) -> Ticker | None:
        cands = [t for t in self.tickers.get((exchange, market), {}).values() if t.base == base]
        return max(cands, key=lambda t: t.volume, default=None)

    def meta(self) -> dict:
        out = []
        for name, ex in self.exchanges.items():
            markets = {}
            for mk in ex.markets:
                st = self.status.get((name, mk), {})
                markets[mk] = {
                    "updated": st.get("updated"),
                    "count": st.get("count", 0),
                    "error": st.get("error"),
                    "with_candles": sum(1 for t in self.tickers.get((name, mk), {}).values()
                                        if (s := self.series.get(t.key)) and s.ts),
                }
            out.append({"name": name, "label": ex.label, "markets": markets})
        return {"exchanges": out}
