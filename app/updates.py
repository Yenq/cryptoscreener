import logging
import os
import re
import time

import httpx

from .version import GITHUB_REPO, __version__

log = logging.getLogger("updates")
OK_TTL = 300  # после успешной проверки спрашиваем GitHub раз в 5 минут (лимит без токена — 60 запросов/час)
FORCE_MIN_GAP = 10  # ручная проверка не чаще раза в 10 секунд
RETRY_TTL = 120  # после сбоя пробуем снова через 2 минуты


def _parse(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:4]) or (0,)


class UpdateChecker:
    """Спрашивает у GitHub последний релиз. Если репозиторий не задан — молчит; при сбое хранит причину в error."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.repo = os.environ.get("SCREENER_REPO") or GITHUB_REPO
        self._at = 0.0  # wall-clock: time.monotonic() в Windows = время с загрузки ПК и в первый час давал «ещё рано»
        self._ttl = 0.0
        self._latest: dict | None = None
        self.error: str | None = None

    async def _fetch(self):
        try:
            r = await self.client.get(f"https://api.github.com/repos/{self.repo}/releases/latest",
                                      headers={"Accept": "application/vnd.github+json"}, timeout=10)
            if r.status_code == 200:
                j = r.json()
                self._latest = {"tag": j["tag_name"], "url": j["html_url"]}
                self.error, self._ttl = None, OK_TTL
            else:
                hint = " (нет релизов или репозиторий закрыт)" if r.status_code == 404 else ""
                self.error, self._ttl = f"GitHub ответил {r.status_code}{hint}", RETRY_TTL
        except Exception as e:  # сеть, TLS, разбор JSON — в любом случае повторим позже
            self.error, self._ttl = f"{type(e).__name__}: {e}"[:160], RETRY_TTL
            log.info("не удалось проверить обновления: %s", self.error)

    async def info(self, force: bool = False) -> dict:
        out = {"current": __version__, "latest": None, "url": None, "update_available": False,
               "repo": self.repo or None, "error": None}
        if not self.repo:
            return out
        if time.time() - self._at > (FORCE_MIN_GAP if force else self._ttl):
            self._at = time.time()
            await self._fetch()
        out["error"] = self.error
        if self._latest:
            out["latest"] = self._latest["tag"].lstrip("v")
            out["url"] = self._latest["url"]
            out["update_available"] = _parse(self._latest["tag"]) > _parse(__version__)
        return out
