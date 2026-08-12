#!/usr/bin/env python3
"""Собирает новые дневные маршруты из точек, не попавших ни в один существующий.

    python3 tools/build_routes.py --plan            # разложить свободные точки по дням
    <править tools/plan.json: названия, коды, что выкинуть>
    python3 tools/build_routes.py --build           # дописать маршруты в points.json

Порядок точек внутри дня считается как открытый маршрут (свободные концы):
ближайший сосед, затем or-opt и 2-opt. Глиф, число печатей и условия
вытаскиваются из названия и комментария автора списка — вручную потом
правится только то, что вышло криво.
"""

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_points as SP

PLAN = SP.ROOT / "tools" / "plan.json"

TARGET = 24      # точек в дне: столько успеваешь обойти за раз
MAX_PTS = 30     # жёсткий потолок дня
MAX_KM = 8.0     # и по ходьбе тоже — дальше это уже два дня
MIN_PTS = 8      # меньше — не день, пусть лежит в кандидатах
MAX_SPAN = 4.5   # км между крайними точками дня


# ─────────────────── смысл из текста ───────────────────

GLYPHS = [
    (r"кофе|coffee|эспрессо|roaster|капучин|бариста",     "☕"),
    (r"\bчай|чайн|tea\b",                                  "🍵"),
    (r"книж|книг|букин|писател|библиотек|комикс|зин",      "📚"),
    (r"музей|музей-|усадьб",                               "🏛"),
    (r"театр|сцен",                                        "🎭"),
    (r"галере|арт|выстав|artist|искусств",                 "🖼"),
    (r"пицц",                                              "🍕"),
    (r"пекарн|хлеб|булоч|круассан|багет",                  "🥐"),
    (r"десерт|торт|пирож|кондитер|сладк|эклер|макарон",    "🍰"),
    (r"морожен|джелат|gelato",                             "🍦"),
    (r"пив|крафт|эль|паб|brew",                            "🍺"),
    (r"вин(о|а|ный)|бар разбит|коктейл",                   "🍷"),
    (r"цвет|флор|букет",                                   "💐"),
    (r"керамик|гончар|фарфор",                             "🏺"),
    (r"парфюм|аромат|свеч",                                "🕯"),
    (r"\bсыр|сырн",                                        "🧀"),
    (r"мяс|шашлык|гриль|стейк|бургер",                     "🥩"),
    (r"рыб|суши|ролл|сельд|краб",                          "🐟"),
    (r"вег|салат|боул|поке|здоров",                        "🥗"),
    (r"шоколад|какао|конфет",                              "🍫"),
    (r"велосип|bike",                                      "🚲"),
    (r"вокзал|поезд|железн|паровоз|трамва",                "🚂"),
    (r"\bкот\b|кош|мурз|barsik",                           "🐱"),
    (r"собак|пёс|пес\b|dog",                               "🐶"),
    (r"\bпарк|\bсад\b|ботан|оранжер|растен",               "🌿"),
    (r"храм|собор|церк|лавр",                              "⛪"),
    (r"пыш|пончик|донат|donut",                            "🍩"),
    (r"лапш|рамен|удон|вок\b|азиат|том ям",                "🍜"),
    (r"сувенир|подар|открыт",                              "🎁"),
    (r"винил|пласт|музык|records|гитар",                   "🎵"),
    (r"кино|фильм|синема",                                 "🎬"),
    (r"игр|настол|шахмат|квест",                           "🎲"),
    (r"тату|пирсинг",                                      "🖋"),
    (r"космет|уход|мыло|баня|спа",                         "🧴"),
    (r"одежд|мерч|store|shop|магаз|маркет|лавка",          "🛍"),
    (r"мам|дет|игрушк",                                    "🧸"),
    (r"почт|письм",                                        "✉️"),
]

TAGS = [
    (r"нужно куп|что-то куп|при покупк|за покупк|покупочк|за заказ", "покупка", False),
    (r"отзыв",                                                        "отзыв",   False),
    (r"подписк|подпис[ая]",                                           "подписка", False),
    (r"билет|платн|за \d+\s*(₽|руб)",                                 "билет",   True),
    (r"культурн\w* блокнот|блокнот",                                  "блокнот", False),
    (r"нужно проверить|не знаю услов|уточнит|согласны ли",            "проверить", True),
    (r"не ставят|временно",                                           "не ставят", True),
    (r"бесплатн|просто так|без услов|за улыб",                        "бесплатно", False),
]

WORDNUM = {"одн": 1, "две": 2, "два": 2, "три": 3, "четыре": 4, "пять": 5}


# Выдуманные названия по словам не разбираются, поэтому известные сети
# и заметные места держим списком. Регистр и ё/е приводим к одному виду.
KNOWN = {
    "твоя полка": "📗", "подписные издания": "📚", "буквоед": "📚", "порядок слов": "📚",
    "дом книги": "📚", "во весь голос": "📚", "все свободны": "📚", "лес": "📚",
    "север-метрополь": "🐻", "клэрс": "💅", "унция": "🍵", "щегол": "🐦",
    "чудесное рядом": "🙂", "перекрёсток миров": "🔮", "рок остров": "🎸",
    "аврора": "🎬", "башня городской думы": "🕰", "пассаж": "🛍",
    "полторы комнаты": "🪑", "полторы комнаты иосифа бродского": "🪑",
    "красный карандаш": "✏️", "онегин": "🎩", "тайяки": "🐟", "такояки": "🐙",
    "такояки-мисэ": "🐙", "киссkiss": "🐱", "кисскисс": "🐱", "animals": "🐾",
    "додо пицца": "🍕", "baggins coffee": "☕", "дринкит": "✈️", "вингараж": "🍷",
    "горка": "⛰", "выдержка": "🍷", "желтый двор": "🏠", "жёлтый двор": "🏠",
    "тихоходка": "🐌", "зан-зан": "🐻", "лепкарня": "🏺", "папа принт": "🖨",
    "эталон": "👓", "мармеладная бочка": "🍬", "в питере пить": "🍺",
    "бурлящий котел": "⚗️", "бурлящий котёл": "🫧", "по любви": "💌",
    "двадцать восьмой": "🎱", "ля манифик": "✨", "soulmate": "💞",
    "пища династии минь": "🥟", "ярумэн": "🍜", "р-26 кебаб": "🥙",
    "твоя остановочка": "🚏", "нотик": "🏘", "моя пекарня": "🥐",
    "cake&breakfast": "🍰", "el tinto": "🍷", "grey chic": "🩶", "чико": "🌰",
    "ultramen": "🍜", "rooks haven": "🕊", "рукс хевен": "🕊", "парадная": "🚪",
    "gaga.ru": "🎈", "pro. änta's": "🌱", "two-ta": "🎨", "академия": "🎓",
    "bar 812": "🍸", "музей голландская кухня": "🧇", "культурно-выставочный центр": "🖼",
}


def glyph_for(name, note, inherited=None):
    key = name.strip().lower().replace("ё", "е")
    if inherited and key in inherited:
        return inherited[key]
    for k, g in KNOWN.items():
        if k.replace("ё", "е") == key:
            return g
    hay = f"{name} {note}".lower()
    for pat, g in GLYPHS:
        if re.search(pat, hay):
            return g
    return "✦"


def stamps_for(note):
    n = note.lower()
    m = re.search(r"(\d+)\s*(печат|штамп|шт\b)", n)
    if m:
        return max(1, min(9, int(m.group(1))))
    m = re.search(r"(печат\w*|штамп\w*)\D{0,12}?\((\d+)\s*шт", n)
    if m:
        return max(1, min(9, int(m.group(2))))
    for w, v in WORDNUM.items():
        if re.search(rf"\b{w}\w*\s+печат", n):
            return v
    return 1


def tags_for(note):
    n = note.lower()
    out = []
    for pat, t, warn in TAGS:
        if re.search(pat, n) and t not in [x["t"] for x in out]:
            out.append({"t": t, "warn": warn})
    return out[:3]


# ─────────────────── геометрия ───────────────────

def path_len(pts):
    return sum(SP.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) / 1000


def order_route(pts):
    """Открытый маршрут: ближайший сосед, потом or-opt и 2-opt."""
    if len(pts) < 3:
        return pts
    start = min(pts, key=lambda p: (p["lat"], p["lon"]))
    rest, best = [p for p in pts if p is not start], [start]
    while rest:
        nxt = min(rest, key=lambda p: SP.dist(best[-1], p))
        best.append(nxt)
        rest.remove(nxt)
    improved = True
    while improved:
        improved = False
        n = len(best)
        for seg in (1, 2, 3):
            for i in range(n - seg + 1):
                piece, others = best[i:i + seg], best[:i] + best[i + seg:]
                for j in range(len(others) + 1):
                    for cand in (piece, piece[::-1]):
                        trial = others[:j] + cand + others[j:]
                        if path_len(trial) < path_len(best) - 1e-9:
                            best, improved = trial, True
        n = len(best)
        for i in range(n - 1):
            for j in range(i + 1, n):
                trial = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                if path_len(trial) < path_len(best) - 1e-9:
                    best, improved = trial, True
    return best


def kmeans(pts, k, iters=80):
    cx = [(pts[i * len(pts) // k]["lat"], pts[i * len(pts) // k]["lon"]) for i in range(k)]
    groups = [[] for _ in range(k)]
    for _ in range(iters):
        groups = [[] for _ in range(k)]
        for p in pts:
            # долготу сжимаем: на широте Петербурга градус по долготе вдвое короче
            j = min(range(k), key=lambda j: (p["lat"] - cx[j][0]) ** 2
                    + ((p["lon"] - cx[j][1]) * 0.5) ** 2)
            groups[j].append(p)
        nx = [(sum(p["lat"] for p in g) / len(g), sum(p["lon"] for p in g) / len(g))
              if g else cx[j] for j, g in enumerate(groups)]
        if nx == cx:
            break
        cx = nx
    return [g for g in groups if g]


def split_two(g):
    """Режем пополам по той оси, вдоль которой группа вытянута сильнее.
    Детерминированно, в отличие от k-means, который на плотных кучах
    иногда сводит оба центра в одну точку и ничего не делит."""
    lats = [p["lat"] for p in g]
    lons = [p["lon"] * 0.5 for p in g]                 # поправка на широту
    spread = lambda v: max(v) - min(v)
    key = (lambda p: p["lat"]) if spread(lats) >= spread(lons) else (lambda p: p["lon"])
    s = sorted(g, key=key)
    h = len(s) // 2
    return [s[:h], s[h:]]


def label(group):
    st = Counter(p["addr"].split(",")[0].strip() for p in group if p["addr"])
    return ", ".join(k for k, _ in st.most_common(3))


# ─────────────────── команды ───────────────────

def free_points(data):
    cache = json.loads(SP.CACHE.read_text(encoding="utf-8"))
    items = SP.fetch_list()["children"]
    all_pts = SP.collect(items, cache)
    known = {(round(p["lat"], 4), round(p["lon"], 4))
             for r in data["routes"] for p in r["points"]}
    return [p for p in all_pts if (round(p["lat"], 4), round(p["lon"], 4)) not in known]


def cmd_plan(data):
    free = free_points(data)
    print(f"свободных точек: {len(free)}\n")

    # сначала грубо отделяем города-спутники от петербургского центра
    blobs = SP.clusters(free, cell=0.02)
    plan = []
    for blob in blobs:
        if len(blob) < MIN_PTS:
            continue
        k = max(1, round(len(blob) / TARGET))
        # k-means раздаёт кластеры неравномерно, поэтому переросшие режем ещё раз
        queue = kmeans(blob, k) if k > 1 else [blob]
        chunks, guard = [], 0
        while queue and guard < 40:
            guard += 1
            g = queue.pop()
            if len(g) > MAX_PTS or (len(g) > MIN_PTS * 2 and path_len(order_route(g)) * 1.2 > MAX_KM):
                halves = split_two(g)
                if all(len(h) >= MIN_PTS for h in halves):
                    queue += halves
                    continue
            chunks.append(g)

        for g in chunks:
            if len(g) < MIN_PTS:
                continue
            g = order_route(g)
            span = max(SP.dist(a, b) for a in g for b in g) / 1000
            if span > MAX_SPAN:
                continue
            plan.append({
                "code": "??", "short": "?", "title": "?",
                "streets": label(g), "km": round(path_len(g) * 1.2, 1),
                "from": g[0]["name"], "to": g[-1]["name"],
                "points": g,
            })
    plan.sort(key=lambda x: -len(x["points"]))
    PLAN.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    for i, r in enumerate(plan, 1):
        print(f"{i}. {len(r['points']):3} точек · {r['km']:4} км · {r['from']} → {r['to']}")
        print(f"    {r['streets']}")
    left = len(free) - sum(len(r["points"]) for r in plan)
    print(f"\nв планы не попало: {left} (одиночки и слишком растянутые)")
    print(f"план записан в {PLAN.relative_to(SP.ROOT)} — впишите code/short/title и запускайте --build")


def cmd_build(data):
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    used = {r["code"] for r in data["routes"]}
    # глифы, размеченные руками в уже собранных маршрутах, — лучший источник:
    # «Твоя Полка» и «Такояки» встречаются по городу не по одному разу
    inherited = {p["name"].strip().lower().replace("ё", "е"): p["glyph"]
                 for r in data["routes"] for p in r["points"] if p["glyph"] != "✦"}
    added = 0
    for spec in plan:
        if spec["code"] in ("??", "") or spec["code"] in used:
            print(f"пропускаю без кода: {spec['streets'][:50]}")
            continue
        pts = []
        for i, p in enumerate(spec["points"], 1):
            note = p["note"] or "Ставят печать"
            pts.append({
                "id": SP.stable_id(spec["code"], p["name"], p["addr"]),
                "code": f"{spec['code']}—{i:02d}", "i": i,
                "name": p["name"], "addr": p["addr"], "note": note,
                "lat": p["lat"], "lon": p["lon"],
                "tags": tags_for(note), "stamps": stamps_for(note),
                "glyph": glyph_for(p["name"], note, inherited), "pal": (i - 1) % 6, "seed": False,
            })
        data["routes"].append({
            "id": max(r["id"] for r in data["routes"]) + 1,
            "code": spec["code"], "short": spec["short"], "title": spec["title"],
            "sub": f"{pts[0]['name']} → {pts[-1]['name']}",
            "km": spec["km"], "points": pts,
        })
        used.add(spec["code"])
        added += 1
        print(f"+ {spec['short']:<22} {len(pts):3} точек, "
              f"{sum(p['stamps'] for p in pts):3} печатей, {spec['km']} км")

    ids = [p["id"] for r in data["routes"] for p in r["points"]]
    assert len(set(ids)) == len(ids), "коллизия id"
    SP.POINTS.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                         encoding="utf-8")
    v = SP.bump_sw()
    print(f"\nдобавлено маршрутов: {added}, всего точек {len(ids)}, кэш → v{v}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--build", action="store_true")
    a = ap.parse_args()
    data = json.loads(SP.POINTS.read_text(encoding="utf-8"))
    if a.build:
        cmd_build(data)
    else:
        cmd_plan(data)


if __name__ == "__main__":
    main()
