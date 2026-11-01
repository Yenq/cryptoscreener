import logging
import os
import re
import time

import httpx

from .version import GITHUB_REPO, __version__

log = logging.getLogger("updates")
CACHE_SEC = 3600


def _parse(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:4]) or (0,)


class UpdateChecker:
    """Спрашивает у GitHub последний релиз (не чаще раза в час). Если репозиторий не задан или закрыт — молчит."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.repo = os.environ.get("SCREENER_REPO") or GITHUB_REPO
        self._at = 0.0
        self._latest: dict | None = None

    async def info(self) -> dict:
        out = {"current": __version__, "latest": None, "url": None, "update_available": False}
        if not self.repo:
            return out
        if time.monotonic() - self._at > CACHE_SEC:
            self._at = time.monotonic()
            try:
                r = await self.client.get(f"https://api.github.com/repos/{self.repo}/releases/latest",
                                          headers={"Accept": "application/vnd.github+json"}, timeout=8)
                if r.status_code == 200:
                    j = r.json()
                    self._latest = {"tag": j["tag_name"], "url": j["html_url"]}
            except httpx.HTTPError as e:
                log.info("не удалось проверить обновления: %s", type(e).__name__)
        if self._latest:
            out["latest"] = self._latest["tag"].lstrip("v")
            out["url"] = self._latest["url"]
            out["update_available"] = _parse(self._latest["tag"]) > _parse(__version__)
        return out
