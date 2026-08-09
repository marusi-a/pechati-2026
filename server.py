#!/usr/bin/env python3
"""Печати 2026 — статика + приём предложенных мест.

Только стандартная библиотека: на VPS не нужен ни pip, ни venv.

    python3 server.py                      # http://127.0.0.1:8781
    PORT=9000 HOST=0.0.0.0 python3 server.py

За nginx статику лучше отдавать самим nginx, а сюда проксировать только /api/.
Предложения пишутся построчно в var/suggestions.jsonl.
"""

import json
import os
import re
import sys
import time
import threading
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT   = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
VAR    = ROOT / "var"
STORE  = VAR / "suggestions.jsonl"

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8781"))

MAX_BODY   = 8 * 1024      # заявка — это две строки текста, больше не нужно
MAX_NAME   = 80
MAX_NOTE   = 400
RATE_N     = 12            # заявок с одного адреса
RATE_WIN   = 3600          # за час

_hits = defaultdict(deque)
_lock = threading.Lock()

# Петербург с запасом: заявки с другого конца планеты — это мусор или ошибка
BBOX = (59.60, 60.20, 29.40, 30.90)


def rate_ok(ip: str) -> bool:
    now = time.time()
    with _lock:
        q = _hits[ip]
        while q and now - q[0] > RATE_WIN:
            q.popleft()
        if len(q) >= RATE_N:
            return False
        q.append(now)
        return True


def clean(s, limit):
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(s or "")).strip()
    return s[:limit]


def validate(raw: dict):
    """→ (запись, None) или (None, текст ошибки)."""
    name = clean(raw.get("name"), MAX_NAME)
    if len(name) < 2:
        return None, "Название слишком короткое"
    note = clean(raw.get("note"), MAX_NOTE)

    lat = lon = None
    if raw.get("lat") is not None and raw.get("lon") is not None:
        try:
            lat, lon = float(raw["lat"]), float(raw["lon"])
        except (TypeError, ValueError):
            return None, "Некорректные координаты"
        if not (BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lon <= BBOX[3]):
            return None, "Координаты вне Петербурга"
        lat, lon = round(lat, 6), round(lon, 6)

    return {
        "name": name,
        "note": note,
        "lat": lat,
        "lon": lon,
        "client_ts": clean(raw.get("ts"), 40),
        "received": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }, None


class Handler(SimpleHTTPRequestHandler):
    server_version = "pechati/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    # ---------- служебное ----------

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Свой код и данные — только с перепроверкой: иначе после деплоя
        # у людей неделю живёт старый app.js. Неизменяемое (leaflet, иконки) кэшируем надолго.
        path = self.path.split("?")[0]
        if path.startswith("/vendor/") or path.endswith((".png", ".svg")):
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    # ---------- маршруты ----------

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            n = sum(1 for _ in STORE.open(encoding="utf-8")) if STORE.exists() else 0
            return self.send_json(HTTPStatus.OK, {"ok": True, "suggestions": n})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/suggest":
            return self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Нет такого метода"})

        if not rate_ok(self.client_ip()):
            return self.send_json(HTTPStatus.TOO_MANY_REQUESTS,
                                  {"ok": False, "error": "Слишком много заявок, попробуйте позже"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Пустое или слишком большое тело"})

        try:
            raw = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(raw, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Ожидался JSON-объект"})

        rec, err = validate(raw)
        if err:
            return self.send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"ok": False, "error": err})

        rec["ip"] = self.client_ip()
        VAR.mkdir(exist_ok=True)
        with _lock, STORE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())

        self.log_message("предложено: %s (%s, %s)", rec["name"], rec["lat"], rec["lon"])
        return self.send_json(HTTPStatus.CREATED, {"ok": True})


def main():
    if not PUBLIC.is_dir():
        sys.exit(f"нет каталога {PUBLIC}")
    VAR.mkdir(exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"Печати 2026 → http://{HOST}:{PORT}  (статика {PUBLIC}, заявки {STORE})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлено")
        srv.shutdown()


if __name__ == "__main__":
    main()
