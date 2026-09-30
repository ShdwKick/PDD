"use strict";
/**
 * Хранилище и вся «бизнес-логика» этапа 2: ответы, планы, огонёк, заморозки.
 * server.js только разбирает запросы и зовёт отсюда.
 *
 * Главные решения (подробнее — ARCHITECTURE.md, «Планы» и «Огонёк»):
 *
 *   - Правильность ответа решает сервер: клиент присылает id вопроса и номер
 *     выбранного варианта, правильный берётся из bank/.
 *   - День — по часовому поясу пользователя (profiles.tz), не сервера.
 *   - Норма дня фиксируется снимком (activity_days.target) при первом ответе
 *     за этот день. Смена плана поэтому не переписывает прошлое.
 *   - Огонёк и заморозки не хранятся счётчиками, а воспроизводятся по истории
 *     дней (replayStreak). Потраченная заморозка записывается в историю днём
 *     со status='frozen' — так баланс заморозок всегда выводим из истории и
 *     не может с ней разойтись.
 *   - activity_days общая для будущих привычек: habit='pdd' — первая из них.
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const motivation = require("../assets/motivation.js");

const HABIT = "pdd";
const Q_PER_TICKET = 20;
const FREEZE_EVERY = 7;     // заморозка за каждые 7 выполненных дней подряд
const FREEZE_MAX = 2;       // больше двух в запасе не копится
const MAX_TARGET = 200;     // потолок нормы «к дате экзамена» — 10 билетов в день
const OFFLINE_WINDOW = 72 * 3600 * 1000; // ответ без сети засчитываем в свой день, если он не старше 3 суток
const DEFAULT_TZ = "Europe/Moscow";

/* ---------- даты ---------- */

function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}
const dayFmt = new Map();
/** 'YYYY-MM-DD' в поясе tz. sv-SE — локаль, которая форматирует ровно так. */
function dayIn(tz, ts = Date.now()) {
  if (!dayFmt.has(tz)) dayFmt.set(tz, new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dayFmt.get(tz).format(ts);
}
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function diffDays(from, to) {
  const t = k => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(to) - t(from)) / 86400000);
}
const isDayKey = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ---------- планы ---------- */

const DEFAULT_PLAN = { kind: "daily", tickets: 1 };

/** Проверка плана с клиента. null — невалиден. */
function normalizePlan(p, today) {
  if (!p || typeof p !== "object") return null;
  if (p.kind === "daily") {
    const t = Number(p.tickets);
    return Number.isInteger(t) && t >= 1 && t <= 10 ? { kind: "daily", tickets: t } : null;
  }
  if (p.kind === "exam_date") {
    return isDayKey(p.date) && diffDays(today, p.date) >= 0 && diffDays(today, p.date) <= 730
      ? { kind: "exam_date", date: p.date } : null;
  }
  return null;
}

/** Норма на день в вопросах. «К дате экзамена» — всё, что ещё не решено
 * верно, делим на оставшиеся дни; не меньше билета в день. Прошла дата — билет. */
function targetFor(plan, learned, total, today) {
  if (plan.kind === "exam_date") {
    const daysLeft = diffDays(today, plan.date) + 1;
    if (daysLeft < 1) return Q_PER_TICKET;
    return Math.min(MAX_TARGET, Math.max(Q_PER_TICKET, Math.ceil((total - learned) / daysLeft)));
  }
  return plan.tickets * Q_PER_TICKET;
}

/* ---------- экзаменационный вердикт (то же, что verdict() в app.js) ---------- */

function verdict(questions, answers) {
  const byBlock = [0, 0, 0, 0];
  for (const q of questions) if (answers[q.num] !== q.correct) byBlock[Math.ceil(q.num / 5) - 1]++;
  const wrong = byBlock.reduce((a, b) => a + b, 0);
  return { wrong, passed: wrong <= 2 && Math.max(...byBlock) <= 1 };
}

/** Экзамен целиком, с дополнительными вопросами. items — [{correct, block,
 * extra}] (correct уже посчитан сервером по bank). Сдал, если: основных
 * ошибок не больше двух и не больше одной в блоке; на каждую ошибку отвечены
 * 5 дополнительных из того же блока без единой ошибки; время не вышло. */
function examVerdict(items, timeout) {
  const main = items.filter(i => !i.extra), extra = items.filter(i => i.extra);
  const byBlock = [0, 0, 0, 0];
  for (const i of main) if (!i.correct) byBlock[i.block - 1]++;
  const wrong = byBlock.reduce((a, b) => a + b, 0);
  const extraWrong = extra.filter(i => !i.correct).length;
  const needExtra = byBlock.filter(n => n === 1).length * 5;
  let reason = null;
  if (timeout) reason = "timeout";
  else if (Math.max(...byBlock) >= 2) reason = "block";
  else if (wrong > 2) reason = "many";
  else if (extraWrong > 0) reason = "extra";
  else if (main.length < 20 || extra.length < needExtra) reason = "unfinished";
  return { passed: !reason, reason, wrong: wrong + extraWrong };
}

/* ---------- хранилище ---------- */

module.exports = function createStore({ dataDir, bank }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "pdd.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id        TEXT PRIMARY KEY,
      tz             TEXT NOT NULL,
      plan_json      TEXT NOT NULL,
      guest_imported INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    -- Общая для будущих привычек. status: done | partial | frozen.
    CREATE TABLE IF NOT EXISTS activity_days (
      user_id  TEXT NOT NULL,
      habit    TEXT NOT NULL,
      day      TEXT NOT NULL,
      progress INTEGER NOT NULL,
      target   INTEGER NOT NULL,
      status   TEXT NOT NULL,
      PRIMARY KEY (user_id, habit, day)
    );
    -- Сырой лог. rid — id ответа с клиента: повторная отправка из очереди
    -- (ответ ушёл, а подтверждение потерялось) не засчитается дважды.
    CREATE TABLE IF NOT EXISTS answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      rid         TEXT NOT NULL,
      question_id TEXT NOT NULL,
      chosen      INTEGER NOT NULL,
      correct     INTEGER NOT NULL,
      mode        TEXT NOT NULL,
      day         TEXT NOT NULL,
      answered_at INTEGER NOT NULL,
      UNIQUE (user_id, rid)
    );
    CREATE INDEX IF NOT EXISTS idx_answers_user_day ON answers(user_id, day);
    -- Состояние вопроса у человека: для «решено верно», «ошибок» и будущего
    -- режима работы над ошибками (вопрос уходит из ошибок после 2 верных подряд).
    CREATE TABLE IF NOT EXISTS q_state (
      user_id     TEXT NOT NULL,
      question_id TEXT NOT NULL,
      n           INTEGER NOT NULL,
      ok          INTEGER NOT NULL,
      last        INTEGER NOT NULL,
      streak      INTEGER NOT NULL,
      at          INTEGER NOT NULL,
      PRIMARY KEY (user_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS exams (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  TEXT NOT NULL,
      at       INTEGER NOT NULL,
      passed   INTEGER NOT NULL,
      reason   TEXT,
      wrong    INTEGER NOT NULL,
      total    INTEGER NOT NULL,
      seconds  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exams_user ON exams(user_id, at);
    CREATE TABLE IF NOT EXISTS ticket_results (
      user_id     TEXT NOT NULL,
      ticket      INTEGER NOT NULL,
      best        INTEGER NOT NULL,
      last        INTEGER NOT NULL,
      passed      INTEGER NOT NULL,
      ever_passed INTEGER NOT NULL,
      runs        INTEGER NOT NULL,
      at          INTEGER NOT NULL,
      PRIMARY KEY (user_id, ticket)
    );
    -- «Подтолкнуть» — не чаще раза в день на пару (день — по поясу того, кто толкает).
    CREATE TABLE IF NOT EXISTS nudges (
      from_id TEXT NOT NULL,
      to_id   TEXT NOT NULL,
      day     TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, day)
    );
    -- Подписки Web Push: одно устройство/браузер — одна строка (endpoint уникален).
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
    -- Вечернее напоминание «огонёк гаснет» — одно в день (день — по поясу адресата).
    CREATE TABLE IF NOT EXISTS reminders (
      user_id TEXT NOT NULL,
      day     TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    );
  `);
  // Миграция: время напоминания появилось на этапе 4. NULL — выключено.
  if (!db.prepare("PRAGMA table_info(profiles)").all().some(c => c.name === "remind_at")) {
    db.exec("ALTER TABLE profiles ADD COLUMN remind_at TEXT DEFAULT '20:00'");
  }

  const byId = new Map(bank.map(q => [q.id, q]));
  const TOTAL = byId.size; // уникальных вопросов: шесть есть в двух билетах сразу
  const byTicket = new Map();
  for (const q of bank) {
    if (!byTicket.has(q.ticket)) byTicket.set(q.ticket, []);
    byTicket.get(q.ticket).push(q);
  }

  const st = {
    profile: db.prepare("SELECT * FROM profiles WHERE user_id = ?"),
    profileIns: db.prepare("INSERT OR IGNORE INTO profiles (user_id, tz, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
    profileTz: db.prepare("UPDATE profiles SET tz = ?, updated_at = ? WHERE user_id = ?"),
    profilePlan: db.prepare("UPDATE profiles SET plan_json = ?, updated_at = ? WHERE user_id = ?"),
    profileImported: db.prepare("UPDATE profiles SET guest_imported = 1, updated_at = ? WHERE user_id = ?"),
    days: db.prepare("SELECT day, progress, target, status FROM activity_days WHERE user_id = ? AND habit = ? ORDER BY day"),
    day: db.prepare("SELECT progress, target, status FROM activity_days WHERE user_id = ? AND habit = ? AND day = ?"),
    dayIns: db.prepare("INSERT INTO activity_days (user_id, habit, day, progress, target, status) VALUES (?, ?, ?, ?, ?, ?)"),
    dayUpd: db.prepare("UPDATE activity_days SET progress = ?, target = ?, status = ? WHERE user_id = ? AND habit = ? AND day = ?"),
    dayFreeze: db.prepare(`INSERT INTO activity_days (user_id, habit, day, progress, target, status) VALUES (?, ?, ?, 0, 0, 'frozen')
      ON CONFLICT(user_id, habit, day) DO UPDATE SET status = 'frozen'`),
    answerIns: db.prepare("INSERT OR IGNORE INTO answers (user_id, rid, question_id, chosen, correct, mode, day, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    q: db.prepare("SELECT * FROM q_state WHERE user_id = ? AND question_id = ?"),
    qUpsert: db.prepare(`INSERT INTO q_state (user_id, question_id, n, ok, last, streak, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, question_id) DO UPDATE SET n = excluded.n, ok = excluded.ok, last = excluded.last, streak = excluded.streak, at = excluded.at`),
    qInsIgnore: db.prepare("INSERT OR IGNORE INTO q_state (user_id, question_id, n, ok, last, streak, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    // Ошибка — вопрос, где хоть раз ошибся и ещё не ответил верно дважды
    // подряд (ARCHITECTURE.md, «Режимы»). Выучен — последний ответ верный.
    qCounts: db.prepare("SELECT SUM(last = 1) AS learned, SUM(n > ok AND streak < 2) AS mistakes FROM q_state WHERE user_id = ?"),
    qLists: db.prepare("SELECT question_id, last, n > ok AND streak < 2 AS mistake FROM q_state WHERE user_id = ?"),
    examIns: db.prepare("INSERT INTO exams (user_id, at, passed, reason, wrong, total, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    examLast: db.prepare("SELECT at, passed, reason, wrong FROM exams WHERE user_id = ? ORDER BY at DESC LIMIT 1"),
    examCount: db.prepare("SELECT COUNT(*) AS n, SUM(passed) AS ok FROM exams WHERE user_id = ?"),
    tickets: db.prepare("SELECT ticket, best, last, passed, ever_passed, runs, at FROM ticket_results WHERE user_id = ?"),
    ticket: db.prepare("SELECT * FROM ticket_results WHERE user_id = ? AND ticket = ?"),
    ticketUpsert: db.prepare(`INSERT INTO ticket_results (user_id, ticket, best, last, passed, ever_passed, runs, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, ticket) DO UPDATE SET best = excluded.best, last = excluded.last, passed = excluded.passed,
        ever_passed = excluded.ever_passed, runs = excluded.runs, at = excluded.at`),
    profileRemind: db.prepare("UPDATE profiles SET remind_at = ?, updated_at = ? WHERE user_id = ?"),
    profilesRemind: db.prepare("SELECT user_id, tz, plan_json, remind_at FROM profiles WHERE remind_at IS NOT NULL"),
    reminderIns: db.prepare("INSERT OR IGNORE INTO reminders (user_id, day) VALUES (?, ?)"),
    nudgeIns: db.prepare("INSERT OR IGNORE INTO nudges (from_id, to_id, day, at) VALUES (?, ?, ?, ?)"),
    nudgesFrom: db.prepare("SELECT to_id FROM nudges WHERE from_id = ? AND day = ?"),
    lastAnswer: db.prepare("SELECT MAX(answered_at) AS at FROM answers WHERE user_id = ?"),
    // Подписка переезжает к тому, кто вошёл на устройстве последним: один
    // браузер — одна подписка, а человек мог выйти и войти другим аккаунтом.
    subUpsert: db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    subDel: db.prepare("DELETE FROM push_subs WHERE endpoint = ?"),
    subDelOwn: db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?"),
    subsFor: db.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?"),
    // Факты для мотивации (assets/motivation.js) — см. facts().
    fQ: db.prepare("SELECT COUNT(*) AS seen, SUM(n) AS answers, SUM(ok) AS correct FROM q_state WHERE user_id = ?"),
    fTickets: db.prepare("SELECT COUNT(*) AS done, SUM(ever_passed) AS passed_ever, SUM(best = 20) AS perfect FROM ticket_results WHERE user_id = ?"),
    fExams: db.prepare("SELECT passed, wrong, seconds FROM exams WHERE user_id = ? ORDER BY at, id"),
    fDaysFrom: db.prepare("SELECT day, progress, target, status FROM activity_days WHERE user_id = ? AND habit = ? AND day >= ?"),
    fDayOk: db.prepare("SELECT day, SUM(correct) AS ok FROM answers WHERE user_id = ? AND day >= ? GROUP BY day"),
    fMaxDay: db.prepare("SELECT MAX(progress) AS m, SUM(status = 'frozen') AS frozen FROM activity_days WHERE user_id = ? AND habit = ?"),
    fAnswers: db.prepare("SELECT correct, answered_at FROM answers WHERE user_id = ? ORDER BY answered_at, id"),
    fWeek: db.prepare("SELECT SUM(progress) AS n FROM activity_days WHERE user_id = ? AND habit = ? AND day >= ?"),
  };

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  function profile(userId) {
    let p = st.profile.get(userId);
    if (!p) {
      const now = Date.now();
      st.profileIns.run(userId, DEFAULT_TZ, JSON.stringify(DEFAULT_PLAN), now, now);
      p = st.profile.get(userId);
    }
    return { tz: p.tz, plan: JSON.parse(p.plan_json), guestImported: !!p.guest_imported, remindAt: p.remind_at ?? null };
  }

  function counts(userId) {
    const r = st.qCounts.get(userId);
    return { learned: Number(r.learned) || 0, mistakes: Number(r.mistakes) || 0 };
  }

  /** Огонёк по истории дней. Попутно тратит заморозки на пропущенные дни и
   * записывает их — это единственное место, где заморозка «списывается». */
  function replayStreak(userId, tz, plan) {
    const today = dayIn(tz);
    const rows = st.days.all(userId, HABIT);
    const map = new Map(rows.map(r => [r.day, r]));
    const done = r => !!r && r.target > 0 && r.progress >= r.target;

    let run = 0, best = 0, freezes = 0;
    if (rows.length) {
      for (let d = rows[0].day; d < today; d = addDays(d, 1)) {
        const r = map.get(d);
        if (done(r)) {
          run++; best = Math.max(best, run);
          if (run % FREEZE_EVERY === 0) freezes = Math.min(FREEZE_MAX, freezes + 1);
        } else if (r && r.status === "frozen") {
          if (freezes > 0) freezes--; // была потрачена тогда же — повторяем списание
        } else if (run > 0 && freezes > 0) {
          freezes--;
          st.dayFreeze.run(userId, HABIT, d);
        } else {
          run = 0;
        }
      }
    }
    const t = map.get(today);
    const todayDone = done(t);
    if (todayDone) {
      run++; best = Math.max(best, run);
      if (run % FREEZE_EVERY === 0) freezes = Math.min(FREEZE_MAX, freezes + 1);
    }
    const { learned } = counts(userId);
    return {
      current: run,
      best,
      freezes,
      // Сколько ещё выполненных дней до следующей заморозки (null — запас полный).
      nextFreezeIn: freezes >= FREEZE_MAX ? null : FREEZE_EVERY - (run % FREEZE_EVERY),
      todayCount: t ? t.progress : 0,
      target: t && t.target > 0 ? t.target : targetFor(plan, learned, TOTAL, today),
      todayDone,
      today,
    };
  }

  /** Факты для мотивации — та же форма, что guestFacts() в progress.js.
   * Серия, рекорд и выученное считаются тут же, по базе; лучшая серия верных
   * ответов подряд и «ночной/ранний» — одним проходом по логу ответов. */
  const hourFmt = new Map();
  function facts(userId, tz, streak) {
    const today = dayIn(tz);
    const from = addDays(today, -13);
    const q = st.fQ.get(userId), t = st.fTickets.get(userId), c = counts(userId);

    const ex = st.fExams.all(userId);
    let passStreak = 0;
    for (let i = ex.length - 1; i >= 0 && ex[i].passed; i--) passStreak++;
    const passedSecs = ex.filter(e => e.passed && e.seconds > 0).map(e => e.seconds);

    const days = {};
    for (const r of st.fDaysFrom.all(userId, HABIT, from)) {
      days[r.day] = { n: r.progress, ok: 0, done: r.target > 0 && r.progress >= r.target };
    }
    for (const r of st.fDayOk.all(userId, from)) if (days[r.day]) days[r.day].ok = Number(r.ok) || 0;

    if (!hourFmt.has(tz)) hourFmt.set(tz, new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }));
    const hf = hourFmt.get(tz);
    let combo = 0, bestCombo = 0, night = false, early = false;
    for (const a of st.fAnswers.iterate(userId)) {
      combo = a.correct ? combo + 1 : 0;
      if (combo > bestCombo) bestCombo = combo;
      if (!night || !early) {
        const h = Number(hf.format(a.answered_at));
        if (h >= 23 || h < 5) night = true;
        else if (h < 7) early = true;
      }
    }
    const md = st.fMaxDay.get(userId, HABIT);
    return {
      total: TOTAL, learned: c.learned, mistakes: c.mistakes,
      seen: Number(q.seen) || 0, answers: Number(q.answers) || 0, correct: Number(q.correct) || 0,
      tickets: { done: Number(t.done) || 0, passedEver: Number(t.passed_ever) || 0, perfect: Number(t.perfect) || 0 },
      exams: {
        count: ex.length,
        passed: ex.filter(e => e.passed).length,
        perfect: ex.filter(e => e.passed && e.wrong === 0).length,
        fastest: passedSecs.length ? Math.min(...passedSecs) : null,
        passStreak,
        recent: ex.slice(-10).map(e => ({ passed: !!e.passed })),
      },
      streak: { current: streak.current, best: streak.best, frozen: Number(md.frozen) || 0 },
      days, today,
      bestCombo, maxDay: Number(md.m) || 0, night, early,
    };
  }

  function summary(userId) {
    const tickets = {};
    let passedTickets = 0;
    for (const r of st.tickets.all(userId)) {
      tickets[r.ticket] = { best: r.best, last: r.last, passed: !!r.passed, everPassed: !!r.ever_passed, runs: r.runs, at: r.at };
      if (r.passed) passedTickets++;
    }
    const last = st.examLast.get(userId);
    const ex = st.examCount.get(userId);
    const exams = { count: Number(ex.n) || 0, passed: Number(ex.ok) || 0, last: last ? { at: last.at, passed: !!last.passed, reason: last.reason, wrong: last.wrong } : null };
    return { ...counts(userId), total: TOTAL, tickets, passedTickets, exams };
  }

  return {
    TOTAL,
    validTz,
    today: tz => dayIn(tz),

    /** Подписка Web Push с этого устройства. endpoint — адрес push-сервиса
     * браузера (только https), keys — ключи шифрования подписки. */
    addPushSub(userId, sub) {
      const ok = sub && typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://") && sub.endpoint.length < 1000
        && typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string";
      if (!ok) return false;
      st.subUpsert.run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now());
      return true;
    },
    removePushSub(userId, endpoint) { st.subDelOwn.run(String(endpoint || ""), userId); },
    dropPushSub(endpoint) { st.subDel.run(endpoint); },
    pushSubs(userId) {
      return st.subsFor.all(userId).map(r => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
    },

    /** Настройки: время вечернего напоминания 'HH:MM' или null — выключено. */
    setRemind(userId, remindAt) {
      const v = remindAt === null ? null : /^([01]\d|2[0-3]):[0-5]\d$/.test(remindAt) ? remindAt : undefined;
      if (v === undefined) return null;
      return tx(() => { profile(userId); st.profileRemind.run(v, Date.now(), userId); return { remindAt: v }; });
    },

    /** Лента друзей: для каждого user_id — огонёк и прогресс, или null, если
     * он ещё не открывал сервис. Конкретные ответы и ошибки не отдаём. */
    friendsFeed(viewerId, friendIds) {
      return tx(() => {
        const me = profile(viewerId);
        const nudged = new Set(st.nudgesFrom.all(viewerId, dayIn(me.tz)).map(r => r.to_id));
        const out = {};
        for (const id of friendIds) {
          const row = st.profile.get(id);
          if (!row) { out[id] = { started: false, nudgedToday: nudged.has(id) }; continue; }
          const plan = JSON.parse(row.plan_json);
          const s = replayStreak(id, row.tz, plan);
          const sum = summary(id);
          out[id] = {
            started: true,
            nudgedToday: nudged.has(id),
            streak: { current: s.current, best: s.best, todayDone: s.todayDone, todayCount: s.todayCount, target: s.target },
            learned: sum.learned, total: TOTAL, passedTickets: sum.passedTickets,
            lastExam: sum.exams.last ? { passed: sum.exams.last.passed, at: sum.exams.last.at } : null,
            lastActive: st.lastAnswer.get(id)?.at || null,
            // Для сравнения недели и значков друга — без самих ответов.
            week: Number(st.fWeek.get(id, HABIT, addDays(dayIn(row.tz), -6)).n) || 0,
            badges: motivation.badges(facts(id, row.tz, s)).filter(b => b.got).length,
          };
        }
        return out;
      });
    },

    /** Можно ли толкнуть: да — запись сделана (раз в день на пару); нет —
     * уже толкал сегодня. Проверка дружбы — в server.js, по списку из Auth. */
    recordNudge(fromId, toId) {
      return tx(() => {
        const p = profile(fromId);
        return st.nudgeIns.run(fromId, toId, dayIn(p.tz), Date.now()).changes > 0;
      });
    },

    /** Кому пора напомнить «огонёк гаснет»: местное время дошло до remind_at,
     * серия есть, норма сегодня не выполнена, сегодня ещё не напоминали.
     * Попутно отмечает «напомнили» — повторный вызов их не вернёт. */
    dueReminders(now = Date.now()) {
      return tx(() => {
        const due = [];
        for (const r of st.profilesRemind.all()) {
          const hm = new Intl.DateTimeFormat("en-GB", { timeZone: r.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
          if (hm < r.remind_at) continue;
          const s = replayStreak(r.user_id, r.tz, JSON.parse(r.plan_json));
          if (s.current === 0 || s.todayDone) continue;
          if (st.reminderIns.run(r.user_id, dayIn(r.tz, now)).changes === 0) continue;
          due.push({ userId: r.user_id, streak: s.current, left: Math.max(0, s.target - s.todayCount) });
        }
        return due;
      });
    },

    /** Какие вопросы выучены и какие в ошибках — для режима «ошибки» и
     * прогресса по темам (сами вопросы клиент берёт из /api/questions). */
    qState(userId) {
      const learned = [], mistakes = [];
      for (const r of st.qLists.all(userId)) {
        if (!byId.has(r.question_id)) continue; // вопрос ушёл из базы при обновлении
        if (r.last) learned.push(r.question_id);
        if (r.mistake) mistakes.push(r.question_id);
      }
      return { learned, mistakes };
    },

    /** Экзамен закончен. Итог считает сервер по ответам: items —
     * [{questionId, chosen, block, extra}]. Ответы в огонёк уже засчитаны
     * по одному через answer(), здесь только результат экзамена. */
    finishExam(userId, rawItems, seconds, timeout) {
      if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 40) return null;
      const items = [];
      for (const it of rawItems) {
        const q = byId.get(it?.questionId);
        const block = Number(it?.block);
        if (!q || !Number.isInteger(it.chosen) || !(block >= 1 && block <= 4)) return null;
        items.push({ correct: it.chosen === q.correct, block, extra: !!it.extra });
      }
      const v = examVerdict(items, !!timeout);
      return tx(() => {
        st.examIns.run(userId, Date.now(), v.passed ? 1 : 0, v.reason, v.wrong, items.length, Math.max(0, Math.min(3600, seconds | 0)));
        const p = profile(userId);
        return { ...v, summary: summary(userId), facts: facts(userId, p.tz, replayStreak(userId, p.tz, p.plan)) };
      });
    },

    /** Всё для экрана: профиль, огонёк, сводка. tz с клиента обновляет профиль. */
    me(userId, tz) {
      return tx(() => {
        const p = profile(userId);
        const t = validTz(tz);
        if (t && t !== p.tz) { st.profileTz.run(t, Date.now(), userId); p.tz = t; }
        const streak = replayStreak(userId, p.tz, p.plan);
        return { plan: p.plan, tz: p.tz, guestImported: p.guestImported, remindAt: p.remindAt, streak, summary: summary(userId), facts: facts(userId, p.tz, streak) };
      });
    },

    setPlan(userId, rawPlan) {
      return tx(() => {
        const p = profile(userId);
        const today = dayIn(p.tz);
        const plan = normalizePlan(rawPlan, today);
        if (!plan) return null;
        st.profilePlan.run(JSON.stringify(plan), Date.now(), userId);
        // С сегодняшнего дня: норма сегодняшнего дня пересчитывается, если он
        // ещё не выполнен. Выполненный не трогаем — зажжённый огонёк не гасим.
        const row = st.day.get(userId, HABIT, today);
        if (row && row.status !== "done") {
          const target = targetFor(plan, counts(userId).learned, TOTAL, today);
          st.dayUpd.run(row.progress, target, row.progress >= target ? "done" : "partial", userId, HABIT, today);
        }
        return { plan, streak: replayStreak(userId, p.tz, plan) };
      });
    },

    /** Ответ. null — неизвестный вопрос или вариант. */
    answer(userId, { questionId, chosen, mode, rid, at, tz }) {
      const q = byId.get(questionId);
      if (!q || !Number.isInteger(chosen) || chosen < 0 || chosen >= q.answers.length) return null;
      if (typeof rid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(rid)) return null;
      const now = Date.now();
      const ts = Number.isFinite(at) && at <= now && at >= now - OFFLINE_WINDOW ? at : now;
      const correct = chosen === q.correct;

      return tx(() => {
        const p = profile(userId);
        const t = validTz(tz);
        if (t && t !== p.tz) { st.profileTz.run(t, now, userId); p.tz = t; }
        const day = dayIn(p.tz, ts);
        const today = dayIn(p.tz, now);

        const ins = st.answerIns.run(userId, rid, q.id, chosen, correct ? 1 : 0, mode, day, ts);
        if (ins.changes === 0) {
          // Повтор из очереди — уже засчитан, просто отдаём текущее состояние.
          return { correct, correctIndex: q.correct, lit: false, duplicate: true, streak: replayStreak(userId, p.tz, p.plan), summary: summary(userId) };
        }

        const s = st.q.get(userId, q.id) || { n: 0, ok: 0, last: 0, streak: 0 };
        st.qUpsert.run(userId, q.id, s.n + 1, s.ok + (correct ? 1 : 0), correct ? 1 : 0, correct ? s.streak + 1 : 0, ts);

        const row = st.day.get(userId, HABIT, day);
        let lit = false;
        if (row) {
          const progress = row.progress + 1;
          const target = row.target > 0 ? row.target : targetFor(p.plan, counts(userId).learned, TOTAL, day);
          const done = progress >= target;
          lit = done && row.progress < target && day === today;
          st.dayUpd.run(progress, target, done ? "done" : row.status === "frozen" && !done ? "frozen" : "partial", userId, HABIT, day);
        } else {
          // Снимок нормы — по плану на момент первого ответа за день.
          const target = targetFor(p.plan, counts(userId).learned, TOTAL, day);
          const done = 1 >= target;
          lit = done && day === today;
          st.dayIns.run(userId, HABIT, day, 1, target, done ? "done" : "partial");
        }
        return { correct, correctIndex: q.correct, lit, streak: replayStreak(userId, p.tz, p.plan), summary: summary(userId) };
      });
    },

    /** Билет решён целиком. Итог считает сервер по ответам, не по числу с клиента. */
    finishTicket(userId, ticket, answers) {
      const questions = byTicket.get(ticket);
      if (!questions || !answers || typeof answers !== "object") return null;
      const clean = {};
      for (const q of questions) {
        const a = answers[q.num];
        if (!Number.isInteger(a) || a < 0 || a >= q.answers.length) return null; // билет должен быть решён целиком
        clean[q.num] = a;
      }
      const v = verdict(questions, clean);
      const correct = questions.length - v.wrong;
      return tx(() => {
        const prev = st.ticket.get(userId, ticket);
        st.ticketUpsert.run(userId, ticket, Math.max(prev?.best ?? 0, correct), correct, v.passed ? 1 : 0,
          (prev?.ever_passed || v.passed) ? 1 : 0, (prev?.runs || 0) + 1, Date.now());
        const p = profile(userId);
        return { correct, passed: v.passed, summary: summary(userId), facts: facts(userId, p.tz, replayStreak(userId, p.tz, p.plan)) };
      });
    },

    /** Перенос гостевого прогресса — один раз на аккаунт, чтобы нельзя было
     * «дозалить» себе дни задним числом. Вопросы и билеты — только то, чего на
     * сервере ещё нет; дни — только прошлые и сегодняшний, с разумным потолком. */
    importGuest(userId, data, guestTarget) {
      return tx(() => {
        const p = profile(userId);
        if (p.guestImported) return { imported: false, reason: "already" };
        const today = dayIn(p.tz);
        let qn = 0, tn = 0, dn = 0;
        for (const [id, s] of Object.entries(data?.q || {})) {
          if (!byId.has(id) || !s) continue;
          const n = Math.min(1000, Math.max(0, s.n | 0)), ok = Math.min(n, Math.max(0, s.ok | 0));
          if (!n) continue;
          st.qInsIgnore.run(userId, id, n, ok, s.last ? 1 : 0, Math.min(n, Math.max(0, s.streak | 0)), Number(s.at) || Date.now());
          qn++;
        }
        for (const [k, t] of Object.entries(data?.t || {})) {
          const ticket = Number(k);
          if (!byTicket.has(ticket) || !t || st.ticket.get(userId, ticket)) continue;
          const last = Math.min(20, Math.max(0, t.last | 0)), best = Math.min(20, Math.max(last, t.best | 0));
          st.ticketUpsert.run(userId, ticket, best, last, t.passed ? 1 : 0, t.everPassed || t.passed ? 1 : 0, Math.max(1, t.runs | 0), Number(t.at) || Date.now());
          tn++;
        }
        const target = Math.max(1, Math.min(MAX_TARGET, guestTarget | 0 || Q_PER_TICKET));
        for (const [day, raw] of Object.entries(data?.days || {})) {
          if (!isDayKey(day) || day > today || diffDays(day, today) > 730) continue;
          const n = Math.min(400, Math.max(0, raw | 0));
          if (!n || st.day.get(userId, HABIT, day)) continue;
          st.dayIns.run(userId, HABIT, day, n, target, n >= target ? "done" : "partial");
          dn++;
        }
        st.profileImported.run(Date.now(), userId);
        return { imported: true, questions: qn, tickets: tn, days: dn };
      });
    },
  };
};

module.exports.internals = { dayIn, addDays, diffDays, targetFor, normalizePlan, verdict, examVerdict };
