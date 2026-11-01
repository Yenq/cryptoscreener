from .base import STABLES, Exchange, Limiter, Ticker, f

FUT = "https://fapi.binance.com"
SPOT = "https://api.binance.com"


class Binance(Exchange):
    name = "binance"
    label = "Binance"
    rate = 8.0
    oi_history = True
    oi_refresh = 300.0  # у Binance нет ОИ по всем символам сразу — обновляем историей 5м
    oi_rate = 2.5  # лимит /futures/data — 1000 запросов за 5 минут

    def __init__(self, client):
        super().__init__(client)
        # у фьючерсов и спота на Binance независимые лимиты веса
        self._spot_limiter = Limiter(15.0)

    def limiter(self, market):
        return self._limiter if market == "futures" else self._spot_limiter

    async def fetch_tickers(self, market):
        out = []
        if market == "futures":
            data = await self.request(market, "GET", f"{FUT}/fapi/v1/ticker/24hr", limited=False)
            for x in data:
                s = x["symbol"]
                if not s.endswith("USDT") or "_" in s:
                    continue
                price = f(x["lastPrice"])
                if not price:
                    continue
                out.append(Ticker(self.name, market, s, s[:-4], price, f(x["priceChangePercent"]) or 0.0,
                                  f(x["quoteVolume"]) or 0.0, f(x["highPrice"]), f(x["lowPrice"])))
        else:
            data = await self.request(market, "GET", f"{SPOT}/api/v3/ticker/24hr", params={"type": "MINI"}, limited=False)
            for x in data:
                s = x["symbol"]
                if not s.endswith("USDT"):
                    continue
                base = s[:-4]
                price, op = f(x["lastPrice"]), f(x["openPrice"])
                if not price or not op or base in STABLES:
                    continue
                out.append(Ticker(self.name, market, s, base, price, (price / op - 1) * 100,
                                  f(x["quoteVolume"]) or 0.0, f(x["highPrice"]), f(x["lowPrice"])))
        return out

    async def fetch_candles(self, market, symbol, interval, limit, limited=True):
        base = FUT + "/fapi/v1/klines" if market == "futures" else SPOT + "/api/v3/klines"
        data = await self.request(market, "GET", base,
                                  params={"symbol": symbol, "interval": interval, "limit": limit}, limited=limited)
        return [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])) for k in data]

    async def fetch_oi_history(self, symbol, first):
        data = await self.request("futures", "GET", f"{FUT}/futures/data/openInterestHist", params={
            "symbol": symbol, "period": "5m", "limit": 300 if first else 12}, limiter=self._oi_limiter)
        return [(int(k["timestamp"]), float(k["sumOpenInterest"])) for k in data]

    def url(self, market, symbol, base):
        if market == "futures":
            return f"https://www.binance.com/en/futures/{symbol}"
        return f"https://www.binance.com/en/trade/{base}_USDT"
