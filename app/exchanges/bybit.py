from .base import STABLES, Exchange, Ticker, f

API = "https://api.bybit.com"
INTERVAL = {"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D"}


class Bybit(Exchange):
    name = "bybit"
    label = "Bybit"
    rate = 10.0
    oi_history = True
    oi_rate = 6.0

    @staticmethod
    def _category(market):
        return "linear" if market == "futures" else "spot"

    async def fetch_tickers(self, market):
        data = await self.request(market, "GET", f"{API}/v5/market/tickers",
                                  params={"category": self._category(market)}, limited=False)
        out = []
        for x in data["result"]["list"]:
            s = x["symbol"]
            if not s.endswith("USDT"):
                continue
            base = s[:-4]
            price = f(x["lastPrice"])
            if not price or base in STABLES:
                continue
            out.append(Ticker(self.name, market, s, base, price, (f(x.get("price24hPcnt")) or 0.0) * 100,
                              f(x.get("turnover24h")) or 0.0, f(x.get("highPrice24h")), f(x.get("lowPrice24h")),
                              f(x.get("openInterest")) if market == "futures" else None))
        return out

    async def fetch_candles(self, market, symbol, interval, limit, limited=True):
        data = await self.request(market, "GET", f"{API}/v5/market/kline", params={
            "category": self._category(market), "symbol": symbol,
            "interval": INTERVAL[interval], "limit": limit}, limited=limited)
        rows = [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]))
                for k in data["result"]["list"]]
        rows.reverse()  # Bybit отдаёт новые первыми
        return rows

    async def fetch_oi_history(self, symbol, first):
        data = await self.request("futures", "GET", f"{API}/v5/market/open-interest", params={
            "category": "linear", "symbol": symbol, "intervalTime": "15min", "limit": 100}, limiter=self._oi_limiter)
        return [(int(k["timestamp"]), float(k["openInterest"])) for k in data["result"]["list"]]

    def url(self, market, symbol, base):
        if market == "futures":
            return f"https://www.bybit.com/trade/usdt/{symbol}"
        return f"https://www.bybit.com/en/trade/spot/{base}/USDT"
