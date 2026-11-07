"""Невеликий веб-сервер: віддає сторінку пошуку і /api/data з розібраними графіками.

Запуск:  py server.py [--lan] [--open] [--port 8765]
  --lan   слухати всю локальну мережу (щоб заходити з телефона по Wi-Fi)
  --open  відкрити сторінку в браузері після запуску
Зібраний KolySvitlo.exe поводиться як `server.py --lan --open`.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import socket
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

FROZEN = getattr(sys, "frozen", False)  # запущено як .exe (PyInstaller)
# ресурси (static/) — всередині exe; кеш — поруч з exe, щоб переживав перезапуск
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
ROOT = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent

sys.path.insert(0, str(BUNDLE_DIR))
import dpem  # noqa: E402

STATIC_DIR = BUNDLE_DIR / "static"
CACHE_FILE = ROOT / "cache" / "last.json"
CACHE_TTL = int(os.environ.get("CACHE_TTL", "300"))   # як часто перечитувати сайт, сек
FORCE_MIN_INTERVAL = 30                               # не частіше при ?refresh=1


class DataCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict | None = None
        self._loaded_at = 0.0
        self._last_attempt = 0.0
        self._last_error: str | None = None
        if CACHE_FILE.exists():
            try:
                self._data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self._data = None

    def get(self, force: bool = False) -> dict:
        with self._lock:
            now = time.time()
            fresh = self._data is not None and self._loaded_at and now - self._loaded_at < CACHE_TTL
            if fresh and not force:
                return self._result()
            if self._data is not None and now - self._last_attempt < FORCE_MIN_INTERVAL:
                return self._result()
            self._last_attempt = now
            try:
                data = dpem.load()
            except Exception as e:  # мережа, зміна верстки сайту тощо
                self._last_error = f"{type(e).__name__}: {e}"
                print(f"[!] Не вдалося оновити дані: {self._last_error}", file=sys.stderr)
                if self._data is None:
                    raise
                return self._result()
            self._data, self._loaded_at, self._last_error = data, now, None
            try:
                CACHE_FILE.parent.mkdir(exist_ok=True)
                CACHE_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            except OSError:
                pass
            return self._result()

    def _result(self) -> dict:
        out = dict(self._data or {})
        out["stale"] = bool(self._last_error) or not self._loaded_at
        if self._last_error:
            out["error"] = self._last_error
        return out


CACHE = DataCache()


class Handler(SimpleHTTPRequestHandler):
    # на Windows типи з реєстру бувають дивні (.js як text/plain) — задаємо явно
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
    }

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/api/data":
            force = parse_qs(url.query).get("refresh", ["0"])[0] == "1"
            try:
                self._json(200, CACHE.get(force=force))
            except Exception as e:
                self._json(502, {"error": f"Не вдалося отримати дані з {dpem.SOURCE_URL}: {e}"})
            return
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            super().log_message(fmt, *args)


class Server(ThreadingHTTPServer):
    # На Windows SO_REUSEADDR дозволяє двом серверам «сісти» на один порт — вимикаємо,
    # щоб зайнятий порт давав помилку і ми брали наступний.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def _is_private(ip: str) -> bool:
    a, b = (int(x) for x in ip.split(".")[:2])
    return a == 10 or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31)


def lan_addresses() -> list[str]:
    """IP цього комп'ютера в локальній мережі (основний — першим)."""
    ips: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))  # UDP connect нічого не надсилає, лише обирає інтерфейс
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            if info[4][0] not in ips:
                ips.append(info[4][0])
    except OSError:
        pass
    return [ip for ip in ips if _is_private(ip)]


def _warm_cache() -> None:
    try:
        CACHE.get()
    except Exception as e:  # повідомлення вже надруковано в DataCache.get
        print(f"[!] Поки немає даних: {e}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description="Коли світло? — пошук черги ГПВ за адресою")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--lan", dest="lan", action="store_true", default=FROZEN,
                    help="доступ з інших пристроїв у локальній мережі (за замовчуванням для exe)")
    ap.add_argument("--local-only", dest="lan", action="store_false", help="лише з цього комп'ютера")
    ap.add_argument("--open", dest="open", action="store_true", default=FROZEN,
                    help="відкрити браузер після запуску (за замовчуванням для exe)")
    ap.add_argument("--no-browser", dest="open", action="store_false")
    args = ap.parse_args()

    host = os.environ.get("HOST") or ("0.0.0.0" if args.lan else "127.0.0.1")
    handler = functools.partial(Handler, directory=str(STATIC_DIR))
    httpd = None
    for port in range(args.port, args.port + 20):
        try:
            httpd = Server((host, port), handler)
            break
        except OSError:
            continue
    if httpd is None:
        print(f"Не вдалося зайняти жоден порт {args.port}–{args.port + 19}.", file=sys.stderr)
        sys.exit(1)

    local_url = f"http://localhost:{port}"
    print("Коли світло? — пошук черги ГПВ за адресою\n")
    print(f"  На цьому комп'ютері:   {local_url}")
    if host == "0.0.0.0":
        for i, ip in enumerate(lan_addresses()):
            label = "З телефона (та сама Wi-Fi мережа):" if i == 0 else "                       або:"
            print(f"  {label} http://{ip}:{port}")
    print("\nЩоб зупинити — закрийте це вікно або натисніть Ctrl+C.\n")

    threading.Thread(target=_warm_cache, daemon=True).start()
    if args.open:
        threading.Timer(0.8, webbrowser.open, args=(local_url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
