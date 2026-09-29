#!/usr/bin/env node
"use strict";
/**
 * «Когда на права?» — тренажёр билетов ПДД (категория A/B), pdd.burninghouse.ru.
 * План целиком — ARCHITECTURE.md.
 *
 * Этап 1: без входа и без базы. Сервер отдаёт index.html на все маршруты
 * клиентского роутера (History API: /bilet/7), статику из assets/ и билеты по
 * одному через /api/tickets/N. Прогресс гостя живёт в localStorage
 * (assets/progress.js). Вход, серверный лог ответов и огонёк — этап 2.
 *
 * Билеты лежат в bank/ — это результат tools/import.mjs, часть образа, а не
 * данные: data/ зарезервирован под SQLite и в контейнере будет volume'ом.
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
// ARCHITECTURE.md, «База билетов»). Выключатель на случай, если их придётся
// убрать быстро, не дожидаясь переписывания: SHOW_TIPS=0.
const SHOW_TIPS = process.env.SHOW_TIPS !== "0";

// ---------- билеты ----------

const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "ab.json"), "utf8"));
const META = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "meta.json"), "utf8"));
const TICKET_COUNT = META.tickets;

// Готовые тела ответов: билеты не меняются, пока жив процесс, — сериализуем
// один раз на старте, а не на каждый запрос.
const TICKET_BODIES = new Map();
for (let n = 1; n <= TICKET_COUNT; n++) {
  const questions = BANK.filter(q => q.ticket === n).sort((a, b) => a.num - b.num).map(q => ({
    id: q.id, num: q.num, text: q.text, image: q.image, answers: q.answers, correct: q.correct,
    tip: SHOW_TIPS ? q.tip : null, ref: SHOW_TIPS ? q.ref : null, topics: q.topics,
  }));
  TICKET_BODIES.set(n, JSON.stringify({ ticket: n, questions }));
}

// ---------- маршруты и SEO ----------

// Пока пояснения не свои — не индексируемся вовсе (robots в index.html тоже
// noindex). Включается одной переменной, когда тексты будут переписаны.
const INDEXABLE = process.env.INDEXABLE === "1";

function routeSeo(rel) {
  if (rel === "") {
    return {
      title: `${SERVICE_NAME} — билеты ПДД 2026 категории A и B онлайн`,
      description: "40 экзаменационных билетов ПДД категории A, B, M: 800 вопросов с пояснениями, как на экзамене в ГАИ. План подготовки и огонёк за каждый день занятий.",
    };
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
    .replace(/<meta name="robots" content="[^"]*">/, () => `<meta name="robots" content="${INDEXABLE ? "index, follow" : "noindex, nofollow"}">`)
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

function handleApi(req, res, pathname) {
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

  if (pathname === "/api/config") {
    return json(res, 200, {
      tickets: TICKET_COUNT,
      questions: BANK.length,
      topics: META.topics,
      dataset: { version: META.version, sha: META.sha.slice(0, 7) },
    });
  }

  const m = /^\/api\/tickets\/(\d{1,2})$/.exec(pathname);
  if (m && TICKET_BODIES.has(Number(m[1]))) {
    // Билеты меняются только с новым образом — можно кэшировать, но не
    // надолго: после квартального обновления люди должны увидеть новые вопросы
    // в пределах часа, а не через неделю.
    res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "public, max-age=3600" });
    return res.end(TICKET_BODIES.get(Number(m[1])));
  }

  return json(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400).end(); return; }

  if (pathname.startsWith("/api/")) {
    try { handleApi(req, res, pathname); }
    catch (err) { console.error("Ошибка API:", err); if (!res.headersSent) json(res, 500, { error: "internal" }); }
    return;
  }

  const isHead = req.method === "HEAD";
  if (req.method !== "GET" && !isHead) {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method Not Allowed");
    return;
  }

  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const seo = routeSeo(rel === "index.html" ? "" : rel);
  if (seo) {
    fs.readFile(path.join(ROOT, "index.html"), "utf8", (err, html) => {
      if (err) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal Error"); return; }
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
      res.end(isHead ? undefined : injectSeo(html, rel === "index.html" ? "" : rel, seo));
    });
    return;
  }

  // Белый список: только assets/ и favicon. "../" отсекаем явно — в отличие от
  // Brain, тут путь внутри assets/ произвольный (картинки вопросов).
  if (!(rel.startsWith("assets/") || rel === "favicon.svg") || rel.split("/").includes("..")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }
  const filePath = path.join(ROOT, rel === "favicon.svg" ? "assets/favicon.svg" : rel);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found"); return; }
    // Картинки вопросов названы хешем содержимого — меняться под тем же
    // именем не могут, кэшируем навсегда. Остальное — ненадолго, как у Brain.
    const immutable = rel.startsWith("assets/q/");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    });
    res.end(isHead ? undefined : data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`${SERVICE_NAME} слушает http://${HOST}:${PORT} — билеты ${META.version}, ${BANK.length} вопросов`);
});
