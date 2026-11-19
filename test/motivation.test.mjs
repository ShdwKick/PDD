// Проверки «Дороги к правам»: порядок отметок и место машины.
// Условия у отметок независимые, поэтому главное здесь — инвариант: позади
// машины только открытое, впереди только закрытое.   node test/motivation.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../assets/motivation.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};

/** Факты с нужными отклонениями от «ничего не делал». */
const facts = (over = {}) => ({
  total: 800, learned: 0, mistakes: 0, seen: 0, answers: 0, correct: 0,
  streak: { current: 0, best: 0, frozen: 0 },
  days: {}, today: "2026-11-18", bestCombo: 0, maxDay: 0, night: false, early: false,
  ...over,
  tickets: { done: 0, passedEver: 0, perfect: 0, ...(over.tickets || {}) },
  exams: { count: 0, passed: 0, perfect: 0, fastest: null, passStreak: 0, recent: [], ...(over.exams || {}) },
});

/** Инвариант дороги: пройденные идут сплошь с начала, машина стоит ровно на
 * границе, reached — это и есть число пройденных. */
const invariant = f => {
  const rd = M.route(f);
  const firstLocked = rd.points.findIndex(p => !p.done);
  const openAfterLocked = firstLocked < 0 ? [] : rd.points.slice(firstLocked + 1).filter(p => p.done);
  return {
    открытыхПослеЗакрытой: openAfterLocked.length,
    reachedРавноЧислуПройденных: rd.reached === rd.points.map(p => p.done).filter(Boolean).length,
    машинаНаГранице: firstLocked < 0 ? rd.reached === rd.points.length : rd.reached === firstLocked,
    nextЭтоПерваяЗакрытая: rd.next === (firstLocked < 0 ? null : rd.points[firstLocked]),
  };
};
const ок = { открытыхПослеЗакрытой: 0, reachedРавноЧислуПройденных: true, машинаНаГранице: true, nextЭтоПерваяЗакрытая: true };

{ // ничего не делал: всё закрыто, порядок канонический
  const rd = M.route(facts());
  eq("пустой: ничего не пройдено", [rd.reached, rd.next.id], [0, "start"]);
  eq("пустой: порядок как в ROUTE", rd.points.map(p => p.id), ["start", "ticket", "q25", "exam", "q50", "t20", "q75", "ready"]);
  eq("пустой: инвариант", invariant(facts()), ок);
}
{ // экзамен сдан раньше, чем выучена четверть — отметка «через закрытую»
  const f = facts({ answers: 400, learned: 160, tickets: { done: 3, passedEver: 2 }, exams: { count: 2, passed: 1, recent: [{ passed: false }, { passed: true }] } });
  const rd = M.route(f);
  eq("пройденные подняты вперёд", rd.points.map(p => p.id), ["start", "ticket", "exam", "q25", "q50", "t20", "q75", "ready"]);
  eq("счётчик считает все пройденные", rd.reached, 3);
  eq("следующая — первая закрытая по порядку ROUTE", rd.next.id, "q25");
  eq("экзамен раньше четверти: инвариант", invariant(f), ок);
}
{ // другой перекос: билетов много, вопросы не выучены
  const f = facts({ answers: 900, learned: 120, tickets: { done: 25, passedEver: 22, perfect: 3 } });
  eq("половина билетов раньше четверти пути", M.route(f).points.map(p => p.id).slice(0, 4), ["start", "ticket", "t20", "q25"]);
  eq("билеты вперёд вопросов: инвариант", invariant(f), ок);
}
{ // всё пройдено — финиш, следующей нет
  const f = facts({ answers: 5000, learned: 800, tickets: { done: 40, passedEver: 40, perfect: 12 }, exams: { count: 9, passed: 9, passStreak: 3, recent: [{ passed: true }, { passed: true }, { passed: true }] } });
  const rd = M.route(f);
  eq("всё пройдено", [rd.reached, rd.next, rd.pct], [8, null, 100]);
  eq("финиш: порядок канонический", rd.points.map(p => p.id), ["start", "ticket", "q25", "exam", "q50", "t20", "q75", "ready"]);
  eq("финиш: инвариант", invariant(f), ок);
}

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
