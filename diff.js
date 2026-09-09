'use strict';
/* Пометки изменений: сравнение расписания с той версией, которую табло
   увидело для этого дня первой. Подключать после parse.js, до tv.js.

   Точка отсчёта — календарный день, а не неделя. Соблазн взять период из
   шапки («08.09.2026 — 13.09.2026») велик, но период этот собирается
   объединением по всем файлам, а файлы обновляются не разом: пока половина
   групп уже на новой неделе, а половина на старой, границы периода скачут,
   и база отсчёта скакала бы вместе с ними. У даты такой беды нет. Новая
   неделя — это просто шесть дат, которых в хранилище ещё не было; они
   становятся собственной точкой отсчёта сами, без всякого «начала недели».

   Хранится по ключу на день:
     rasp.base.08.09.2026 → {"v":1,"g":{"ИС-24":{"1":"Матанализ|Иванова|312"}}}
   Полсотни групп на неделю — около сотни килобайт при лимите в пять
   мегабайт, так что подписи держим текстом и ничего не хешируем. */

var BASE_PREFIX = 'rasp.base.';

/* Хранилище может не работать вовсе: телевизоры в режиме киоска нередко
   стартуют с пустым профилем или с запретом на запись. Проверяем один раз
   записью, а не наличием объекта: в приватном режиме localStorage есть,
   но setItem бросает исключение. Не работает — просто не подсвечиваем. */
var storeChecked = false, storeRef = null;

function store() {
  if (storeChecked) return storeRef;
  storeChecked = true;
  try {
    var s = window.localStorage;
    s.setItem(BASE_PREFIX + '?', '1');
    s.removeItem(BASE_PREFIX + '?');
    storeRef = s;
  } catch (e) { storeRef = null; }
  return storeRef;
}

function dayNum(date) {
  var p = String(date).split('.');
  return p.length === 3 ? +p[2] * 10000 + +p[1] * 100 + +p[0] : 0;
}

/* Подпись занятия. Сравнивается целиком, поэтому разделители могут быть
   любыми — важно лишь, чтобы в неё попало всё, что видно в ячейке.
   Подгруппы не сортируем: если первая и вторая поменялись преподавателями,
   это настоящее изменение, а не перестановка. */
function sig(lesson) {
  var who = [], room = [];
  lesson.variants.forEach(function (v) {
    who.push(v.who || '');
    room.push(v.room || '');
  });
  return lesson.subject + '|' + who.join(',') + '|' + room.join(',');
}

/* Срез одной группы за один день: номер пары → подпись. В g.at лежат только
   непустые занятия, поэтому пустая пара просто отсутствует и в срезе. */
function snapshot(g, date) {
  var out = {}, pre = date + '/';
  Object.keys(g.at).forEach(function (k) {
    if (k.indexOf(pre) === 0) out[k.slice(pre.length)] = sig(g.at[k]);
  });
  return out;
}

function readDay(s, date) {
  try {
    var raw = s.getItem(BASE_PREFIX + date);
    var rec = raw ? JSON.parse(raw) : null;
    return rec && rec.g ? rec : null;
  } catch (e) { return null; }
}

function writeDay(s, date, rec) {
  try { s.setItem(BASE_PREFIX + date, JSON.stringify(rec)); }
  catch (e) { /* переполнение или запрет — подсветка не стоит падения табло */ }
}

/* Чистим записи старше самого раннего показываемого дня. Именно раннего,
   а не сегодняшнего: понедельник в среду ещё висит на экране, и его точка
   отсчёта нужна — иначе пометки прошедших дней пересоздались бы по текущей
   версии и исчезли. */
function prune(s, keepFrom) {
  try {
    for (var i = s.length - 1; i >= 0; i--) {
      var k = s.key(i);
      if (!k || k.indexOf(BASE_PREFIX) !== 0) continue;
      var n = dayNum(k.slice(BASE_PREFIX.length));
      if (n && n < keepFrom) s.removeItem(k);
    }
  } catch (e) { /* пропускаем */ }
}

/* Отметка времени, когда снята точка отсчёта. Нужна не коду, а человеку:
   когда на табло «нет подсветки», первый вопрос — от чего вообще идёт
   отсчёт и не сбросился ли он вчера вместе с профилем браузера. */
function stampNow() {
  var d = new Date();
  function p(n) { return ('0' + n).slice(-2); }
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes());
}

/* Что хранилище знает о показываемых днях — для tv.html?diag. */
function baseInfo(days) {
  var s = store();
  if (!s) return { works: false, days: [] };
  return {
    works: true,
    days: days.map(function (day) {
      var rec = readDay(s, day.date);
      return {
        date: day.date,
        has: !!rec,
        at: rec && rec.at ? rec.at : '',
        groups: rec ? Object.keys(rec.g).length : 0
      };
    })
  };
}

/* Проставляет g.marks['дата/пара'] = 'chg' | 'off' для каждой группы.
   'chg' — занятие появилось или изменилось, 'off' — было и снято. */
function markChanges(groups, days, opts) {
  opts = opts || {};
  groups.forEach(function (g) { g.marks = {}; });
  if (opts.off || !days.length) return;

  var s = store();
  if (!s) return;

  prune(s, dayNum(days[0].date));

  days.forEach(function (day) {
    var date = day.date;
    var rec = opts.rebase ? null : readDay(s, date);
    var dirty = !rec;
    if (!rec) rec = { v: 1, at: stampNow(), g: {} };

    groups.forEach(function (g) {
      var now = snapshot(g, date);
      var was = rec.g[g.title];
      /* Группы, которой в базе нет, — либо день видим впервые, либо файл
         добавили в середине недели. И в том, и в другом случае помечать
         нечего: записываем как есть и молчим. */
      if (!was) { rec.g[g.title] = now; dirty = true; return; }

      Object.keys(now).forEach(function (n) {
        if (was[n] !== now[n]) g.marks[date + '/' + n] = 'chg';
      });
      Object.keys(was).forEach(function (n) {
        if (now[n] === undefined) g.marks[date + '/' + n] = 'off';
      });
    });

    if (dirty) writeDay(s, date, rec);
  });

  /* Группу, чей файл не открылся, loadAll() просто выбрасывает из списка.
     Здесь она поэтому не встречается — и в базе остаётся нетронутой. Иначе
     одна сетевая икота красила бы целую колонку как «пары сняли». */
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { markChanges: markChanges, sig: sig, baseInfo: baseInfo };
}
