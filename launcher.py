"""Точка входа для exe (и для `python launcher.py`): поднимает сервер и открывает браузер."""
import os
import socket
import sys
import threading
import time
import webbrowser

# в exe без консоли stdout/stderr бывают None — uvicorn на этом падает
for _name in ("stdout", "stderr"):
    _s = getattr(sys, _name)
    if _s is None:
        setattr(sys, _name, open(os.devnull, "w"))
    else:
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")  # кириллица в консоли Windows
        except Exception:
            pass

import uvicorn  # noqa: E402

from app.main import app  # noqa: E402
from app.paths import DATA_DIR  # noqa: E402
from app.version import __version__  # noqa: E402

HOST = "127.0.0.1"  # только локально: у API нет авторизации, а в нём лежит токен бота


def free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket() as s:
            if s.connect_ex((HOST, port)) != 0:  # никто не слушает — порт свободен
                return port
    return start


def open_browser_when_ready(port: int):
    for _ in range(100):
        with socket.socket() as s:
            if s.connect_ex((HOST, port)) == 0:
                break
        time.sleep(0.2)
    webbrowser.open(f"http://{HOST}:{port}")


def main():
    port = free_port(int(os.environ.get("PORT", 8000)))
    print(f"Vibescreener v{__version__}")
    print(f"Адрес:  http://{HOST}:{port}   (откроется в браузере сам)")
    print(f"Данные: {DATA_DIR}")
    print("Чтобы остановить, закрой это окно.\n")
    if not os.environ.get("NO_BROWSER"):
        threading.Thread(target=open_browser_when_ready, args=(port,), daemon=True).start()
    uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="info", loop="asyncio", http="h11", ws="none")).run()


if __name__ == "__main__":
    main()
