#!/usr/bin/env python3
"""Сверяет маршруты приложения с публичным списком закладок Яндекс Карт.

    python3 tools/sync_points.py            # только отчёт, ничего не трогает
    python3 tools/sync_points.py --apply    # вписать близкие точки и обновить данные
    python3 tools/sync_points.py --clusters # где ещё набирается материал на маршрут

Что делает:
  1. Тянет список закладок (в HTML страницы лежит JSON `bookmarksPublicList`).
  2. Догружает координаты только для новых организаций — остальные берёт
     из кэша tools/coords.json, чтобы не долбить Яндекс лишний раз.
  3. Ищет точки, которых нет ни в одном маршруте, и считает, во что обойдётся
     вставка каждой: крюк меньше DETOUR_M метров — вписываем, иначе в кандидаты.

Устойчивые id (хэш от названия с адресом) не меняются при вставке, поэтому
сохранённый прогресс не съезжает. Порядковые `code` и `i` пересчитываются.
"""

import argparse
import gzip
import hashlib
import json
import math
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
POINTS = ROOT / "public" / "data" / "points.json"
SW     = ROOT / "public" / "sw.js"
CACHE  = ROOT / "tools" / "coords.json"
CANDS  = ROOT / "tools" / "candidates.json"

PUBLIC_ID = "OLdDxtRu"
LIST_URL  = (f"https://yandex.ru/maps/2/saint-petersburg/"
             f"?bookmarks%5BpublicId%5D={PUBLIC_ID}&mode=bookmarks&ll=30.31%2C59.95&z=13")
ORG_URL   = "https://yandex.ru/maps/org/{}/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

DETOUR_M = 700     # больше этого крюка точку сама не вписываем
MAX_PTS  = 32      # и не раздуваем маршрут за пределы одного дня ходьбы
WORKERS  = 4       # выше — быстрее ловим капчу

ADDR_RE = re.compile(r'"address":"([^"]{3,120})","coordinates":\[([-\d.]+),([-\d.]+)\]')
ANY_RE  = re.compile(r'"coordinates":\[([-\d.]+),([-\d.]+)\]')


# ─────────────────────────── сеть ───────────────────────────

def get(url, tries=4):
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9",
                "Accept-Encoding": "gzip", "Accept": "text/html"})
            raw = urllib.request.urlopen(req, timeout=45).read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            return raw.decode("utf-8", "ignore")
        except Exception as e:
            if a == tries - 1:
                raise
            time.sleep(2 * (a + 1))


def fetch_list():
    """→ [{title, uri, comment}] из встроенного в страницу JSON."""
    h = get(LIST_URL)
    i = h.index('"bookmarksPublicList":')
    start = h.index("{", i + len('"bookmarksPublicList":') - 1)
    depth, j = 0, start
    while True:
        c = h[j]
        if c == '"':
            j += 1
            while True:
                if h[j] == "\\":
                    j += 2
                    continue
                if h[j] == '"':
                    break
                j += 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return json.loads(h[start:j + 1])


def fetch_coords(oids, cache):
    """Догружает только неизвестные oid. Кэш правится на месте."""
    todo = [o for o in oids if o not in cache]
    if not todo:
        return 0

    def one(oid):
        try:
            h = get(ORG_URL.format(oid))
        except Exception:
            return
        m = ADDR_RE.search(h)
        if m:
            cache[oid] = {"addr": m.group(1), "lon": float(m.group(2)), "lat": float(m.group(3))}
            return
        m = ANY_RE.search(h)
        if m:
            cache[oid] = {"addr": "", "lon": float(m.group(1)), "lat": float(m.group(2))}

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(one, todo))
    return sum(1 for o in todo if o in cache)


# ─────────────────────────── геометрия ───────────────────────────

def dist(a, b):
    """Метры между двумя {lat, lon}."""
    R, t = 6371000, math.pi / 180
    dla, dlo = (b["lat"] - a["lat"]) * t, (b["lon"] - a["lon"]) * t
    s = (math.sin(dla / 2) ** 2 +
         math.cos(a["lat"] * t) * math.cos(b["lat"] * t) * math.sin(dlo / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(s))


def best_insertion(route_pts, new):
    """→ (крюк в метрах, индекс вставки). Хвост считаем как продление."""
    best = None
    for i in range(1, len(route_pts) + 1):
        if i < len(route_pts):
            add = (dist(route_pts[i - 1], new) + dist(new, route_pts[i])
                   - dist(route_pts[i - 1], route_pts[i]))
        else:
            add = dist(route_pts[i - 1], new)
        if best is None or add < best[0]:
            best = (add, i)
    return best


def stable_id(code, name, addr):
    return f"{code}-{hashlib.sha1(f'{name}|{addr}'.encode()).hexdigest()[:6]}"


def renumber(route):
    for k, p in enumerate(route["points"], 1):
        p["i"] = k
        p["code"] = f"{route['code']}—{k:02d}"
        p["pal"] = (k - 1) % 6


# ─────────────────────────── сборка ───────────────────────────

def collect(items, cache):
    """Список закладок → плоские записи с координатами."""
    out = []
    for it in items:
        u = it.get("uri", "")
        if "oid=" in u:
            c = cache.get(u.split("oid=")[1])
            if not c:
                continue
            addr = c["addr"].replace("Санкт-Петербург, ", "")
            out.append({"name": it["title"], "addr": addr, "lat": round(c["lat"], 6),
                        "lon": round(c["lon"], 6), "note": (it.get("comment") or "").strip()})
        elif "ll=" in u:
            lon, lat = u.split("ll=")[1].split("%2C")
            out.append({"name": it["title"], "addr": it.get("description", ""),
                        "lat": round(float(lat), 6), "lon": round(float(lon), 6),
                        "note": (it.get("comment") or "").strip()})
    return out


def clusters(free, cell=0.0063):
    """Грубая склейка соседних ячеек сетки — где ещё набирается маршрут."""
    grid = defaultdict(list)
    for r in free:
        grid[(round((r["lat"] - 59.75) / cell), round((r["lon"] - 30.10) / (cell * 2)))].append(r)
    seen, groups = set(), []
    for k in list(grid):
        if k in seen:
            continue
        stack, g = [k], []
        while stack:
            c = stack.pop()
            if c in seen or c not in grid:
                continue
            seen.add(c)
            g += grid[c]
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    n = (c[0] + dy, c[1] + dx)
                    if n in grid and n not in seen:
                        stack.append(n)
        groups.append(g)
    return sorted(groups, key=len, reverse=True)


def bump_sw():
    s = SW.read_text(encoding="utf-8")
    m = re.search(r"const V\s*=\s*'pechati-v(\d+)'", s)
    if not m:
        return None
    n = int(m.group(1)) + 1
    SW.write_text(s.replace(m.group(0), f"const V     = 'pechati-v{n}'"), encoding="utf-8")
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="вписать близкие точки в маршруты")
    ap.add_argument("--clusters", action="store_true", help="показать заготовки под новые маршруты")
    ap.add_argument("--detour", type=int, default=DETOUR_M, help="предельный крюк, метров")
    a = ap.parse_args()

    data = json.loads(POINTS.read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}

    lst = fetch_list()
    items = lst["children"]
    print(f"список: ревизия {lst['revision']}, {len(items)} точек "
          f"(в данных приложения было {data.get('revision')})")

    oids = [it["uri"].split("oid=")[1] for it in items if "oid=" in it.get("uri", "")]
    got = fetch_coords(oids, cache)
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if got:
        print(f"догрузили координат: {got}")

    all_pts = collect(items, cache)
    known = {(round(p["lat"], 4), round(p["lon"], 4)) for r in data["routes"] for p in r["points"]}
    free = [p for p in all_pts if (round(p["lat"], 4), round(p["lon"], 4)) not in known]
    print(f"вне маршрутов: {len(free)} из {len(all_pts)}\n")

    if a.clusters:
        print("где набирается на отдельный маршрут:\n")
        for g in clusters(free)[:8]:
            if len(g) < 6:
                continue
            span = max(dist(x, y) for x in g for y in g) / 1000
            streets = Counter(p["addr"].split(",")[0] for p in g if p["addr"])
            print(f"  {len(g):3} точек · охват {span:.1f} км · "
                  f"центр {sum(p['lat'] for p in g)/len(g):.4f},{sum(p['lon'] for p in g)/len(g):.4f}")
            print(f"       {', '.join(k for k, _ in streets.most_common(5))}\n")
        return

    live = {(round(q["lat"], 4), round(q["lon"], 4)) for q in all_pts}
    gone = [p for r in data["routes"] for p in r["points"]
            if not p.get("own")            # own — находки владельца, их в закладках нет
            and (round(p["lat"], 4), round(p["lon"], 4)) not in live]
    if gone:
        print("пропали из списка закладок (сами не удаляем — вдруг печать уже собрана):")
        for p in gone:
            print(f"  {p['code']} {p['name']} — {p['addr']}")
        print()

    # Маршрут — это один день ходьбы. Даже если точка ложится рядом,
    # в переполненный маршрут её не суём: пусть ждёт в кандидатах.
    room = {r["id"]: max(0, MAX_PTS - len(r["points"])) for r in data["routes"]}
    fits, far, full = [], [], []
    for p in free:
        opts = [(best_insertion(r["points"], p), r) for r in data["routes"]]
        (add, idx), route = min(opts, key=lambda x: x[0][0])
        if add > a.detour:
            far.append((add, idx, route, p))
        elif room[route["id"]] > 0:
            room[route["id"]] -= 1
            fits.append((add, idx, route, p))
        else:
            full.append((add, idx, route, p))

    fits.sort(key=lambda x: x[0])
    if fits:
        print(f"вписываются (крюк ≤ {a.detour} м):")
        for add, idx, route, p in fits:
            print(f"  +{add:4.0f} м  {route['short']:<13} после №{idx:<3} {p['name']} — {p['addr']}")
    else:
        print("рядом с маршрутами ничего нового")

    if full:
        by = Counter(x[2]["short"] for x in full)
        print(f"\nрядом, но маршрут уже полон ({MAX_PTS} точек): "
              f"{', '.join(f'{k} +{v}' for k, v in by.items())}")
        print("  им пора в отдельный маршрут — смотрите --clusters")

    if far or full:
        CANDS.write_text(json.dumps(
            [{"detour_m": round(x[0]), "nearest": x[2]["short"], **x[3]}
             for x in sorted(far + full, key=lambda x: x[0])],
            ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nвсего не вписано: {len(far) + len(full)} → tools/candidates.json")

    if not a.apply:
        print("\nэто был отчёт. чтобы вписать — запустите с --apply")
        return

    for add, idx, route, p in fits:
        route["points"].insert(idx, {
            "id": stable_id(route["code"], p["name"], p["addr"]),
            "code": "", "i": 0, "name": p["name"], "addr": p["addr"],
            "note": p["note"] or "Ставят печать",
            "lat": p["lat"], "lon": p["lon"],
            "tags": [{"t": "новое", "warn": True}],
            "stamps": 1, "glyph": "✦", "pal": 0, "seed": False,
        })
    for r in data["routes"]:
        renumber(r)
    data["revision"] = lst["revision"]
    data["updated"] = time.strftime("%Y-%m-%d")
    POINTS.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    v = bump_sw()
    total = sum(len(r["points"]) for r in data["routes"])
    print(f"\nвписано {len(fits)}, всего точек {total}, кэш service worker → v{v}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"не вышло: {e}", file=sys.stderr)
        sys.exit(1)
