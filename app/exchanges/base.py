import asyncio
import time
from dataclasses import dataclass

import httpx

# Интервалы свечей, которые поддерживает приложение.
INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")
INTERVAL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}

# Стейблы и подобное — пары вида USDC/USDT смысла в скринере не имеют.
STABLES = {
    "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDD", "USDE", "PYUSD", "EUR", "EURI",
    "AEUR", "GBP", "TRY", "BRL", "RLUSD", "USD1", "USDG", "XUSD", "BFUSD", "UST",
}


class RateLimited(Exception):
    pass


@dataclass(slots=True)
class Ticker:
    exchange: str
    market: str  # "futures" | "spot"
    symbol: str  # нативный символ биржи
    base: str
    price: float
    change24h: float  # %
    volume: float  # оборот за 24ч в USD (котируемая валюта)
    high: float | None = None
    low: float | None = None
    oi: float | None = None  # открытый интерес в монетах (только фьючерсы)

    @property
    def key(self) -> str:
        return f"{self.exchange}:{self.market}:{self.symbol}"


class Limiter:
    """Простой ограничитель частоты запросов (равномерный, не пачками)."""

    def __init__(self, rate: float):
        self.interval = 1.0 / rate
        self._next = 0.0
        self._lock = asyncio.Lock()
        self.blocked_until = 0.0

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            start = max(now, self._next, self.blocked_until)
            self._next = start + self.interval
        if start > now:
            await asyncio.sleep(start - now)

    def block(self, seconds: float):
        self.blocked_until = max(self.blocked_until, time.monotonic() + seconds)


def f(x) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class Exchange:
    name = ""
    label = ""
    markets = ("futures", "spot")
    rate = 5.0  # запросов свечей в секунду
    poll_interval = 5.0  # период опроса тикеров
    # история ОИ для старта (чтобы изменение за 24ч было сразу, а не через сутки работы)
    oi_history = False
    oi_refresh: float | None = None  # None — история берётся один раз, дальше ОИ копится из тикеров
    oi_rate = 2.0

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self._limiter = Limiter(self.rate)
        self._oi_limiter = Limiter(self.oi_rate)

    def limiter(self, market: str) -> Limiter:
        return self._limiter

    async def request(self, market: str, method: str, url: str, *, params=None, json=None, limited=True, limiter=None):
        lim = limiter or self.limiter(market)
        if limited:
            await lim.acquire()
        elif lim.blocked_until > time.monotonic():
            raise RateLimited(self.name)
        r = await self.client.request(method, url, params=params, json=json)
        if r.status_code in (418, 429):
            retry = f(r.headers.get("retry-after")) or 30
            lim.block(min(retry, 120))
            raise RateLimited(f"{self.name} {r.status_code}")
        r.raise_for_status()
        return r.json()

    async def fetch_tickers(self, market: str) -> list[Ticker]:
        raise NotImplementedError

    async def fetch_candles(self, market: str, symbol: str, interval: str, limit: int, limited: bool = True):
        """Возвращает свечи по возрастанию времени: [(ts_ms, o, h, l, c, v), ...]."""
        raise NotImplementedError

    async def fetch_oi_history(self, symbol: str, first: bool) -> list[tuple[int, float]]:
        """[(ts_ms, ОИ в монетах), ...]; first=True — глубокая история для старта."""
        raise NotImplementedError

    def url(self, market: str, symbol: str, base: str) -> str:
        return ""
