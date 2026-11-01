import time

from .base import STABLES, Exchange, Ticker, f

API = "https://api.bitget.com"
FUT_GRAN = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D"}
SPOT_GRAN = {"1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day"}


class Bitget(Exchange):
    name = "bitget"
    label = "Bitget"
    rate = 8.0

    _crypto_spot: set[str] | None = None
    _crypto_spot_at = 0.0

    async def _crypto_spot_symbols(self) -> set[str] | None:
        """В споте Bitget ~3000 токенизированных акций/RWA (areaSymbol=yes) с дикими объёмами — отсекаем их."""
        if self._crypto_spot is None or time.monotonic() - self._crypto_spot_at > 3600:
            try:
                data = await self.request("spot", "GET", f"{API}/api/v2/spot/public/symbols", limited=False)
                self._crypto_spot = {x["symbol"] for x in data["data"]
                                     if x.get("areaSymbol") == "no" and x.get("status") == "online"}
                self._crypto_spot_at = time.monotonic()
            except Exception:
                if self._crypto_spot is None:
                    raise
        return self._crypto_spot

    async def fetch_tickers(self, market):
        if market == "futures":
            data = await self.request(market, "GET", f"{API}/api/v2/mix/market/tickers",
                                      params={"productType": "USDT-FUTURES"}, limited=False)
        else:
            data = await self.request(market, "GET", f"{API}/api/v2/spot/market/tickers", limited=False)
        allowed = await self._crypto_spot_symbols() if market == "spot" else None
        out = []
        for x in data["data"]:
            s = x["symbol"]
            if not s.endswith("USDT") or (allowed is not None and s not in allowed):
                continue
            base = s[:-4]
            price = f(x["lastPr"])
            if not price or base in STABLES:
                continue
            out.append(Ticker(self.name, market, s, base, price, (f(x.get("change24h")) or 0.0) * 100,
                              f(x.get("usdtVolume")) or f(x.get("quoteVolume")) or 0.0,
                              f(x.get("high24h")), f(x.get("low24h")),
                              f(x.get("holdingAmount")) if market == "futures" else None))
        return out

    async def fetch_candles(self, market, symbol, interval, limit, limited=True):
        if market == "futures":
            data = await self.request(market, "GET", f"{API}/api/v2/mix/market/candles", params={
                "symbol": symbol, "productType": "USDT-FUTURES",
                "granularity": FUT_GRAN[interval], "limit": limit}, limited=limited)
        else:
            data = await self.request(market, "GET", f"{API}/api/v2/spot/market/candles", params={
                "symbol": symbol, "granularity": SPOT_GRAN[interval], "limit": limit}, limited=limited)
        rows = [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])) for k in data["data"]]
        rows.sort(key=lambda r: r[0])
        return rows

    def url(self, market, symbol, base):
        if market == "futures":
            return f"https://www.bitget.com/futures/usdt/{symbol}"
        return f"https://www.bitget.com/spot/{symbol}"
