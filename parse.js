'use strict';
/* Разбор выгрузок Excel: формат файлов из ../s/ описан только здесь.
   Подключать первым, до diff.js и tv.js. */

/* ── Разбор ─────────────────────────────────────────────── */

var LABELS = {
  'день недели': 'day', '№': 'num', 'пара': 'num',
  'начало': 'start', 'окончание': 'end', 'предмет': 'subject',
  'преподаватель': 'teacher', 'группа': 'group',
  'кабинет': 'room', 'каб.': 'room', 'каб': 'room'
};
var TIME_RE = /^\d{1,2}[:.]\d{2}$/;
var DAY_RE = /^(Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье)\s*[-–—]?\s*(.*)$/i;
var WEEK_RE = /недел\S*\s*№?\s*(\d+)\s*(числител\S*|знаменател\S*)?/i;
var GROUP_RE = /^[A-Za-zА-Яа-яЁё]{1,6}[-‑]?\d{2,4}[А-Яа-яA-Za-z/\d-]*$/;

function norm(s) {
  return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Раскрывает rowspan/colspan: grid[r][c] = {text, origin} */
function buildGrid(table) {
  var grid = [], rows = table.rows;
  for (var ri = 0; ri < rows.length; ri++) {
    if (!grid[ri]) grid[ri] = [];
    var cells = rows[ri].cells, ci = 0;
    for (var i = 0; i < cells.length; i++) {
      while (grid[ri][ci]) ci++;
      var td = cells[i];
      var rs = parseInt(td.getAttribute('rowspan'), 10) || 1;
      var cs = parseInt(td.getAttribute('colspan'), 10) || 1;
      var text = norm(td.textContent);
      for (var r = ri; r < ri + rs; r++) {
        if (!grid[r]) grid[r] = [];
        for (var c = ci; c < ci + cs; c++) {
          grid[r][c] = { text: text, origin: r === ri && c === ci };
        }
      }
      ci += cs;
    }
  }
  return grid;
}

function at(grid, r, c) { var v = grid[r] && grid[r][c]; return v ? v.text : ''; }
function own(grid, r, c) { var v = grid[r] && grid[r][c]; return v && v.origin ? v.text : ''; }

function parseSchedule(doc, fallbackName) {
  var table = doc.querySelector('table');
  if (!table) throw new Error('таблица не найдена');

  var grid = buildGrid(table);
  var nrows = grid.length, ncols = 0, r, c;
  for (r = 0; r < nrows; r++) ncols = Math.max(ncols, (grid[r] || []).length);

  var head = -1, dayCol = 0;
  for (r = 0; r < Math.min(nrows, 12) && head < 0; r++) {
    for (c = 0; c < ncols; c++) {
      if (at(grid, r, c).toLowerCase() === 'день недели') { head = r; dayCol = c; break; }
    }
  }
  if (head < 0) throw new Error('не найдена строка заголовков');

  var cols = {};
  [head, head + 1].forEach(function (row) {
    for (var c = 0; c < ncols; c++) {
      var key = LABELS[own(grid, row, c).toLowerCase().replace(/:$/, '')];
      if (key) cols[key] = c;
    }
  });
  ['num', 'start', 'end', 'subject'].forEach(function (k) {
    if (cols[k] === undefined) throw new Error('нет колонки: ' + k);
  });

  var kind = cols.group !== undefined ? 'teacher' : 'group';
  var whoCol = kind === 'teacher' ? cols.group : cols.teacher;

  /* заголовок над таблицей */
  var title = '';
  for (r = 0; r < head; r++) title += ' ' + at(grid, r, 0);
  title = norm(title);

  var owner = '', week = '', parity = '';
  var m = WEEK_RE.exec(title);
  if (m) { week = m[1]; parity = (m[2] || '').toLowerCase(); }
  m = /Преподавател[ья]\s+(.+?)\s*(?:Расписание|$)/.exec(title);
  if (m) owner = norm(m[1]);

  if (kind === 'group' && !owner) {
    for (r = head; r < Math.min(head + 3, nrows) && !owner; r++) {
      for (c = 0; c < ncols; c++) {
        var t = own(grid, r, c);
        if (t && GROUP_RE.test(t) && !LABELS[t.toLowerCase()]) { owner = t; break; }
      }
    }
  }

  /* пары */
  var days = [], index = {}, total = 0;
  for (r = head + 1; r < nrows; r++) {
    if (!TIME_RE.test(at(grid, r, cols.start))) continue;
    var num = at(grid, r, cols.num);
    if (!/^\d+$/.test(num)) continue;

    var dayRaw = at(grid, r, dayCol);
    var dm = DAY_RE.exec(dayRaw);
    if (!dm) continue;

    if (!(dayRaw in index)) {
      index[dayRaw] = days.length;
      days.push({
        name: dm[1].charAt(0).toUpperCase() + dm[1].slice(1).toLowerCase(),
        date: norm(dm[2]), lessons: [], byNum: {}
      });
    }
    var day = days[index[dayRaw]];

    if (!day.byNum[num]) {
      day.byNum[num] = {
        num: num,
        start: at(grid, r, cols.start).replace('.', ':'),
        end: at(grid, r, cols.end).replace('.', ':'),
        subject: '', variants: []
      };
      day.lessons.push(day.byNum[num]);
    }
    var lesson = day.byNum[num];

    var subject = own(grid, r, cols.subject);
    if (subject && !lesson.subject) lesson.subject = subject;

    var who = whoCol !== undefined ? own(grid, r, whoCol) : '';
    var room = cols.room !== undefined ? own(grid, r, cols.room) : '';
    if (who || room) {
      var dup = lesson.variants.some(function (v) { return v.who === who && v.room === room; });
      if (!dup) lesson.variants.push({ who: who, room: room });
    }
  }

  days.forEach(function (day) {
    delete day.byNum;
    var ls = day.lessons;
    ls.forEach(function (l) { l.free = !l.subject && !l.variants.length; });
    /* хвост пустых пар — это просто конец дня, а не окно;
       пустые пары в начале дня показываем: люди привыкли их видеть */
    var b = ls.length;
    while (b > 0 && ls[b - 1].free) b--;
    day.lessons = ls.slice(0, b);
    day.lessons.forEach(function (l) { if (!l.free) total++; });
  });

  /* подвал: нагрузка, дата выгрузки, объявление */
  var load = '', stamp = '', note = '';
  for (r = 0; r < nrows; r++) {
    for (c = 0; c < ncols; c++) {
      var lab = own(grid, r, c).toLowerCase();
      if (lab.indexOf('недельная нагрузка') === 0) {
        load = firstAfter(grid, r, c, ncols);
      } else if (lab === 'дата и время' || lab === 'дата') {
        stamp = firstAfter(grid, r, c, ncols);
        if (lab === 'дата') {
          for (var r2 = r + 1; r2 < Math.min(r + 4, nrows); r2++) {
            if (own(grid, r2, c).toLowerCase() === 'время') {
              stamp += ' ' + firstAfter(grid, r2, c, ncols);
              break;
            }
          }
        }
      } else if (!note && /^уважаем/i.test(lab)) {
        note = own(grid, r, c);
      }
    }
  }

  return {
    kind: kind, owner: owner || fallbackName, week: week, parity: parity,
    load: load, stamp: norm(stamp), note: note, days: days, total: total
  };
}

function firstAfter(grid, r, c, ncols) {
  for (var x = c + 1; x < ncols; x++) if (own(grid, r, x)) return own(grid, r, x);
  return '';
}


/* Часовой пояс расписания в минутах от UTC. 660 — UTC+11.
   Нужен, чтобы пара считалась идущей по времени колледжа, а не по часам телефона. */
var TZ_OFFSET_MIN = 660;

function moment(date, time) {
  var d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date || '');
  var t = /^(\d{1,2})[:.](\d{2})$/.exec(time || '');
  if (!d || !t) return null;
  return Date.UTC(+d[3], +d[2] - 1, +d[1], +t[1], +t[2]) - TZ_OFFSET_MIN * 60000;
}


/* ── Бегущая строка ─────────────────────────────
   Объявления для нижней полосы табло лежат в ../ticker.txt — рядом
   с list.txt и в том же виде: одна строка — одна запись, поля через палку.

       тип|срок|текст

   тип    — t обычное объявление, ! важное (выделяется цветом);
   срок   — когда показывать; пусто — всегда:
              до 10.09           по 10 сентября включительно
              с 08.09            начиная с 8 сентября
              с 08.09 до 12.09   окно показа
              10.09              только в этот день
            вместо «до» можно писать «по», год — необязателен;
   текст  — всё остальное до конца строки; палки внутри него
            разрешены — полей всего три, остаток склеивается обратно.

   Пустые строки и строки с # в начале пропускаются, всё остальное
   показывается: непонятная строка идёт на табло как есть, целиком. Молча
   выбрасывать её, как это сделано в list.txt с чужими строками, здесь
   нельзя — там формат машинный, а тут файл правит человек, и «я написал
   объявление, а на табло ничего» не должно случаться вовсе. Пустая полоса
   внизу экрана ничего не объясняет, а строка с лишними палками объясняет
   сразу. По той же причине признаётся и русская «т»: на клавиатуре, где
   набирают само объявление, латинская t стоит не под тем же пальцем. */

var TICK_FROM_RE = /(?:^|\s)с\s+(\d{1,2}\.\d{1,2}(?:\.\d{4})?)/i;
var TICK_TO_RE = /(?:^|\s)(?:до|по)\s+(\d{1,2}\.\d{1,2}(?:\.\d{4})?)/i;
var TICK_DATE_RE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/;

/* Дата срока в ключ ГГГГММДД — в таком же виде считает дни tv.js.
   Год можно не писать: без него берём тот из соседних трёх, в котором
   дата ложится ближе всего к сегодняшнему дню. Иначе «до 10.01», набранное
   в декабре, означало бы январь уже прошедший и объявление не показалось
   бы ни разу. Близость меряем по календарю, а не вычитанием ключей:
   от 20.12.2026 ключ 20260110 отстоит на 1110, а 20270110 — на 8890, хотя по
   календарю второй ближе вдесятеро. */
function tickDate(s, nowTs) {
  var m = TICK_DATE_RE.exec(s || '');
  if (!m) return 0;
  var d = +m[1], mo = +m[2];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return 0;

  var y;
  if (m[3]) y = +m[3];
  else {
    var now = nowTs + TZ_OFFSET_MIN * 60000;
    var base = new Date(now).getUTCFullYear(), best = -1, bestDist = 0;
    for (var i = -1; i <= 1; i++) {
      var dist = Math.abs(Date.UTC(base + i, mo - 1, d) - now);
      if (best < 0 || dist < bestDist) { best = base + i; bestDist = dist; }
    }
    y = best;
  }
  return y * 10000 + mo * 100 + d;
}

/* Разбор всего файла. Сроки отдаём ключами дат, а не готовым
   ответом «показывать или нет»: файл перечитывается редко, а день за
   это время может смениться — отбор по сроку делается перед каждым
   показом. */
function parseTicker(text, nowTs) {
  var out = [];
  (text || '').split(/\r?\n/).forEach(function (raw) {
    var line = norm(raw);
    if (!line || line.charAt(0) === '#') return;

    var kind = 't', term = '', body = line;
    if (line.indexOf('|') >= 0) {
      var p = line.split('|');
      kind = norm(p.shift()).toLowerCase();
      term = norm(p.shift());
      body = norm(p.join('|'));
      /* Тип не опознан — значит, палки в строке стоят не как поля, а как
         часть текста. Берём строку целиком: пусть на табло будет лишняя
         палка, чем ничего. */
      if (kind !== 't' && kind !== '\u0442' && kind !== '!') {
        kind = 't'; term = ''; body = line;
      }
    }
    if (!body) return;

    var from = 0, to = 0, m;
    if ((m = TICK_FROM_RE.exec(term))) from = tickDate(m[1], nowTs);
    if ((m = TICK_TO_RE.exec(term))) to = tickDate(m[1], nowTs);
    /* голая дата без предлога — один-единственный день показа */
    if (!from && !to) from = to = tickDate(term, nowTs);

    out.push({ text: body, imp: kind === '!', from: from, to: to });
  });
  return out;
}


if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSchedule: parseSchedule, parseTicker: parseTicker,
    moment: moment, norm: norm
  };
}
