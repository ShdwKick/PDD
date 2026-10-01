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

  /* ---------- рубежи огонька и гараж ----------
     Рубеж (3/7/14/30/50/100 дней текущей серии) меняет огонёк — он держится,
     пока горит серия, — и открывает в гараже детали и цвета. Открытое в
     гараже остаётся навсегда (по лучшей серии), а что надеть на машину,
     выбирает сам человек: цвет кузова сам не меняется. */
  // flame — как выглядит огонёк с этого рубежа (как в TikTok: серия растёт —
  // пламя становится больше, потом меняет цвет). Уровень пламени = номер
  // рубежа, см. flameTier(); вёрстка уровней — flameSvg() в app.js.
  const MILESTONES = [
    { at: 3, flame: "пламя разгорается" },
    { at: 7, flame: "двойное пламя" },
    { at: 14, flame: "раскалённое ядро" },
    { at: 30, flame: "синее пламя" },
    { at: 50, flame: "сияющее синее пламя" },
    { at: 100, flame: "легендарное пламя" },
  ];

  /* Гараж: категории и варианты. at — с какой лучшей серии открывается;
     первый вариант каждой категории — «как с завода». Цвета — в styles.css
     (классы car-<категория>-<вариант>). */
  const CAR = [
    { id: "paint", name: "Кузов", items: [
      { id: "blue", name: "Синий", at: 0 },
      { id: "white", name: "Белый", full: "белый кузов", at: 3 },
      { id: "black", name: "Чёрный", full: "чёрный кузов", at: 7 },
      { id: "green", name: "Изумрудный", full: "изумрудный кузов", at: 14 },
      { id: "red", name: "Красный", full: "красный кузов", at: 30 },
      { id: "silver", name: "Серебро", full: "серебристый кузов", at: 50 },
      { id: "gold", name: "Золото", full: "золотой кузов", at: 100 },
    ] },
    { id: "stripes", name: "Полосы", items: [
      { id: "none", name: "Без полос", at: 0 },
      { id: "white", name: "Белые", full: "гоночные полосы", at: 3 },
      { id: "black", name: "Чёрные", full: "чёрные полосы", at: 7 },
      { id: "red", name: "Красные", full: "красные полосы", at: 30 },
      { id: "gold", name: "Золотые", full: "золотые полосы", at: 100 },
    ] },
    { id: "spoiler", name: "Спойлер", items: [
      { id: "none", name: "Без спойлера", at: 0 },
      { id: "on", name: "Спойлер", full: "спойлер", at: 7 },
    ] },
    { id: "glow", name: "Подсветка", items: [
      { id: "none", name: "Без подсветки", at: 0 },
      { id: "blue", name: "Синяя", full: "синяя подсветка", at: 14 },
      { id: "red", name: "Красная", full: "красная подсветка", at: 30 },
      { id: "purple", name: "Фиолетовая", full: "фиолетовая подсветка", at: 50 },
    ] },
    { id: "exhaust", name: "Выхлоп", items: [
      { id: "none", name: "Обычный", at: 0 },
      { id: "fire", name: "Пламя", full: "пламя из выхлопа", at: 50 },
    ] },
  ];

  /* Свой текст на номерном знаке, как в Forza: открывается с 3 дней, до 8
     символов — буквы (русские и латинские), цифры, пробел, дефис. Хранится
     рядом с выбором машины (plate), пустая строка — чистый номер. */
  const PLATE_AT = 3, PLATE_MAX = 8;
  function normalizePlate(raw) {
    if (typeof raw !== "string") return null;
    const t = raw.toUpperCase().replace(/\s+/g, " ").trim();
    return t.length <= PLATE_MAX && /^[A-ZА-ЯЁ0-9 -]*$/.test(t) ? t : null;
  }

  /** Что открывает рубеж — для праздника и строки «следующий рубеж». */
  function unlocksAt(at) {
    const out = [];
    for (const c of CAR) for (const it of c.items) if (it.at === at) out.push(it.full);
    if (at === PLATE_AT) out.push("свой номер");
    return out;
  }

  /** Итоговая машина: выбранное, если открыто; иначе — по умолчанию.
   * По умолчанию кузов — синий, а детали — первая открытая (как было раньше:
   * взял рубеж — деталь появилась). Цвет сам не меняется никогда. */
  function carConfig(saved, best) {
    const cfg = {};
    for (const c of CAR) {
      const open = c.items.filter(it => (best || 0) >= it.at);
      const want = saved && open.find(it => it.id === saved[c.id]);
      cfg[c.id] = want ? want.id : c.id === "paint" ? "blue" : (open[1] || open[0]).id;
    }
    cfg.plate = (best || 0) >= PLATE_AT && saved ? normalizePlate(saved.plate) || "" : "";
    return cfg;
  }

  /** Проверка выбора с клиента: только известные категории и открытые варианты. */
  function validCar(raw, best) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const c of CAR) {
      if (!(c.id in raw)) continue;
      const it = c.items.find(x => x.id === raw[c.id]);
      if (!it || (best || 0) < it.at) return null;
      out[c.id] = it.id;
    }
    if ("plate" in raw) {
      const t = normalizePlate(raw.plate);
      if (t === null || (best || 0) < PLATE_AT) return null;
      out.plate = t;
    }
    return Object.keys(out).length ? out : null;
  }

  /** Уровень огонька 0..6 — сколько рубежей взято текущей серией. */
  const flameTier = current => MILESTONES.filter(m => (current || 0) >= m.at).length;

  function milestone(current) {
    const reached = MILESTONES.filter(m => current >= m.at);
    const next = MILESTONES.find(m => current < m.at) || null;
    const prevAt = reached.length ? reached[reached.length - 1].at : 0;
    return {
      next,
      left: next ? next.at - current : 0,
      progress: next ? clamp01((current - prevAt) / (next.at - prevAt)) : 1,
      hit: MILESTONES.find(m => m.at === current) || null,
    };
  }

  /* ---------- неделя и рекорды ----------
     Неделя — календарная, с понедельника по сегодня. Сравнение — с тем же
     отрезком прошлой недели (пн–чт против пн–чт): иначе в начале недели она
     всегда выглядела бы хуже полной прошлой. 14 дней фактов на это хватает. */
  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  /** Понедельник недели, в которую входит день key ('YYYY-MM-DD'). */
  function weekStart(key) {
    const wd = (new Date(key + "T00:00:00Z").getUTCDay() + 6) % 7; // 0 — понедельник
    return addDays(key, -wd);
  }

  function week(f) {
    const mon = weekStart(f.today);
    const span = Math.round((Date.parse(f.today) - Date.parse(mon)) / 86400000); // 0 в понедельник
    const cur = { n: 0, ok: 0, done: 0 }, prev = { n: 0, ok: 0 };
    let best = null;
    for (let i = 0; i <= span; i++) {
      const d = f.days[addDays(mon, i)];
      if (d) {
        cur.n += d.n; cur.ok += d.ok; if (d.done) cur.done++;
        if (!best || d.n > best.n) best = { day: addDays(mon, i), n: d.n };
      }
      const p = f.days[addDays(mon, i - 7)];
      if (p) { prev.n += p.n; prev.ok += p.ok; }
    }
    return {
      monday: mon,
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

  const M = { readiness, badges, BADGES, milestone, MILESTONES, flameTier, CAR, carConfig, validCar, unlocksAt, PLATE_AT, PLATE_MAX, normalizePlate, week, weekStart, addDays, records };
  if (typeof module === "object" && module.exports) module.exports = M;
  else root.PddMotivation = M;
})(typeof globalThis !== "undefined" ? globalThis : this);
