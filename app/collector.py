import asyncio
import logging
import time

from .exchanges import Exchange, RateLimited
from .paths import DATA_DIR
from .store import Store

log = logging.getLogger("collector")

MIN_CANDLE_VOLUME = 300_000  # для монет с меньшим оборотом минутные свечи не тянем
CANDLE_LIMIT = 300  # 5 часов минуток: хватает на окно 4ч и на NATR 5/14
OI_MIN_VOLUME = 1_000_000  # историю ОИ у биржи запрашиваем только по ликвидным монетам
OI_SAVE_SEC = 300
OI_FILE = DATA_DIR / "oi.bin"
CANDLE_REFRESH_SEC = 120  # окна считаются от живой цены, поэтому свечи могут чуть «стареть»


class Collector:
    def __init__(self, store: Store, alerts):
        self.store = store
        self.alerts = alerts
        self._tasks: list[asyncio.Task] = []

    def start(self):
        self.store.oi_load(OI_FILE)
        for ex in self.store.exchanges.values():
            for market in ex.markets:
                self._tasks.append(asyncio.create_task(self._poll_tickers(ex, market)))
            self._tasks.append(asyncio.create_task(self._candle_loop(ex)))
            if ex.oi_history:
                self._tasks.append(asyncio.create_task(self._oi_loop(ex)))
        self._tasks.append(asyncio.create_task(self._oi_saver()))

    async def stop(self):
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        try:
            self.store.oi_save(OI_FILE)
        except Exception as e:
            log.warning("не удалось сохранить ОИ: %r", e)

    async def _oi_saver(self):
        # чтобы после перезапуска не терять накопленную историю ОИ (у Bitget и Hyperliquid другой нет)
        while True:
            await asyncio.sleep(OI_SAVE_SEC)
            try:
                await asyncio.to_thread(self.store.oi_save, OI_FILE)
            except Exception as e:
                log.warning("не удалось сохранить ОИ: %r", e)

    async def _oi_loop(self, ex: Exchange):
        """Подтягивает историю ОИ (для старта); у Binance заодно служит живым источником."""
        done: dict[str, float] = {}
        while True:
            now = time.time()
            todo = [t for t in self.store.tickers.get((ex.name, "futures"), {}).values()
                    if t.volume >= OI_MIN_VOLUME and (t.key not in done or (ex.oi_refresh and now - done[t.key] > ex.oi_refresh))]
            if not todo:
                await asyncio.sleep(5)
                continue
            todo.sort(key=lambda t: t.volume, reverse=True)
            for t in todo:
                first = t.key not in done
                try:
                    self.store.set_oi_history(t.key, await ex.fetch_oi_history(t.symbol, first))
                except asyncio.CancelledError:
                    raise
                except RateLimited as e:
                    log.warning("oi %s: %s", ex.name, e)
                    await asyncio.sleep(5)
                    continue
                except Exception as e:
                    log.debug("oi %s %s failed: %r", ex.name, t.symbol, e)
                done[t.key] = time.time()

    async def _poll_tickers(self, ex: Exchange, market: str):
        while True:
            started = time.monotonic()
            try:
                tickers = await ex.fetch_tickers(market)
                self.store.set_tickers(ex.name, market, tickers)
                await self.alerts.on_update(ex.name, market)
            except asyncio.CancelledError:
                raise
            except RateLimited as e:
                self.store.set_error(ex.name, market, f"rate limit: {e}")
                log.warning("tickers %s/%s: %s", ex.name, market, e)
            except Exception as e:
                self.store.set_error(ex.name, market, repr(e)[:200])
                log.warning("tickers %s/%s failed: %r", ex.name, market, e)
            await asyncio.sleep(max(1.0, ex.poll_interval - (time.monotonic() - started)))

    async def _candle_loop(self, ex: Exchange):
        """Обходит монеты биржи по убыванию оборота и обновляет минутные свечи."""
        while True:
            now = time.time()
            todo = [
                t for t in self.store.all_tickers(ex.name)
                if t.volume >= MIN_CANDLE_VOLUME
                and now - (self.store.series[t.key].updated if t.key in self.store.series else 0) > CANDLE_REFRESH_SEC
            ]
            if not todo:
                await asyncio.sleep(2)
                continue
            todo.sort(key=lambda t: t.volume, reverse=True)
            for t in todo:
                try:
                    candles = await ex.fetch_candles(t.market, t.symbol, "1m", CANDLE_LIMIT)
                    self.store.set_candles(t.key, candles)
                    if not candles:
                        self.store.touch_series(t.key)
                except asyncio.CancelledError:
                    raise
                except RateLimited as e:
                    log.warning("candles %s: %s", ex.name, e)
                    await asyncio.sleep(5)
                except Exception as e:
                    self.store.touch_series(t.key)
                    log.debug("candles %s %s failed: %r", ex.name, t.symbol, e)
