import os
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)  # запущено из exe (PyInstaller)

# Данные пользователя (алерты, настройки Telegram) лежат рядом с программой в data/ —
# при обновлении достаточно распаковать новую версию поверх старой, data/ не затрагивается.
_base = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SCREENER_DATA_DIR") or _base / "data")
