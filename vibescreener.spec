# PyInstaller: `pyinstaller --noconfirm vibescreener.spec` -> dist/Vibescreener/
import os
from PyInstaller.utils.hooks import collect_submodules

icon = "assets/icon.ico" if os.path.exists("assets/icon.ico") else None

a = Analysis(
    ["launcher.py"],
    datas=[("app/static", "app/static")],
    # uvicorn подгружает loops/protocols по строкам — сам PyInstaller их не увидит
    hiddenimports=collect_submodules("uvicorn"),
    excludes=["tkinter", "uvloop", "httptools", "watchfiles", "websockets"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Vibescreener", console=True, icon=icon)
coll = COLLECT(exe, a.binaries, a.datas, name="Vibescreener")
