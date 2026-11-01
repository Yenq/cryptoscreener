from .base import STABLES, Exchange, Ticker, f

API = "https://www.okx.com"
BAR = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D"}


class OKX(Exchange):
    name = "okx"
    label = "OKX"
    rate = 7.0  # лимит свечей — 20 запросов / 2 с
    oi_history = True
    oi_rate = 2.0  # rubik: 5 запросов / 2 с

    async def fetch_tickers(self, market):
        inst = "SWAP" if market == "futures" else "SPOT"
        data = await self.request(market, "GET", f"{API}/api/v5/market/tickers", params={"instType": inst}, limited=False)
        oi = {}
        if market == "futures":  # ОИ по всем свопам — отдельный запрос; если упадёт, тикеры всё равно отдаём
            try:
                od = await self.request(market, "GET", f"{API}/api/v5/public/open-interest",
                                        params={"instType": "SWAP"}, limited=False)
                oi = {x["instId"]: f(x["oiCcy"]) for x in od["data"]}
            except Exception:
                pass
        out = []
        suffix = "-USDT-SWAP" if market == "futures" else "-USDT"
        for x in data["data"]:
            s = x["instId"]
            if not s.endswith(suffix):
                continue
            base = s[: -len(suffix)]
            price, op = f(x["last"]), f(x["open24h"])
            if not price or not op or base in STABLES:
                continue
            vol = f(x["volCcy24h"]) or 0.0
            if market == "futures":
                vol *= price  # для свопов volCcy24h указан в базовой монете
            out.append(Ticker(self.name, market, s, base, price, (price / op - 1) * 100, vol,
                              f(x["high24h"]), f(x["low24h"]), oi.get(s)))
        return out

    async def fetch_candles(self, market, symbol, interval, limit, limited=True):
        data = await self.request(market, "GET", f"{API}/api/v5/market/candles",
                                  params={"instId": symbol, "bar": BAR[interval], "limit": min(limit, 300)},
                                  limited=limited)
        rows = [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]))
                for k in data["data"]]
        rows.reverse()
        return rows

    async def fetch_oi_history(self, symbol, first):
        data = await self.request("futures", "GET", f"{API}/api/v5/rubik/stat/contracts/open-interest-history",
                                  params={"instId": symbol, "period": "1H", "limit": 48}, limiter=self._oi_limiter)
        return [(int(k[0]), float(k[2])) for k in data["data"]]  # k[2] — ОИ в монетах

    def url(self, market, symbol, base):
        if market == "futures":
            return f"https://www.okx.com/trade-swap/{base.lower()}-usdt-swap"
        return f"https://www.okx.com/trade-spot/{base.lower()}-usdt"
