import httpx

from .base import INTERVALS, INTERVAL_MS, Exchange, RateLimited, Ticker
from .binance import Binance
from .bitget import Bitget
from .bybit import Bybit
from .hyperliquid import Hyperliquid
from .okx import OKX

__all__ = ["INTERVALS", "INTERVAL_MS", "Exchange", "RateLimited", "Ticker", "build_exchanges"]


def build_exchanges(client: httpx.AsyncClient) -> dict[str, Exchange]:
    classes = (Binance, Bybit, OKX, Bitget, Hyperliquid)
    return {c.name: c(client) for c in classes}
