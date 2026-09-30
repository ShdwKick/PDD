"use strict";
/* Локальное хранилище. Две роли, в зависимости от того, вошёл ли человек:

   Гость — здесь вся правда: статистика вопросов (q), результаты билетов (t),
   вопросы по дням (days, по МЕСТНОМУ времени) и свой план. Огонёк у гостя
   считается здесь же, упрощённо: норма текущего плана применяется ко всем
   дням, заморозок нет. При первом входе всё это один раз уезжает на сервер
   (exportGuest → /api/import-guest) и отсюда стирается (clearGuestStats).

   Вошедший — правда на сервере (lib/store.js). Здесь остаются только
   незаконченные билеты (runs — они про это устройство) и очередь ответов,
   которые не удалось отправить (outbox): без сети ответ не должен пропасть
   для огонька, сервер засчитает его в свой день по времени ответа. */

const KEY = "bh-pdd-v1";
const OUTBOX_KEY = "bh-pdd-outbox";
export const Q_PER_TICKET = 20;

// dok — верных за день (days — всех), rec — для рекордов и значков
// (motivation.js): серия верных подряд, «ночной» и «ранний» ответ.
function empty() { return { v: 1, q: {}, t: {}, days: {}, dok: {}, rec: { combo: 0, bestCombo: 0, night: false, early: false }, runs: {}, exams: [], plan: { kind: "daily", tickets: 1 } }; }

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
function shiftDay(key, delta) {
  const [y, m, dd] = key.split("-").map(Number);
  return new Date(y, m - 1, dd + delta).toLocaleDateString("sv-SE");
}
function diffDays(from, to) {
  const t = k => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(to) - t(from)) / 86400000);
}

/* ---------- незаконченные билеты — и у гостя, и у вошедшего ---------- */

export function getRun(ticket) {
  return read().runs[ticket] || null;
}
export function setRunAnswer(ticket, num, chosen) {
  const d = read();
  const run = d.runs[ticket] || { answers: {}, startedAt: Date.now() };
  run.answers[num] = chosen;
  d.runs[ticket] = run;
  write(d);
}
export function resetRun(ticket) {
  const d = read();
  delete d.runs[ticket];
  write(d);
}
export function localRuns() {
  return read().runs;
}

/* ---------- план ---------- */

export function getLocalPlan() { return read().plan; }

/* ---------- гараж ---------- */

/** Выбор машины (motivation.js CAR) — и у гостя, и как запасной у вошедшего
 * без сети. null — ничего не выбирал, машина по умолчанию. */
export function getLocalCar() { return read().car || null; }
export function setLocalCar(car) { const d = read(); d.car = { ...(d.car || {}), ...car }; write(d); }
export function setLocalPlan(plan) { const d = read(); d.plan = plan; write(d); }

/** Норма на сегодня в вопросах — та же формула, что targetFor() на сервере. */
export function targetFor(plan, learned, total) {
  if (plan?.kind === "exam_date") {
    const daysLeft = diffDays(today(), plan.date) + 1;
    if (daysLeft < 1) return Q_PER_TICKET;
    return Math.min(200, Math.max(Q_PER_TICKET, Math.ceil((total - learned) / daysLeft)));
  }
  return (plan?.tickets || 1) * Q_PER_TICKET;
}

/* ---------- гость ---------- */

/** Ответ гостя. Пишется сразу, а не в конце билета: вопрос решён — значит,
 * засчитан в день, даже если билет бросили на середине. lit — этот ответ
 * закрыл дневную норму. */
export function recordGuestAnswer(ticket, num, question, chosen, total) {
  const d = read();
  const ok = chosen === question.correct;
  const target = targetFor(d.plan, Object.values(d.q).filter(s => s.last === 1).length, total);

  const s = d.q[question.id] || { n: 0, ok: 0, last: 0, streak: 0, at: 0 };
  s.n++; if (ok) s.ok++;
  s.last = ok ? 1 : 0;
  s.streak = ok ? s.streak + 1 : 0;
  s.at = Date.now();
  d.q[question.id] = s;

  const day = today();
  const before = d.days[day] || 0;
  d.days[day] = before + 1;
  if (ok) d.dok[day] = (d.dok[day] || 0) + 1;
  const rec = d.rec;
  rec.combo = ok ? rec.combo + 1 : 0;
  rec.bestCombo = Math.max(rec.bestCombo, rec.combo);
  const h = new Date().getHours();
  if (h >= 23 || h < 5) rec.night = true; else if (h < 7) rec.early = true;

  // Незаконченный билет — только в режиме билета (ticket не null). Экзамен,
  // ошибки и темы в runs не пишут.
  if (ticket != null) {
    const run = d.runs[ticket] || { answers: {}, startedAt: Date.now() };
    run.answers[num] = chosen;
    d.runs[ticket] = run;
  }

  write(d);
  return { ok, lit: before < target && before + 1 >= target };
}

/** Билет решён целиком: запоминаем результат (гость) и убираем незаконченный. */
export function finishGuestRun(ticket, correctCount, passed) {
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

/** Ошибка — хоть раз ошибся и ещё не ответил верно дважды подряд (то же
 * правило, что на сервере, lib/store.js). */
const isMistake = s => s.n > s.ok && s.streak < 2;

/** Сводка гостя для главной — в той же форме, что summary с сервера. */
export function guestSummary(total) {
  const d = read();
  const qs = Object.values(d.q);
  const exams = d.exams || [];
  return {
    tickets: d.t,
    passedTickets: Object.values(d.t).filter(t => t.passed).length, // по последнему решению
    learned: qs.filter(s => s.last === 1).length,  // последний ответ верный
    mistakes: qs.filter(isMistake).length,
    total,
    exams: { count: exams.length, passed: exams.filter(e => e.passed).length, last: exams[exams.length - 1] || null },
  };
}

/** Выученные и ошибки гостя — в той же форме, что /api/me/qstate. */
export function guestQState() {
  const d = read();
  const learned = [], mistakes = [];
  for (const [id, s] of Object.entries(d.q)) {
    if (s.last === 1) learned.push(id);
    if (isMistake(s)) mistakes.push(id);
  }
  return { learned, mistakes };
}

/** Экзамен гостя — хранятся последние 20 итогов. */
export function recordGuestExam(result) {
  const d = read();
  d.exams = [...(d.exams || []), { at: Date.now(), passed: !!result.passed, reason: result.reason || null, wrong: result.wrong | 0, seconds: result.seconds | 0 }].slice(-20);
  // Счётчики — отдельно: список хранит только последние 20.
  d.examStats = d.examStats || { count: 0, passed: 0, perfect: 0, fastest: null };
  const es = d.examStats;
  es.count++;
  if (result.passed) {
    es.passed++;
    if (!result.wrong) es.perfect++;
    if (result.seconds > 0) es.fastest = es.fastest === null ? result.seconds : Math.min(es.fastest, result.seconds);
  }
  write(d);
}

/** Огонёк гостя — в той же форме, что streak с сервера (без заморозок). Сегодня
 * ещё не выполнено — серия не сгорела, считаем со вчера: до полуночи время есть. */
export function guestStreak(total) {
  const d = read();
  const target = targetFor(d.plan, Object.values(d.q).filter(s => s.last === 1).length, total);
  const todayKey = today();
  const todayCount = d.days[todayKey] || 0;
  const todayDone = todayCount >= target;
  let current = 0;
  for (let key = todayDone ? todayKey : shiftDay(todayKey, -1); (d.days[key] || 0) >= target; key = shiftDay(key, -1)) current++;
  let best = 0, run = 0, prev = null;
  for (const key of Object.keys(d.days).filter(k => d.days[k] >= target).sort()) {
    run = prev && shiftDay(prev, 1) === key ? run + 1 : 1;
    best = Math.max(best, run);
    prev = key;
  }
  return { current, best, todayCount, todayDone, target, freezes: null, nextFreezeIn: null };
}

/** Факты для мотивации — та же форма, что facts() в lib/store.js. */
export function guestFacts(total) {
  const d = read();
  const qs = Object.values(d.q);
  const st = guestStreak(total);
  const tickets = Object.values(d.t);
  const exams = d.exams || [];
  const es = d.examStats || {
    count: exams.length, passed: exams.filter(e => e.passed).length,
    perfect: exams.filter(e => e.passed && !e.wrong).length, fastest: null,
  };
  let passStreak = 0;
  for (let i = exams.length - 1; i >= 0 && exams[i].passed; i--) passStreak++;
  const todayKey = today();
  const days = {};
  for (let i = 0; i < 14; i++) {
    const key = shiftDay(todayKey, -i), n = d.days[key] || 0;
    if (n) days[key] = { n, ok: (d.dok || {})[key] || 0, done: n >= st.target };
  }
  const rec = { bestCombo: 0, night: false, early: false, ...(d.rec || {}) };
  return {
    total,
    learned: qs.filter(s => s.last === 1).length,
    mistakes: qs.filter(isMistake).length,
    seen: qs.length,
    answers: qs.reduce((a, s) => a + s.n, 0),
    correct: qs.reduce((a, s) => a + s.ok, 0),
    tickets: {
      done: tickets.length,
      passedEver: tickets.filter(t => t.everPassed).length,
      perfect: tickets.filter(t => t.best === 20).length,
    },
    exams: { ...es, passStreak, recent: exams.slice(-10).map(e => ({ passed: !!e.passed })) },
    streak: { current: st.current, best: st.best, frozen: 0 },
    days, today: todayKey,
    bestCombo: rec.bestCombo,
    maxDay: Math.max(0, ...Object.values(d.days)),
    night: rec.night, early: rec.early,
  };
}

/* ---------- перенос гостя на сервер ---------- */

export function hasGuestStats() {
  const d = read();
  return Object.keys(d.q).length > 0 || Object.keys(d.t).length > 0;
}
export function exportGuest() {
  const d = read();
  return { data: { q: d.q, t: d.t, days: d.days }, target: targetFor(d.plan, 0, 0) };
}
/** После переноса статистика гостя больше не нужна: иначе при выходе из
 * аккаунта человек увидел бы старый гостевой прогресс вместо пустого. */
export function clearGuestStats() {
  const d = read();
  d.q = {}; d.t = {}; d.days = {}; d.dok = {}; d.rec = empty().rec; d.exams = []; delete d.examStats;
  write(d);
}

/* ---------- очередь неотправленных ответов ---------- */

export function outbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; }
}
export function outboxPush(item) {
  const list = outbox();
  list.push(item);
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-500))); } catch {}
}
export function outboxDrop(rid) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox().filter(x => x.rid !== rid))); } catch {}
}

/** «вопрос», «вопроса», «вопросов». */
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}
