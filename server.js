#!/usr/bin/env node
"use strict";
/**
 * «Когда на права?» — тренажёр билетов ПДД (категория A/B), pdd.burninghouse.ru.
 * План целиком — ARCHITECTURE.md.
 *
 * Сервер отдаёт index.html на все маршруты клиентского роутера (History API:
 * /bilet/7, /plan), статику из assets/, билеты по одному (/api/tickets/N) и
 * API вошедшего пользователя: ответы, план, огонёк (/api/me, /api/answers...).
 * Логика ответов, планов и огонька — в lib/store.js, здесь только разбор
 * запросов.
 *
 * Вход необязателен, как у Brain: гость решает всё то же, прогресс у него в
 * localStorage (assets/progress.js). Если auth-client не поднялся, /api/config
 * отдаёт authBase: null и фронт просто не предлагает войти.
 *
 * Билеты лежат в bank/ — это результат tools/import.mjs, часть образа, а не
 * данные. Данные — data/pdd.db (в контейнере volume).
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 8798;
const ROOT = __dirname;
const SITE_URL = "https://pdd.burninghouse.ru";
const SERVICE_NAME = "Когда на права?";

// Пояснения к ответам в датасете написаны не нами и без лицензии (см.
// ARCHITECTURE.md, «База билетов»). Свои, переписанные, лежат в
// bank/tips-own.json и всегда важнее датасетных. SHOW_TIPS=0 прячет только
// датасетные — свои остаются.
const SHOW_TIPS = process.env.SHOW_TIPS !== "0";
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");

// ---------- билеты ----------

const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "ab.json"), "utf8"));
const META = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "meta.json"), "utf8"));
const TICKET_COUNT = META.tickets;

// Готовые тела ответов: билеты не меняются, пока жив процесс, — сериализуем
// один раз на старте, а не на каждый запрос.
// Свои пояснения: { id: { tip, ref } } — отдельным файлом, чтобы квартальный
// импорт датасета (tools/import.mjs) их не затирал.
const OWN_TIPS = fs.existsSync(path.join(ROOT, "bank", "tips-own.json"))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "tips-own.json"), "utf8")) : {};
const pub = q => {
  const own = OWN_TIPS[q.id];
  return {
    id: q.id, ticket: q.ticket, num: q.num, text: q.text, image: q.image, answers: q.answers, correct: q.correct,
    tip: own ? own.tip : SHOW_TIPS ? q.tip : null,
    ref: own ? own.ref : SHOW_TIPS ? q.ref : null,
    topics: q.topics,
  };
};
const TICKET_BODIES = new Map();
for (let n = 1; n <= TICKET_COUNT; n++) {
  const questions = BANK.filter(q => q.ticket === n).sort((a, b) => a.num - b.num).map(pub);
  TICKET_BODIES.set(n, JSON.stringify({ ticket: n, questions }));
}

// Вопрос по id — первое вхождение (шесть вопросов есть в двух билетах).
const BY_ID = new Map();
for (const q of BANK) if (!BY_ID.has(q.id)) BY_ID.set(q.id, q);

// Темы: индекс в META.topics — он же номер в адресе (/tema/3). Вопрос бывает
// в нескольких темах сразу. ids — чтобы клиент сам считал прогресс по теме.
const TOPICS = META.topics.map((name, i) => ({ i, name, ids: [...BY_ID.values()].filter(q => q.topics.includes(name)).map(q => q.id) }));
const TOPICS_BODY = JSON.stringify({ topics: TOPICS.map(t => ({ i: t.i, name: t.name, count: t.ids.length, ids: t.ids })) });

// ---------- вход и хранилище ----------

// auth-client.js — копия Auth/client/auth-client.js (см. Auth/INTEGRATION.md):
// подпись access-токена проверяется локально, в auth на каждый запрос не ходим.
const AUTH_ISSUER = (process.env.AUTH_ISSUER || "https://auth.burninghouse.ru").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "pdd";
let auth = null;
try {
  auth = require("./auth-client")({ issuer: AUTH_ISSUER, audience: AUTH_CLIENT_ID, jwksUrl: process.env.AUTH_JWKS_URL });
  auth.warmup();
} catch (e) {
  console.error("auth-client не поднялся — вход будет недоступен:", e.message);
}

const store = require("./lib/store")({ dataDir: DATA_DIR, bank: BANK });
const { createWebPush } = require("./lib/webpush");

// ---------- друзья и уведомления (через Auth) ----------

// Куда ведут ссылки в уведомлениях. Локально (dev.mjs) — http://localhost:8798.
const PUBLIC_URL = (process.env.PUBLIC_URL || SITE_URL).replace(/\/+$/, "");
// Для server-to-server вызовов Auth (/internal/*) — может отличаться от
// публичного ISSUER (в Docker — имя сервиса). Ключ — тот же ADMIN_INTERNAL_KEY,
// что у Admin: без него вечерние напоминания просто выключены.
const AUTH_INTERNAL_URL = (process.env.AUTH_INTERNAL_URL || AUTH_ISSUER).replace(/\/+$/, "");
const ADMIN_INTERNAL_KEY = process.env.ADMIN_INTERNAL_KEY || "";

async function authCall(path, { bearer, method = "GET", body, internal = false } = {}) {
  const res = await fetch((internal ? AUTH_INTERNAL_URL : AUTH_ISSUER) + path, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(internal ? { "X-Admin-Key": ADMIN_INTERNAL_KEY } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  return m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many;
};

/* Вечернее напоминание «огонёк гаснет» — раз в 5 минут ищем, у кого по
   местному времени наступил выбранный час (store.dueReminders), и шлём
   уведомление через Auth /internal/notifications: токена пользователя тут
   нет и быть не может, поэтому по ключу, как Admin. */
/* Уведомление на устройство (Web Push) — во все браузеры, где человек
   включил уведомления. Отозванные подписки (404/410) стираются. Ошибки не
   роняют основное действие: уведомление в кабинете Auth всё равно есть. */
const webpush = createWebPush({ dataDir: DATA_DIR, subject: process.env.VAPID_SUBJECT || SITE_URL });
async function pushTo(userId, message) {
  for (const sub of store.pushSubs(userId)) {
    try {
      const r = await webpush.send(sub, message);
      if (r.gone) store.dropPushSub(sub.endpoint);
    } catch (e) { console.error("Push не ушёл:", e.message); }
  }
}

/* Событие пары (приглашение, принятие, «напарник выполнил норму») — в кабинет
   Auth и на устройство. Сбой не роняет основное действие, только в лог. */
async function notifyPair(userId, type, title, bearer) {
  try {
    await authCall("/api/notifications", { bearer, method: "POST", body: { userId, type, title, url: PUBLIC_URL + "/" } });
  } catch (e) { console.error("Уведомление пары не ушло:", e.message); }
  pushTo(userId, { title, body: "«Когда на права?» — общий огонёк.", url: PUBLIC_URL + "/", tag: type });
}

/* После того как у человека загорелся день: если у него есть напарник и тот
   ещё не выполнил норму — сообщаем. Не ждём и не падаем. */
function notifyPartnerDone(user, bearer) {
  const partnerId = store.pairPartnerToNotify(user.id);
  if (!partnerId) return;
  notifyPair(partnerId, "pdd.pair_done", `${user.name || user.username} выполнил(а) норму — общий огонёк ждёт вас`, bearer);
}

async function sendReminders() {
  for (const r of store.dueReminders()) {
    const title = `Огонёк гаснет: ${r.streak} ${plural(r.streak, "день", "дня", "дней")} подряд`;
    const body = `На сегодня осталось ${r.left} ${plural(r.left, "вопрос", "вопроса", "вопросов")} — успейте до полуночи.`;
    await pushTo(r.userId, { title, body, url: PUBLIC_URL + "/", tag: "pdd-streak" });
    if (!ADMIN_INTERNAL_KEY) continue;
    try {
      await authCall("/internal/notifications", {
        internal: true, method: "POST",
        body: { userId: r.userId, source: "pdd", type: "pdd.streak_risk", title, body, url: PUBLIC_URL + "/" },
      });
    } catch (e) { console.error("Напоминание не ушло:", r.userId, e.message); }
  }
}
// Напоминания идут и без ключа — тогда только на устройство (push), без
// копии в кабинете BurningHouse.
setInterval(() => sendReminders().catch(e => console.error("Напоминания:", e)), 5 * 60 * 1000).unref();
setTimeout(() => sendReminders().catch(() => {}), 10 * 1000).unref();
if (!ADMIN_INTERNAL_KEY) console.log("ADMIN_INTERNAL_KEY не задан — напоминания только на устройства (push), без кабинета BurningHouse.");

/* Аккаунт удалили в Auth (кабинет → «Удалить аккаунт») — Auth сервисам об
   этом не сообщает, поэтому раз в 6 часов сверяемся со списком аккаунтов и
   стираем данные тех, кого нет дольше суток (store.purgeMissing). Пустой или
   неудачный ответ Auth — ничего не трогаем. */
async function purgeDeletedAccounts() {
  if (!ADMIN_INTERNAL_KEY) return;
  const { users } = await authCall("/internal/users", { internal: true });
  if (!Array.isArray(users) || !users.length) return console.error("Уборка: Auth вернул пустой список — пропускаем");
  const r = store.purgeMissing(new Set(users.map(u => u.id)));
  if (r.purged) console.log(`Уборка: стёрты данные ${r.purged} удалённых в Auth аккаунтов`);
}
setInterval(() => purgeDeletedAccounts().catch(e => console.error("Уборка:", e.message)), 6 * 3600 * 1000).unref();
setTimeout(() => purgeDeletedAccounts().catch(e => console.error("Уборка:", e.message)), 60 * 1000).unref();

// ---------- маршруты и SEO ----------

// Пока пояснения не свои — не индексируемся вовсе (robots в index.html тоже
// noindex). Включается одной переменной, когда тексты будут переписаны.
const INDEXABLE = process.env.INDEXABLE === "1";
// Приложение для Android (android/): TWA-обёртка сайта + виджет огонька.
// assetlinks.json подтверждает, что приложение — наше: без него TWA
// показывает адресную строку. SHA-256 сертификатов подписи — через запятую:
// ключ Play App Signing и, для APK в обход стора, ключ загрузки.
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || "ru.burninghouse.pdd";
// По умолчанию — наш ключ загрузки (android/README.md, «Подпись»): отпечаток не
// секрет, а без него приложение показывает адресную строку, пока на сервере не
// поправят compose. Ключ подписи Google Play — дописать сюда же через запятую.
const ANDROID_CERTS_DEFAULT = "9C:0A:87:11:81:BD:4A:C3:76:BC:20:73:D4:40:E5:36:18:B0:C3:E8:8F:79:C6:D3:1C:95:22:11:2E:BF:45:37";
const ANDROID_CERTS = (process.env.ANDROID_CERT_SHA256 || ANDROID_CERTS_DEFAULT).split(",").map(x => x.trim().toUpperCase()).filter(x => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x));

function routeSeo(rel) {
  if (rel === "") {
    return {
      title: `${SERVICE_NAME} — билеты ПДД 2026 категории A и B онлайн`,
      description: "40 экзаменационных билетов ПДД категории A, B, M: 800 вопросов с пояснениями, как на экзамене в ГАИ. План подготовки и огонёк за каждый день занятий.",
    };
  }
  if (rel === "ekzamen") {
    return { title: `Экзамен ПДД онлайн как в ГИБДД — ${SERVICE_NAME}`, description: "Экзамен по билетам ПДД категории A, B, M по правилам ГИБДД: 20 вопросов, 20 минут, дополнительные вопросы за ошибки." };
  }
  const mini = /^mini\/(\d{1,2})$/.exec(rel);
  if (mini && Number(mini[1]) >= 5 && Number(mini[1]) <= 20) {
    return { title: `Мини-билет: ${mini[1]} случайных вопросов ПДД — ${SERVICE_NAME}`, description: `${mini[1]} случайных вопросов из всех билетов ПДД категории A, B, M — быстрая тренировка с ответами и пояснениями.` };
  }
  if (rel === "oshibki") {
    return { title: `Работа над ошибками — ${SERVICE_NAME}`, description: "Вопросы ПДД, в которых вы ошибались: повторяйте, пока не ответите верно дважды подряд." };
  }
  if (rel === "temy") {
    return { title: `Билеты ПДД по темам — ${SERVICE_NAME}`, description: "Вопросы экзаменационных билетов ПДД, сгруппированные по темам: знаки, разметка, перекрёстки и другие." };
  }
  const tt = /^tema\/(\d{1,2})$/.exec(rel);
  if (tt && TOPICS[Number(tt[1])]) {
    const t = TOPICS[Number(tt[1])];
    return { title: `${t.name} — вопросы ПДД по теме — ${SERVICE_NAME}`, description: `Вопросы билетов ПДД по теме «${t.name}»: ${t.ids.length} вопросов с ответами и пояснениями.` };
  }
  if (rel === "garazh") {
    return { title: `Гараж — ${SERVICE_NAME}`, description: "Цвета и детали для машины за рубежи огонька: 3, 7, 14, 30, 50 и 100 дней подготовки к экзамену ПДД подряд.", noindex: true };
  }
  if (rel === "sources") {
    return { title: `Источники — ${SERVICE_NAME}`, description: "Откуда вопросы билетов ПДД и правила: Госавтоинспекция МВД России, ПДД РФ (постановление № 1090). Неофициальное приложение." };
  }
  if (rel === "privacy") {
    return { title: `Политика конфиденциальности — ${SERVICE_NAME}`, description: "Какие данные хранит тренажёр билетов ПДД «Когда на права?», кто их видит и как их удалить." };
  }
  if (rel === "delete-account") {
    return { title: `Удаление аккаунта и данных — ${SERVICE_NAME}`, description: "Как удалить данные подготовки и аккаунт BurningHouse в «Когда на права?» — самостоятельно, в пару нажатий." };
  }
  // «Вопрос дня» из виджета — у каждого свой, искать тут нечего.
  if (/^question\/[0-9a-f]{32}$/.test(rel)) {
    return { title: `Вопрос дня — ${SERVICE_NAME}`, description: "Вопрос из билетов ПДД с ответом и пояснением.", noindex: true };
  }
  if (rel === "widget") {
    return { title: `Виджет на экран телефона — ${SERVICE_NAME}`, description: "Огонёк и норма дня прямо на главном экране телефона — в приложении для Android.", noindex: true };
  }
  if (rel === "znachki") {
    // Личная страница: у каждого свои значки — искать тут нечего.
    return { title: `Значки и рекорды — ${SERVICE_NAME}`, description: "Значки за подготовку к экзамену ПДД, личные рекорды и тюнинг машины за огонёк.", noindex: true };
  }
  if (rel === "plan") {
    return { title: `План подготовки — ${SERVICE_NAME}`, description: "Сколько билетов ПДД решать в день и к какой дате готовиться." };
  }
  const m = /^bilet\/(\d{1,2})$/.exec(rel);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= TICKET_COUNT) {
    const n = Number(m[1]);
    return {
      title: `Билет ${n} ПДД 2026 категории AB — ${SERVICE_NAME}`,
      description: `Экзаменационный билет № ${n} ПДД категории A, B, M: 20 вопросов с ответами и пояснениями. Решить онлайн, как в ГАИ.`,
    };
  }
  return null;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Подмена по месту вместо шаблонизатора, как у Brain: страница одна, полей мало.
// Функция-замена вместо строки — чтобы "$" в тексте не трактовался replace'ом.
function injectSeo(html, rel, seo) {
  const url = `${SITE_URL}/${rel}`;
  const t = escapeAttr(seo.title), d = escapeAttr(seo.description);
  return html
    .replace(/<title>.*?<\/title>/, () => `<title>${t}</title>`)
    .replace(/<meta name="robots" content="[^"]*">/, () => `<meta name="robots" content="${INDEXABLE && !seo.noindex ? "index, follow" : "noindex, nofollow"}">`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${d}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${url}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, () => `<meta property="og:url" content="${url}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, () => `<meta property="og:title" content="${t}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, () => `<meta property="og:description" content="${d}">`);
}

// ---------- HTTP ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", c => {
      data += c;
      if (data.length > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === "/api/config" && method === "GET") {
    return json(res, 200, {
      tickets: TICKET_COUNT,
      questions: BANK.length,
      unique: store.TOTAL, // шесть вопросов есть в двух билетах — «решено верно» считается из 794
      topics: META.topics,
      dataset: { version: META.version, sha: META.sha.slice(0, 7) },
      // null — вход сейчас недоступен, фронт не покажет кнопку «Войти».
      authBase: auth ? AUTH_ISSUER : null,
      clientId: AUTH_CLIENT_ID,
    });
  }

  const m = /^\/api\/tickets\/(\d{1,2})$/.exec(pathname);
  if (m && method === "GET" && TICKET_BODIES.has(Number(m[1]))) {
    // Билеты меняются только с новым образом — можно кэшировать, но не
    // надолго: после квартального обновления люди должны увидеть новые вопросы
    // в пределах часа, а не через неделю.
    res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "public, max-age=3600" });
    return res.end(TICKET_BODIES.get(Number(m[1])));
  }

  if (pathname === "/api/topics" && method === "GET") {
    res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "public, max-age=3600" });
    return res.end(TOPICS_BODY);
  }
  const tm = /^\/api\/topics\/(\d{1,2})$/.exec(pathname);
  if (tm && method === "GET" && TOPICS[Number(tm[1])]) {
    const t = TOPICS[Number(tm[1])];
    return json(res, 200, { i: t.i, name: t.name, questions: t.ids.map(id => pub(BY_ID.get(id))) });
  }
  // Мини-билет: N случайных разных вопросов из всей базы (5–20).
  if (pathname === "/api/random" && method === "GET") {
    const n = Math.min(20, Math.max(5, Number(new URL(req.url, "http://localhost").searchParams.get("n")) || 10));
    const all = [...BY_ID.values()];
    for (let i = all.length - 1; i > all.length - 1 - n; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return json(res, 200, { questions: all.slice(-n).map(pub) });
  }

  // Публичный ключ VAPID — браузер подписывается на push именно под него.
  if (pathname === "/api/push/key" && method === "GET") return json(res, 200, { publicKey: webpush.publicKey });

  // Вопросы по списку id — для работы над ошибками. Не больше 200 за раз.
  if (pathname === "/api/questions" && method === "GET") {
    const ids = (new URL(req.url, "http://localhost").searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200);
    return json(res, 200, { questions: ids.filter(id => BY_ID.has(id)).map(id => pub(BY_ID.get(id))) });
  }

  // Виджет на экране телефона — по своему ключу (не по входу: токен входа
  // живёт минуты, а виджет обновляется сам часами). Только чтение огонька.
  if (pathname === "/api/widget" && method === "GET") {
    const m = /^Widget ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || "");
    const data = m && store.widget(m[1]);
    return data ? json(res, 200, data) : json(res, 401, { error: "bad_widget_token" });
  }

  // Всё ниже — только для вошедших.
  if (!pathname.startsWith("/api/me") && !pathname.startsWith("/api/friends") && !pathname.startsWith("/api/pair") && !["/api/widget/token", "/api/answers", "/api/answers/batch", "/api/import-guest", "/api/exams", "/api/push/subscribe", "/api/push/unsubscribe"].includes(pathname) && !/^\/api\/tickets\/\d{1,2}\/finish$/.test(pathname)) {
    return json(res, 404, { error: "not_found" });
  }
  if (!auth) return json(res, 503, { error: "auth_unavailable" });
  const user = await auth.userFromRequest(req);
  if (!user) return json(res, 401, { error: "unauthorized" });

  if (pathname === "/api/me" && method === "GET") {
    const tz = new URL(req.url, "http://localhost").searchParams.get("tz");
    return json(res, 200, { user: { id: user.id, name: user.name || user.username }, ...store.me(user.id, tz) });
  }
  if (pathname === "/api/me/daily" && method === "GET") {
    return json(res, 200, { question: store.dailyQuestion(user.id) });
  }
  // «Удалить мои данные» (страница /delete-account): весь прогресс в сервисе.
  // Аккаунт BurningHouse остаётся — он в Auth, удаляется в его кабинете.
  if (pathname === "/api/me" && method === "DELETE") {
    store.deleteUserData(user.id);
    console.log("Данные стёрты по просьбе пользователя:", user.id);
    return json(res, 200, { deleted: true });
  }

  if (pathname === "/api/me/plan" && method === "PUT") {
    const r = store.setPlan(user.id, (await readJson(req)).plan);
    return r ? json(res, 200, r) : json(res, 400, { error: "bad_plan" });
  }

  const answerOf = b => store.answer(user.id, {
    questionId: String(b?.questionId || ""), chosen: b?.chosen, rid: b?.rid, tz: b?.tz, at: Number(b?.at),
    mode: ["ticket", "exam", "mistakes", "topic", "mini"].includes(b?.mode) ? b.mode : "ticket",
  });
  if (pathname === "/api/answers" && method === "POST") {
    const r = answerOf(await readJson(req));
    if (r?.lit) notifyPartnerDone(user, auth.bearer(req));
    return r ? json(res, 200, r) : json(res, 400, { error: "bad_answer" });
  }
  // Ответы засчитываются, только когда подход закончен (билет, экзамен, мини,
  // тема, ошибки) — клиент присылает их разом. Кривые пропускаем, а не рушим
  // весь подход; lit — хоть один ответ зажёг огонёк.
  if (pathname === "/api/answers/batch" && method === "POST") {
    const items = (await readJson(req)).items;
    if (!Array.isArray(items) || !items.length || items.length > 60) return json(res, 400, { error: "bad_batch" });
    let last = null, lit = false, saved = 0;
    for (const it of items) {
      const r = answerOf(it);
      if (!r) continue;
      last = r; saved++;
      if (r.lit) lit = true;
    }
    if (lit) notifyPartnerDone(user, auth.bearer(req));
    return last ? json(res, 200, { lit, saved, streak: last.streak, summary: last.summary }) : json(res, 400, { error: "bad_batch" });
  }

  const f = /^\/api\/tickets\/(\d{1,2})\/finish$/.exec(pathname);
  if (f && method === "POST") {
    const b = await readJson(req);
    const r = store.finishTicket(user.id, Number(f[1]), b.answers, { rid: b.rid, at: Number(b.at) });
    return r ? json(res, 200, r) : json(res, 400, { error: "bad_ticket" });
  }

  // Ключ для виджета: выдаётся вошедшему и уходит в приложение (страница /widget).
  if (pathname === "/api/widget/token" && method === "POST") {
    return json(res, 200, { token: store.createWidgetToken(user.id) });
  }
  if (pathname === "/api/widget/token" && method === "DELETE") {
    return json(res, 200, { revoked: store.revokeWidgetTokens(user.id) });
  }

  if (pathname === "/api/me/car" && method === "PUT") {
    const r = store.setCar(user.id, (await readJson(req)).car);
    return r ? json(res, 200, r) : json(res, 400, { error: "bad_car" });
  }
  if (pathname === "/api/me/settings" && method === "PUT") {
    const b = await readJson(req);
    const r = store.setRemind(user.id, b.remindAt === null ? null : String(b.remindAt || ""));
    return r ? json(res, 200, r) : json(res, 400, { error: "bad_settings" });
  }

  // Друзья — список из Auth (кто кому друг решает Auth, не клиент), огоньки
  // и прогресс — наши. Показываем только принятых друзей.
  if (pathname === "/api/friends" && method === "GET") {
    let data;
    try { data = await authCall("/api/friends", { bearer: auth.bearer(req) }); }
    catch (e) { console.error("Друзья из Auth:", e.message); return json(res, 502, { error: "friends_unavailable" }); }
    const list = data.friends || [];
    const feed = store.friendsFeed(user.id, list.map(f => f.userId));
    return json(res, 200, {
      friends: list.map(f => ({ userId: f.userId, name: f.name || f.username, ...feed[f.userId] })),
      incoming: (data.incoming || []).length,
      inviteLink: data.inviteLink || null,
      accountUrl: AUTH_ISSUER + "/",
    });
  }

  // Напарник — общий огонёк на двоих. Кто друг — решает Auth; имена берём оттуда же.
  const friendsOf = async () => (await authCall("/api/friends", { bearer: auth.bearer(req) })).friends || [];
  const pairBody = (v, friends) => {
    const f = friends.find(x => x.userId === v.partnerId);
    return { id: v.id, status: v.status, invitedByMe: v.invitedByMe, accepted_day: v.accepted_day,
      partner: { userId: v.partnerId, name: f.name || f.username, car: v.partner.car, todayDone: v.partner.todayDone },
      me: v.me, streak: v.streak, rescue: v.rescue };
  };
  if (pathname === "/api/pair" && method === "GET") {
    let friends;
    try { friends = await friendsOf(); }
    catch (e) { console.error("Друзья из Auth:", e.message); return json(res, 502, { error: "friends_unavailable" }); }
    const v = store.pairFor(user.id);
    if (!v) return json(res, 200, { pair: null });
    if (!friends.some(f => f.userId === v.partnerId)) { store.pairLeave(user.id, "unfriended"); return json(res, 200, { pair: null }); }
    return json(res, 200, { pair: pairBody(v, friends) });
  }
  if (pathname === "/api/pair" && method === "DELETE") {
    store.pairLeave(user.id);
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/pair/invite" && method === "POST") {
    const toId = String((await readJson(req)).userId || "");
    let friends;
    try { friends = await friendsOf(); }
    catch (e) { console.error("Друзья из Auth:", e.message); return json(res, 502, { error: "friends_unavailable" }); }
    if (!friends.some(f => f.userId === toId)) return json(res, 404, { error: "not_friend" });
    const r = store.pairInvite(user.id, toId);
    if (!r.ok) return json(res, r.error === "self" ? 400 : 409, { error: r.error });
    await notifyPair(toId, "pdd.pair_invite", `${user.name || user.username} зовёт вас в напарники — общий огонёк`, auth.bearer(req));
    return json(res, 200, { pair: pairBody(r.pair, friends) });
  }
  if (pathname === "/api/pair/accept" && method === "POST") {
    let friends;
    try { friends = await friendsOf(); }
    catch (e) { console.error("Друзья из Auth:", e.message); return json(res, 502, { error: "friends_unavailable" }); }
    const v = store.pairAccept(user.id);
    if (!v) return json(res, 404, { error: "no_invite" });
    if (!friends.some(f => f.userId === v.partnerId)) { store.pairLeave(user.id, "unfriended"); return json(res, 404, { error: "no_invite" }); }
    await notifyPair(v.partnerId, "pdd.pair_accept", `${user.name || user.username} теперь ваш напарник — общий огонёк зажжён`, auth.bearer(req));
    return json(res, 200, { pair: pairBody(v, friends) });
  }
  if (pathname === "/api/pair/rescue" && method === "POST") {
    let friends;
    try { friends = await friendsOf(); }
    catch (e) { console.error("Друзья из Auth:", e.message); return json(res, 502, { error: "friends_unavailable" }); }
    const r = store.pairRescue(user.id);
    if (!r.ok) return json(res, r.error === "no_pair" ? 404 : 409, { error: r.error });
    return json(res, 200, { pair: friends.some(f => f.userId === r.pair.partnerId) ? pairBody(r.pair, friends) : null });
  }

  const nm = /^\/api\/friends\/([\w-]{8,64})\/nudge$/.exec(pathname);
  if (nm && method === "POST") {
    const toId = nm[1];
    let data;
    try { data = await authCall("/api/friends", { bearer: auth.bearer(req) }); }
    catch (e) { return json(res, 502, { error: "friends_unavailable" }); }
    if (!(data.friends || []).some(f => f.userId === toId)) return json(res, 404, { error: "not_friend" });
    const f = store.friendsFeed(user.id, [toId])[toId];
    if (f.started && f.streak.todayDone) return json(res, 409, { error: "already_done" });
    const nudge = store.recordNudge(user.id, toId);
    if (!nudge.ok) return json(res, 429, { error: "already_nudged", nextAt: nudge.nextAt });
    const who = user.name || user.username;
    // Текст фиксированный — канал Auth для событий, не для переписки.
    try {
      await authCall("/api/notifications", {
        bearer: auth.bearer(req), method: "POST",
        body: {
          userId: toId, type: "pdd.nudge",
          title: f.started ? `${who} подталкивает: пора решить билеты` : `${who} зовёт вместе готовиться к экзамену на права`,
          url: PUBLIC_URL + "/",
        },
      });
    } catch (e) {
      console.error("Толчок не ушёл:", e.message);
      return json(res, 502, { error: "notify_failed" });
    }
    pushTo(toId, {
      title: f.started ? `${who} подталкивает: пора решить билеты` : `${who} зовёт вместе готовиться к экзамену на права`,
      body: f.started ? "Огонёк ждёт — один билет, и норма на сегодня закрыта." : "«Когда на права?» — билеты ПДД с огоньком за каждый день.",
      url: PUBLIC_URL + "/", tag: "pdd-nudge",
    });
    return json(res, 200, { ok: true, nextAt: nudge.nextAt });
  }

  if (pathname === "/api/push/subscribe" && method === "POST") {
    return store.addPushSub(user.id, (await readJson(req)).subscription) ? json(res, 200, { ok: true }) : json(res, 400, { error: "bad_subscription" });
  }
  if (pathname === "/api/push/unsubscribe" && method === "POST") {
    store.removePushSub(user.id, (await readJson(req)).endpoint);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/me/qstate" && method === "GET") {
    return json(res, 200, store.qState(user.id));
  }

  if (pathname === "/api/exams" && method === "POST") {
    const b = await readJson(req, 64 * 1024);
    const r = store.finishExam(user.id, b.items, Number(b.seconds), !!b.timeout, { rid: b.rid, at: Number(b.at) });
    return r ? json(res, 200, r) : json(res, 400, { error: "bad_exam" });
  }

  if (pathname === "/api/import-guest" && method === "POST") {
    // Гостевой прогресс целиком: до ~800 вопросов — десятки килобайт.
    const b = await readJson(req, 512 * 1024);
    return json(res, 200, store.importGuest(user.id, b.data, Number(b.target)));
  }

  return json(res, 405, { error: "method_not_allowed" });
}

const MOVED = { konfidencialnost: "privacy", "udalenie-dannyh": "delete-account", vidzhet: "widget" };

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400).end(); return; }

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch(err => {
      if (err.status) return json(res, err.status, { error: err.status === 413 ? "too_large" : "bad_request" });
      console.error("Ошибка API:", err);
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
    return;
  }

  const isHead = req.method === "HEAD";
  if (req.method !== "GET" && !isHead) {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method Not Allowed");
    return;
  }

  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  // Служебные страницы первые дни жили под транслитом — старые ссылки (в т. ч.
  // из приложения 1.0.1) ведём на новые адреса навсегда, с тем же ?query.
  if (MOVED[rel]) {
    res.writeHead(301, { Location: `/${MOVED[rel]}${new URL(req.url, "http://localhost").search}` }).end();
    return;
  }
  const seo = routeSeo(rel === "index.html" ? "" : rel);
  if (seo) {
    fs.readFile(path.join(ROOT, "index.html"), "utf8", (err, html) => {
      if (err) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal Error"); return; }
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
      res.end(isHead ? undefined : injectSeo(html, rel === "index.html" ? "" : rel, seo));
    });
    return;
  }

  // robots.txt и sitemap.xml собираются на лету: состав страниц известен по
  // банку билетов, а закрытый режим (INDEXABLE=0) закрывает сайт целиком.
  if (rel === "robots.txt") {
    res.writeHead(200, { "Content-Type": TYPES[".txt"], "Cache-Control": "public, max-age=3600" });
    res.end(isHead ? undefined : INDEXABLE
      ? `User-agent: *\nDisallow: /api/\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
      : "User-agent: *\nDisallow: /\n");
    return;
  }
  if (rel === "sitemap.xml" && INDEXABLE) {
    const paths = ["", "ekzamen", "temy", ...Array.from({ length: TICKET_COUNT }, (_, i) => `bilet/${i + 1}`), ...TOPICS.map(t => `tema/${t.i}`)];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + paths.map(p => `  <url><loc>${SITE_URL}/${p}</loc></url>`).join("\n") + "\n</urlset>\n";
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(isHead ? undefined : xml);
    return;
  }

  if (rel === ".well-known/assetlinks.json" && ANDROID_CERTS.length) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(isHead ? undefined : JSON.stringify([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_CERTS },
    }]));
    return;
  }

  // Белый список: assets/, favicon и корневые файлы приложения. sw.js обязан
  // отдаваться с корня — иначе его scope не накроет навигацию по "/". "../"
  // отсекаем явно — путь внутри assets/ произвольный (картинки вопросов).
  const ROOT_FILES = ["favicon.svg", "sw.js", "manifest.webmanifest"];
  if (!(rel.startsWith("assets/") || ROOT_FILES.includes(rel)) || rel.split("/").includes("..")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }
  const filePath = path.join(ROOT, rel === "favicon.svg" ? "assets/favicon.svg" : rel);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found"); return; }
    // Картинки вопросов названы хешем содержимого — меняться под тем же
    // именем не могут, кэшируем навсегда. sw.js браузер должен перепроверять
    // при каждой навигации — иначе обновления не дойдут до установленного
    // приложения. Остальное — ненадолго, как у Brain.
    const immutable = rel.startsWith("assets/q/");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : rel === "sw.js" ? "no-cache" : "public, max-age=300",
    });
    res.end(isHead ? undefined : data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`${SERVICE_NAME} слушает http://${HOST}:${PORT} — билеты ${META.version}, ${BANK.length} вопросов`);
});
