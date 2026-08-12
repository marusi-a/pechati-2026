/* Печати 2026 — главный экран маршрута.
   Данные: public/data/points.json (три маршрута по Петербургу).
   Прогресс и блокнот находок живут в localStorage. Если рядом отвечает
   POST /api/suggest — находка уходит ещё и на сервер, но это не обязательно. */
'use strict';

const NEAR_M   = 150;   // радиус, в котором отметка считается «я на месте»
const FAR_M    = 600;   // дальше этого точку в подсказке не показываем
const KEY      = 'pechati.progress.v1';
const QKEY     = 'pechati.queue.v1';
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR= '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ───────────────────────── состояние ───────────────────────── */

const S = {
  data: null,
  points: [],          // плоский список
  done: new Set(),
  pos: null,           // {lat, lon, acc}
  view: 'route',
  mapRoute: 1,
  stampFilter: 'all',
  map: null, layer: null, meMark: null, marks: new Map(),
  fallback: false,
  ready: false,
};

const byId = id => S.points.find(p => p.id === id);
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...S.done])); } catch {} };

function seedDone() {
  return S.points.filter(p => p.seed).map(p => p.id);
}

/* До версии с автообновлением id были позиционными («П08»), и вставка новой
   точки в середину маршрута сдвигала отметки на соседние места. Теперь id —
   хэш от названия с адресом; сохранённый прогресс переводим на новые по позиции. */
function migrateIds(saved) {
  const old = new Map();
  S.data.routes.forEach(r => r.points.forEach((p, i) => {
    old.set(`${r.code}${String(i + 1).padStart(2, '0')}`, p.id);
  }));
  return saved.map(x => old.get(x) || x).filter(x => S.points.some(p => p.id === x));
}

/* ───────────────────────── утилиты ───────────────────────── */

function dist(a, b) {                       // метры, гаверсинус
  const R = 6371000, t = Math.PI / 180;
  const dLa = (b.lat - a.lat) * t, dLo = (b.lon - a.lon) * t;
  const s = Math.sin(dLa / 2) ** 2 +
            Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const fmtD = m => m < 950
  ? `${Math.round(m / 10) * 10} м`
  : `${(m / 1000).toFixed(m < 9500 ? 1 : 0).replace('.', ',')} км`;
const esc  = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

/* активный маршрут — первый недособранный */
function activeRoute() {
  return S.data.routes.find(r => r.points.some(p => !S.done.has(p.id))) || S.data.routes[0];
}
/* следующая точка активного маршрута */
function nextPoint() {
  const r = activeRoute();
  return r.points.find(p => !S.done.has(p.id)) || r.points[r.points.length - 1];
}
function nearestUndone(from, limit = 3) {
  return S.points
    .filter(p => !S.done.has(p.id))
    .map(p => ({ p, d: dist(from, p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}

/* ───────────────────────── геолокация ───────────────────────── */

function getPosition(opts = {}) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej({ code: 0 });
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(e),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000, ...opts }
    );
  });
}
const geoReason = e => ({
  1: 'Доступ к геопозиции запрещён. Разрешите его в настройках браузера или отметьте точку вручную.',
  2: 'Не удалось определить положение. Сигнал слабый — попробуйте на открытом месте или отметьте вручную.',
  3: 'Геопозиция ищется слишком долго. Попробуйте ещё раз или отметьте точку вручную.',
}[e && e.code] || 'Геолокация недоступна на этом устройстве. Отметьте точку вручную.');

/* ───────────────────────── отрисовка ───────────────────────── */

function stampHTML(p, opts = {}) {
  const got = S.done.has(p.id);
  const lock = !got && !opts.always;
  const mul = p.stamps > 1 ? `<span class="stamp-mul"><b>×${p.stamps}</b></span>` : '';
  return `<div class="stamp${lock ? ' locked' : ''}${opts.big ? ' big' : ''}"
     style="--pc:var(--p${p.pal});--pi:var(--p${p.pal}i)">
     <span class="stamp-code">${esc(p.code)}</span>${mul}
     <span class="stamp-glyph">${p.glyph}</span></div>`;
}

function renderHero() {
  const total = S.points.length;
  const got = S.done.size;
  const pct = Math.round(got / total * 100);
  const r = activeRoute();
  const first = S.points[0];

  const nn = n => String(n).padStart(2, '0');   // маршрутов уже больше девяти
  $('#dayLabel').textContent = `День ${nn(r.id)} · ${r.title}`;
  $('#heroKicker').textContent = `Маршрут ${nn(r.id)} / ${nn(S.data.routes.length)}`;
  $('#heroTitle').textContent =
    got === 0     ? `Начнём с «${first.name}»` :
    got === total ? 'Все печати собраны' : 'Где ты был сегодня?';
  $('#heroSub').textContent = `${got} ${plural(got, 'место', 'места', 'мест')} отмечено`;
  $('#heroPct').textContent = `${pct}%`;
  $('#heroBar').style.width = pct + '%';
  $('#stampCount').textContent = got;
}
const plural = (n, a, b, c) => {
  const m = n % 100, k = n % 10;
  return m > 4 && m < 21 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c;
};

function renderStepper() {
  const r = activeRoute();
  const pts = r.points;
  const cur = pts.indexOf(nextPoint());
  const SLOT = 4;
  const start = Math.max(0, Math.min(cur - 1, pts.length - SLOT));
  const win = pts.slice(start, start + SLOT);

  /* линия идёт от центра первой точки до центра последней, поэтому
     отступ по краям — половина колонки, а заливка меряется в шагах между точками */
  const N = win.length;
  const inset = 50 / N;
  const nowIdx = win.findIndex(p => p.id === pts[cur]?.id);
  const fillTo = nowIdx === -1 ? N - 1 : nowIdx;
  const fill = N > 1 ? (fillTo / (N - 1)) * 100 : 0;

  $('#stepKm').textContent = `${String(r.km).replace('.', ',')} км`;
  $('#stepper').innerHTML =
    `<div class="step-line" style="left:${inset}%;right:${inset}%"><i style="width:${fill}%"></i></div>
     <div class="step-row">${win.map(p => {
       const cls = S.done.has(p.id) ? 'done' : (p.id === pts[cur]?.id ? 'now' : '');
       return `<button class="step ${cls}" data-pt="${p.id}">
                 <span class="step-dot"></span><span class="step-lbl">${esc(p.name)}</span></button>`;
     }).join('')}</div>`;

  const np = pts[cur];
  $('#hereName').textContent = np ? np.name : '—';
  const allDone = S.done.size === S.points.length;
  $('#hereLabel').textContent = allDone ? 'Маршрут пройден' : 'Следующая точка';
  $('#herePin').classList.toggle('pulse', !allDone);
  $('#hereDist').textContent = S.pos && np ? fmtD(dist(S.pos, np)) : '';
}

function renderRail() {
  const got = S.points.filter(p => S.done.has(p.id));
  const rail = $('#rail');
  if (!got.length) {
    rail.innerHTML = `<div class="tail-note" style="margin:0;flex:1">
      <p style="margin:0">Штампов пока нет. Отметьтесь на первой точке — карточка появится здесь.</p></div>`;
    return;
  }
  rail.innerHTML = got.slice().reverse().slice(0, 12).map(p =>
    `<button class="stamp-card" data-pt="${p.id}">${stampHTML(p)}
       <span class="stamp-name">${esc(p.name)}</span></button>`).join('');
}

function renderStamps() {
  const f = S.stampFilter;
  const list = S.points.filter(p =>
    f === 'got' ? S.done.has(p.id) : f === 'left' ? !S.done.has(p.id) : true);
  const grid = $('#stampGrid'), empty = $('#stampEmpty');
  const none = !list.length;
  empty.hidden = !none;
  grid.hidden = none;
  if (none) {
    $('#stampEmpty b').textContent = f === 'got' ? 'Пока пусто' : 'Всё собрано';
    $('#stampEmpty p').textContent = f === 'got'
      ? 'Отметьтесь на первой точке маршрута — штамп появится здесь.'
      : 'Не осталось ни одной неотмеченной точки. Красиво.';
    return;
  }
  grid.innerHTML = list.map(p =>
    `<button class="stamp-card" data-pt="${p.id}">${stampHTML(p)}
       <span class="stamp-name">${esc(p.name)}</span></button>`).join('');
}

function renderProfile() {
  const got = S.points.filter(p => S.done.has(p.id));
  const stamps = got.reduce((n, p) => n + p.stamps, 0);
  const totalStamps = S.points.reduce((n, p) => n + p.stamps, 0);
  $('#stats').innerHTML = `
    <div class="stat lime"><b>${got.length}</b><span>точек</span></div>
    <div class="stat"><b>${stamps}</b><span>печатей</span></div>
    <div class="stat"><b>${S.points.length - got.length}</b><span>осталось</span></div>`;
  $('#fine').innerHTML = `Источник точек — публичный список закладок Яндекс Карт <b>${S.data.source}</b>,
    ревизия ${S.data.revision} от ${S.data.updated}. Всего в двух маршрутах ${totalStamps} печатей
    на ${S.points.length} точках. Условия печатей взяты из комментариев авторов и не проверялись.`;
  const q = findings();
  $('#suggestState').textContent = q.length
    ? `В блокноте ${q.length} ${plural(q.length, 'находка', 'находки', 'находок')}`
    : 'Печать, которой нет в списке';
}

/* переключатель маршрутов на карте строится из данных: маршрутов может стать больше */
function renderMapSeg() {
  $('#mapSeg').innerHTML = S.data.routes.map(r =>
    `<button data-r="${r.id}" aria-pressed="${r.id === S.mapRoute}">${esc(r.short || r.title)}</button>`
  ).join('');
  scrollSegIntoView();
}

/* Маршрутов полтора десятка, полоса переключателя прокручивается —
   подтягиваем активную кнопку в видимую часть. */
function scrollSegIntoView() {
  const box = $('#mapSeg');
  if (!box) return;
  // после innerHTML ширины ещё нулевые, поэтому ждём кадр; таймер —
  // страховка на случай, когда rAF не идёт (свёрнутая вкладка)
  const go = () => {
    const on = box.querySelector('button[aria-pressed="true"]');
    if (on && box.clientWidth) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  requestAnimationFrame(go);
  setTimeout(go, 120);
}


function renderAll() {
  renderHero(); renderStepper(); renderRail(); renderStamps(); renderProfile();
  if (S.map || S.fallback) drawMap();
}

/* ───────────────────────── шторка ───────────────────────── */

const Sheet = {
  open(html) {
    $('#sheetBody').innerHTML = html;
    $('#sheetHost').hidden = false;
    document.body.style.overflow = 'hidden';
  },
  close() {
    $('#sheetHost').hidden = true;
    $('#sheetBody').innerHTML = '';
    document.body.style.overflow = '';
    if (Sheet._map) { Sheet._map.remove(); Sheet._map = null; }
  },
};
$('#scrim').addEventListener('click', () => Sheet.close());
document.addEventListener('keydown', e => { if (e.key === 'Escape') Sheet.close(); });

/* ───────────────────────── отметка точки ───────────────────────── */

async function markPlace() {
  const btn = $('#markBtn');
  btn.classList.add('busy'); btn.disabled = true;
  $('#ctaHint').textContent = 'Ищем вас…';
  try {
    S.pos = await getPosition();
    renderStepper();
    if (S.map) drawMe();
    const near = nearestUndone(S.pos, 3);
    if (!near.length)                 sheetAllDone();
    else if (near[0].d <= NEAR_M)     sheetConfirm(near[0].p, near[0].d);
    else                              sheetTooFar(near);
  } catch (e) {
    sheetNoGeo(geoReason(e));
  } finally {
    btn.classList.remove('busy'); btn.disabled = false;
    $('#ctaHint').textContent = 'Определим геопозицию и найдём ближайшую точку';
  }
}

function tagsHTML(p) {
  const t = p.tags.map(x => `<span class="tag${x.warn ? ' warn' : ''}">${esc(x.t)}</span>`).join('');
  const m = p.stamps > 1 ? `<span class="tag mul">×${p.stamps}</span>` : '';
  return t || m ? `<div class="tags">${m}${t}</div>` : '';
}

function sheetConfirm(p, d) {
  Sheet.open(`
    <h2 id="sheetTitle">Вы у точки «${esc(p.name)}»</h2>
    <p>${esc(p.addr)} · ${fmtD(d)} от вас<br>${esc(p.note)}</p>
    ${tagsHTML(p)}
    <div class="sheet-actions">
      <button class="cta" data-act="confirm" data-pt="${p.id}"><span class="cta-txt">Отметить и получить штамп</span></button>
      <button class="ghost-btn" data-act="manual">Это другая точка</button>
    </div>`);
}

function sheetTooFar(near) {
  const inRange = near.filter(x => x.d <= FAR_M);
  Sheet.open(`
    <h2 id="sheetTitle">Рядом нет точек маршрута</h2>
    <p>Ближайшая — ${esc(near[0].p.name)}, ${fmtD(near[0].d)}.
       ${inRange.length ? 'Выберите её из списка или' : 'Можно'} отметить точку вручную,
       а если нашли печать, которой нет в списке — предложите место.</p>
    ${inRange.length ? `<div class="pick">${inRange.map(x => pickRow(x.p, x.d)).join('')}</div>` : ''}
    <div class="sheet-actions">
      <button class="ghost-btn" data-act="manual">Выбрать точку вручную</button>
      <button class="cta" data-act="suggest"><span class="cta-txt">Предложить это место</span></button>
    </div>`);
}

function sheetNoGeo(reason) {
  Sheet.open(`
    <h2 id="sheetTitle">Не видим, где вы</h2>
    <p>${esc(reason)}</p>
    <div class="sheet-actions">
      <button class="cta" data-act="manual"><span class="cta-txt">Отметить точку вручную</span></button>
      <button class="ghost-btn" data-act="retry">Попробовать ещё раз</button>
    </div>`);
}

function sheetAllDone() {
  Sheet.open(`
    <h2 id="sheetTitle">Все точки отмечены</h2>
    <p>Оба маршрута пройдены целиком — ${S.points.reduce((n, p) => n + p.stamps, 0)} печатей.
       Если нашли место, которого нет в списке, предложите его.</p>
    <div class="sheet-actions">
      <button class="cta" data-act="suggest"><span class="cta-txt">Предложить место</span></button>
    </div>`);
}

const pickRow = (p, d) => `
  <button class="pick-item${S.done.has(p.id) ? ' is-done' : ''}" data-act="confirm" data-pt="${p.id}">
    <span class="pick-g">${p.glyph}</span>
    <span class="pick-t"><b>${esc(p.code)} · ${esc(p.name)}</b><small>${esc(p.addr)}</small></span>
    ${d != null ? `<span class="pick-d">${fmtD(d)}</span>` : ''}
  </button>`;

function sheetManual() {
  const undone = S.points.filter(p => !S.done.has(p.id));
  const list = S.pos
    ? undone.map(p => ({ p, d: dist(S.pos, p) })).sort((a, b) => a.d - b.d)
    : undone.map(p => ({ p, d: null }));
  Sheet.open(`
    <h2 id="sheetTitle">Какую точку отметить?</h2>
    <p>${S.pos ? 'Отсортировано по расстоянию от вас.' : 'Порядок — как в маршруте.'}
       Осталось ${undone.length} ${plural(undone.length, 'точка', 'точки', 'точек')}.</p>
    <div class="pick">${list.map(x => pickRow(x.p, x.d)).join('')}</div>`);
}

function confirmPoint(id) {
  const p = byId(id);
  if (!p || S.done.has(id)) { Sheet.close(); return; }
  S.done.add(id); save();
  Sheet.close();
  renderAll();
  reveal(p);
}

function reveal(p) {
  $('#revealStamp').innerHTML = stampHTML(p, { big: true, always: true });
  $('#revealKick').textContent = p.stamps > 1 ? `Новые штампы · ×${p.stamps}` : 'Новый штамп';
  $('#revealName').textContent = p.name;
  $('#revealNote').textContent = p.note || p.addr;
  $('#reveal').hidden = false;
  if (navigator.vibrate) navigator.vibrate(18);
}
$('#revealClose').addEventListener('click', () => { $('#reveal').hidden = true; });

/* ───────────────────────── предложить место ───────────────────────── */

/* Находка всегда ложится в локальный блокнот. Если рядом есть сервер (server.py
   или VPS) — заявка уходит и ему. На GitHub Pages сервера нет, поэтому находку
   надо скопировать и отправить автору списка руками. */
const findings = () => { try { return JSON.parse(localStorage.getItem(QKEY)) || []; } catch { return []; } };
const setFindings = q => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch {} };

const findingText = f => [
  `Печать: ${f.name}`,
  f.note ? `Условия: ${f.note}` : null,
  f.lat != null ? `Координаты: ${f.lat}, ${f.lon}` : null,
  f.lat != null ? `https://yandex.ru/maps/?ll=${f.lon},${f.lat}&z=18&pt=${f.lon},${f.lat}` : null,
].filter(Boolean).join('\n');

async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch {}
  const ta = document.createElement('textarea');          // запасной путь для http и старых webview
  ta.value = txt;
  ta.style.cssText = 'position:fixed;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

function sheetSuggest() {
  const c = S.pos || { lat: 59.9541, lon: 30.3065 };
  Sheet.open(`
    <h2 id="sheetTitle">Предложить место</h2>
    <p>Передвиньте булавку на нужный адрес и опишите печать. Находка сохранится у вас, дальше её можно скопировать и отправить автору списка.</p>
    <div id="pickMap"></div>
    <p class="pick-hint"><span id="pickLL">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</span></p>
    <div class="field">
      <label for="sName">Название места</label>
      <input id="sName" maxlength="80" autocomplete="off" placeholder="Например, книжный «Самокат»">
    </div>
    <div class="field">
      <label for="sNote">Что за печать и условия</label>
      <textarea id="sNote" rows="3" maxlength="400"
        placeholder="Ставят на кассе бесплатно, до 20:00"></textarea>
    </div>
    <p class="field err" id="sErr" hidden></p>
    <div class="sheet-actions">
      <button class="cta" data-act="send"><span class="cta-txt">Сохранить находку</span><span class="spin"></span></button>
    </div>`);

  /* Шторка выезжает через transform, и Leaflet, поднятый в этот момент,
     считает размеры контейнера по промежуточному положению — тайлы не приходят.
     Ждём конца анимации, и уже потом строим карту. */
  const host = $('#sheet');
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    host.removeEventListener('animationend', build);
    buildPickMap(c);
  };
  host.addEventListener('animationend', build);
  setTimeout(build, 420);
}

function buildPickMap(c) {
  {
    if (typeof L === 'undefined') { $('#pickMap')?.remove(); return; }
    if (!$('#pickMap')) return;
    const m = L.map('pickMap', { attributionControl: false, zoomControl: false })
               .setView([c.lat, c.lon], 16);
    L.tileLayer(TILE_URL, { maxZoom: 19, subdomains: 'abcd' }).addTo(m);
    const mk = L.marker([c.lat, c.lon], {
      draggable: true,
      icon: L.divIcon({ className: '', html: '<span class="mk mk-now">✦</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).addTo(m);
    const sync = ll => { $('#pickLL').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`; };
    mk.on('drag', e => sync(e.target.getLatLng()));
    m.on('click', e => { mk.setLatLng(e.latlng); sync(e.latlng); });
    Sheet._map = m; Sheet._mk = mk;
    m.invalidateSize();
    setTimeout(() => m.invalidateSize(), 200);
  }
}

async function sendSuggestion() {
  const name = $('#sName').value.trim();
  const note = $('#sNote').value.trim();
  const err = $('#sErr');
  if (name.length < 2) { err.hidden = false; err.textContent = 'Напишите название места.'; return; }
  err.hidden = true;

  const ll = Sheet._mk ? Sheet._mk.getLatLng() : null;
  const body = {
    name, note,
    lat: ll ? +ll.lat.toFixed(6) : (S.pos ? S.pos.lat : null),
    lon: ll ? +ll.lng.toFixed(6) : (S.pos ? S.pos.lon : null),
    ts: new Date().toISOString(),
  };

  const btn = $('[data-act="send"]');
  btn.classList.add('busy'); btn.disabled = true;
  body.sent = await postSuggestion(body);
  btn.classList.remove('busy'); btn.disabled = false;

  const all = findings(); all.push(body); setFindings(all);
  renderProfile();
  sheetFinding(body, all.length - 1);
}

function sheetFinding(f, idx) {
  const txt = findingText(f);
  Sheet.open(`
    <h2 id="sheetTitle">${f.sent ? 'Отправили автору' : 'Записали находку'}</h2>
    <p>${f.sent
      ? `«${esc(f.name)}» ушло в список предложений.`
      : `«${esc(f.name)}» лежит в вашем блокноте находок. Отправлять некому — приложение живёт без сервера, поэтому скопируйте текст и киньте автору списка.`}</p>
    <pre class="quote">${esc(txt)}</pre>
    <div class="sheet-actions">
      ${f.sent ? '' : `<button class="cta" data-act="copy" data-i="${idx}"><span class="cta-txt">Скопировать</span></button>`}
      ${navigator.share && !f.sent ? `<button class="ghost-btn" data-act="share" data-i="${idx}">Поделиться</button>` : ''}
      <button class="ghost-btn" data-act="close">Готово</button>
    </div>`);
}

function sheetFindings() {
  const all = findings();
  if (!all.length) {
    Sheet.open(`
      <h2 id="sheetTitle">Блокнот находок пуст</h2>
      <p>Сюда попадают места с печатями, которых нет в списке. Нашли такое — жмите «Предложить место».</p>
      <div class="sheet-actions">
        <button class="cta" data-act="suggest"><span class="cta-txt">Предложить место</span></button>
      </div>`);
    return;
  }
  Sheet.open(`
    <h2 id="sheetTitle">Мои находки</h2>
    <p>${all.length} ${plural(all.length, 'место', 'места', 'мест')} вне списка закладок.
       Скопируйте всё разом и отправьте автору.</p>
    <div class="pick">${all.map((f, i) => `
      <button class="pick-item" data-act="copy" data-i="${i}">
        <span class="pick-g">✎</span>
        <span class="pick-t"><b>${esc(f.name)}</b><small>${esc(f.note || 'без описания')}</small></span>
        <span class="pick-d">${f.sent ? 'ушло' : 'копировать'}</span>
      </button>`).join('')}</div>
    <div class="sheet-actions">
      <button class="cta" data-act="copyall"><span class="cta-txt">Скопировать все</span></button>
    </div>`);
}

async function postSuggestion(body) {
  try {
    const c = AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined;
    const r = await fetch('api/suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: c,
    });
    return r.ok;
  } catch { return false; }
}

/* ───────────────────────── карта ───────────────────────── */

function initMap() {
  if (S.map || S.fallback) return;
  if (typeof L === 'undefined') return startFallback();

  /* кнопок зума нет намеренно: это телефон, работают щипок и двойной тап */
  S.map = L.map('map', { zoomControl: false, attributionControl: true })
           .setView([59.9560, 30.3060], 13);

  const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, subdomains: 'abcd', attribution: TILE_ATTR });
  let loaded = false;
  tiles.on('load', () => { loaded = true; $('#mapLoad').hidden = true; });
  tiles.on('tileerror', () => { if (!loaded) startFallback(); });
  tiles.addTo(S.map);
  setTimeout(() => { if (!loaded) startFallback(); }, 4000);

  S.layer = L.layerGroup().addTo(S.map);
  drawMap();
}

function startFallback() {
  if (S.fallback) return;
  S.fallback = true;
  if (S.map) { S.map.remove(); S.map = null; S.layer = null; S.marks.clear(); }
  $('#map').hidden = true;
  $('#mapFallback').hidden = false;
  $('#mapLoad').hidden = true;
  toast('Тайлы не загрузились — рисуем схему маршрута');
  drawMap();
}

function drawMap() {
  return S.fallback ? drawCanvas() : drawLeaflet();
}

function drawLeaflet() {
  if (!S.map || !S.layer) return;
  S.layer.clearLayers(); S.marks.clear();
  const r = S.data.routes.find(x => x.id === S.mapRoute);
  const pts = r.points;
  const cur = nextPoint();

  const cut = pts.findIndex(p => !S.done.has(p.id));
  const split = cut === -1 ? pts.length : cut + 1;
  L.polyline(pts.slice(0, split).map(p => [p.lat, p.lon]),
             { color: '#C7F04A', weight: 3, opacity: .85 }).addTo(S.layer);
  L.polyline(pts.slice(Math.max(0, split - 1)).map(p => [p.lat, p.lon]),
             { color: '#6E787D', weight: 2.5, opacity: .55, dashArray: '5 7' }).addTo(S.layer);

  pts.forEach(p => {
    const isNow = p.id === cur.id, got = S.done.has(p.id);
    const cls = isNow ? 'mk-now' : got ? 'mk-done' : 'mk-todo';
    const size = isNow ? 30 : 22;
    const m = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', html: `<span class="mk ${cls}">${got ? '✓' : p.i}</span>`,
                        iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      zIndexOffset: isNow ? 1000 : got ? 0 : 400,
    }).addTo(S.layer).on('click', () => showMapCard(p));
    S.marks.set(p.id, m);
  });

  S.map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])).pad(0.12), { animate: false });
  drawMe();
}

function drawMe() {
  if (!S.map || !S.pos) return;
  if (S.meMark) S.meMark.remove();
  S.meMark = L.marker([S.pos.lat, S.pos.lon], {
    icon: L.divIcon({ className: '', html: '<span class="mk mk-me"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    zIndexOffset: 2000,
  }).addTo(S.map);
}

/* запасная схема на canvas — без тайлов, но с настоящей геометрией */
function drawCanvas() {
  const cv = $('#mapFallback');
  const box = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = box.width * dpr; cv.height = box.height * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#12181C'; g.fillRect(0, 0, box.width, box.height);

  const r = S.data.routes.find(x => x.id === S.mapRoute);
  const pts = r.points;
  const merc = p => ({ x: p.lon, y: Math.log(Math.tan(Math.PI / 4 + p.lat * Math.PI / 360)) * 180 / Math.PI });
  const ms = pts.map(merc);
  const xs = ms.map(m => m.x), ys = ms.map(m => m.y);
  const pad = 44;
  const sx = (box.width - pad * 2) / Math.max(1e-9, Math.max(...xs) - Math.min(...xs));
  const sy = (box.height - pad * 2 - 60) / Math.max(1e-9, Math.max(...ys) - Math.min(...ys));
  const k = Math.min(sx, sy);
  const cxm = (Math.max(...xs) + Math.min(...xs)) / 2, cym = (Math.max(...ys) + Math.min(...ys)) / 2;
  const proj = p => { const m = merc(p);
    return { x: box.width / 2 + (m.x - cxm) * k, y: box.height / 2 - (m.y - cym) * k }; };

  const xy = pts.map(proj);
  const cut = pts.findIndex(p => !S.done.has(p.id));
  const split = cut === -1 ? pts.length : cut + 1;

  const line = (arr, color, w, dash) => {
    if (arr.length < 2) return;
    g.save(); g.setLineDash(dash || []); g.strokeStyle = color; g.lineWidth = w;
    g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
    arr.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y));
    g.stroke(); g.restore();
  };
  line(xy.slice(Math.max(0, split - 1)), '#5C666B', 2.5, [5, 7]);
  line(xy.slice(0, split), '#C7F04A', 3, null);

  cv._hit = [];
  const cur = nextPoint();
  /* точки на Большом проспекте стоят в 20 метрах друг от друга и сливаются:
     текущую рисуем последней, иначе её накрывают соседние */
  const order = pts.map((p, i) => i)
    .sort((a, b) => (pts[a].id === cur.id ? 1 : 0) - (pts[b].id === cur.id ? 1 : 0)
                 || (S.done.has(pts[a].id) ? 1 : 0) - (S.done.has(pts[b].id) ? 1 : 0));
  order.forEach(i => {
    const p = pts[i], q = xy[i], got = S.done.has(p.id), isNow = p.id === cur.id;
    const rad = isNow ? 13 : 9;
    g.beginPath(); g.arc(q.x, q.y, rad, 0, 7);
    g.fillStyle = isNow ? '#FFFFFF' : got ? '#C7F04A' : '#394247'; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#12181C'; g.stroke();
    g.fillStyle = isNow ? '#12181C' : got ? '#131A06' : '#C3CCD1';
    g.font = `700 ${isNow ? 11 : 9}px ${getComputedStyle(document.body).fontFamily}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(got ? '✓' : String(p.i), q.x, q.y + .5);
    cv._hit.push({ p, x: q.x, y: q.y, r: rad + 9 });
  });

  if (S.pos) {
    const q = proj(S.pos);
    g.beginPath(); g.arc(q.x, q.y, 8, 0, 7); g.fillStyle = '#4DA3FF'; g.fill();
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
  }

  const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 64;
  g.fillStyle = '#6E787D'; g.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText('Схема по координатам · тайлы недоступны', 14, box.height - navH - 14);
}

$('#mapFallback').addEventListener('click', e => {
  const cv = e.currentTarget, b = cv.getBoundingClientRect();
  const x = e.clientX - b.left, y = e.clientY - b.top;
  const hit = (cv._hit || []).find(h => Math.hypot(h.x - x, h.y - y) <= h.r);
  if (hit) showMapCard(hit.p); else $('#mapCard').hidden = true;
});

function showMapCard(p) {
  const got = S.done.has(p.id);
  const d = S.pos ? ` · ${fmtD(dist(S.pos, p))}` : '';
  $('#mapCard').hidden = false;
  $('#mapCard').innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start">
      <span class="pick-g" style="width:42px;height:42px;font-size:20px">${p.glyph}</span>
      <span style="flex:1;min-width:0">
        <b style="display:block;font-size:15.5px">${esc(p.code)} · ${esc(p.name)}</b>
        <small style="color:var(--muted);font-size:12.5px">${esc(p.addr)}${d}</small>
      </span>
      <button class="link" data-act="closecard">✕</button>
    </div>
    <p style="margin:10px 0 0;font-size:13px;color:var(--muted);line-height:1.45">${esc(p.note)}</p>
    ${tagsHTML(p)}
    <div class="sheet-actions" style="margin-top:12px">
      ${got ? `<button class="ghost-btn" data-act="undo" data-pt="${p.id}">Снять отметку</button>`
            : `<button class="cta" data-act="confirm" data-pt="${p.id}"><span class="cta-txt">Отметить</span></button>`}
    </div>`;
}

/* ───────────────────────── навигация ───────────────────────── */

function go(view) {
  S.view = view;
  $('#app').dataset.view = view;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === view));
  if (view === 'map') {
    initMap();
    setTimeout(() => { if (S.map) { S.map.invalidateSize(); drawLeaflet(); } else if (S.fallback) drawCanvas(); }, 60);
  }
  if (view === 'stamps') renderStamps();
  if (view === 'profile') renderProfile();
}

/* делегирование кликов */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-go],[data-pt],[data-f],[data-r]');
  if (!t) return;

  if (t.dataset.go) return go(t.dataset.go);

  if (t.dataset.f) {
    S.stampFilter = t.dataset.f;
    $$('#stampSeg button').forEach(b => b.setAttribute('aria-pressed', String(b === t)));
    return renderStamps();
  }
  if (t.dataset.r) {
    S.mapRoute = +t.dataset.r;
    $$('#mapSeg button').forEach(b => b.setAttribute('aria-pressed', String(b === t)));
    $('#mapCard').hidden = true;
    return drawMap();
  }

  const act = t.dataset.act;
  if (act === 'confirm')  return confirmPoint(t.dataset.pt);
  if (act === 'manual')   return sheetManual();
  if (act === 'retry')    { Sheet.close(); return markPlace(); }
  if (act === 'suggest')  return sheetSuggest();
  if (act === 'send')     return sendSuggestion();
  if (act === 'close')    return Sheet.close();
  if (act === 'findings') return sheetFindings();
  if (act === 'copy') {
    const f = findings()[+t.dataset.i];
    if (f) copyText(findingText(f)).then(ok => toast(ok ? 'Скопировано' : 'Не вышло скопировать', !ok));
    return;
  }
  if (act === 'copyall') {
    const txt = findings().map(findingText).join('\n\n');
    copyText(txt).then(ok => toast(ok ? 'Скопировали все находки' : 'Не вышло скопировать', !ok));
    return;
  }
  if (act === 'share') {
    const f = findings()[+t.dataset.i];
    if (f) navigator.share({ title: f.name, text: findingText(f) }).catch(() => {});
    return;
  }
  if (act === 'closecard'){ $('#mapCard').hidden = true; return; }
  if (act === 'undo') {
    S.done.delete(t.dataset.pt); save(); renderAll();
    $('#mapCard').hidden = true; toast('Отметка снята'); return;
  }

  /* тап по штампу или шагу маршрута */
  if (t.dataset.pt) {
    const p = byId(t.dataset.pt);
    if (!p) return;
    if (S.view === 'map') return showMapCard(p);
    Sheet.open(`
      <h2 id="sheetTitle">${esc(p.code)} · ${esc(p.name)}</h2>
      <p>${esc(p.addr)}<br>${esc(p.note)}</p>
      ${tagsHTML(p)}
      <div style="margin-top:16px">${stampHTML(p, { big: true, always: true })}</div>
      <div class="sheet-actions">
        ${S.done.has(p.id)
          ? `<button class="ghost-btn" data-act="undo" data-pt="${p.id}">Снять отметку</button>`
          : `<button class="cta" data-act="confirm" data-pt="${p.id}"><span class="cta-txt">Отметить</span></button>`}
        <a class="ghost-btn" style="display:grid;place-items:center;text-decoration:none"
           href="https://yandex.ru/maps/?ll=${p.lon},${p.lat}&z=17&pt=${p.lon},${p.lat}"
           target="_blank" rel="noopener">Открыть в Яндекс Картах</a>
      </div>`);
  }
});

$('#markBtn').addEventListener('click', markPlace);
$('#suggestBtn').addEventListener('click', sheetSuggest);
$('#rowSuggest').addEventListener('click', () => findings().length ? sheetFindings() : sheetSuggest());
$('#toMap').addEventListener('click', () => go('map'));
$('#toStamps').addEventListener('click', () => go('stamps'));

$('#locBtn').addEventListener('click', async () => {
  const b = $('#locBtn'); b.classList.add('on');
  try {
    S.pos = await getPosition();
    if (S.map) { drawMe(); S.map.setView([S.pos.lat, S.pos.lon], 16); } else drawCanvas();
    renderStepper();
  } catch (e) { toast(geoReason(e), true); }
  finally { b.classList.remove('on'); }
});

$('#rowReset').addEventListener('click', () => {
  if (!confirm('Вернуть отметки к состоянию на 9 августа?')) return;
  S.done = new Set(seedDone()); save(); renderAll(); toast('Прогресс сброшен');
});

$('#rowExport').addEventListener('click', () => {
  const out = {
    exported: new Date().toISOString(),
    total: S.points.length,
    done: [...S.done].map(id => { const p = byId(id); return p && { id, code: p.code, name: p.name, addr: p.addr }; }).filter(Boolean),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'pechati-progress.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Файл выгружен');
});

window.addEventListener('resize', () => { if (S.fallback && S.view === 'map') drawCanvas(); });

/* ───────────────────────── старт ───────────────────────── */

(async function boot() {
  try {
    const r = await fetch('data/points.json');
    if (!r.ok) throw new Error(r.status);
    S.data = await r.json();
  } catch (e) {
    $('#routeScroll').innerHTML = `
      <div class="empty"><span class="empty-ico">⚠</span><b>Не загрузились точки</b>
      <p>Файл data/points.json недоступен. Проверьте, что сервер отдаёт статику.</p>
      <button class="ghost-btn" onclick="location.reload()">Обновить</button></div>`;
    return;
  }
  S.points = S.data.routes.flatMap(r => r.points);
  const saved = load();
  S.done = new Set(saved ? migrateIds(saved) : seedDone());
  if (saved) save();
  S.mapRoute = activeRoute().id;
  S.ready = true;
  renderMapSeg();
  renderAll();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
