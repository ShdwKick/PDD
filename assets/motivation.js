/* Мотивация «Когда на права?»: готовность к экзамену, значки, рубежи огонька,
   итоги недели и рекорды. Чистые функции от «фактов» — одинаково для гостя
   (факты собирает progress.js из localStorage) и вошедшего (lib/store.js из
   базы). Один файл на оба мира: в браузере — обычный <script>
   (window.PddMotivation), на сервере — require(). Сервер считает по нему
   значки друзей, браузер — всё остальное.

   Факты (facts):
     total, learned, mistakes, seen — вопросы: всего уникальных, последний
       ответ верный, «в ошибках», хоть раз отвеченных;
     answers, correct — всего ответов и верных (с повторами);
     tickets: { done, passedEver, perfect } — решено целиком, сдано хоть раз,
       решено на 20 из 20;
     exams: { count, passed, perfect, fastest, passStreak, recent:[{passed}] }
       — recent: последние 10, от старых к новым; fastest — секунд, лучший
       сданный, или null;
     streak: { current, best, frozen } — frozen: дней, спасённых заморозкой;
     days: { 'YYYY-MM-DD': { n, ok, done } } — последние 14 дней;
     today, bestCombo, maxDay, night, early. */
(function (root) {
  "use strict";

  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m100 >= 11 && m100 <= 14) return many;
    if (m10 === 1) return one;
    if (m10 >= 2 && m10 <= 4) return few;
    return many;
  };
  const clamp01 = x => Math.max(0, Math.min(1, x || 0));

  /* ---------- готовность к экзамену ----------
     70% — знание вопросов (последний ответ верный), 30% — экзамены: сколько
     из последних пяти сдано. Готов — когда выучено 90% и три последних
     экзамена подряд сданы: так ГАИ не станет сюрпризом. */
  const LEVELS = [
    [90, "Готовы к ГАИ"],
    [75, "Почти готовы"],
    [50, "Больше половины пути"],
    [25, "Уверенный старт"],
    [0, "Только начали"],
  ];

  function readiness(f) {
    const know = clamp01(f.learned / f.total);
    const recent = f.exams.recent.slice(-5);
    const passes = recent.filter(e => e.passed).length;
    const pct = Math.round(100 * (0.7 * know + 0.3 * passes / 5));
    const last3 = f.exams.recent.slice(-3);
    const ready = know >= 0.9 && last3.length === 3 && last3.every(e => e.passed);
    const level = ready ? "Готовы к ГАИ" : LEVELS.find(([min]) => pct >= min && min < 90)?.[1] || LEVELS[4][1];

    // Что сделать дальше — не больше двух шагов, самые полезные первыми.
    const steps = [];
    if (f.mistakes > 0 && (f.mistakes >= 10 || know >= 0.6)) {
      steps.push({ href: "/oshibki", text: `Закрыть ${f.mistakes} ${plural(f.mistakes, "ошибку", "ошибки", "ошибок")}` });
    }
    const needKnow = Math.ceil(0.9 * f.total) - f.learned;
    if (needKnow > 0) steps.push({ href: null, text: `Выучить ещё ${needKnow} ${plural(needKnow, "вопрос", "вопроса", "вопросов")}` });
    if (!f.exams.count) steps.push({ href: "/ekzamen", text: "Попробовать экзамен" });
    else if (!ready) {
      const streakNeed = 3 - Math.min(3, f.exams.passStreak);
      if (streakNeed > 0) steps.push({ href: "/ekzamen", text: `Сдать ${streakNeed} ${plural(streakNeed, "экзамен", "экзамена", "экзаменов")} подряд` });
    }
    return { pct, level, ready, know: Math.round(know * 100), passes, examsN: recent.length, steps: steps.slice(0, 2) };
  }

  /* ---------- значки ----------
     test — получен ли; progress — 0..1, насколько близко (для «следующего»). */
  const BADGES = [
    { id: "first", icon: "star", title: "Первый шаг", desc: "Ответить на первый вопрос", p: f => f.answers },
    { id: "ticket1", icon: "flag", title: "Первый билет", desc: "Решить билет целиком", p: f => f.tickets.done },
    { id: "clean1", icon: "check", title: "Без единой ошибки", desc: "Решить билет на 20 из 20", p: f => f.tickets.perfect },
    { id: "q100", icon: "target", title: "Сотня", desc: "Ответить на 100 вопросов", p: f => f.answers / 100 },
    { id: "streak3", icon: "flame", title: "Разогрев", desc: "Огонёк 3 дня подряд", p: f => f.streak.best / 3 },
    { id: "exam1", icon: "shield", title: "Сдал!", desc: "Сдать экзамен", p: f => f.exams.passed },
    { id: "combo20", icon: "bolt", title: "Двадцать в точку", desc: "20 верных ответов подряд", p: f => f.bestCombo / 20 },
    { id: "half", icon: "road", title: "Полпути", desc: "Выучить половину вопросов", p: f => f.learned / (f.total / 2) },
    { id: "streak7", icon: "flame", title: "Неделя за рулём", desc: "Огонёк 7 дней подряд", p: f => f.streak.best / 7 },
    { id: "clean10", icon: "check", title: "Отличник", desc: "10 билетов на 20 из 20", p: f => f.tickets.perfect / 10 },
    { id: "marathon", icon: "road", title: "Марафон", desc: "100 вопросов за один день", p: f => f.maxDay / 100 },
    { id: "exam_clean", icon: "shield", title: "Чистый экзамен", desc: "Экзамен без единой ошибки", p: f => f.exams.perfect },
    { id: "exam3", icon: "shield", title: "Три из трёх", desc: "Сдать три экзамена подряд", p: f => f.exams.passStreak / 3 },
    { id: "exam_fast", icon: "bolt", title: "Скоростник", desc: "Сдать экзамен быстрее 7 минут", p: f => f.exams.fastest !== null && f.exams.fastest <= 420 ? 1 : 0 },
    { id: "fixed", icon: "check", title: "Работа над ошибками", desc: "Закрыть все ошибки после 100 ответов", p: f => f.answers >= 100 && f.correct < f.answers && f.mistakes === 0 ? 1 : 0 },
    { id: "saved", icon: "snow", title: "Спасённый огонёк", desc: "Заморозка сберегла серию", p: f => f.streak.frozen },
    { id: "night", icon: "moon", title: "Ночной водитель", desc: "Заниматься после 23:00", p: f => f.night ? 1 : 0 },
    { id: "early", icon: "sun", title: "Ранняя пташка", desc: "Заниматься до 7 утра", p: f => f.early ? 1 : 0 },
    { id: "combo50", icon: "bolt", title: "Полсотни подряд", desc: "50 верных ответов подряд", p: f => f.bestCombo / 50 },
    { id: "q1000", icon: "target", title: "Тысяча", desc: "Ответить на 1000 вопросов", p: f => f.answers / 1000 },
    { id: "all40", icon: "flag", title: "Весь сборник", desc: "Сдать все 40 билетов", p: f => f.tickets.passedEver / 40 },
    { id: "streak30", icon: "flame", title: "Месяц без пропусков", desc: "Огонёк 30 дней подряд", p: f => f.streak.best / 30 },
    { id: "all", icon: "crown", title: "Знаю всё", desc: "Все вопросы — последний ответ верный", p: f => f.learned / f.total },
    { id: "ready", icon: "crown", title: "Готов к ГАИ", desc: "Шкала готовности на «готов»", p: f => readiness(f).ready ? 1 : 0 },
    { id: "streak100", icon: "flame", title: "Сто дней", desc: "Огонёк 100 дней подряд", p: f => f.streak.best / 100 },
  ];

  function badges(f) {
    return BADGES.map(b => {
      const progress = clamp01(b.p(f));
      return { id: b.id, icon: b.icon, title: b.title, desc: b.desc, got: progress >= 1, progress };
    });
  }

  /* ---------- рубежи огонька и тюнинг машины ----------
     Детали держатся, пока горит серия: погас огонёк — машина снова «стоковая».
     Это и есть смысл: есть что терять. */
  // flame — как выглядит огонёк с этого рубежа (как в TikTok: серия растёт —
  // пламя становится больше, потом меняет цвет). Уровень пламени = номер
  // рубежа, см. flameTier(); вёрстка уровней — flameSvg() в app.js.
  const MILESTONES = [
    { at: 3, part: "stripes", name: "гоночные полосы", flame: "пламя разгорается" },
    { at: 7, part: "spoiler", name: "спойлер", flame: "двойное пламя" },
    { at: 14, part: "glow", name: "неоновая подсветка", flame: "раскалённое ядро" },
    { at: 30, part: "red", name: "красный кузов", flame: "синее пламя" },
    { at: 50, part: "fire", name: "пламя из выхлопа", flame: "сияющее синее пламя" },
    { at: 100, part: "gold", name: "золотой кузов", flame: "легендарное пламя" },
  ];

  /** Уровень огонька 0..6 — сколько рубежей взято текущей серией. */
  const flameTier = current => MILESTONES.filter(m => (current || 0) >= m.at).length;

  function milestone(current) {
    const reached = MILESTONES.filter(m => current >= m.at);
    const next = MILESTONES.find(m => current < m.at) || null;
    const prevAt = reached.length ? reached[reached.length - 1].at : 0;
    return {
      parts: reached.map(m => m.part),
      next,
      left: next ? next.at - current : 0,
      progress: next ? clamp01((current - prevAt) / (next.at - prevAt)) : 1,
      hit: MILESTONES.find(m => m.at === current) || null,
    };
  }

  /* ---------- неделя и рекорды ----------
     Неделя — скользящие 7 дней, включая сегодня, против 7 дней до них: так
     в понедельник не обнуляется всё, что было в выходные. */
  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function week(f) {
    const cur = { n: 0, ok: 0, done: 0 }, prev = { n: 0, ok: 0 };
    let best = null;
    for (let i = 0; i < 14; i++) {
      const key = addDays(f.today, -i), d = f.days[key];
      if (!d) continue;
      if (i < 7) {
        cur.n += d.n; cur.ok += d.ok; if (d.done) cur.done++;
        if (!best || d.n > best.n) best = { day: key, n: d.n };
      } else { prev.n += d.n; prev.ok += d.ok; }
    }
    return {
      n: cur.n,
      accuracy: cur.n ? Math.round(100 * cur.ok / cur.n) : null,
      doneDays: cur.done,
      bestDay: best,
      prevN: prev.n,
      delta: prev.n ? Math.round(100 * (cur.n - prev.n) / prev.n) : null,
    };
  }

  function records(f) {
    return {
      bestStreak: f.streak.best,
      bestCombo: f.bestCombo,
      maxDay: f.maxDay,
      fastestExam: f.exams.fastest,
      perfectTickets: f.tickets.perfect,
      perfectExams: f.exams.perfect,
    };
  }

  const M = { readiness, badges, BADGES, milestone, MILESTONES, flameTier, week, records };
  if (typeof module === "object" && module.exports) module.exports = M;
  else root.PddMotivation = M;
})(typeof globalThis !== "undefined" ? globalThis : this);
