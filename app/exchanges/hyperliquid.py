import time

from .base import INTERVAL_MS, STABLES, Exchange, Ticker, f

API = "https://api.hyperliquid.xyz/info"


class Hyperliquid(Exchange):
    name = "hyperliquid"
    label = "Hyperliquid"
    # лимит — 1200 веса в минуту, candleSnapshot весит ~25, поэтому свечи идут медленно
    rate = 0.5
    poll_interval = 10.0

    async def fetch_tickers(self, market):
        out = []
        if market == "futures":
            meta, ctxs = await self.request(market, "POST", API, json={"type": "metaAndAssetCtxs"}, limited=False)
            for u, c in zip(meta["universe"], ctxs):
                if u.get("isDelisted"):
                    continue
                price, prev = f(c.get("markPx")), f(c.get("prevDayPx"))
                if not price or not prev:
                    continue
                out.append(Ticker(self.name, market, u["name"], u["name"], price, (price / prev - 1) * 100,
                                  f(c.get("dayNtlVlm")) or 0.0, oi=f(c.get("openInterest"))))
        else:
            meta, ctxs = await self.request(market, "POST", API, json={"type": "spotMetaAndAssetCtxs"}, limited=False)
            tokens = {t["index"]: t["name"] for t in meta["tokens"]}
            for u, c in zip(meta["universe"], ctxs):
                base_i, quote_i = u["tokens"]
                base = tokens.get(base_i, "?")
                if tokens.get(quote_i) != "USDC" or base in STABLES:
                    continue
                price, prev = f(c.get("markPx")), f(c.get("prevDayPx"))
                if not price or not prev:
                    continue
                out.append(Ticker(self.name, market, u["name"], base, price, (price / prev - 1) * 100,
                                  f(c.get("dayNtlVlm")) or 0.0))
        return out

    async def fetch_candles(self, market, symbol, interval, limit, limited=True):
        end = int(time.time() * 1000)
        start = end - limit * INTERVAL_MS[interval]
        data = await self.request(market, "POST", API, json={
            "type": "candleSnapshot",
            "req": {"coin": symbol, "interval": interval, "startTime": start, "endTime": end}}, limited=limited)
        return [(int(k["t"]), float(k["o"]), float(k["h"]), float(k["l"]), float(k["c"]), float(k["v"])) for k in data]

    def url(self, market, symbol, base):
        return f"https://app.hyperliquid.xyz/trade/{symbol}"
