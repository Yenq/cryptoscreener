import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .alerts import Alert, AlertEngine, AlertIn
from .collector import Collector
from .exchanges import INTERVALS, RateLimited, build_exchanges
from .store import Store
from .telegram import Telegram, TelegramError
from .updates import UpdateChecker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATIC = Path(__file__).parent / "static"
SORT_FIELD = {"5m": "ch5m", "15m": "ch15m", "1h": "ch1h", "4h": "ch4h", "24h": "ch24h"}
OI_FIELD = {"5m": "oi5m", "15m": "oi15m", "1h": "oi1h", "4h": "oi4h", "24h": "oi24h"}  # изменение ОИ в монетах
OIU_FIELD = {w: "oiu" + f[2:] for w, f in OI_FIELD.items()}  # изменение ОИ в долларах


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = httpx.AsyncClient(timeout=httpx.Timeout(15, connect=8),
                               headers={"User-Agent": "vibescreener/1.0"},
                               limits=httpx.Limits(max_connections=40))
    app.state.store = store = Store(build_exchanges(client))
    app.state.telegram = telegram = Telegram()
    app.state.alerts = alerts = AlertEngine(store, telegram)
    app.state.collector = collector = Collector(store, alerts)
    app.state.kline_cache = {}
    app.state.updates = UpdateChecker(client)
    collector.start()
    telegram.start()
    yield
    await collector.stop()
    await telegram.close()
    await client.aclose()


app = FastAPI(title="Vibescreener", lifespan=lifespan)


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def _exchanges(request: Request, csv: str | None) -> list[str]:
    known = request.app.state.store.exchanges
    if not csv:
        return list(known)
    names = [n for n in csv.split(",") if n in known]
    return names


# --- данные ---------------------------------------------------------------
@app.get("/api/version")
async def version(request: Request):
    return await request.app.state.updates.info()


@app.get("/api/meta")
async def meta(request: Request):
    return request.app.state.store.meta()


@app.get("/api/screener")
async def screener(
    request: Request,
    market: Literal["futures", "spot"] = "futures",
    exchanges: str | None = None,
    window: Literal["5m", "15m", "1h", "4h", "24h"] = "5m",
    direction: Literal["up", "down", "abs"] = "up",
    limit: int = Query(16, ge=1, le=100),
    min_volume: float = Query(0, ge=0),
    q: str = "",
    dedupe: bool = True,
    by: Literal["price", "oi", "oiu"] = "price",
):
    field = {"price": SORT_FIELD, "oi": OI_FIELD, "oiu": OIU_FIELD}[by][window]
    names = _exchanges(request, exchanges)
    q = q.strip().upper()
    rows = [r for r in request.app.state.store.rows(names, market)
            if r[field] is not None and r["volume"] >= min_volume and (not q or q in r["base"])]
    if dedupe:  # одна и та же монета на нескольких биржах — оставляем самую ликвидную
        best: dict[str, dict] = {}
        for r in rows:
            if r["base"] not in best or r["volume"] > best[r["base"]]["volume"]:
                best[r["base"]] = r
        rows = list(best.values())
    if direction == "up":
        rows.sort(key=lambda r: r[field], reverse=True)
    elif direction == "down":
        rows.sort(key=lambda r: r[field])
    else:
        rows.sort(key=lambda r: abs(r[field]), reverse=True)
    return {"total": len(rows), "rows": rows[:limit], "ts": time.time()}


@app.get("/api/tickers")
async def tickers(request: Request, exchange: str, market: Literal["futures", "spot"] = "futures"):
    if exchange not in request.app.state.store.exchanges:
        raise HTTPException(404, "unknown exchange")
    return {"rows": request.app.state.store.rows([exchange], market), "ts": time.time()}


@app.get("/api/ticker")
async def ticker(request: Request, exchange: str, market: Literal["futures", "spot"], symbol: str):
    st: Store = request.app.state.store
    t = st.find(exchange, market, symbol)
    if t is None:
        raise HTTPException(404, "unknown symbol")
    return st.row(t, int(time.time() * 1000))


@app.get("/api/oi")
async def open_interest(request: Request, exchange: str, symbol: str):
    st: Store = request.app.state.store
    t = st.find(exchange, "futures", symbol)
    if t is None:
        raise HTTPException(404, "unknown symbol")
    return {"points": [{"time": ts // 1000, "coins": v} for ts, v in st.oi_points(t.key)]}


@app.get("/api/klines")
async def klines(
    request: Request,
    exchange: str,
    market: Literal["futures", "spot"],
    symbol: str,
    interval: str = "1m",
    limit: int = Query(200, ge=10, le=500),
):
    st: Store = request.app.state.store
    if interval not in INTERVALS:
        raise HTTPException(400, "bad interval")
    if st.find(exchange, market, symbol) is None:
        raise HTTPException(404, "unknown symbol")
    cache: dict = request.app.state.kline_cache
    ck = (exchange, market, symbol, interval, limit)
    hit = cache.get(ck)
    if hit and time.monotonic() - hit[0] < 8:
        return hit[1]
    try:
        candles = await st.exchanges[exchange].fetch_candles(market, symbol, interval, limit, limited=False)
    except RateLimited:
        if hit:
            return hit[1]
        raise HTTPException(429, "rate limited by exchange")
    except httpx.HTTPError as e:
        if hit:
            return hit[1]
        raise HTTPException(502, f"exchange error: {e!r}")
    data = [{"time": c[0] // 1000, "open": c[1], "high": c[2], "low": c[3], "close": c[4], "volume": c[5]}
            for c in candles]
    cache[ck] = (time.monotonic(), data)
    if len(cache) > 400:
        for k in sorted(cache, key=lambda k: cache[k][0])[:100]:
            del cache[k]
    return data


# --- алерты ---------------------------------------------------------------
@app.get("/api/alerts")
async def list_alerts(request: Request):
    alerts = request.app.state.alerts
    return {"alerts": sorted(alerts.alerts.values(), key=lambda a: -a.created),
            "telegram": request.app.state.telegram.configured}


@app.get("/api/alerts/history")
async def alert_history(request: Request):
    return {"events": request.app.state.alerts.history}


@app.delete("/api/alerts/history")
async def clear_history(request: Request):
    request.app.state.alerts.clear_history()
    return {"ok": True}


@app.post("/api/alerts", response_model=Alert)
async def create_alert(request: Request, data: AlertIn):
    try:
        return request.app.state.alerts.create(data)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/alerts/{alert_id}", response_model=Alert)
async def toggle_alert(request: Request, alert_id: str, enabled: bool):
    a = request.app.state.alerts.set_enabled(alert_id, enabled)
    if a is None:
        raise HTTPException(404)
    return a


@app.delete("/api/alerts/{alert_id}")
async def delete_alert(request: Request, alert_id: str):
    if not request.app.state.alerts.delete(alert_id):
        raise HTTPException(404)
    return {"ok": True}


@app.get("/api/alerts/stream")
async def alert_stream(request: Request):
    alerts: AlertEngine = request.app.state.alerts
    q = alerts.subscribe()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), 15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        finally:
            alerts.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --- Telegram ---------------------------------------------------------------
class TelegramIn(BaseModel):
    token: str | None = None
    chat_id: str | None = None


def _tg_error(e: TelegramError):
    return HTTPException(400, str(e))


@app.get("/api/telegram")
async def telegram_status(request: Request):
    return request.app.state.telegram.status()


@app.put("/api/telegram")
async def telegram_save(request: Request, data: TelegramIn):
    tg: Telegram = request.app.state.telegram
    try:
        if data.token and data.token.strip():
            await tg.set_token(data.token)
        if data.chat_id is not None and data.chat_id.strip():
            tg.set_chat(data.chat_id)
    except TelegramError as e:
        raise _tg_error(e)
    return tg.status()


@app.post("/api/telegram/detect")
async def telegram_detect(request: Request):
    tg: Telegram = request.app.state.telegram
    try:
        await tg.detect_chat()
    except TelegramError as e:
        raise _tg_error(e)
    return tg.status()


@app.post("/api/telegram/test")
async def telegram_test(request: Request):
    try:
        await request.app.state.telegram.send_now("✅ Vibescreener: уведомления в Telegram работают")
    except TelegramError as e:
        raise _tg_error(e)
    return {"ok": True}


@app.delete("/api/telegram")
async def telegram_clear(request: Request):
    request.app.state.telegram.clear()
    return request.app.state.telegram.status()


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
