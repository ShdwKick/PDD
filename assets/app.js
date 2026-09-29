"use strict";
/**
 * «Когда на права?» — фронт. Роутер на History API (/, /bilet/7), как у Brain:
 * пути настоящие ради поиска, сервер отдаёт на каждый тот же index.html.
 *
 * Этап 1: главная со списком билетов и решение билета. Всё — гостем, прогресс
 * в localStorage (progress.js). Вход, план и огонёк — этап 2.
 */
import { getRun, recordAnswer, finishRun, resetRun, summary, plural, streak } from "./progress.js";

const SERVICE_NAME = "Когда на права?";
const $ = id => document.getElementById(id);
const view = $("view");

/* ---------- тема: рассвет и ночь (Design/palette.md) ---------- */

const THEME_KEY = "bh-theme";
const moonIcon = `<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const sunIcon = `<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>`;

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
  catch { return "light"; }
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("themeBtn").innerHTML = theme === "dark" ? sunIcon : moonIcon;
}
applyTheme(currentTheme());
$("themeBtn").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme(next);
});

/* Тихий фон — та же анимация, приглушённая (Shared/brand.css, .bh-backdrop--quiet).
   Здесь особенно к месту: над вопросом думают, фон не должен отвлекать. */
const QUIET_KEY = "bh-quiet";
function isQuiet() { try { return localStorage.getItem(QUIET_KEY) === "1"; } catch { return false; } }
function applyQuiet(on) {
  $("backdrop").classList.toggle("bh-backdrop--quiet", on);
  $("quietBtn").classList.toggle("is-active", on);
}
applyQuiet(isQuiet());
$("quietBtn").addEventListener("click", () => {
  const next = !isQuiet();
  try { localStorage.setItem(QUIET_KEY, next ? "1" : "0"); } catch {}
  applyQuiet(next);
});

/* ---------- конфиг и билеты ---------- */

let config = null;
async function loadConfig() {
  if (!config) config = await (await fetch("/api/config")).json();
  return config;
}

const ticketCache = new Map();
async function loadTicket(n) {
  if (!ticketCache.has(n)) {
    const res = await fetch(`/api/tickets/${n}`);
    if (!res.ok) throw new Error(`Билет ${n}: HTTP ${res.status}`);
    ticketCache.set(n, (await res.json()).questions);
  }
  return ticketCache.get(n);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- шкала приборки ----------
   Дуга на 270°, как у спидометра: от левого нижнего угла по часовой до
   правого нижнего. pathLength=100 — чтобы заполнение задавалось процентом,
   без расчёта длины дуги. Риски — только у крупной шкалы. */

let dialUid = 0;
function dial({ value, max, unit = "", label = "", big = false }) {
  const id = `d${dialUid++}`, steps = 8, cx = 60, cy = 60;
  const pt = (deg, r) => {
    const a = deg * Math.PI / 180;
    return [(cx + r * Math.cos(a)).toFixed(2), (cy + r * Math.sin(a)).toFixed(2)];
  };
  // Красная зона — последние 15% шкалы, как отсечка на тахометре.
  const [zx0, zy0] = pt(135 + 270 * 0.85, 46), [zx1, zy1] = pt(45, 46);
  let ticks = "";
  for (let i = 0; i <= steps * 2; i++) {
    const deg = 135 + i * 270 / (steps * 2), major = i % 2 === 0;
    const [x1, y1] = pt(deg, 48), [x2, y2] = pt(deg, major ? 40 : 44);
    ticks += `<line class="tick${major ? " major" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    if (major && big) {
      const [tx, ty] = pt(deg, 32);
      ticks += `<text class="num" x="${tx}" y="${(+ty + 3).toFixed(2)}">${Math.round(max / steps * i / 2)}</text>`;
    }
  }
  // Стрелка нарисована в нулевом положении и поворачивается через CSS
  // (--a), чтобы её можно было анимировать transform'ом — см. startDials().
  const to = (270 * Math.max(0, Math.min(1, max > 0 ? value / max : 0))).toFixed(1);
  const [nx, ny] = pt(135, 45), [bx, by] = pt(135, -8);
  return `<div class="dial${big ? " big" : ""}" role="img" aria-label="${esc(label)}: ${value}${unit ? " " + esc(unit) : ""}">
    <svg viewBox="0 0 120 118" aria-hidden="true">
      <defs>
        <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f0f2f4"/><stop offset=".45" stop-color="#8a9097"/>
          <stop offset=".55" stop-color="#555b62"/><stop offset="1" stop-color="#d4d8dc"/>
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r="56" fill="url(#${id}c)"/>
      <circle cx="60" cy="60" r="51.5" fill="#000"/>
      <circle class="face" cx="60" cy="60" r="51"/>
      <path class="redzone" d="M${zx0} ${zy0} A46 46 0 0 1 ${zx1} ${zy1}"/>
      ${ticks}
      <g class="needle" style="--to:${to}deg"><line x1="${bx}" y1="${by}" x2="${nx}" y2="${ny}"/></g>
      <circle class="hub" cx="60" cy="60" r="6"/>
      <text class="val" x="60" y="${big ? 89 : 88}" data-to="${value}">${value}</text>
      ${unit && !big ? `<text class="unit" x="60" y="100">${esc(unit)}</text>` : ""}
    </svg>
    ${label ? `<div class="label">${esc(label)}</div>` : ""}
  </div>`;
}

/* ---------- анимации приборов ----------
   При первом заходе за сессию — «проверка приборов», как при повороте ключа:
   стрелки доходят до упора и возвращаются к своим значениям. Дальше — просто
   плавный подъём от нуля. Только transform и текст (Design/motion.md), и
   ничего — при prefers-reduced-motion: стрелки сразу на месте. */

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function startDials(root, { ignition = false } = {}) {
  const needles = [...root.querySelectorAll(".needle")];
  const vals = [...root.querySelectorAll(".val[data-to]")];
  if (reducedMotion()) {
    for (const n of needles) n.style.setProperty("--a", n.style.getPropertyValue("--to"));
    return;
  }
  for (const v of vals) v.textContent = "0";
  // Два кадра: первый фиксирует нулевое положение, иначе transition не
  // сработает и стрелка просто появится на месте.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (ignition) {
      for (const n of needles) { n.classList.add("sweep"); n.style.setProperty("--a", "270deg"); }
      setTimeout(() => {
        for (const n of needles) { n.classList.remove("sweep"); n.style.setProperty("--a", n.style.getPropertyValue("--to")); }
        countUp(vals, 900);
      }, 620);
    } else {
      for (const n of needles) n.style.setProperty("--a", n.style.getPropertyValue("--to"));
      countUp(vals, 900);
    }
  }));
}

function countUp(els, ms) {
  const t0 = performance.now();
  const tick = now => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    for (const el of els) el.textContent = String(Math.round(Number(el.dataset.to) * e));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function firstVisitThisSession() {
  try {
    if (sessionStorage.getItem("bh-pdd-ignition")) return false;
    sessionStorage.setItem("bh-pdd-ignition", "1");
  } catch {}
  return true;
}

/* ---------- огонёк ----------
   Контур — пламя из знака BurningHouse без выреза дома, внутри — язычок
   поменьше. Цвет — от красного к жёлтому, как огонь, а не оранжевый акцент:
   это сигнал, как лампы на приборке, а не цвет интерфейса.

   Три состояния: lit — норма на сегодня выполнена, горит и мерцает;
   ember — серия жива, но сегодня ещё не выполнено: тлеет уголёк; out —
   серии нет, серый контур. */

const FLAME_PATH = "M12 1.2C13.6 5 16.4 6.6 18.2 9.4C21.4 14.4 18.6 22.4 12 22.4C5.4 22.4 2.6 14.4 5.8 9.4C7.2 7.2 9.2 6 10.2 3.4C10.9 5.6 11.4 6.6 12 7.4C12.4 5.6 12.3 3.4 12 1.2Z";

function flameState(st) {
  return st.todayDone ? "lit" : st.current > 0 ? "ember" : "out";
}

let flameUid = 0;
function flameSvg(state, cls = "") {
  const id = `fl${flameUid++}`;
  return `<span class="flame ${cls}" data-state="${state}" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <defs>
        <linearGradient id="${id}o" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#e0241b"/><stop offset=".6" stop-color="#ff6a1a"/><stop offset="1" stop-color="#ffcc00"/></linearGradient>
        <linearGradient id="${id}i" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffd60a"/><stop offset="1" stop-color="#fff6c2"/></linearGradient>
      </defs>
      <path class="outer" d="${FLAME_PATH}" fill="url(#${id}o)"/>
      <path class="inner" d="${FLAME_PATH}" fill="url(#${id}i)"/>
      <circle class="coal" cx="12" cy="17.5" r="3"/>
    </svg>
    <i class="sparks">${"<b></b>".repeat(6)}</i>
  </span>`;
}

const daysWord = n => plural(n, "день", "дня", "дней");

/** Блок огонька на приборке: пламя, серия и «бак» сегодняшней нормы. */
function streakBlock(st) {
  const state = flameState(st);
  const left = Math.max(0, st.target - st.todayCount);
  const title = st.current > 0 ? `${st.current} ${daysWord(st.current)} подряд` : "Огонёк не горит";
  const hint = state === "lit"
    ? "Норма на сегодня выполнена"
    : state === "ember"
      ? `Ещё ${left} ${plural(left, "вопрос", "вопроса", "вопросов")} — и огонёк не погаснет`
      : `Реши ${left} ${plural(left, "вопрос", "вопроса", "вопросов")} за день — зажжётся`;
  // Шкала нормы — сегменты, как указатель топлива: 10 делений по 2 вопроса.
  const segs = 10, filled = Math.min(segs, Math.floor(st.todayCount / st.target * segs));
  return `<div class="streak" data-state="${state}">
    ${flameSvg(state, "big")}
    <div class="streak-text">
      <p class="streak-title">${title}</p>
      <p class="streak-hint">${hint}</p>
      <div class="fuel" role="img" aria-label="Сегодня ${st.todayCount} из ${st.target} вопросов">
        ${Array.from({ length: segs }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("")}
        <span>${Math.min(st.todayCount, st.target)}/${st.target}</span>
      </div>
    </div>
    ${st.best > st.current ? `<p class="streak-best">рекорд<b>${st.best}</b></p>` : ""}
  </div>`;
}

/** Огонёк в шапке билета — маленький, с числом дней. */
function streakChip(st) {
  const state = flameState(st);
  const label = state === "lit" ? `Огонёк горит, ${st.current} ${daysWord(st.current)} подряд`
    : `Сегодня ${st.todayCount} из ${st.target} вопросов`;
  return `<span class="streak-chip" data-state="${state}" title="${label}" aria-label="${label}">
    ${flameSvg(state)}<b>${state === "lit" || st.current ? st.current : `${st.todayCount}/${st.target}`}</b>
  </span>`;
}

/** Зажглось прямо сейчас: карточка с разгорающимся пламенем, искрами и
 * перещёлкиванием счётчика дней. Сама исчезает через несколько секунд. */
function celebrateLit(st) {
  document.querySelector(".lit-toast")?.remove();
  const el = document.createElement("div");
  el.className = "lit-toast";
  el.setAttribute("role", "status");
  el.innerHTML = `
    ${flameSvg("lit", "igniting")}
    <div>
      <p class="lt-title">Огонёк горит!</p>
      <p class="lt-days"><span class="odo"><span class="odo-roll"><b>${st.current - 1}</b><b>${st.current}</b></span></span> ${daysWord(st.current)} подряд</p>
    </div>`;
  document.body.append(el);
  const close = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 300); };
  el.addEventListener("click", close);
  setTimeout(close, 4200);
}

/* ---------- экзаменационный вердикт ----------
   Правила ГАИ: 20 вопросов в 4 блоках по 5 (номера 1–5, 6–10, 11–15, 16–20).
   Ошибка в блоке — +5 дополнительных вопросов из этого блока. Две ошибки в
   одном блоке или больше двух всего — «не сдал». Тренировочный билет даёт
   тот же ответ на вопрос «а на экзамене что было бы?» */

function verdict(questions, answers) {
  const byBlock = [0, 0, 0, 0];
  for (const q of questions) if (answers[q.num] !== q.correct) byBlock[Math.ceil(q.num / 5) - 1]++;
  const wrong = byBlock.reduce((a, b) => a + b, 0);
  const worst = Math.max(...byBlock);
  if (wrong === 0) return { passed: true, wrong, title: "Без ошибок", text: "На экзамене это «сдал» сразу, без дополнительных вопросов." };
  if (wrong <= 2 && worst <= 1) {
    return {
      passed: true, wrong,
      title: `${wrong} ${plural(wrong, "ошибка", "ошибки", "ошибок")}`,
      text: `На экзамене дали бы ещё ${wrong * 5} вопросов и ${wrong * 5} минут. Ответишь на них без ошибок — сдал.`,
    };
  }
  return {
    passed: false, wrong,
    title: `${wrong} ${plural(wrong, "ошибка", "ошибки", "ошибок")}`,
    text: worst >= 2
      ? "Две ошибки в одном блоке из пяти вопросов — на экзамене это «не сдал»."
      : "Больше двух ошибок — на экзамене это «не сдал».",
  };
}

/* ---------- роутер ---------- */

let cleanup = null;
function teardown() { if (cleanup) { cleanup(); cleanup = null; } }

function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", to); else history.pushState(null, "", to);
  route();
}
window.addEventListener("popstate", route);

// Внутренние ссылки — без перезагрузки страницы. Обычные <a href>, чтобы
// работали «открыть в новой вкладке» и поисковые боты.
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

function route() {
  teardown();
  const p = location.pathname.replace(/\/+$/, "");
  const m = /^\/bilet\/(\d{1,2})$/.exec(p);
  if (m) return renderTicket(Number(m[1]));
  if (p === "" || p === "/index.html") return renderHub();
  navigate("/", { replace: true });
}

/* ---------- главная ---------- */

async function renderHub() {
  document.title = `${SERVICE_NAME} — билеты ПДД категории A и B`;
  const cfg = await loadConfig();
  const s = summary();

  // Продолжить — самый свежий незаконченный билет. Нет такого — следующий
  // после последнего решённого, чтобы кнопка вела вперёд, а не в начало.
  const openRuns = Object.entries(s.runs).sort((a, b) => b[1].startedAt - a[1].startedAt);
  let primary;
  if (openRuns.length) {
    const [n, run] = openRuns[0];
    const done = Object.keys(run.answers).length;
    primary = { href: `/bilet/${n}`, label: `Продолжить билет ${n}`, hint: `${done} из 20` };
  } else {
    const solved = Object.entries(s.tickets).sort((a, b) => b[1].at - a[1].at);
    const next = solved.length ? (Number(solved[0][0]) % cfg.tickets) + 1 : 1;
    primary = { href: `/bilet/${next}`, label: solved.length ? `Билет ${next}` : "Начать с билета 1", hint: null };
  }
  const unsolved = [];
  for (let n = 1; n <= cfg.tickets; n++) if (!s.tickets[n]) unsolved.push(n);
  const pool = unsolved.length ? unsolved : Array.from({ length: cfg.tickets }, (_, i) => i + 1);

  view.innerHTML = `
    <section class="hero">
      <h1>${SERVICE_NAME}</h1>
      <p>Билеты ПДД категорий A, B и M: ${cfg.tickets} билетов, ${cfg.questions} вопросов с пояснениями — как на экзамене в ГАИ.</p>
    </section>

    <section class="dash" aria-label="Приборная панель">
      ${streakBlock(streak())}
      <div class="dials">
        ${dial({ value: s.todayCount, max: 20, unit: plural(s.todayCount, "вопрос", "вопроса", "вопросов"), label: "сегодня" })}
        ${dial({ value: s.learned, max: cfg.questions, label: `решено верно из ${cfg.questions}`, big: true })}
        ${dial({ value: s.passedTickets, max: cfg.tickets, unit: `из ${cfg.tickets}`, label: "билетов сдано" })}
      </div>
    </section>
    <div class="lamps">
      ${s.mistakes
        ? `<span class="lamp warn">${s.mistakes} ${plural(s.mistakes, "ошибка", "ошибки", "ошибок")} на повторение</span>`
        : s.learned ? `<span class="lamp ok">Ошибок на повторение нет</span>` : ""}
    </div>
    <div class="actions hub-actions">
      <a class="btn primary" href="${primary.href}" data-link>${esc(primary.label)}${primary.hint ? `<span class="btn-hint">${primary.hint}</span>` : ""}</a>
      <button class="btn" id="randomBtn" type="button">Случайный билет</button>
    </div>

    <h2 class="section-title">Билеты</h2>
    <div class="plates">
      ${Array.from({ length: cfg.tickets }, (_, i) => ticketPlate(i + 1, s)).join("")}
    </div>

    <p class="dataset-note">Вопросы — официальные билеты ГИБДД, база
      <a href="https://github.com/etspring/pdd_russia" rel="noopener" target="_blank">pdd_russia</a>,
      версия ${esc(cfg.dataset.version)}.</p>
  `;
  $("randomBtn").addEventListener("click", () => {
    navigate(`/bilet/${pool[Math.floor(Math.random() * pool.length)]}`);
  });
  startDials(view.querySelector(".dash"), { ignition: firstVisitThisSession() });
}

/* Билет — номерной знак. Основное поле — результат («18 из 20»), поле
   «региона» — номер билета, а на месте флага — полоска прогресса: её длина —
   доля верных, цвет — сдал бы / не сдал бы / ещё решается. */
function ticketPlate(n, s) {
  const t = s.tickets[n], run = s.runs[n];
  let state = "none", main = `<span class="n empty">не решён</span>`, pct = 0, label = "не решён";
  if (run) {
    const k = Object.keys(run.answers).length;
    state = "progress"; pct = k / 20;
    main = `<span class="n">${k}<small>из 20</small></span>`;
    label = `решается, отвечено ${k} из 20`;
  } else if (t) {
    state = t.passed ? "pass" : "fail"; pct = t.last / 20;
    main = `<span class="n">${t.last}<small>из 20</small></span>`;
    label = `${t.last} из 20, ${t.passed ? "сдал бы" : "не сдал бы"}`;
  }
  return `<a class="plate" data-state="${state}" href="/bilet/${n}" data-link aria-label="Билет ${n}: ${label}">
    ${main}
    <span class="region" aria-hidden="true">${String(n).padStart(2, "0")}<i>RUS<span class="bar" style="--p:${(pct * 100).toFixed(0)}%"></span></i></span>
  </a>`;
}

/* ---------- билет ---------- */

const backIcon = `<svg class="icon" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>`;
const restartIcon = `<svg class="icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

async function renderTicket(n) {
  const cfg = await loadConfig();
  if (n < 1 || n > cfg.tickets) return navigate("/", { replace: true });
  document.title = `Билет ${n} — ${SERVICE_NAME}`;

  view.innerHTML = `
    <div class="ex-header">
      <a class="back-btn" href="/" data-link aria-label="Все билеты">${backIcon}</a>
      <div class="titles"><h1>Билет ${n}</h1><p class="sub" id="tSub"></p></div>
      <span id="tStreak">${streakChip(streak())}</span>
      <button class="icon-btn" id="tRestart" type="button" title="Начать заново" aria-label="Начать билет заново">${restartIcon}</button>
    </div>
    <nav class="strip" id="tStrip" aria-label="Вопросы билета"></nav>
    <section class="card qcard" id="tStage" aria-live="polite"><p class="loading">Загрузка…</p></section>
  `;

  let questions;
  try { questions = await loadTicket(n); }
  catch (e) {
    console.error(e);
    $("tStage").innerHTML = `<p class="loading">Не получилось загрузить билет. Проверьте интернет и обновите страницу.</p>`;
    return;
  }
  if (location.pathname.replace(/\/+$/, "") !== `/bilet/${n}`) return; // ушли, пока грузился

  // Картинки всех вопросов билета — заранее, чтобы переход к следующему
  // вопросу не прыгал, пока грузится схема перекрёстка.
  for (const q of questions) if (q.image) { const i = new Image(); i.src = `/assets/q/${q.image}`; }

  let answers = { ...(getRun(n)?.answers || {}) };
  let idx = firstUnanswered();
  let finished = false;

  function firstUnanswered() {
    const i = questions.findIndex(q => !(q.num in answers));
    return i < 0 ? 0 : i;
  }
  const answeredCount = () => Object.keys(answers).length;

  // justNum — номер вопроса, на который только что ответили: его лампа
  // «загорается» (короткая вспышка), остальные просто горят.
  function renderStrip(justNum = null) {
    const pill = (q, i) => {
      const a = answers[q.num];
      const state = a === undefined ? "" : a === q.correct ? "ok" : "bad";
      return `<button type="button" class="pill ${state} ${q.num === justNum ? "lit" : ""} ${i === idx && !finished ? "current" : ""}" data-i="${i}"
        aria-label="Вопрос ${q.num}${state === "ok" ? ", верно" : state === "bad" ? ", ошибка" : ""}"
        ${i === idx && !finished ? 'aria-current="step"' : ""}>${q.num}</button>`;
    };
    // Группами по 5 — это блоки экзамена, от них зависит вердикт.
    const blocks = [];
    for (let b = 0; b < questions.length; b += 5) {
      blocks.push(`<div class="strip-block">${questions.slice(b, b + 5).map((q, k) => pill(q, b + k)).join("")}</div>`);
    }
    $("tStrip").innerHTML = blocks.join("");
    const wrong = questions.filter(q => q.num in answers && answers[q.num] !== q.correct).length;
    $("tSub").textContent = `${answeredCount()} из 20` + (wrong ? ` · ${wrong} ${plural(wrong, "ошибка", "ошибки", "ошибок")}` : "");
  }

  function renderQuestion({ justAnswered = false } = {}) {
    finished = false;
    const q = questions[idx];
    const chosen = answers[q.num];
    const answered = chosen !== undefined;
    const isLast = answeredCount() === questions.length;
    // Тот же вопрос перерисовывается после ответа — картинку не пересоздаём,
    // иначе она на кадр гаснет в чёрное, пока браузер заново её декодирует.
    const keepImg = $("tStage").querySelector(`.qimg[data-q="${q.id}"]`);

    $("tStage").innerHTML = `
      ${q.image ? `<div class="qimg" data-q="${q.id}"><img src="/assets/q/${q.image}" width="604" height="225" alt="Иллюстрация к вопросу ${q.num}"></div>` : ""}
      <p class="qnum">Вопрос ${q.num} из 20</p>
      <h2 class="qtext">${esc(q.text)}</h2>
      <ol class="answers">
        ${q.answers.map((a, i) => {
          let cls = "";
          if (answered) cls = i === q.correct ? "correct" : i === chosen ? "wrong" : "dim";
          return `<li><button type="button" class="answer ${cls}" data-a="${i}" ${answered ? "disabled" : ""}>
            <span class="key">${i + 1}</span><span class="txt">${esc(a)}</span></button></li>`;
        }).join("")}
      </ol>
      ${answered ? `
        <div class="verdict ${chosen === q.correct ? "ok" : "bad"}" role="status">${chosen === q.correct ? "Верно" : `Неверно — правильный ответ ${q.correct + 1}`}</div>
        ${q.tip ? `<div class="tip"><p>${esc(q.tip)}</p>${q.ref ? `<p class="ref">${esc(q.ref)}</p>` : ""}</div>` : ""}
        <div class="qnav">
          <button type="button" class="btn primary" id="tNext">${isLast ? "Итог билета" : "Дальше"}</button>
        </div>` : ""}
    `;
    if (keepImg) $("tStage").querySelector(".qimg").replaceWith(keepImg);
    // Новый вопрос въезжает; тот же после ответа — нет, меняются только ответы.
    const stage = $("tStage");
    if (!keepImg && !justAnswered) { stage.classList.remove("enter"); void stage.offsetWidth; stage.classList.add("enter"); }
    if (justAnswered) stage.querySelector(chosen === q.correct ? ".answer.correct" : ".answer.wrong")?.classList.add("just");
    for (const b of stage.querySelectorAll(".answer")) {
      b.addEventListener("click", () => choose(Number(b.dataset.a)));
    }
    $("tNext")?.addEventListener("click", next);
    renderStrip(justAnswered ? q.num : null);
    // Фокус на «Дальше» после ответа — чтобы Enter/пробел вели вперёд и с
    // клавиатуры, и с экранной читалки.
    if (answered) $("tNext")?.focus({ preventScroll: true });
  }

  function choose(a) {
    const q = questions[idx];
    if (q.num in answers || a < 0 || a >= q.answers.length) return;
    answers[q.num] = a;
    const { lit } = recordAnswer(n, q.num, q, a);
    renderQuestion({ justAnswered: true });
    const st = streak();
    $("tStreak").innerHTML = streakChip(st);
    if (lit) celebrateLit(st);
    // На телефоне пояснение оказывается ниже экрана — подкатываем к нему.
    $("tNext")?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function next() {
    if (answeredCount() === questions.length) return showResult();
    // Следующий неотвеченный после текущего, по кругу — если человек
    // перепрыгивал по ленте, возвращаемся к пропущенным.
    for (let k = 1; k <= questions.length; k++) {
      const j = (idx + k) % questions.length;
      if (!(questions[j].num in answers)) { idx = j; break; }
    }
    renderQuestion();
    window.scrollTo({ top: 0 });
  }

  function showResult() {
    finished = true;
    const v = verdict(questions, answers);
    const correct = questions.length - v.wrong;
    finishRun(n, correct, v.passed);
    const mistakes = questions.filter(q => answers[q.num] !== q.correct);
    const nextN = n % cfg.tickets + 1;

    $("tStage").innerHTML = `
      <div class="result ${v.passed ? "pass" : "fail"}">
        ${dial({ value: correct, max: 20, unit: "из 20" })}
        <h2>${v.title}</h2>
        <p>${v.text}</p>
        <div class="actions">
          <a class="btn primary" href="/bilet/${nextN}" data-link>Билет ${nextN}</a>
          <button type="button" class="btn" id="tAgain">Решить заново</button>
        </div>
      </div>
      ${mistakes.length ? `
        <h3 class="section-title">Разбор ошибок</h3>
        <ol class="mistakes">
          ${mistakes.map(q => `
            <li>
              <p class="m-q"><span class="m-num">${q.num}</span>${esc(q.text)}</p>
              ${q.image ? `<img class="m-img" src="/assets/q/${q.image}" width="604" height="225" alt="" loading="lazy">` : ""}
              <p class="m-a bad">Ваш ответ: ${esc(q.answers[answers[q.num]])}</p>
              <p class="m-a ok">Правильно: ${esc(q.answers[q.correct])}</p>
              ${q.tip ? `<p class="m-tip">${esc(q.tip)}${q.ref ? ` <span class="ref">${esc(q.ref)}</span>` : ""}</p>` : ""}
            </li>`).join("")}
        </ol>` : ""}
    `;
    $("tAgain").addEventListener("click", restart);
    startDials($("tStage").querySelector(".result"));
    renderStrip();
    window.scrollTo({ top: 0 });
  }

  function restart() {
    resetRun(n);
    answers = {};
    idx = 0;
    renderQuestion();
    window.scrollTo({ top: 0 });
  }

  $("tStrip").addEventListener("click", e => {
    const b = e.target.closest(".pill");
    if (!b) return;
    idx = Number(b.dataset.i);
    renderQuestion();
  });
  $("tRestart").addEventListener("click", () => {
    if (answeredCount() && !finished && !confirm("Начать билет заново? Ответы в этом билете сбросятся, статистика по вопросам останется.")) return;
    restart();
  });

  // Клавиатура: 1–5 — ответ, Enter/→ — дальше, ← — предыдущий вопрос.
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea")) return;
    if (finished) return;
    const q = questions[idx];
    if (/^[1-5]$/.test(e.key) && !(q.num in answers)) { e.preventDefault(); choose(Number(e.key) - 1); }
    else if ((e.key === "Enter" || e.key === "ArrowRight") && q.num in answers && e.target.id !== "tNext") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft" && idx > 0) { e.preventDefault(); idx--; renderQuestion(); }
  };
  document.addEventListener("keydown", onKey);
  cleanup = () => document.removeEventListener("keydown", onKey);

  // Билет уже был решён целиком, но итог не показан (закрыли вкладку на
  // последнем вопросе) — сразу к итогу.
  if (answeredCount() === questions.length) showResult();
  else renderQuestion();
}

route();
