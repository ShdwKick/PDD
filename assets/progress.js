"use strict";
/* Прогресс гостя — в localStorage этого браузера. На этапе 1 единственный
   источник правды; на этапе 2 при входе он один раз уедет на сервер
   (/api/import-guest, см. ARCHITECTURE.md), дальше правдой станет сервер.
   Поэтому формат держим близким к серверным таблицам:

     q[id]      — как q_state: сколько раз отвечал, сколько верно, верно ли
                  в последний раз, сколько верно подряд (для «ошибок»);
     t[n]       — лучший и последний результат билета;
     days[день] — сколько вопросов решено в этот день по МЕСТНОМУ времени,
                  заготовка под activity_days и огонёк;
     runs[n]    — незаконченный билет: какие ответы уже даны. Отдельно на
                  каждый билет, чтобы открыв другой, не потерять начатый. */

const KEY = "bh-pdd-v1";

function empty() { return { v: 1, q: {}, t: {}, days: {}, runs: {} }; }

function read() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    return d && d.v === 1 ? { ...empty(), ...d } : empty();
  } catch { return empty(); }
}
function write(d) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); }
  catch { /* приватный режим или квота — прогресс не переживёт визит, решать это не мешает */ }
}

/** 'YYYY-MM-DD' по местному времени. sv-SE — единственная распространённая
 * локаль, которая форматирует дату ровно так. */
export function today() {
  return new Date().toLocaleDateString("sv-SE");
}

/** Незаконченный билет или null. */
export function getRun(ticket) {
  return read().runs[ticket] || null;
}

/** Ответ на вопрос билета. Пишется сразу, а не в конце билета: вопрос решён —
 * значит, он засчитан в день, даже если билет бросили на середине. */
export function recordAnswer(ticket, num, question, chosen) {
  const d = read();
  const ok = chosen === question.correct;

  const s = d.q[question.id] || { n: 0, ok: 0, last: 0, streak: 0, at: 0 };
  s.n++; if (ok) s.ok++;
  s.last = ok ? 1 : 0;
  s.streak = ok ? s.streak + 1 : 0;
  s.at = Date.now();
  d.q[question.id] = s;

  const day = today();
  const before = d.days[day] || 0;
  d.days[day] = before + 1;

  const run = d.runs[ticket] || { answers: {}, startedAt: Date.now() };
  run.answers[num] = chosen;
  d.runs[ticket] = run;

  write(d);
  // lit — этот ответ закрыл дневную норму: огонёк зажёгся прямо сейчас.
  return { ok, lit: before < DAILY_TARGET && before + 1 >= DAILY_TARGET };
}

/* ---------- огонёк ----------
   Дневная норма — пока фиксированная: один билет, 20 вопросов. На этапе 2 её
   заменит норма из плана пользователя и заморозки (ARCHITECTURE.md, «Огонёк»);
   считать тогда будет сервер, а это останется гостевым вариантом. */

export const DAILY_TARGET = 20;

function shiftDay(key, delta) {
  const [y, m, dd] = key.split("-").map(Number);
  return new Date(y, m - 1, dd + delta).toLocaleDateString("sv-SE");
}

/** Серия дней подряд с выполненной нормой. Сегодня ещё не выполнено — серия
 * не сгорела, её просто считаем со вчера: до полуночи время есть. */
export function streak() {
  const { days } = read();
  const todayKey = today();
  const todayCount = days[todayKey] || 0;
  const todayDone = todayCount >= DAILY_TARGET;
  let current = 0;
  for (let key = todayDone ? todayKey : shiftDay(todayKey, -1); (days[key] || 0) >= DAILY_TARGET; key = shiftDay(key, -1)) current++;
  // Лучшая серия — по всей истории, чтобы после перерыва было к чему стремиться.
  let best = 0, run = 0, prev = null;
  for (const key of Object.keys(days).filter(k => days[k] >= DAILY_TARGET).sort()) {
    run = prev && shiftDay(prev, 1) === key ? run + 1 : 1;
    best = Math.max(best, run);
    prev = key;
  }
  return { current, best, todayCount, todayDone, target: DAILY_TARGET };
}

/** Билет решён целиком: запоминаем результат и убираем незаконченный. */
export function finishRun(ticket, correctCount, passed) {
  const d = read();
  const prev = d.t[ticket];
  d.t[ticket] = {
    best: Math.max(prev?.best ?? 0, correctCount),
    last: correctCount,
    passed: !!passed, // по правилам ГАИ, см. verdict() в app.js
    everPassed: !!(prev?.everPassed || passed),
    runs: (prev?.runs || 0) + 1,
    at: Date.now(),
  };
  delete d.runs[ticket];
  write(d);
}

export function resetRun(ticket) {
  const d = read();
  delete d.runs[ticket];
  write(d);
}

/** Сводка для главной. */
export function summary() {
  const d = read();
  const qs = Object.values(d.q);
  return {
    tickets: d.t,
    runs: d.runs,
    passedTickets: Object.values(d.t).filter(t => t.passed).length, // по последнему решению
    days: d.days,
    learned: qs.filter(s => s.last === 1).length,  // последний ответ верный
    mistakes: qs.filter(s => s.last === 0).length, // последний ответ неверный
    todayCount: d.days[today()] || 0,
  };
}

/** «вопрос», «вопроса», «вопросов». */
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}
