import asyncio
import json
import logging
import os

import httpx

from .paths import DATA_DIR

log = logging.getLogger("telegram")

SEND_INTERVAL = 0.5  # Telegram: ~1 сообщение/с в один чат, держим запас
QUEUE_LIMIT = 200


class TelegramError(Exception):
    """Сообщение безопасно показывать пользователю — токена в нём нет."""


class Telegram:
    """Личные уведомления через бота. Токен и chat_id хранятся в data/settings.json (env — как значения по умолчанию)."""

    def __init__(self):
        self.token: str | None = os.environ.get("TELEGRAM_BOT_TOKEN") or None
        self.chat_id: str | None = os.environ.get("TELEGRAM_CHAT_ID") or None
        self.bot: str | None = None  # username бота
        self._path = DATA_DIR / "settings.json"
        self._client = httpx.AsyncClient(timeout=15)
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=QUEUE_LIMIT)
        self._worker: asyncio.Task | None = None
        self._load()

    # --- настройки --------------------------------------------------------
    def _load(self):
        try:
            tg = json.loads(self._path.read_text()).get("telegram", {})
            self.token = tg.get("token") or self.token
            self.chat_id = tg.get("chat_id") or self.chat_id
            self.bot = tg.get("bot")
        except FileNotFoundError:
            pass
        except Exception:
            log.warning("не удалось прочитать settings.json")

    def _save(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        data = {"telegram": {"token": self.token, "chat_id": self.chat_id, "bot": self.bot}}
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        os.chmod(tmp, 0o600)  # в файле секрет
        tmp.replace(self._path)

    @property
    def configured(self) -> bool:
        return bool(self.token and self.chat_id)

    def status(self) -> dict:
        t = self.token or ""
        return {
            "configured": self.configured,
            "has_token": bool(t),
            "token_hint": f"…{t[-4:]}" if len(t) > 8 else "",
            "bot": self.bot,
            "chat_id": self.chat_id,
        }

    # --- Bot API ----------------------------------------------------------
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

    async def set_token(self, token: str) -> str:
        me = await self._call(token.strip(), "getMe")
        self.token = token.strip()
        self.bot = me.get("username")
        self._save()
        return self.bot or ""

    def set_chat(self, chat_id: str):
        self.chat_id = chat_id.strip() or None
        self._save()

    async def detect_chat(self) -> dict:
        """Находит личный чат: пользователь должен был написать боту (/start)."""
        if not self.token:
            raise TelegramError("сначала сохрани токен бота")
        updates = await self._call(self.token, "getUpdates", limit=100, allowed_updates=["message"])
        for u in reversed(updates):
            chat = (u.get("message") or {}).get("chat") or {}
            if chat.get("type") == "private":
                name = " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username", "")
                self.set_chat(str(chat["id"]))
                return {"chat_id": self.chat_id, "name": name}
        raise TelegramError(f"не нашёл личных сообщений боту — открой @{self.bot or 'бота'} и нажми Start")

    def clear(self):
        self.token = self.chat_id = self.bot = None
        self._path.unlink(missing_ok=True)

    # --- отправка ---------------------------------------------------------
    async def send_now(self, text: str):
        if not self.configured:
            raise TelegramError("Telegram не настроен")
        await self._call(self.token, "sendMessage", chat_id=self.chat_id, text=text, disable_web_page_preview=True)

    def enqueue(self, text: str):
        if not self.configured:
            return
        if self._queue.full():
            try:
                self._queue.get_nowait()  # при шторме алертов теряем самые старые
            except asyncio.QueueEmpty:
                pass
        self._queue.put_nowait(text)

    def start(self):
        self._worker = asyncio.create_task(self._run())

    async def _run(self):
        while True:
            text = await self._queue.get()
            try:
                await self.send_now(text)
            except TelegramError as e:
                wait = getattr(e, "retry_after", None)
                if wait:  # упёрлись в лимит — ждём и пробуем ещё раз
                    await asyncio.sleep(min(wait, 60))
                    if not self._queue.full():
                        self._queue.put_nowait(text)
                else:
                    log.warning("не отправилось: %s", e)
            await asyncio.sleep(SEND_INTERVAL)

    async def close(self):
        if self._worker:
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)
        await self._client.aclose()
