import asyncio
import json
import logging
import os
import uuid

import httpx

from .paths import DATA_DIR

log = logging.getLogger("telegram")

SEND_INTERVAL = 0.5  # Telegram: ~1 сообщение/с в один чат, держим запас
QUEUE_LIMIT = 200


class TelegramError(Exception):
    """Сообщение безопасно показывать пользователю — токена в нём нет."""


class Telegram:
    """Уведомления через ботов. Можно подключить несколько (бот + чат): алерты уходят во все включённые параллельно,
    у каждого своя очередь, поэтому сбой или лимит одного не тормозит остальных.
    Токены и chat_id лежат в data/settings.json; пара из окружения (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — ещё один адресат."""

    def __init__(self):
        self.dests: list[dict] = []  # сохранённые: id, token, chat_id, chat_name, bot, enabled
        self._env: dict | None = None
        token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
        if token and chat:
            self._env = {"id": "env", "token": token, "chat_id": chat, "chat_name": "", "bot": None, "enabled": True}
        self._path = DATA_DIR / "settings.json"
        self._client = httpx.AsyncClient(timeout=15)
        self._queues: dict[str, asyncio.Queue] = {}
        self._workers: dict[str, asyncio.Task] = {}
        self._load()

    # --- хранение ----------------------------------------------------------
    def _load(self):
        try:
            tg = json.loads(self._path.read_text(encoding="utf-8")).get("telegram", {})
        except FileNotFoundError:
            return
        except Exception:
            log.warning("не удалось прочитать settings.json")
            return
        if "destinations" in tg:
            self.dests = [d for d in tg["destinations"] if d.get("token")]
        elif tg.get("token"):  # старый формат: один бот
            self.dests = [{"id": uuid.uuid4().hex[:8], "token": tg["token"], "chat_id": tg.get("chat_id"),
                           "chat_name": "", "bot": tg.get("bot"), "enabled": True}]
            self._save()

    def _save(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"telegram": {"destinations": self.dests}}), encoding="utf-8")
        os.chmod(tmp, 0o600)  # в файле секреты
        tmp.replace(self._path)

    def _all(self) -> list[dict]:
        return self.dests + ([self._env] if self._env else [])

    def _find(self, dest_id: str) -> dict:
        d = next((d for d in self._all() if d["id"] == dest_id), None)
        if d is None:
            raise TelegramError("такой бот не подключён")
        return d

    @staticmethod
    def _ready(d: dict) -> bool:
        return bool(d.get("enabled") and d.get("token") and d.get("chat_id"))

    @property
    def configured(self) -> bool:
        return any(self._ready(d) for d in self._all())

    def status(self) -> dict:
        def pub(d):
            t = d["token"]
            return {"id": d["id"], "bot": d.get("bot"), "chat_id": d.get("chat_id"), "chat_name": d.get("chat_name", ""),
                    "token_hint": f"…{t[-4:]}" if len(t) > 8 else "", "enabled": d.get("enabled", True),
                    "from_env": d["id"] == "env"}
        return {"configured": self.configured, "destinations": [pub(d) for d in self._all()]}

    # --- Bot API ------------------------------------------------------------
    async def _call(self, token: str, method: str, **payload) -> dict:
        try:
            r = await self._client.post(f"https://api.telegram.org/bot{token}/{method}", json=payload)
            data = r.json()
        except httpx.HTTPError as e:
            # repr(e) может содержать URL с токеном — наружу отдаём только тип ошибки
            raise TelegramError(f"нет связи с Telegram ({type(e).__name__})") from None
        except ValueError:
            raise TelegramError("Telegram вернул не-JSON") from None
        if not data.get("ok"):
            err = TelegramError(data.get("description", "ошибка Telegram"))
            err.retry_after = (data.get("parameters") or {}).get("retry_after")
            raise err
        return data["result"]

    @staticmethod
    def _chat_name(chat: dict) -> str:
        return (chat.get("title") or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")]))
                or (f"@{chat['username']}" if chat.get("username") else ""))

    async def _detect(self, token: str, bot: str | None) -> tuple[str, str]:
        """Личный чат с ботом: пользователь должен был написать ему (/start)."""
        updates = await self._call(token, "getUpdates", limit=100, allowed_updates=["message"])
        for u in reversed(updates):
            chat = (u.get("message") or {}).get("chat") or {}
            if chat.get("type") == "private":
                return str(chat["id"]), self._chat_name(chat)
        raise TelegramError(f"не нашёл сообщений боту — открой @{bot or 'бота'}, нажми Start и повтори")

    async def _check_chat(self, token: str, chat_id: str, bot: str | None) -> str:
        try:
            chat = await self._call(token, "getChat", chat_id=chat_id)
        except TelegramError as e:
            raise TelegramError(f"бот @{bot or '?'} не видит чат {chat_id}: {e}. Личный чат — открой бота и нажми Start; "
                                "группа или канал — добавь бота туда") from None
        return self._chat_name(chat)

    # --- управление ботами ---------------------------------------------------
    async def add(self, token: str, chat_id: str = "") -> dict:
        """Подключает готового бота: токен проверяется, тег бота подтягивается сам; без chat_id ищем личный чат."""
        token, chat_id = token.strip(), chat_id.strip()
        if not token:
            raise TelegramError("нужен токен бота (BotFather → /mybots → твой бот → API Token)")
        me = await self._call(token, "getMe")
        bot = me.get("username")
        if chat_id:
            name = await self._check_chat(token, chat_id, bot)
        else:
            chat_id, name = await self._detect(token, bot)
        if any(d["token"] == token and str(d["chat_id"]) == chat_id for d in self._all()):
            raise TelegramError(f"@{bot} с чатом {chat_id} уже подключён")
        d = {"id": uuid.uuid4().hex[:8], "token": token, "chat_id": chat_id, "chat_name": name, "bot": bot, "enabled": True}
        self.dests.append(d)
        self._save()
        return d

    async def detect(self, dest_id: str):
        d = self._find(dest_id)
        if d["id"] == "env":
            raise TelegramError("этот бот задан переменными окружения")
        d["chat_id"], d["chat_name"] = await self._detect(d["token"], d.get("bot"))
        self._save()

    def set_enabled(self, dest_id: str, enabled: bool):
        d = self._find(dest_id)
        if d["id"] == "env":
            raise TelegramError("этот бот задан переменными окружения — убери их, чтобы отключить")
        d["enabled"] = enabled
        self._save()

    def remove(self, dest_id: str):
        d = self._find(dest_id)
        if d["id"] == "env":
            raise TelegramError("этот бот задан переменными окружения")
        self.dests.remove(d)
        self._save()
        w = self._workers.pop(dest_id, None)
        if w:
            w.cancel()
        self._queues.pop(dest_id, None)

    # --- отправка -----------------------------------------------------------------
    async def _send(self, d: dict, text: str):
        await self._call(d["token"], "sendMessage", chat_id=d["chat_id"], text=text, disable_web_page_preview=True)

    async def test(self, dest_id: str | None = None) -> list[dict]:
        """Тестовое сообщение: одному боту (ошибка пробрасывается) или всем включённым (результат по каждому)."""
        text = "✅ Vibescreener: уведомления в Telegram работают"
        if dest_id:
            await self._send(self._find(dest_id), text)
            return [{"id": dest_id, "ok": True}]
        targets = [d for d in self._all() if self._ready(d)]
        if not targets:
            raise TelegramError("нет подключённых ботов")
        out = []
        for d in targets:
            try:
                await self._send(d, text)
                out.append({"id": d["id"], "ok": True})
            except TelegramError as e:
                out.append({"id": d["id"], "ok": False, "error": str(e)})
        return out

    def enqueue(self, text: str):
        """Алерт уходит во все включённые боты параллельно."""
        for d in self._all():
            if not self._ready(d):
                continue
            q = self._queues.get(d["id"])
            if q is None:
                q = self._queues[d["id"]] = asyncio.Queue(maxsize=QUEUE_LIMIT)
                self._workers[d["id"]] = asyncio.create_task(self._run(d["id"], q))
            if q.full():
                try:
                    q.get_nowait()  # при шторме алертов теряем самые старые
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(text)

    def start(self):
        pass  # очереди и обработчики создаются по требованию в enqueue()

    async def _run(self, dest_id: str, q: asyncio.Queue):
        while True:
            text = await q.get()
            try:
                d = self._find(dest_id)
                if self._ready(d):
                    await self._send(d, text)
            except TelegramError as e:
                wait = getattr(e, "retry_after", None)
                if wait:  # упёрлись в лимит — ждём и пробуем ещё раз
                    await asyncio.sleep(min(wait, 60))
                    if not q.full():
                        q.put_nowait(text)
                else:
                    log.warning("бот %s: не отправилось: %s", dest_id, e)
            await asyncio.sleep(SEND_INTERVAL)

    async def close(self):
        for w in self._workers.values():
            w.cancel()
        await asyncio.gather(*self._workers.values(), return_exceptions=True)
        await self._client.aclose()
