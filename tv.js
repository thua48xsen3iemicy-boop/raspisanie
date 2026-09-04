'use strict';
/* Табло для телевизора в холле: расписание всей недели по всем группам
   одной большой таблицей.

   Строки — день недели и номер пары (понедельник–суббота, шесть пар).
   Колонки — группы. Когда группы перестают влезать по ширине, таблица
   переносится: ниже снова рисуются колонки дня и пары, а за ними следующая
   порция групп. Так лист заполняется полосами сверху вниз.

   Каталог самостоятельный: с обычной страницей расписания ничего не делит,
   кроме самих выгрузок в ../s/ и списка ../list.txt.
   parse.js здесь свой — копия корневого, см. README. */

var RELOAD_MINUTES = 10;   // как часто перечитывать файлы расписаний
var MAX_BANDS = 4;         // на сколько полос разрешено переносить таблицу
var GOOD_COL_PX = 150;     // ширина колонки группы, при которой читается легко
var GOOD_ROW_PX = 30;      // высота строки, при которой читается легко
var PAD_X = 0;             // поле таблицы от боков экрана, пикселей
var BAR_PAD_X = 10;        // поле шапки и нижней полосы

/* Табло лежит в своём каталоге, расписания — уровнем выше.
   Если разложите иначе, поправьте только эти два пути. */
var GROUPS_DIR = '../s/';
var LIST_URL = '../list.txt';

var qs = location.search;
function num(name, def) {
  var m = new RegExp('[?&]' + name + '=(\\d+)').exec(qs);
  return m ? +m[1] : def;
}
function has(name) { return new RegExp('[?&]' + name + '=').test(qs); }
/* Безопасное поле по краям экрана. Телевизоры в обычном режиме картинки
   подрезают края (оверскан) — до нескольких процентов с каждой стороны,
   и крайняя колонка уходит за рамку матрицы. Правильное лечение —
   включить в телевизоре режим «точка в точку», но он есть не везде,
   поэтому поле задаётся здесь.

   Снизу — процентом от высоты экрана: tv.html?safe=4
   Сверху и по бокам — в пикселях: tv.html?safetop=32, tv.html?safex=24.
   Там процент оказался расточителен: на широком экране он съедал сразу
   десятки пикселей, а таблица выигрывает от каждого отвоёванного. Сверху
   поля нет вовсе — шапка идёт от самого края.

   ?safe= остаётся общим лекарством от оверскана: если он задан, а своего
   значения у стороны нет, эта сторона тоже считается процентом. */
var SAFE_PCT = num('safe', 3);
var SAFE_TOP_PX = num('safetop', 0);
var SAFE_X_PX = num('safex', 10);
function safeSide(name, px, pct) { return (has('safe') && !has(name)) ? pct : px; }
var BLEED_X = num('bleed', 0);         // tv.html?bleed=92 — вылезти за края по бокам
var BLEED_Y = num('bleedy', 0);        // tv.html?bleedy=48 — то же сверху и снизу
var FORCED_PER = num('groups', 0);     // tv.html?groups=8 — групп в полосе
var FORCED_BANDS = num('bands', 0);    // tv.html?bands=2 — полос в таблице
if (qs.indexOf('dark') >= 0) document.documentElement.setAttribute('data-tv', 'dark');

var els = {
  bar: document.querySelector('.bar'),
  ticker: document.querySelector('.ticker'),
  day: document.getElementById('day'),
  date: document.getElementById('date'),
  note: document.getElementById('note'),
  clock: document.getElementById('clock'),
  board: document.getElementById('board')
};

var groups = [];    // [{title, at: {'дата/пара': урок}}]
var view = null;    // {rows, days, from, to}
var skew = 0;       // расхождение часов телевизора и сервера

function serverNow() { return Date.now() + skew; }

/* ── Загрузка ───────────────────────────────────────────── */

function get(url) {
  return fetch(url, { cache: 'no-cache' }).then(function (res) {
    var d = res.headers ? Date.parse(res.headers.get('date') || '') : NaN;
    if (!isNaN(d)) skew = d - Date.now();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.arrayBuffer().then(function (buf) {
      var ct = res.headers.get('content-type') || '';
      var m = /charset=([\w-]+)/i.exec(ct);
      if (m) return new TextDecoder(m[1]).decode(buf);
      var text = new TextDecoder('utf-8').decode(buf);
      if (text.indexOf('\uFFFD') >= 0) {
        try { return new TextDecoder('windows-1251').decode(buf); } catch (e) { /* оставляем */ }
      }
      return text;
    });
  });
}

function loadAll() {
  return get(LIST_URL).then(function (text) {
    var files = [];
    text.split(/\r?\n/).forEach(function (line) {
      if (!line || line.charAt(0) === '#') return;
      var p = line.split('|');
      if (p.length >= 3 && p[0].trim() === 's') {
        files.push({ file: p[1].trim(), title: p[2].trim() });
      }
    });

    /* по три файла за раз: телевизор слабый, а файлов может быть полсотни */
    var out = [], failed = 0, i = 0;
    function next() {
      if (i >= files.length) return Promise.resolve();
      var batch = files.slice(i, i + 3);
      i += 3;
      return Promise.all(batch.map(function (it) {
        return get(GROUPS_DIR + it.file + '.htm').then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          out.push({ title: it.title, data: parseSchedule(doc, it.title) });
        }).catch(function () { failed++; });
      })).then(next);
    }
    return next().then(function () {
      out.sort(function (a, b) { return a.title.localeCompare(b.title, 'ru'); });
      groups = out;
      return failed;
    });
  });
}

/* ── Сборка сетки недели ────────────────────────────────── */

function dmy(ts) {
  var d = new Date(ts + TZ_OFFSET_MIN * 60000);
  return ('0' + d.getUTCDate()).slice(-2) + '.' +
         ('0' + (d.getUTCMonth() + 1)).slice(-2) + '.' + d.getUTCFullYear();
}
function dkey(s) {
  var p = s.split('.');
  return p.length === 3 ? +p[2] * 10000 + +p[1] * 100 + +p[0] : 0;
}

function build() {
  if (!groups.length) { view = null; return; }

  /* дни недели в порядке дат, номера пар — объединением по всем файлам */
  var dayMap = {}, nums = {}, common = {};
  groups.forEach(function (g) {
    g.data.days.forEach(function (d) {
      if (!d.date) return;
      if (!dayMap[d.date]) dayMap[d.date] = { date: d.date, name: d.name, times: {} };
      d.lessons.forEach(function (l) {
        nums[l.num] = 1;
        if (!dayMap[d.date].times[l.num]) {
          dayMap[d.date].times[l.num] = { start: l.start, end: l.end };
        }
        /* звонки одинаковы всю неделю: запоминаем, чтобы подставить
           в те дни, где такой пары ни у кого не оказалось */
        if (!common[l.num]) common[l.num] = { start: l.start, end: l.end };
      });
    });
  });

  var days = Object.keys(dayMap).sort(function (a, b) { return dkey(a) - dkey(b); })
    .map(function (k) { return dayMap[k]; });
  var pairs = Object.keys(nums).map(Number).sort(function (a, b) { return a - b; });
  if (!days.length || !pairs.length) { view = null; return; }

  /* строки таблицы: день × пара */
  var rows = [];
  days.forEach(function (day, di) {
    pairs.forEach(function (n, i) {
      var t = day.times[n] || common[n] || {};
      rows.push({
        date: day.date, name: day.name, first: i === 0, span: pairs.length,
        di: di, last: i === pairs.length - 1,
        num: String(n), start: t.start || '', end: t.end || '',
        from: t.start ? moment(day.date, t.start) : null,
        to: t.end ? moment(day.date, t.end) : null
      });
    });
  });

  /* быстрый доступ: группа → 'дата/пара' → занятие */
  groups.forEach(function (g) {
    var at = {};
    g.data.days.forEach(function (d) {
      d.lessons.forEach(function (l) { if (!l.free) at[d.date + '/' + l.num] = l; });
    });
    g.at = at;
  });

  view = { rows: rows, days: days, pairs: pairs };
}

/* ── Отрисовка ──────────────────────────────────────────── */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* «каб. 33» → жирной остаётся только 33, слово-приставка обычным.
   Если приставки нет («СЗ», «спортзал»), жирным идёт всё целиком.
   Приставка и номер — отдельные элементы: в узкой колонке ужимается и
   пропадает приставка, а номер остаётся целым. Раньше строка резалась с
   конца, и у правой колонки исчезала как раз последняя цифра. */
function roomHtml(where) {
  var m = /^(каб\.?|ауд\.?)\s*(.+)$/i.exec(String(where).trim());
  return m
    ? '<span class="pre">' + esc(m[1]) + '</span><b>' + esc(m[2]) + '</b>'
    : '<b>' + esc(where) + '</b>';
}

/* Кто ведёт: в файле группы это преподаватель, в файле преподавателя —
   группа, то есть всегда «вторая сторона» занятия. Одно и то же имя на
   все подгруппы пишется один раз без номера: повторять фамилию незачем.
   Когда имена разные, номер связывает имя слева с кабинетом справа. */
function whoHtml(variants) {
  var names = [];
  variants.forEach(function (v) {
    if (v.who && names.indexOf(v.who) < 0) names.push(v.who);
  });
  if (!names.length) return '';
  if (names.length === 1) return esc(names[0]);
  return variants.map(function (v, i) {
    return v.who ? '<i>' + (i + 1) + '</i>\u00a0' + esc(v.who) : '';
  }).filter(Boolean).join(' · ');
}

function cellHtml(lesson, key, band) {
  band = band || '';
  if (!lesson) return '<div class="cell cell--empty' + band + '" data-k="' + key + '"></div>';
  var rooms = lesson.variants.map(function (v, i) {
    if (!v.room) return '';
    return lesson.variants.length > 1
      ? '<i>' + (i + 1) + '</i>\u00a0' + roomHtml(v.room) : roomHtml(v.room);
  }).filter(Boolean).join(' · ');
  var who = whoHtml(lesson.variants);
  return '<div class="cell' + band + '" data-k="' + key + '">' +
    '<span class="subject">' + esc(lesson.subject) + '</span>' +
    (who || rooms
      ? '<span class="meta"><span class="who">' + who + '</span>' +
        '<span class="room">' + rooms + '</span></span>'
      : '') + '</div>';
}

/* Телевизор отводит странице «безопасную зону» под оверскан — на 3072
   пикселях это по 92 с каждой стороны. Задаёт её сам браузер, поэтому ни
   обнуление полей, ни position:fixed не помогают: отсчёт всё равно идёт от
   границы зоны. Единственное надёжное средство — померить фактический сдвиг
   и вытянуть страницу обратно на эту же величину. Если полей нет, сдвиг
   нулевой и ничего не меняется. */
function bleed() {
  var b = document.body;

  /* Ручной режим: значение задано в адресе, страница просто вылезает за
     края на столько пикселей. Работает независимо от того, чем вызваны
     поля — стилями браузера, безопасной зоной или масштабированием. */
  if (BLEED_X || BLEED_Y) {
    b.style.left = -BLEED_X + 'px';
    b.style.right = -BLEED_X + 'px';
    b.style.top = -BLEED_Y + 'px';
    b.style.bottom = -BLEED_Y + 'px';
    b.style.width = 'auto';
    b.style.height = 'auto';
    /* без этого страница сдвинется влево, но расшириться не сможет:
       ограничение ширины превратит весь сдвиг в пустоту справа */
    b.style.maxWidth = 'none';
    b.style.maxHeight = 'none';
    return;
  }

  var r = b.getBoundingClientRect();
  var needX = Math.abs(r.left) > 0.5 || Math.abs(r.width - window.innerWidth) > 0.5;
  var needY = Math.abs(r.top) > 0.5 || Math.abs(r.height - window.innerHeight) > 0.5;
  if (!needX && !needY) return;

  var curL = parseFloat(b.style.left) || 0;
  var curT = parseFloat(b.style.top) || 0;
  b.style.right = 'auto';
  b.style.bottom = 'auto';
  b.style.left = (curL - r.left) + 'px';
  b.style.top = (curT - r.top) + 'px';
  b.style.maxWidth = 'none';
  b.style.maxHeight = 'none';
  b.style.width = window.innerWidth + 'px';
  b.style.height = window.innerHeight + 'px';
}

function draw() {
  bleed();
  if (!view) {
    els.day.textContent = 'Расписание не заполнено';
    els.date.textContent = '';
    els.board.innerHTML = '<p class="msg">В файлах групп нет ни одного учебного дня</p>';
    return;
  }

  /* Всё меряем в физических пикселях экрана, а не в CSS-пикселях.
     На 4K телевизоре браузер обычно работает с дробным масштабом: один
     CSS-пиксель ложится, например, на полтора физических. Целые значения
     в CSS при этом попадают между физическими пикселями, и линии сетки
     выходят то в один, то в два — та самая пляшущая толщина. */
  var dpr = window.devicePixelRatio || 1;
  var snap = function (v) { return Math.floor(v * dpr) / dpr; };
  /* волосяная линия ровно в целое число физических пикселей */
  var hair = Math.max(1, Math.round(dpr)) / dpr;

  /* Поле отдаём странице целиком, а не таблице: под обрез иначе попадали бы
     и часы, и герб. Ставим до замеров — иначе посчитаем по старым размерам. */
  var pctY = window.innerHeight * SAFE_PCT / 100;
  var pctX = window.innerWidth * SAFE_PCT / 100;
  document.body.style.padding =
    snap(safeSide('safetop', SAFE_TOP_PX, pctY)) + 'px ' +
    snap(safeSide('safex', SAFE_X_PX, pctX)) + 'px ' +
    snap(pctY) + 'px';

  var vh = window.innerHeight / 100;
  if (els.bar) els.bar.style.height = snap(vh * 5.6) + 'px';
  if (els.ticker) els.ticker.style.height = snap(vh * 6) + 'px';

  /* Поля кладём на корень документа, а не на таблицу: тогда шапка и нижняя
     полоса берут ровно те же отступы и их края совпадают с краями таблицы. */
  var padX = snap(PAD_X), padY = snap(4), bandGap = snap(8);
  var root = document.documentElement;
  root.style.setProperty('--hair', hair + 'px');
  root.style.setProperty('--padx', padX + 'px');
  root.style.setProperty('--barpadx', snap(BAR_PAD_X) + 'px');
  root.style.setProperty('--pady', padY + 'px');
  root.style.setProperty('--bandgap', bandGap + 'px');

  /* clientWidth и clientHeight включают внутренние отступы — вычитаем их,
     иначе полоса получается шире содержимого на два отступа, уезжает
     вправо за обрезку и у правой колонки пропадает хвост строки. */
  var W = els.board.clientWidth - padX * 2;
  var H = els.board.clientHeight - padY * 2;
  /* прикидка для выбора числа полос; настоящие ширины считаем ниже,
     когда станет известна высота строки */
  var dayW = snap(34), pairW = snap(64);

  /* Всё должно уместиться на экране, поэтому выбор один: меньше полос —
     строки выше, но колонки уже; больше полос — наоборот. Перебираем и
     берём вариант, где хуже всего выглядящий из двух размеров максимален. */
  var per, bands, best = null;
  if (FORCED_PER || FORCED_BANDS) {
    bands = FORCED_BANDS || Math.ceil(groups.length / FORCED_PER);
    per = FORCED_PER || Math.ceil(groups.length / bands);
  } else {
    for (var b = 1; b <= Math.min(MAX_BANDS, groups.length); b++) {
      var p = Math.ceil(groups.length / b);
      var colWide = (W - dayW - pairW) / p;
      var rh = H / (b * (view.rows.length + 1));
      var score = Math.min(colWide / GOOD_COL_PX, rh / GOOD_ROW_PX);
      if (!best || score > best.score) best = { b: b, p: p, score: score };
    }
    bands = best.b; per = best.p;
  }

  var totalRows = bands * (view.rows.length + 1);
  var rowH = Math.max(hair, snap(H / totalRows));

  /* Ширина левых колонок — от высоты строки, как и весь кегль. Раньше здесь
     стояли жёсткие 34 и 64 пикселя: на 4K строка вдвое выше, шрифт вдвое
     крупнее, а колонки те же — день и время в них не помещались. */
  dayW = Math.max(snap(24), snap(rowH * 0.95));
  pairW = Math.max(snap(52), snap(rowH * 2.6));
  root.style.setProperty('--dayw', dayW + 'px');
  root.style.setProperty('--pairw', pairW + 'px');

  /* То же для колонок: считаем ширину сами вместо 1fr. Остаток от деления
     отдаём последней колонке — тогда полоса шириной точно в контейнер и
     её край стоит на физическом пикселе. Центрировать ничего не нужно. */
  var unit = 1 / dpr;                       /* один физический пиксель */
  /* Два физических пикселя в запас. Если из-за округлений таблица окажется
     хоть немного шире экрана, телевизор ужимает всю страницу целиком, чтобы
     её вписать, — и вокруг всего, включая шапку, появляются поля. Лучше
     недобрать пару пикселей, чем поймать это. */
  var freeW = W - dayW - pairW - (per + 1) * hair - 2 * hair - 2 * unit;
  var base = Math.max(unit, snap(freeW / per));
  /* Остаток от деления раздаём по одному физическому пикселю первым
     колонкам, а не сваливаем в последнюю: иначе крайняя колонка заметно
     шире прочих и выглядит как поле у края экрана. */
  var extra = Math.round((freeW - base * per) * dpr);
  var widths = [];
  for (var wi = 0; wi < per; wi++) widths.push(base + (wi < extra ? unit : 0));

  els.board.style.setProperty('--rh', rowH + 'px');
  els.board.style.setProperty('--snap', dpr);
  els.board.style.setProperty('--dayw', dayW + 'px');
  els.board.style.setProperty('--pairw', pairW + 'px');

  var week = view.days.length
    ? view.days[0].date + ' — ' + view.days[view.days.length - 1].date : '';
  els.day.textContent = 'Расписание на неделю';
  els.date.textContent = week;

  var today = dmy(serverNow());

  var html = '';
  for (var b = 0; b < bands; b++) {
    var slice = groups.slice(b * per, (b + 1) * per);
    if (!slice.length) continue;

    /* Колонок всегда ровно per, даже если групп в полосе меньше: пустые
       добиваются заглушками. Иначе последняя полоса была бы уже прочих,
       её дорожки съезжали бы вбок, а по краям светился бы фон полосы —
       он же цвет сетки — толстой вертикальной линией. */
    var padCount = per - slice.length;

    var tracks = widths.join('px ') + 'px';
    html += '<div class="band" style="grid-template-columns:var(--dayw) var(--pairw) ' +
      tracks + '">';

    /* шапка полосы: угол на две левые колонки и названия групп */
    html += '<div class="head head--corner">Пара</div>';
    slice.forEach(function (g) {
      html += '<div class="head head--group">' + esc(g.title) + '</div>';
    });
    for (var q = 0; q < padCount; q++) html += '<div class="head head--pad"></div>';

    view.rows.forEach(function (r) {
      var key = r.date + '/' + r.num;
      var isToday = r.date === today;
      /* чередование фона по дням: без него шесть дней подряд
         сливаются в одно полотно */
      var band = r.di % 2 ? ' dim' : '';

      if (r.first) {
        html += '<div class="day' + band + (isToday ? ' day--today' : '') +
          '" style="grid-row:span ' + r.span + '">' +
          '<span>' + esc(r.name) + '</span></div>';
      }
      html += '<div class="slot' + band + (isToday ? ' slot--today' : '') +
        '" data-k="' + key + '">' +
        '<span class="slot__no">' + esc(r.num) + '</span>' +
        '<span class="slot__time">' + esc(r.start) + '</span></div>';

      slice.forEach(function (g) { html += cellHtml(g.at[key], key, band); });
      for (var q = 0; q < padCount; q++) {
        html += '<div class="cell cell--pad' + band + '"></div>';
      }
    });
    html += '</div>';
  }

  els.board.innerHTML = html;
  fit(totalRows);

  /* Подсветка идущей пары отключена. Чтобы вернуть: найти строку, у которой
     serverNow() попадает между r.from и r.to, и повесить класс now на все
     ячейки с её data-k — время в строках по-прежнему считается. */

}

/* ── Подгонка высоты ────────────────────────────────────────
   Расчётная высота строки не учитывает рамки полос, промежутки сетки и
   отступы между полосами — на шести днях это набегает заметной пустотой
   внизу. Проще не считать всё это, а померить готовую таблицу и поправить
   высоту строки по факту. Двух проходов хватает. */

function fit(totalRows) {
  var board = els.board;
  var pad = parseFloat(document.documentElement.style.getPropertyValue('--pady')) || 0;
  var free = board.clientHeight - pad * 2;
  if (!free || !totalRows) return;

  for (var pass = 0; pass < 2; pass++) {
    var used = board.scrollHeight;
    if (!used) return;                       /* нет раскладки — нечего мерить */
    var k = free / used;
    if (k > 0.995 && k < 1.005) return;      /* и так впритык */
    var d = parseFloat(board.style.getPropertyValue('--snap')) || 1;
    var rh = Math.floor(parseFloat(board.style.getPropertyValue('--rh')) * k * d) / d;
    if (rh < 1 / d) return;
    board.style.setProperty('--rh', rh + 'px');
  }
}

/* ── Часы и обновление ──────────────────────────────────── */

var shownDate = '';

function clock() {
  var d = new Date(serverNow() + TZ_OFFSET_MIN * 60000);
  els.clock.textContent = ('0' + d.getUTCHours()).slice(-2) + ':' +
                          ('0' + d.getUTCMinutes()).slice(-2);
  var today = dmy(serverNow());
  if (shownDate && today !== shownDate) { shownDate = today; build(); draw(); }
  else if (!shownDate) shownDate = today;
}

var VERSION = 16;   /* поднимайте вместе с ?v= в tv.html */

function refresh() {
  loadAll().then(function (failed) {
    els.note.textContent = failed ? 'Не открылось расписаний: ' + failed : '';
    build();
    clock();   /* часы сверены с сервером только теперь, обновляем сразу */
    draw();
  }).catch(function (err) {
    els.note.textContent = 'Ошибка загрузки: ' + (err.message || err);
  });
}

window.addEventListener('resize', function () { if (view) draw(); });

clock();
setInterval(clock, 10000);
setInterval(refresh, RELOAD_MINUTES * 60000);
/* раз в минуту — чтобы подсветка переходила на следующую пару */
setInterval(function () { if (view) draw(); }, 60000);
refresh();
