"""Невеликий веб-сервер: віддає сторінку пошуку і /api/data з розібраними графіками.

Запуск:  py server.py            (порт 8765, або змінна оточення PORT)
"""
from __future__ import annotations

import functools
import json
import os
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dpem  # noqa: E402

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
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


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    host = os.environ.get("HOST", "127.0.0.1")
    handler = functools.partial(Handler, directory=str(STATIC_DIR))
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"Пошук черги ГПВ: http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}")
    threading.Thread(target=lambda: CACHE.get(), daemon=True).start()  # прогріти кеш
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
