import asyncio
import logging
import time
from datetime import datetime, timezone

from .alerts import EX_LABEL, MARKET_LABEL, Alert, SetupParams, _fmt_price
from .exchanges import INTERVAL_MS, Exchange, RateLimited
from .exchanges.base import Limiter
from .setups import Setup, detect

log = logging.getLogger("scanner")

PASS_SLEEP = 10  # пауза между проходами по алертам, с
CACHE_LIMIT = 3000
# запросов свечей в секунду на биржу для сканера (поверх основного потока, лимиты бирж общие)
SCAN_RATE = {"binance": 2.0, "bybit": 3.0, "okx": 3.0, "bitget": 3.0, "hyperliquid": 0.3}
PREVIEW_MAX = 40  # столько монет проверяет «Найти сейчас»


def _fmt_ts(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%d.%m %H:%M")


class SetupScanner:
    """Фоново ищет сетапы по включённым алертам kind=setup. Свечи кэшируются и перезапрашиваются только когда
    на таймфрейме закрылась новая свеча; сама проверка (доли миллисекунды) идёт по кэшу и по живой цене тикеров."""

    def __init__(self, store, engine):
        self.store = store
        self.engine = engine
        self._cache: dict[tuple, tuple[int, list]] = {}  # key -> (fetched_at_ms, candles)
        self._limiters: dict[str, Limiter] = {}
        self._fired: dict[tuple, float] = {}  # (alert_id, ticker_key, level) -> ts
        self._task: asyncio.Task | None = None

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    # --- свечи ---------------------------------------------------------------
    def _limiter(self, ex: Exchange) -> Limiter:
        if ex.name not in self._limiters:
            self._limiters[ex.name] = Limiter(SCAN_RATE.get(ex.name, 2.0))
        return self._limiters[ex.name]

    async def _candles(self, row: dict, tf: str, lookback: int, *, limited: bool = True):
        """Закрытые свечи монеты на таймфрейме. Новый запрос — только если успела закрыться новая свеча."""
        ex = self.store.exchanges[row["exchange"]]
        key = (row["exchange"], row["market"], row["symbol"], tf)
        iv, now = INTERVAL_MS[tf], int(time.time() * 1000)
        hit = self._cache.get(key)
        # в кэше последняя свеча — формирующаяся; когда её время + интервал прошло, появилась новая закрытая
        if hit and now < hit[1][-1][0] + iv + 3000 and len(hit[1]) >= min(lookback, 100):
            candles = hit[1]
        else:
            if limited:
                await self._limiter(ex).acquire()
            candles = await ex.fetch_candles(row["market"], row["symbol"], tf, min(lookback + 20, 1000), limited=False)
            if not candles:
                return []
            if len(self._cache) > CACHE_LIMIT:
                for k in sorted(self._cache, key=lambda k: self._cache[k][0])[:CACHE_LIMIT // 5]:
                    del self._cache[k]
            self._cache[key] = (now, candles)
        return candles[:-1] if candles[-1][0] + iv > now else candles

    # --- поиск ---------------------------------------------------------------------
    def universe(self, exchanges: list[str], market: str, symbols: list[str], min_volume: float, limit: int) -> list[dict]:
        wanted = None if symbols == ["*"] else set(symbols)
        rows = [r for r in self.store.rows(exchanges or list(self.store.exchanges), market)
                if r["volume"] >= min_volume and (wanted is None or r["base"] in wanted)]
        rows.sort(key=lambda r: -r["volume"])
        return rows[:limit]

    async def check(self, row: dict, sp: SetupParams, want: str, *, limited: bool = True) -> Setup | None:
        candles = await self._candles(row, sp.timeframe, sp.lookback, limited=limited)
        return detect(candles, sp.to_detect(), row["price"], want)

    async def preview(self, exchanges, market, symbols, min_volume, sp: SetupParams) -> list[dict]:
        """«Найти сейчас»: пробои и формирующиеся уровни по самым ликвидным монетам (с параллельной загрузкой свечей)."""
        rows = self.universe(exchanges, market, symbols, min_volume, min(sp.max_symbols, PREVIEW_MAX))
        sem = asyncio.Semaphore(6)
        out = []

        async def one(r):
            async with sem:
                try:
                    for want in ("breakout", "forming"):
                        s = await self.check(r, sp, want, limited=False)
                        if s:
                            out.append({"row": r, "status": s.status, "level": s.level, "price": s.price,
                                        "distance_pct": s.distance_pct,
                                        "touches": [{"time": t // 1000, "price": p} for t, p in s.touches]})
                            break
                except (RateLimited, Exception) as e:
                    log.debug("preview %s: %r", r["key"], e)

        await asyncio.gather(*[one(r) for r in rows])
        out.sort(key=lambda x: (x["status"] != "breakout", abs(x["distance_pct"])))
        return out

    def _text(self, a: Alert, r: dict, s: Setup) -> str:
        sp = a.setup
        arrow = "вверх ↑" if s.direction == "long" else "вниз ↓"
        iv = INTERVAL_MS[sp.timeframe]
        gaps = [(b[0] - x[0]) // iv for x, b in zip(s.touches, s.touches[1:])]
        if len(s.touches) <= 4:
            when = ", ".join(_fmt_ts(t) for t, _ in s.touches) + " UTC"
        else:
            when = f"первое {_fmt_ts(s.touches[0][0])}, последнее {_fmt_ts(s.touches[-1][0])} UTC"
        gaps_txt = ", ".join(map(str, gaps)) if len(gaps) <= 6 else f"{min(gaps)}–{max(gaps)}"
        return (f"{r['base']} ({EX_LABEL.get(r['exchange'], r['exchange'])} · {MARKET_LABEL[r['market']]}): "
                f"пробой {sp.timeframe}-уровня {_fmt_price(s.level)} {arrow} · касаний {len(s.touches)} "
                f"({when}; между ними {gaps_txt} св.) · цена {_fmt_price(s.price)}")

    # --- фоновый цикл ------------------------------------------------------------------
    async def _run(self):
        while True:
            try:
                await self._pass()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("проход сканера")
            await asyncio.sleep(PASS_SLEEP)

    async def _pass(self):
        for a in list(self.engine.alerts.values()):
            if a.kind != "setup" or not a.enabled or a.setup is None:
                continue
            for r in self.universe(a.exchanges, a.market, a.symbols, a.min_volume, a.setup.max_symbols):
                if not a.enabled:
                    break
                try:
                    s = await self.check(r, a.setup, "breakout")
                except RateLimited:
                    await asyncio.sleep(5)
                    continue
                except Exception as e:
                    log.debug("scan %s: %r", r["key"], e)
                    continue
                if s is None:
                    continue
                key = (a.id, r["key"], round(s.level, 8), s.touches[0][0])
                now = time.time()
                if key in self._fired or now - self._fired.get((a.id, r["key"]), 0) < a.cooldown_min * 60:
                    continue
                self._fired[key] = self._fired[(a.id, r["key"])] = now
                self.engine.fire_setup(a, r, self._text(a, r, s), now)
        cut = time.time() - 7 * 86400
        for k in [k for k, v in self._fired.items() if v < cut]:
            del self._fired[k]
