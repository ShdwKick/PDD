// Проверки логики огонька, заморозок, планов и переноса гостя — без сети и
// без auth: store.js напрямую на временной базе.   node test/store.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const createStore = require("../lib/store.js");
const { addDays, dayIn } = createStore.internals;
const bank = JSON.parse(fs.readFileSync(new URL("../bank/ab.json", import.meta.url)));

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};
const fresh = () => createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pdd-")), bank });
const TZ = "Europe/Moscow";
const today = dayIn(TZ);
let rid = 0;
const R = () => `rid-${(++rid).toString().padStart(8, "0")}`;
const answerN = (s, user, n, { correct = true, at } = {}) => {
  let last;
  for (let i = 0; i < n; i++) {
    const q = bank[i % bank.length];
    last = s.answer(user, { questionId: q.id, chosen: correct ? q.correct : (q.correct + 1) % q.answers.length, mode: "ticket", rid: R(), at, tz: TZ });
  }
  return last;
};
// История дней задаётся через перенос гостя: он пишет activity_days напрямую.
const withDays = (s, user, days) => s.importGuest(user, { days }, 20);
const ago = k => addDays(today, -k);

{ // пустой профиль
  const s = fresh(), m = s.me("u", TZ);
  eq("новый: огонька нет", [m.streak.current, m.streak.freezes, m.streak.target], [0, 0, 20]);
  eq("новый: план по умолчанию", m.plan, { kind: "daily", tickets: 1 });
}
{ // зажигание ровно на 20-м ответе
  const s = fresh();
  const r19 = answerN(s, "u", 19);
  eq("19 ответов: не горит", [r19.lit, r19.streak.todayDone, r19.streak.current], [false, false, 0]);
  const r20 = answerN(s, "u", 1);
  eq("20-й ответ зажигает", [r20.lit, r20.streak.todayDone, r20.streak.current], [true, true, 1]);
  const r21 = answerN(s, "u", 1);
  eq("21-й — уже не «зажёгся»", r21.lit, false);
}
{ // повтор из очереди не считается дважды
  const s = fresh(), q = bank[0];
  const a = s.answer("u", { questionId: q.id, chosen: q.correct, mode: "ticket", rid: "same-rid-1", tz: TZ });
  const b = s.answer("u", { questionId: q.id, chosen: q.correct, mode: "ticket", rid: "same-rid-1", tz: TZ });
  eq("дубликат rid", [a.streak.todayCount, b.streak.todayCount, !!b.duplicate], [1, 1, true]);
}
{ // серия вчера жива, сегодня ещё нет — огонёк тлеет, серия не сгорает
  const s = fresh();
  withDays(s, "u", { [ago(3)]: 20, [ago(2)]: 25, [ago(1)]: 20 });
  const m = s.me("u", TZ);
  eq("3 дня, сегодня пусто", [m.streak.current, m.streak.todayDone], [3, false]);
}
{ // пропуск без заморозок — серия сгорает
  const s = fresh();
  withDays(s, "u", { [ago(4)]: 20, [ago(3)]: 20, [ago(1)]: 20 });
  eq("пропуск без заморозки", s.me("u", TZ).streak.current, 1);
}
{ // 7 дней подряд → заморозка, пропуск её съедает, серия живёт
  const s = fresh(), days = {};
  for (let k = 9; k >= 3; k--) days[ago(k)] = 20;   // 7 дней: ago 9..3
  days[ago(1)] = 20;                                // ago 2 пропущен
  withDays(s, "u", days);
  const m = s.me("u", TZ);
  eq("заморозка потрачена на пропуск", [m.streak.current, m.streak.freezes], [8, 0]);
  eq("потраченная заморозка стабильна", s.me("u", TZ).streak.freezes, 0);
}
{ // заморозки копятся максимум до двух
  const s = fresh(), days = {};
  for (let k = 22; k >= 1; k--) days[ago(k)] = 20;  // 22 дня подряд → 3 раза по 7, но максимум 2
  withDays(s, "u", days);
  const m = s.me("u", TZ);
  eq("потолок заморозок", [m.streak.current, m.streak.freezes, m.streak.nextFreezeIn], [22, 2, null]);
}
{ // смена плана: сегодняшняя норма пересчитывается, прошлые дни — нет
  const s = fresh();
  withDays(s, "u", { [ago(1)]: 20 });
  answerN(s, "u", 25);
  eq("25 при норме 20 — горит", s.me("u", TZ).streak.todayDone, true);
  const r = s.setPlan("u", { kind: "daily", tickets: 3 });
  eq("выполненный сегодня не гасим", [r.streak.todayDone, r.streak.current], [true, 2]);
  const s2 = fresh();
  answerN(s2, "u", 10);
  const r2 = s2.setPlan("u", { kind: "daily", tickets: 2 });
  eq("невыполненный сегодня — новая норма", [r2.streak.target, r2.streak.todayCount], [40, 10]);
  eq("неверный план отвергается", s2.setPlan("u", { kind: "daily", tickets: 50 }), null);
}
{ // «к дате экзамена»: норма из оставшегося
  const s = fresh();
  const r = s.setPlan("u", { kind: "exam_date", date: addDays(today, 9) });  // 10 дней
  eq("к дате: ceil(794/10)", r.streak.target, Math.ceil(s.TOTAL / 10));
  eq("прошедшая дата отвергается", s.setPlan("u", { kind: "exam_date", date: ago(1) }), null);
}
{ // перенос гостя — один раз
  const s = fresh();
  const q = bank[0];
  const a = s.importGuest("u", { q: { [q.id]: { n: 2, ok: 2, last: 1, streak: 2 } }, t: { 1: { best: 18, last: 18, passed: true } }, days: { [ago(1)]: 20, [addDays(today, 1)]: 50 } }, 20);
  eq("гость перенесён (день из будущего отброшен)", [a.questions, a.tickets, a.days], [1, 1, 1]);
  eq("второй перенос запрещён", s.importGuest("u", { days: { [ago(2)]: 20 } }, 20).imported, false);
  const m = s.me("u", TZ);
  eq("сводка после переноса", [m.summary.learned, m.summary.passedTickets, m.streak.current], [1, 1, 1]);
}
{ // итог билета считает сервер
  const s = fresh(), qs = bank.filter(q => q.ticket === 5);
  const ans = Object.fromEntries(qs.map(q => [q.num, q.num === 1 || q.num === 2 ? (q.correct + 1) % q.answers.length : q.correct]));
  const r = s.finishTicket("u", 5, ans);
  eq("2 ошибки в одном блоке — не сдал", [r.correct, r.passed], [18, false]);
  eq("неполный билет отвергается", s.finishTicket("u", 5, { 1: 0 }), null);
}
{ // ответ без сети засчитывается в свой день
  const s = fresh();
  const yesterdayNoon = Date.now() - 24 * 3600 * 1000;
  answerN(s, "u", 20, { at: yesterdayNoon });
  const m = s.me("u", TZ);
  eq("офлайн-ответы вчера: вчера выполнено", [m.streak.current, m.streak.todayCount], [1, 0]);
}

{ // вердикт экзамена
  const { examVerdict } = createStore.internals;
  const mk = (wrongBlocks, extras = {}) => {
    const items = [];
    for (let b = 1; b <= 4; b++) for (let k = 0; k < 5; k++) items.push({ block: b, extra: false, correct: !(wrongBlocks[b] > k) });
    for (const [b, list] of Object.entries(extras)) for (const ok of list) items.push({ block: +b, extra: true, correct: ok });
    return items;
  };
  eq("экзамен без ошибок — сдал", examVerdict(mk({}), false).passed, true);
  eq("1 ошибка без доп. вопросов — не закончен", examVerdict(mk({ 2: 1 }), false).reason, "unfinished");
  eq("1 ошибка + 5 верных доп. — сдал", examVerdict(mk({ 2: 1 }, { 2: [1, 1, 1, 1, 1] }), false).passed, true);
  eq("ошибка в доп. — не сдал", examVerdict(mk({ 2: 1 }, { 2: [1, 0, 1, 1, 1] }), false).reason, "extra");
  eq("2 в одном блоке — не сдал", examVerdict(mk({ 3: 2 }), false).reason, "block");
  eq("3 в разных блоках — не сдал", examVerdict(mk({ 1: 1, 2: 1, 3: 1 }), false).reason, "many");
  eq("время вышло — не сдал", examVerdict(mk({}), true).reason, "timeout");
}
{ // ошибка уходит после двух верных подряд
  const s = fresh(), q = bank[0], wrong = (q.correct + 1) % q.answers.length;
  const ans = c => s.answer("u", { questionId: q.id, chosen: c, mode: "mistakes", rid: R(), tz: TZ });
  ans(wrong);
  eq("после ошибки — в ошибках", s.qState("u").mistakes, [q.id]);
  ans(q.correct);
  eq("один верный — ещё в ошибках", s.qState("u").mistakes.length, 1);
  ans(q.correct);
  eq("два верных подряд — ушёл", [s.qState("u").mistakes.length, s.qState("u").learned.length], [0, 1]);
}
{ // экзамен сохраняется, итог — сервера
  const s = fresh(), qs = bank.filter(q => q.ticket === 3);
  const items = qs.map(q => ({ questionId: q.id, chosen: q.correct, block: Math.ceil(q.num / 5), extra: false }));
  const r = s.finishExam("u", items, 600, false);
  eq("экзамен сохранён", [r.passed, r.summary.exams.count, r.summary.exams.passed], [true, 1, 1]);
  eq("мусор вместо ответов отвергается", s.finishExam("u", [{ questionId: "x", chosen: 0, block: 1 }], 1, false), null);
}
{ // итоги из очереди без сети: повтор с тем же rid не считается дважды, время — своё
  const s = fresh();
  const ex = bank.filter(q => q.ticket === 3).map(q => ({ questionId: q.id, chosen: q.correct, block: Math.ceil(q.num / 5), extra: false }));
  const hourAgo = Date.now() - 3600 * 1000;
  s.finishExam("u", ex, 600, false, { rid: "exam-rid-0001", at: hourAgo });
  const again = s.finishExam("u", ex, 600, false, { rid: "exam-rid-0001", at: hourAgo });
  eq("экзамен: повтор из очереди — не второй экзамен", [again.duplicate, again.summary.exams.count, again.summary.exams.last.at], [true, 1, hourAgo]);
  const qs = bank.filter(q => q.ticket === 7);
  const ok = Object.fromEntries(qs.map(q => [q.num, q.correct]));
  s.finishTicket("u", 7, ok, { rid: "ticket-rid-0001", at: hourAgo });
  const t2 = s.finishTicket("u", 7, ok, { rid: "ticket-rid-0001", at: hourAgo });
  eq("билет: повтор из очереди — один заход, сдан", [t2.duplicate, t2.summary.tickets[7].runs, t2.summary.passedTickets], [true, 1, 1]);
  eq("кривой rid — отказ", s.finishTicket("u", 7, ok, { rid: "<x>" }), null);
  eq("без rid (старый клиент) — как раньше", s.finishTicket("u", 7, ok).summary.tickets[7].runs, 2);
}

{ // лента друзей и толчки
  const s = fresh();
  withDays(s, "a", { [ago(2)]: 20, [ago(1)]: 20 });
  answerN(s, "a", 20);
  const feed = s.friendsFeed("me", ["a", "ghost"]);
  eq("друг с огоньком", [feed.a.started, feed.a.streak.current, feed.a.streak.todayDone], [true, 3, true]);
  eq("друг, который ещё не открывал", feed.ghost.started, false);
  eq("первый толчок за день проходит", s.recordNudge("me", "a"), true);
  eq("второй — нет", s.recordNudge("me", "a"), false);
  eq("в ленте отмечено «толкнули»", s.friendsFeed("me", ["a"]).a.nudgedToday, true);
}
{ // вечернее напоминание
  const s = fresh();
  withDays(s, "r", { [ago(1)]: 20 });
  // Серия вчерашняя, сегодня пусто. Время напоминания 00:00 — «сейчас» оно
  // уже наступило при любом поясе.
  s.setRemind("r", "00:00");
  const due = s.dueReminders();
  eq("серия есть, сегодня не выполнено — напомнить", due.map(d => d.userId), ["r"]);
  eq("второй раз за день — нет", s.dueReminders().length, 0);
  s.setRemind("r", null);
  eq("выключенное напоминание не приходит", s.dueReminders().length, 0);
  eq("кривое время отвергается", s.setRemind("r", "25:99"), null);
}

{ // факты для мотивации и расчёт по ним (assets/motivation.js)
  const M = require("../assets/motivation.js");
  const s = fresh();
  withDays(s, "m", { [ago(2)]: 20, [ago(1)]: 20 });
  answerN(s, "m", 25);                      // 25 верных подряд
  answerN(s, "m", 1, { correct: false });    // и одна ошибка
  const f = s.me("m", TZ).facts;
  eq("факты: ответы и верные", [f.answers, f.correct], [26, 25]);
  eq("факты: лучшая серия верных", f.bestCombo, 25);
  eq("факты: огонёк", [f.streak.current, f.streak.best], [3, 3]);
  eq("факты: сегодня в неделе", [f.days[today].n, f.days[today].ok, f.days[today].done], [26, 25, true]);
  const got = M.badges(f).filter(b => b.got).map(b => b.id);
  eq("значки: первый шаг, разогрев, двадцать подряд", ["first", "streak3", "combo20"].every(id => got.includes(id)), true);
  eq("значки: экзамена не было — «Сдал!» нет", got.includes("exam1"), false);
  // Неделя — с понедельника: какие из трёх дней в неё попали, зависит от того,
  // какой сегодня день недели, — ждём ровно то, что в неё попадает.
  const w = M.week(f), mon = M.weekStart(today);
  const inWeek = [[ago(2), 20], [ago(1), 20], [today, 26]].filter(([d]) => d >= mon);
  eq("неделя с понедельника: вопросы и дни с нормой", [w.monday, w.n, w.doneDays], [mon, inWeek.reduce((a, [, n]) => a + n, 0), inWeek.length]);
  eq("неделя: понедельник — первый день", [M.weekStart("2026-10-01"), M.weekStart("2026-09-28"), M.weekStart("2026-10-04")], ["2026-09-28", "2026-09-28", "2026-09-28"]);
  const fw = { today: "2026-10-01", days: { "2026-09-30": { n: 20, ok: 18, done: true }, "2026-09-23": { n: 10, ok: 5 }, "2026-09-26": { n: 40, ok: 30, done: true } } };
  eq("неделя: сравнение с тем же отрезком прошлой (пн–чт), суббота не в счёт", [M.week(fw).n, M.week(fw).prevN, M.week(fw).delta], [20, 10, 100]);
  eq("рубеж: 3 дня взят, следующий 7, в гараже — белый кузов и полосы", [M.milestone(3).hit.at, M.milestone(3).next.at, M.unlocksAt(3)], [3, 7, ["белый кузов", "гоночные полосы", "свой номер"]]);
  const r0 = M.readiness(f);
  eq("готовность: без экзаменов не «готов», шаг — экзамен", [r0.ready, r0.steps.some(x => x.href === "/ekzamen")], [false, true]);
  const full = { ...f, learned: f.total, exams: { ...f.exams, count: 3, passStreak: 3, recent: [{ passed: true }, { passed: true }, { passed: true }] } };
  eq("готовность: всё выучено и 3 экзамена подряд — готов", [M.readiness(full).ready, M.readiness(full).pct], [true, 88]);
  const feed = s.friendsFeed("x", ["m"]).m;
  eq("лента: неделя (с понедельника) и значки друга", [feed.week, feed.badges >= 3], [w.n, true]);
}

{ // гараж: выбор машины только из открытого по лучшей серии
  const M = require("../assets/motivation.js");
  const s = fresh();
  withDays(s, "g", { [ago(3)]: 20, [ago(2)]: 20, [ago(1)]: 20 });
  const m = s.me("g", TZ);
  eq("по умолчанию: синий кузов, полосы уже открыты", M.carConfig(m.car, m.streak.best), { paint: "blue", stripes: "white", spoiler: "none", glow: "none", exhaust: "none", plate: "" });
  eq("открытый белый кузов — можно", s.setCar("g", { paint: "white" }), { car: { paint: "white" } });
  eq("красный (30 дней) — ещё закрыт", s.setCar("g", { paint: "red" }), null);
  eq("мусор — нет", s.setCar("g", { paint: "pink" }), null);
  s.setCar("g", { stripes: "none" });
  eq("выбор дописывается и приходит в /api/me", s.me("g", TZ).car, { paint: "white", stripes: "none" });
  eq("снятые полосы остаются снятыми", M.carConfig(s.me("g", TZ).car, 3).stripes, "none");
  eq("свой номер с 3 дней — сохраняется заглавными", s.setCar("g", { plate: "ане 77" })?.car.plate, "АНЕ 77");
  eq("номер длиннее 8 символов — нет", s.setCar("g", { plate: "123456789" }), null);
  eq("номер со спецсимволами — нет", s.setCar("g", { plate: "<b>hi" }), null);
  eq("друзья видят машину такой, какой её выбрал хозяин", s.friendsFeed("v", ["g"]).g.car,
    { paint: "white", stripes: "none", spoiler: "none", glow: "none", exhaust: "none", plate: "АНЕ 77" });
  const s2 = fresh();
  eq("номер до 3 дней огонька — закрыт", s2.setCar("n", { plate: "ANYA" }), null);
}

{ // ключ виджета: только чтение огонька, хранится хешем, отзывается
  const s = fresh();
  withDays(s, "w", { [ago(2)]: 20, [ago(1)]: 20 });
  const t = s.createWidgetToken("w");
  const w = s.widget(t);
  eq("виджет по ключу: серия и норма", [w.current, w.best, w.todayCount, w.target, w.todayDone], [2, 2, 0, 20, false]);
  eq("чужой/кривой ключ — нет", [s.widget("x".repeat(43)), s.widget("<bad>"), s.widget(undefined)], [null, null, null]);
  const keys = Array.from({ length: 6 }, () => s.createWidgetToken("w"));
  eq("старше 5 последних ключей — удалены", [s.widget(t), !!s.widget(keys[5]), !!s.widget(keys[1])], [null, true, true]);
  eq("отзыв — все ключи мертвы", [s.revokeWidgetTokens("w"), s.widget(keys[5])], [5, null]);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
