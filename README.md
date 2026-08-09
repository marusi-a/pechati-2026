# Печати 2026

Мобильное веб-приложение для городского квеста: три пеших маршрута — Петроградская
сторона, Васильевский остров и Техноложка. 83 точки, 98 печатей. Прогресс живёт
в браузере, предложенные места уходят на сервер.

Без сборки и без зависимостей: статика + один Python-файл на стандартной библиотеке.

## HTTPS обязателен

Геолокация и оффлайн-режим работают **только** по HTTPS (или на `localhost`).
По голому `http://IP` кнопка «Отметить место» молча откажет во всех мобильных
браузерах — это ограничение самих браузеров, не приложения.

Значит, нужен домен и сертификат. Если домена нет, самый быстрый путь —
любой бесплатный поддомен и Caddy, который выпускает сертификат сам.

## Быстрый старт локально

```bash
python3 server.py
```

Откроется на <http://127.0.0.1:8781>. `PORT` и `HOST` задаются переменными окружения.

## Что где лежит

```
server.py                 статика + POST /api/suggest, только stdlib
public/
  index.html app.css app.js       приложение
  sw.js                           оффлайн-кэш оболочки и тайлов
  data/points.json                83 точки: координаты, условия печатей, глифы
  vendor/leaflet.*                карта, вшита локально
var/suggestions.jsonl     предложенные места, по одной JSON-строке на заявку
```

## Развёртывание на VPS

```bash
# 1. код
sudo mkdir -p /srv/pechati && sudo chown "$USER" /srv/pechati
rsync -av --exclude var/ ./ user@vps:/srv/pechati/

# 2. сервис
sudo cp /srv/pechati/deploy/pechati.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pechati
systemctl status pechati

# 3. фронт
sudo cp /srv/pechati/deploy/nginx.conf /etc/nginx/sites-available/pechati
sudo ln -sf /etc/nginx/sites-available/pechati /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. сертификат
sudo certbot --nginx -d ПЕЧАТИ.ВАШ-ДОМЕН
```

Nginx отдаёт статику сам и проксирует в Python только `/api/`.

### Вариант с Caddy

Если nginx не нужен, `deploy/Caddyfile` делает то же самое и берёт сертификат
автоматически:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

## Предложенные места

```bash
tail -f var/suggestions.jsonl
python3 -c "
import json
for l in open('var/suggestions.jsonl'):
    r = json.loads(l)
    print(f\"{r['received'][:16]}  {r['name']}  {r['lat']},{r['lon']}  {r['note']}\")
"
```

Проверка живости: `curl https://ваш-домен/api/health` → `{"ok": true, "suggestions": N}`.

Защита на входе: тело до 8 КБ, 12 заявок с адреса в час, координаты только в границах
Петербурга, управляющие символы вырезаются. Аутентификации нет — форма публичная,
поэтому смотрите на файл как на входящую почту, а не как на источник правды.

## Обновление точек

`public/data/points.json` — плоские данные, правятся руками. Формат точки:

```json
{"id":"П08","code":"П—08","i":8,"name":"Твоя Полка",
 "addr":"Каменноостровский просп., 27","note":"Печать с разводными мостами",
 "lat":59.964241,"lon":30.313497,
 "tags":[{"t":"билет","warn":true}],"stamps":1,"glyph":"📘","pal":1,"seed":false}
```

`seed: true` — точка отмечена по умолчанию (пройденное 9 августа).
Маршрут добавляется новым объектом в `routes` с полями `id`, `code`, `short`,
`title`, `sub`, `km` — переключатель на карте строится из данных сам.
`pal` 0–5 — цвет карточки. `warn: true` у тега красит его в оранжевый.

После правки данных сдвиньте версию кэша в `public/sw.js` (`const V`), иначе у тех,
кто уже открывал приложение, останется старый список.

## Ограничения

- Прогресс хранится в `localStorage` конкретного браузера: аккаунтов нет,
  между устройствами не синхронизируется. Выгрузка — «Профиль → Выгрузить прогресс».
- Условия печатей взяты из комментариев авторов списка закладок и не проверялись.
- Тайлы приходят с CARTO. Если они недоступны, приложение рисует схему маршрута
  по координатам на canvas — геометрия настоящая, подложки нет.
