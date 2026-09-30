"use strict";
/**
 * «Когда на права?» — фронт. Роутер на History API (/, /bilet/7), как у Brain:
 * пути настоящие ради поиска, сервер отдаёт на каждый тот же index.html.
 *
 * Вход через общий аккаунт BurningHouse необязателен. Вошедшему правду даёт
 * сервер (/api/me: огонёк, план, заморозки, сводка), гостю — localStorage
 * (progress.js). Экраны не различают эти случаи: читают currentSummary() /
 * currentStreak() / currentPlan(), а за ними уже решено, откуда данные.
 */
import {
  getRun, setRunAnswer, resetRun, localRuns, getLocalPlan, setLocalPlan, targetFor,
  recordGuestAnswer, finishGuestRun, guestSummary, guestStreak,
  hasGuestStats, exportGuest, clearGuestStats, outbox, outboxPush, outboxDrop, plural,
  guestQState, recordGuestExam,
} from "./progress.js";

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

/* Тихий фон — машина встаёт: дорога замирает. Над вопросом думают, фон не
   должен отвлекать. */
const QUIET_KEY = "bh-quiet";
function isQuiet() { try { return localStorage.getItem(QUIET_KEY) === "1"; } catch { return false; } }
function applyQuiet(on) {
  $("backdrop").classList.toggle("parked", on);
  $("quietBtn").classList.toggle("is-active", on);
}
applyQuiet(isQuiet());
$("quietBtn").addEventListener("click", () => {
  const next = !isQuiet();
  try { localStorage.setItem(QUIET_KEY, next ? "1" : "0"); } catch {}
  applyQuiet(next);
});

/* ---------- приложение на экран (PWA) ----------
   sw.js кэширует оболочку и билеты — решать можно и без сети. Кнопка
   «Установить» появляется, только когда браузер сам готов предложить установку. */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* без офлайна страница всё равно рабочая */ });
  });
}
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredInstall = e;
  $("installBtn").classList.remove("is-hidden");
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("installBtn").classList.add("is-hidden");
});
window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  $("installBtn").classList.add("is-hidden");
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

/* ---------- данные: сервер для вошедшего, localStorage для гостя ---------- */

// createAuthClient/AuthRequiredError — глобали из assets/auth-client.js
// (обычный <script>, копия Auth/client/auth-client-browser.js).
let auth = null;   // null — вход недоступен (нет AUTH_ISSUER или сервер лёг)
let me = null;     // ответ /api/me; null — гость
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
const ME_CACHE = "bh-pdd-me";

const signedIn = () => !!(auth && auth.isAuthenticated());
const currentSummary = cfg => me ? me.summary : guestSummary(cfg.unique);
const currentStreak = cfg => me ? me.streak : guestStreak(cfg.unique);
const currentPlan = () => me ? me.plan : getLocalPlan();

function setMe(next) {
  me = next;
  // Последний известный /api/me — чтобы без сети вошедший видел свой
  // огонёк, а не пустой гостевой.
  try { next ? localStorage.setItem(ME_CACHE, JSON.stringify(next)) : localStorage.removeItem(ME_CACHE); } catch {}
}

async function apiJson(path, init = {}) {
  const res = await auth.fetch(path, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function loadMe() {
  setMe(await apiJson(`/api/me?tz=${encodeURIComponent(TZ)}`));
}

/** Ответ из ответа сервера — обновляет огонёк и сводку, не перезагружая /api/me. */
function applyServer(r) {
  if (!me || !r) return;
  if (r.streak) me.streak = r.streak;
  if (r.summary) me.summary = r.summary;
  if (r.plan) me.plan = r.plan;
  setMe(me);
}

const newRid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/** Отправить ответ; не вышло — в очередь, отправится позже со своим временем
 * и id (повтор сервер не засчитает дважды). Возвращает { lit }. Без сети
 * огонёк считаем оптимистично, чтобы человек сразу видел, что норма закрыта. */
async function submitAnswer(ticket, num, q, chosen, mode = "ticket") {
  const item = { questionId: q.id, chosen, mode, rid: newRid(), at: Date.now(), tz: TZ };
  try {
    const r = await apiJson("/api/answers", { method: "POST", body: item });
    applyServer(r);
    return { lit: r.lit };
  } catch (e) {
    // Вход протух насовсем — дальше человек гость, ответ не теряем.
    if (e.name === "AuthRequiredError") { setMe(null); applyAuthButton(); return recordGuestAnswer(ticket, num, q, chosen, config.unique); }
    outboxPush(item);
    if (!me) return { lit: false }; // первый вход и сразу без сети — считать не от чего
    const st = me.streak, before = st.todayCount;
    st.todayCount++;
    const lit = before < st.target && st.todayCount >= st.target;
    if (lit) { st.todayDone = true; st.current++; }
    setMe(me);
    return { lit };
  }
}

async function flushOutbox() {
  for (const item of outbox()) {
    try {
      applyServer(await apiJson("/api/answers", { method: "POST", body: item }));
      outboxDrop(item.rid);
    } catch (e) {
      if (e.status === 400) outboxDrop(item.rid); // вопрос убрали из базы — не держим вечно
      else break;                                 // сети всё ещё нет — попробуем в следующий раз
    }
  }
}

/* Кнопка входа в шапке: гость — войти, вошедший — выйти. */
const RETURN_KEY = "bh-pdd-return";
function login() {
  try { sessionStorage.setItem(RETURN_KEY, location.pathname); } catch {}
  auth.login();
}
function applyAuthButton() {
  const btn = $("authBtn");
  if (!auth) return;
  btn.classList.remove("is-hidden");
  btn.classList.toggle("is-active", signedIn());
  const who = me?.user?.name;
  btn.title = signedIn() ? `Выйти${who ? ` (${who})` : ""}` : "Войти через аккаунт BurningHouse";
  btn.setAttribute("aria-label", btn.title);
}
$("authBtn").addEventListener("click", () => {
  if (!auth) return;
  if (signedIn()) { setMe(null); auth.logout(); } else login();
});

/** Вход: обмен кода, подгрузка /api/me, один раз — перенос гостя. Ошибки
 * сети не фатальны: гость решает и без этого, вошедший — по кэшу. */
async function initAuth() {
  const cfg = await loadConfig();
  if (!cfg.authBase || typeof createAuthClient !== "function") return;
  auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    // Фиксированный корень: redirect_uri сверяется побайтово с тем, что
    // зарегистрировано в auth, а маршрутов у нас много. Куда вернуться — RETURN_KEY.
    redirectUri: location.origin + "/",
    storagePrefix: "pdd",
  });
  let justLoggedIn = false;
  try { justLoggedIn = await auth.handleRedirect(); } catch (e) { console.error("Вход не завершился:", e); }
  if (signedIn()) {
    try { me = JSON.parse(localStorage.getItem(ME_CACHE)); } catch { me = null; }
    try {
      await flushOutbox();
      await loadMe();
      if (!me.guestImported && hasGuestStats()) {
        await apiJson("/api/import-guest", { method: "POST", body: exportGuest() });
        clearGuestStats();
        await loadMe();
      }
    } catch (e) {
      if (e.name === "AuthRequiredError") setMe(null);
      else console.error("Не удалось загрузить профиль:", e);
    }
  }
  applyAuthButton();
  if (justLoggedIn) {
    let back = null;
    try { back = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); } catch {}
    if (back && back !== location.pathname) history.replaceState(null, "", back);
  }
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

/** Скорость дороги на фоне — от огонька: погас — стоим, тлеет — едем
 * медленно, горит — крейсерская. */
function setDrive(st) {
  $("backdrop").dataset.drive = flameState(st);
}

/** Реакция машины на ответ: ok — газует, bad — тормозит и заносит,
 * lit — подпрыгивает. Перезапуск анимации — через снятие класса и reflow. */
let carTimer = 0;
function carReact(kind) {
  const car = $("car");
  car.classList.remove("ok", "bad", "lit");
  void car.offsetWidth;
  car.classList.add(kind);
  clearTimeout(carTimer);
  carTimer = setTimeout(() => car.classList.remove(kind), kind === "bad" ? 1300 : 1600);
  if (kind === "ok") roadSpeed([[0, 1], [.25, 5], [.6, 3.5], [1, 1]], 1600);   // разгон
  if (kind === "bad") roadSpeed([[0, 1], [.15, .15], [.7, .35], [1, 1]], 1300); // торможение
}

/* Скорость дороги во время реакции — через playbackRate её CSS-анимации
   (Web Animations API): в отличие от смены animation-duration, дорога не
   перескакивает, а плавно разгоняется и тормозит. Если машина стоит (огонёк
   погас или «приглушить фон»), на время реакции дорога всё равно едет. */
let roadRaf = 0;
function roadSpeed(curve, ms) {
  if (reducedMotion()) return;
  const anim = document.querySelector(".road-strip")?.getAnimations?.()[0];
  if (!anim) return;
  cancelAnimationFrame(roadRaf);
  const wasPaused = getComputedStyle(document.querySelector(".road-strip")).animationPlayState === "paused";
  anim.play();
  const t0 = performance.now();
  const at = k => {
    for (let i = 1; i < curve.length; i++) {
      if (k <= curve[i][0]) {
        const [k0, v0] = curve[i - 1], [k1, v1] = curve[i];
        const e = (k - k0) / (k1 - k0), s = e * e * (3 - 2 * e); // плавно на стыках
        return v0 + (v1 - v0) * s;
      }
    }
    return curve[curve.length - 1][1];
  };
  const tick = now => {
    const k = Math.min(1, (now - t0) / ms);
    anim.playbackRate = at(k);
    if (k < 1) roadRaf = requestAnimationFrame(tick);
    else { anim.playbackRate = 1; if (wasPaused) anim.pause(); }
  };
  roadRaf = requestAnimationFrame(tick);
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

const snowIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M4.2 6.5l15.6 9M4.2 17.5l15.6-9M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5M2.8 10l3.6 1-1 3.6M21.2 14l-3.6-1 1-3.6M2.8 14l3.6-1-1-3.6M21.2 10l-3.6 1 1 3.6"/></svg>`;

function planLabel(plan) {
  if (plan?.kind === "exam_date") {
    const d = new Date(plan.date + "T12:00:00");
    return `к экзамену ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
  }
  const t = plan?.tickets || 1;
  return `${t} ${plural(t, "билет", "билета", "билетов")} в день`;
}

/** Строка под огоньком: план и заморозки (заморозки — только у вошедших:
 * у гостя их нет, вместо них — приглашение войти). */
function streakFooter(st, plan) {
  let freezes = "";
  if (st.freezes !== null && st.freezes !== undefined) {
    const next = st.nextFreezeIn ? ` · новая через ${st.nextFreezeIn} ${daysWord(st.nextFreezeIn)}` : "";
    freezes = `<span class="freezes" title="Заморозка спасает огонёк, если пропустил день. Копится за 7 дней подряд, в запасе — до двух."
      aria-label="Заморозки: ${st.freezes} из 2">
      ${[0, 1].map(i => `<i class="${i < st.freezes ? "on" : ""}">${snowIcon}</i>`).join("")}
      <span>${st.freezes ? `${st.freezes} ${plural(st.freezes, "заморозка", "заморозки", "заморозок")}` : "заморозок нет"}${next}</span>
    </span>`;
  } else if (auth) {
    freezes = `<span class="login-hint"><span>Заморозки и огонёк на всех устройствах</span>
      <button type="button" class="btn-mini" data-login>Войти</button></span>`;
  }
  return `<div class="streak-foot">
    <div class="plan-row">
      <span class="plan-name">План: <b>${esc(planLabel(plan))}</b></span>
      <a class="btn-mini" href="/plan" data-link>Настроить план</a>
    </div>
    ${freezes ? `<div class="foot-extra">${freezes}</div>` : ""}
  </div>`;
}

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
  if (p === "/plan") return renderPlan();
  if (p === "/ekzamen") return renderExam();
  if (p === "/oshibki") return renderMistakes();
  if (p === "/temy") return renderTopics();
  const mini = /^\/mini\/(\d{1,2})$/.exec(p);
  if (mini && Number(mini[1]) >= 5 && Number(mini[1]) <= 20) return renderMini(Number(mini[1]));
  const t = /^\/tema\/(\d{1,2})$/.exec(p);
  if (t) return renderTopic(Number(t[1]));
  navigate("/", { replace: true });
}

/* ---------- главная ---------- */

async function renderHub() {
  document.title = `${SERVICE_NAME} — билеты ПДД 2026 категории A и B онлайн`;
  const cfg = await loadConfig();
  const s = { ...currentSummary(cfg), runs: localRuns() };

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
      ${(setDrive(currentStreak(cfg)), streakBlock(currentStreak(cfg)))}
      ${streakFooter(currentStreak(cfg), currentPlan())}
      <div class="dials">
        ${dial({ value: currentStreak(cfg).todayCount, max: currentStreak(cfg).target, unit: plural(s.todayCount, "вопрос", "вопроса", "вопросов"), label: "сегодня" })}
        ${dial({ value: s.learned, max: cfg.questions, label: `решено верно из ${cfg.questions}`, big: true })}
        ${dial({ value: s.passedTickets, max: cfg.tickets, unit: `из ${cfg.tickets}`, label: "билетов сдано" })}
      </div>
    </section>
    <div class="lamps">
      ${s.mistakes
        ? `<a class="lamp warn" href="/oshibki" data-link>${s.mistakes} ${plural(s.mistakes, "ошибка", "ошибки", "ошибок")} на повторение</a>`
        : s.learned ? `<span class="lamp ok">Ошибок на повторение нет</span>` : ""}
    </div>
    <div class="actions hub-actions">
      <a class="btn primary" href="${primary.href}" data-link>${esc(primary.label)}${primary.hint ? `<span class="btn-hint">${primary.hint}</span>` : ""}</a>
      <button class="btn" id="randomBtn" type="button">Случайный билет</button>
    </div>

    <div class="modes">
      <a class="mode" href="/ekzamen" data-link>
        <b>Экзамен</b><span>20 вопросов, 20 минут</span>
        ${s.exams?.last ? `<em class="${s.exams.last.passed ? "ok" : "bad"}">последний: ${s.exams.last.passed ? "сдал" : "не сдал"}</em>` : ""}
      </a>
      <div class="mode mini">
        <b>Мини-билет</b><span>Случайные вопросы из всех билетов</span>
        <span class="mini-pick">${MINI_SIZES.map(k => `<a href="/mini/${k}" data-link aria-label="Мини-билет: ${k} вопросов">${k}</a>`).join("")}</span>
      </div>
      <a class="mode" href="/oshibki" data-link>
        <b>Ошибки</b><span>${s.mistakes ? `${s.mistakes} ${plural(s.mistakes, "вопрос", "вопроса", "вопросов")} на повторение` : "повторять пока нечего"}</span>
      </a>
      <a class="mode" href="/temy" data-link>
        <b>Темы</b><span>${cfg.topics.length} разделов правил</span>
      </a>
    </div>

    <h2 class="section-title">Друзья</h2>
    <div class="friends" id="friends">${me ? `<p class="loading">Загрузка…</p>` : friendsGuest()}</div>

    <h2 class="section-title">Билеты</h2>
    <div class="plates">
      ${Array.from({ length: cfg.tickets }, (_, i) => ticketPlate(i + 1, s)).join("")}
    </div>

    <p class="dataset-note">Вопросы — официальные билеты ГИБДД, база
      <a href="https://github.com/etspring/pdd_russia" rel="noopener" target="_blank">pdd_russia</a>,
      версия ${esc(cfg.dataset.version)}.</p>
  `;
  view.querySelector("[data-login]")?.addEventListener("click", login);
  $("randomBtn").addEventListener("click", () => {
    navigate(`/bilet/${pool[Math.floor(Math.random() * pool.length)]}`);
  });
  startDials(view.querySelector(".dash"), { ignition: firstVisitThisSession() });
  view.querySelector("#friends [data-login]")?.addEventListener("click", login);
  if (me) loadFriends();
}

/* ---------- друзья ----------
   Список — из Auth (через наш /api/friends), огоньки и прогресс — наши.
   Друзьям видно: серию, выполнена ли норма сегодня, сколько билетов сдано и
   последний экзамен. Конкретные ответы и ошибки — нет. */

function friendsGuest() {
  return `<div class="friends-empty">
    <p>Войдите — будет видно огоньки друзей, и можно будет подталкивать друг друга.</p>
    ${auth ? `<button type="button" class="btn-mini" data-login>Войти</button>` : ""}
  </div>`;
}

async function loadFriends() {
  const box = $("friends");
  let data;
  try { data = await apiJson("/api/friends"); }
  catch (e) {
    console.error("Друзья:", e);
    if (box) box.innerHTML = `<p class="friends-note">Не получилось загрузить друзей — попробуйте позже.</p>`;
    return;
  }
  if (!$("friends")) return; // ушли с главной, пока грузилось
  // Сначала те, у кого огонёк горит сегодня, потом по длине серии, потом —
  // кто ещё не начинал.
  const rank = f => !f.started ? 3 : f.streak.todayDone ? 0 : f.streak.current ? 1 : 2;
  const list = [...data.friends].sort((a, b) => rank(a) - rank(b) || (b.streak?.current || 0) - (a.streak?.current || 0));
  const invite = `
    <div class="friends-actions">
      ${data.inviteLink ? `<button type="button" class="btn-mini" id="inviteBtn">Пригласить друга</button>` : ""}
      <a class="btn-mini ghost" href="${esc(data.accountUrl)}" target="_blank" rel="noopener">Друзья в аккаунте</a>
      ${data.incoming ? `<span class="friends-note">${data.incoming} ${plural(data.incoming, "заявка", "заявки", "заявок")} в друзья ждут ответа в аккаунте</span>` : ""}
    </div>`;
  $("friends").innerHTML = list.length
    ? `<ul class="friend-list">${list.map(friendRow).join("")}</ul>${invite}`
    : `<div class="friends-empty"><p>Пока никого. Позовите друга — держать огонёк вдвоём проще.</p></div>${invite}`;

  $("inviteBtn")?.addEventListener("click", async () => {
    const text = "Готовлюсь к экзамену на права — давай вместе, с огоньком за каждый день:";
    try {
      if (navigator.share) await navigator.share({ title: SERVICE_NAME, text, url: data.inviteLink });
      else { await navigator.clipboard.writeText(`${text} ${data.inviteLink}`); $("inviteBtn").textContent = "Ссылка скопирована"; }
    } catch { /* отменили «поделиться» — ничего не делаем */ }
  });
  for (const b of $("friends").querySelectorAll("[data-nudge]")) b.addEventListener("click", () => nudge(b));
}

function friendRow(f) {
  let flame = "out", line, action = "";
  if (!f.started) {
    line = `<span class="f-sub">ещё не начинал(а)</span>`;
    action = f.nudgedToday ? `<span class="f-sent">позвали</span>` : `<button type="button" class="btn-mini" data-nudge="${esc(f.userId)}">Позвать</button>`;
  } else {
    const s = f.streak;
    flame = flameState(s);
    const today = s.todayDone ? `сегодня ✓` : `сегодня ${s.todayCount}/${s.target}`;
    const exam = f.lastExam ? ` · экзамен: ${f.lastExam.passed ? "сдал(а)" : "не сдал(а)"}` : "";
    line = `<span class="f-sub">${today} · билетов сдано ${f.passedTickets}/40${exam}</span>`;
    if (s.todayDone) action = `<span class="f-sent ok">молодец</span>`;
    else action = f.nudgedToday ? `<span class="f-sent">подтолкнули</span>` : `<button type="button" class="btn-mini" data-nudge="${esc(f.userId)}">Подтолкнуть</button>`;
  }
  const days = f.started && f.streak.current ? `${f.streak.current} ${daysWord(f.streak.current)} подряд` : "огонёк не горит";
  return `<li class="friend" data-state="${flame}">
    ${flameSvg(flame)}
    <span class="f-main"><b>${esc(f.name)}</b><span class="f-days">${f.started ? days : ""}</span>${line}</span>
    <span class="f-act">${action}</span>
  </li>`;
}

async function nudge(btn) {
  btn.disabled = true;
  const label = btn.textContent;
  try {
    await apiJson(`/api/friends/${encodeURIComponent(btn.dataset.nudge)}/nudge`, { method: "POST", body: {} });
    btn.replaceWith(Object.assign(document.createElement("span"), { className: "f-sent", textContent: label === "Позвать" ? "позвали" : "подтолкнули" }));
  } catch (e) {
    const msg = e.status === 409 ? "уже решил(а)" : e.status === 429 ? "уже сегодня" : "не вышло";
    btn.replaceWith(Object.assign(document.createElement("span"), { className: "f-sent", textContent: msg }));
  }
}

/* Входящие толчки и напоминания — уведомления Auth от нашего сервиса. При
   открытии показываем непрочитанные тостом и гасим. Auth пускает сюда по
   CORS (Auth/INTEGRATION.md, «Уведомления»). */
async function showIncoming() {
  if (!auth || !signedIn()) return;
  let list;
  try {
    const res = await auth.fetch(`${auth.authBase}/api/notifications?unread=1`);
    if (!res.ok) return;
    list = (await res.json()).notifications.filter(n => n.source === "pdd" && /^pdd\./.test(n.type));
  } catch { return; }
  if (!list.length) return;
  const n = list[0];
  const el = document.createElement("div");
  el.className = "lit-toast nudge-toast";
  el.setAttribute("role", "status");
  el.innerHTML = `${flameSvg(n.type === "pdd.streak_risk" ? "ember" : "lit")}
    <div><p class="lt-title">${esc(n.title)}</p>${list.length > 1 ? `<p class="lt-days">и ещё ${list.length - 1}</p>` : n.body ? `<p class="lt-days">${esc(n.body)}</p>` : ""}</div>`;
  document.body.append(el);
  const close = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 300); };
  el.addEventListener("click", close);
  setTimeout(close, 6000);
  for (const x of list) auth.fetch(`${auth.authBase}/api/notifications/${encodeURIComponent(x.id)}/read`, { method: "POST" }).catch(() => {});
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

/* ---------- мотивация ----------
   По ходу — просто: фраза к ответу, «+1», значок серии. В конце билета и
   экзамена — полноценно: карточка с финишным флагом, конфетти, огонёк, машина
   подпрыгивает (celebrateFinish). Фразы — наборы, показываются случайно,
   чтобы не приедались. */

const pickOne = list => list[Math.floor(Math.random() * list.length)];
const COMBO_MARKS = [3, 5, 10, 15, 20];
const PRAISE_OK = ["В точку", "Чётко", "Так держать", "Отлично", "Верно подмечено", "Как по учебнику", "Уверенно", "Зачёт"];
const PRAISE_BAD = ["Бывает — теперь запомнишь", "Разберись в пояснении", "Вернётся в «ошибки» — добьём", "Хорошо, что здесь, а не на экзамене", "Ничего, это тренировка"];
const FINISH = {
  perfect: ["Идеально!", "Ни одной ошибки!", "Чистый заезд!", "Как по нотам!", "Инспектор аплодирует!"],
  pass: ["Молодец!", "Инспектор доволен!", "Права всё ближе!", "Отличная езда!", "Так держать!", "Уверенный зачёт!"],
  fail: ["Почти получилось", "Ещё один заезд — и сдашь", "Ошибки — тоже тренировка", "Не сдал — зато знаешь, что подтянуть", "Не беда, попробуем ещё"],
};
const CONFETTI_COLORS = ["#ffffff", "#30d158", "#ffcc00", "#2f6fd6", "#ff453a"];

const flagSvg = `<svg class="fo-flag" viewBox="0 0 64 48" aria-hidden="true">
  <rect x="4" y="2" width="3" height="46" rx="1.5" fill="currentColor" opacity=".8"/>
  <g class="fo-cloth">${Array.from({ length: 24 }, (_, i) => {
    const c = i % 6, r = Math.floor(i / 6);
    return `<rect x="${7 + c * 9}" y="${4 + r * 8}" width="9" height="8" fill="${(c + r) % 2 ? "#111" : "#fff"}"/>`;
  }).join("")}</g>
</svg>`;

/** Праздник в конце: kind — perfect | pass | fail. Сам уходит через ~3 с. */
function celebrateFinish({ kind, sub = "" }) {
  document.querySelector(".finish-overlay")?.remove();
  const good = kind !== "fail";
  const el = document.createElement("div");
  el.className = `finish-overlay ${kind}`;
  el.setAttribute("role", "status");
  const confetti = good && !reducedMotion()
    ? Array.from({ length: 42 }, () => `<i style="--x:${(Math.random() * 100).toFixed(1)}vw;--dx:${(Math.random() * 30 - 15).toFixed(0)}vw;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;--d:${(1.8 + Math.random() * 1.4).toFixed(2)}s;--t:${(Math.random() * .5).toFixed(2)}s;--c:${pickOne(CONFETTI_COLORS)};--w:${(6 + Math.random() * 6).toFixed(0)}px"></i>`).join("")
    : "";
  el.innerHTML = `
    <div class="fo-confetti" aria-hidden="true">${confetti}</div>
    <div class="fo-card">
      <div class="fo-icons">${good ? flagSvg : ""}${flameSvg(good ? "lit" : "ember", "fo-flame")}</div>
      <h2>${esc(pickOne(FINISH[kind]))}</h2>
      ${sub ? `<p>${esc(sub)}</p>` : ""}
    </div>`;
  document.body.append(el);
  if (good) { carReact("lit"); roadSpeed([[0, 1], [.3, 4], [1, 1]], 2200); }
  const close = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 350); };
  el.addEventListener("click", close);
  setTimeout(close, good ? 3200 : 2600);
}

/* ---------- решатель ----------
   Один экран вопросов на все режимы: билет, экзамен, ошибки, тема. Режим
   отличается настройками (opts), а не своей копией вёрстки:

     questions      — массив вопросов (может расти: доп. вопросы экзамена);
     mode           — 'ticket' | 'exam' | 'mistakes' | 'topic' (уходит на сервер);
     feedback       — показывать ли сразу верно/неверно и пояснение (на
                      экзамене — нет, как в ГИБДД);
     grouped        — лента по 5 (блоки экзамена) или сплошная;
     initial        — уже данные ответы {индекс: вариант} (незаконченный билет);
     ticketKey(i)   — для билета: [номер билета, номер вопроса] — куда писать
                      незаконченный билет; для остальных режимов null;
     onAnswer(i,a,answers) — после ответа: вернуть { stop: true }, чтобы
                      закончить досрочно (экзамен), или { wait: Promise } —
                      дождаться, пока в questions добавятся доп. вопросы;
     result(answers)— HTML итога и обработчики (возвращает { html, bind });
     extraHeader    — HTML справа в шапке (таймер экзамена). */

const backIcon = `<svg class="icon" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>`;
const restartIcon = `<svg class="icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

function quizShell({ title, backHref = "/", backLabel = "На главную", restart = true, extraHeader = "" }, cfg) {
  view.innerHTML = `
    <div class="ex-header">
      <a class="back-btn" href="${backHref}" data-link aria-label="${esc(backLabel)}">${backIcon}</a>
      <div class="titles"><h1>${esc(title)}</h1><p class="sub" id="tSub"></p></div>
      ${extraHeader}
      <span id="tStreak">${(setDrive(currentStreak(cfg)), streakChip(currentStreak(cfg)))}</span>
      ${restart ? `<button class="icon-btn" id="tRestart" type="button" title="Начать заново" aria-label="Начать заново">${restartIcon}</button>` : ""}
    </div>
    <nav class="strip" id="tStrip" aria-label="Вопросы"></nav>
    <section class="card qcard" id="tStage" aria-live="polite"><p class="loading">Загрузка…</p></section>
  `;
}

/** Ответ в огонёк и статистику — сервер для вошедшего, localStorage гостю. */
function recordAny(cfg, q, a, mode, ticket, num) {
  if (me) {
    if (ticket != null) setRunAnswer(ticket, num, a);
    return submitAnswer(ticket, num, q, a, mode);
  }
  return Promise.resolve(recordGuestAnswer(ticket, num, q, a, cfg.unique));
}

function runQuiz(cfg, o) {
  const questions = o.questions;
  let answers = { ...(o.initial || {}) };
  // Мотивация по ходу: фраза к каждому ответу (запоминаем, чтобы при
  // возврате к вопросу она не менялась) и серия верных подряд.
  const praise = {};
  let combo = 0, comboAt = null;
  let idx = 0, finished = false;
  const feedback = o.feedback !== false;
  const answeredCount = () => Object.keys(answers).length;
  const firstUnanswered = () => { const i = questions.findIndex((_, k) => !(k in answers)); return i < 0 ? 0 : i; };
  idx = firstUnanswered();

  for (const q of questions) if (q.image) { const i = new Image(); i.src = `/assets/q/${q.image}`; }

  function renderStrip(justI = null) {
    const pill = (q, i) => {
      const a = answers[i];
      // На экзамене лента не выдаёт правильность — только «отвечено».
      const state = a === undefined ? "" : !feedback && !finished ? "done" : a === q.correct ? "ok" : "bad";
      const cur = i === idx && !finished;
      return `<button type="button" class="pill ${state} ${i === justI ? "lit" : ""} ${cur ? "current" : ""} ${q.extra ? "extra" : ""}" data-i="${i}"
        aria-label="Вопрос ${i + 1}${state === "ok" ? ", верно" : state === "bad" ? ", ошибка" : state === "done" ? ", отвечен" : ""}"
        ${cur ? 'aria-current="step"' : ""}>${i + 1}</button>`;
    };
    const blocks = [];
    const step = o.grouped ? 5 : questions.length;
    for (let b = 0; b < questions.length; b += step) {
      blocks.push(`<div class="strip-block" style="--n:${Math.min(step, questions.length - b)}">${questions.slice(b, b + step).map((q, k) => pill(q, b + k)).join("")}</div>`);
    }
    const strip = $("tStrip");
    strip.classList.toggle("flat", !o.grouped);
    strip.innerHTML = blocks.join("");
    const wrong = feedback || finished ? questions.filter((q, i) => i in answers && answers[i] !== q.correct).length : 0;
    $("tSub").textContent = `${answeredCount()} из ${questions.length}` + (wrong ? ` · ${wrong} ${plural(wrong, "ошибка", "ошибки", "ошибок")}` : "");
  }

  function renderQuestion({ justAnswered = false } = {}) {
    const q = questions[idx];
    const chosen = answers[idx];
    const answered = chosen !== undefined;
    const showTruth = answered && feedback;
    const isLast = answeredCount() === questions.length;
    // Тот же вопрос перерисовывается после ответа — картинку не пересоздаём,
    // иначе она на кадр гаснет в чёрное, пока браузер заново её декодирует.
    const keepImg = $("tStage").querySelector(`.qimg[data-q="${q.id}"]`);
    const label = q.extra ? `Дополнительный вопрос` : o.numbered ? `Вопрос ${q.num} из 20` : `Вопрос ${idx + 1} из ${questions.length}`;
    const src = o.showSource ? `<span class="qsrc">билет ${q.ticket}, вопрос ${q.num}</span>` : "";

    $("tStage").innerHTML = `
      ${q.image ? `<div class="qimg" data-q="${q.id}"><img src="/assets/q/${q.image}" width="604" height="225" alt="Иллюстрация к вопросу"></div>` : ""}
      <p class="qnum">${label}${src}</p>
      <h2 class="qtext">${esc(q.text)}</h2>
      <ol class="answers">
        ${q.answers.map((a, i) => {
          let cls = "";
          if (showTruth) cls = i === q.correct ? "correct" : i === chosen ? "wrong" : "dim";
          else if (answered) cls = i === chosen ? "picked" : "dim";
          return `<li><button type="button" class="answer ${cls}" data-a="${i}" ${answered ? "disabled" : ""}>
            <span class="key">${i + 1}</span><span class="txt">${esc(a)}</span></button></li>`;
        }).join("")}
      </ol>
      ${showTruth ? `
        <div class="verdict ${chosen === q.correct ? "ok" : "bad"}" role="status">
          ${chosen === q.correct
            ? `Верно<span class="v-praise">${esc(praise[idx] || "")}</span>${justAnswered ? `<span class="plus-one" aria-hidden="true">+1</span>` : ""}`
            : `Неверно — правильный ответ ${q.correct + 1}<span class="v-praise">${esc(praise[idx] || "")}</span>`}
          ${justAnswered && comboAt === idx ? `<span class="combo-chip">${flameSvg("lit")}${combo} подряд!</span>` : ""}
        </div>
        ${q.tip ? `<div class="tip"><p>${esc(q.tip)}</p>${q.ref ? `<p class="ref">${esc(q.ref)}</p>` : ""}</div>` : ""}` : ""}
      ${answered && feedback ? `<div class="qnav"><button type="button" class="btn primary" id="tNext">${isLast ? "Итог" : "Дальше"}</button></div>` : ""}
    `;
    if (keepImg) $("tStage").querySelector(".qimg").replaceWith(keepImg);
    const stage = $("tStage");
    if (!keepImg && !justAnswered) { stage.classList.remove("enter"); void stage.offsetWidth; stage.classList.add("enter"); }
    if (justAnswered && showTruth) stage.querySelector(chosen === q.correct ? ".answer.correct" : ".answer.wrong")?.classList.add("just");
    for (const b of stage.querySelectorAll(".answer")) b.addEventListener("click", () => choose(Number(b.dataset.a)));
    $("tNext")?.addEventListener("click", next);
    renderStrip(justAnswered ? idx : null);
    if (answered) $("tNext")?.focus({ preventScroll: true });
  }

  function choose(a) {
    const q = questions[idx];
    if (idx in answers || finished || a < 0 || a >= q.answers.length) return;
    answers[idx] = a;
    if (feedback) {
      praise[idx] = pickOne(a === q.correct ? PRAISE_OK : PRAISE_BAD);
      combo = a === q.correct ? combo + 1 : 0;
      comboAt = COMBO_MARKS.includes(combo) ? idx : null;
    }
    const [ticket, num] = o.ticketKey ? o.ticketKey(idx) : [null, null];
    // Машина реагирует только там, где правильность и так видна: на
    // экзамене она не должна подсказывать.
    if (feedback) carReact(a === q.correct ? "ok" : "bad");
    recordAny(cfg, q, a, o.mode, ticket, num).then(({ lit }) => {
      const st = currentStreak(cfg);
      if ($("tStreak")) $("tStreak").innerHTML = streakChip(st);
      setDrive(st);
      if (lit) { celebrateLit(st); setTimeout(() => carReact("lit"), 700); }
    });
    const after = o.onAnswer ? o.onAnswer(idx, a, answers) : null;
    if (after?.stop) return showResult();
    renderQuestion({ justAnswered: true });
    if (feedback) {
      $("tNext")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    } else {
      // Экзамен: выбор подсвечивается и через мгновение — следующий вопрос.
      // Если сейчас подгружаются доп. вопросы — ждём их, иначе экзамен
      // закончился бы раньше, чем они появились.
      Promise.all([after?.wait, new Promise(r => setTimeout(r, 350))]).then(() => { if (!finished) next(); });
    }
  }

  function next() {
    if (answeredCount() === questions.length) return showResult();
    for (let k = 1; k <= questions.length; k++) {
      const j = (idx + k) % questions.length;
      if (!(j in answers)) { idx = j; break; }
    }
    renderQuestion();
    window.scrollTo({ top: 0 });
  }

  function showResult(extra = {}) {
    if (finished) return;
    finished = true;
    cleanupTimer();
    const r = o.result(answers, extra);
    // Билет и экзамен празднуют всегда (или поддерживают при провале) — это
    // решают их result(). Мини-билет, ошибки, темы — только когда всё верно.
    const allRight = questions.every((q, i) => answers[i] === q.correct);
    const party = r.celebrate ?? (allRight ? { kind: "perfect", sub: `Все ${questions.length} верно` } : null);
    if (party) setTimeout(() => celebrateFinish(party), 250);
    $("tStage").innerHTML = r.html;
    r.bind?.($("tStage"));
    startDials($("tStage").querySelector(".result"));
    renderStrip();
    window.scrollTo({ top: 0 });
  }

  function restart() {
    o.onRestart?.();
    answers = {};
    idx = 0;
    finished = false;
    renderQuestion();
    window.scrollTo({ top: 0 });
  }

  $("tStrip").addEventListener("click", e => {
    const b = e.target.closest(".pill");
    if (!b || finished) return;
    idx = Number(b.dataset.i);
    renderQuestion();
  });
  $("tRestart")?.addEventListener("click", () => {
    if (answeredCount() && !finished && !confirm("Начать заново? Ответы сбросятся, статистика по вопросам останется.")) return;
    restart();
  });

  // Клавиатура: 1–5 — ответ, Enter/→ — дальше, ← — предыдущий вопрос.
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea")) return;
    if (finished) return;
    if (/^[1-5]$/.test(e.key) && !(idx in answers)) { e.preventDefault(); choose(Number(e.key) - 1); }
    else if ((e.key === "Enter" || e.key === "ArrowRight") && idx in answers && e.target.id !== "tNext") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft" && idx > 0) { e.preventDefault(); idx--; renderQuestion(); }
  };
  document.addEventListener("keydown", onKey);
  let cleanupTimer = () => {};
  cleanup = () => { document.removeEventListener("keydown", onKey); cleanupTimer(); };

  if (answeredCount() === questions.length) showResult();
  else renderQuestion();

  return {
    finish: extra => showResult(extra),
    rerender: () => { if (!finished) renderStrip(); },
    setTimerCleanup: fn => { cleanupTimer = fn; },
    get finished() { return finished; },
  };
}

/** Разбор ошибок — общий для билета, экзамена и тем. */
function mistakesList(questions, answers) {
  const wrong = questions.map((q, i) => [q, i]).filter(([q, i]) => i in answers && answers[i] !== q.correct);
  if (!wrong.length) return "";
  return `
    <h3 class="section-title">Разбор ошибок</h3>
    <ol class="mistakes">
      ${wrong.map(([q, i]) => `
        <li>
          <p class="m-q"><span class="m-num">${i + 1}</span>${esc(q.text)}</p>
          ${q.image ? `<img class="m-img" src="/assets/q/${q.image}" width="604" height="225" alt="" loading="lazy">` : ""}
          <p class="m-a bad">Ваш ответ: ${esc(q.answers[answers[i]])}</p>
          <p class="m-a ok">Правильно: ${esc(q.answers[q.correct])}</p>
          ${q.tip ? `<p class="m-tip">${esc(q.tip)}${q.ref ? ` <span class="ref">${esc(q.ref)}</span>` : ""}</p>` : ""}
        </li>`).join("")}
    </ol>`;
}

function loadFailed() {
  $("tStage").innerHTML = `<p class="loading">Не получилось загрузить вопросы. Проверьте интернет и обновите страницу.</p>`;
}
const stillOn = path => location.pathname.replace(/\/+$/, "") === path;

/* ---------- билет ---------- */

async function renderTicket(n) {
  const cfg = await loadConfig();
  if (n < 1 || n > cfg.tickets) return navigate("/", { replace: true });
  document.title = `Билет ${n} ПДД 2026 категории AB — ${SERVICE_NAME}`;
  quizShell({ title: `Билет ${n}`, backLabel: "Все билеты" }, cfg);

  let questions;
  try { questions = await loadTicket(n); } catch (e) { console.error(e); return loadFailed(); }
  if (!stillOn(`/bilet/${n}`)) return;

  // Незаконченный билет хранится по номеру вопроса, решатель — по индексу.
  const saved = getRun(n)?.answers || {};
  const initial = {};
  questions.forEach((q, i) => { if (q.num in saved) initial[i] = saved[q.num]; });

  runQuiz(cfg, {
    questions, mode: "ticket", grouped: true, numbered: true, initial,
    ticketKey: i => [n, questions[i].num],
    onRestart: () => resetRun(n),
    result(answers) {
      const byNum = {};
      questions.forEach((q, i) => { byNum[q.num] = answers[i]; });
      const v = verdict(questions, byNum);
      const correct = questions.length - v.wrong;
      // Рекорд сравниваем с тем, что было ДО этого решения.
      const prevBest = currentSummary(cfg).tickets?.[n]?.best;
      const finishSub = prevBest === undefined ? `${correct} из 20 — билет ${n} пройден впервые`
        : correct > prevBest ? `Новый рекорд билета: ${correct} из 20 (было ${prevBest})` : `${correct} из 20`;
      if (me) {
        resetRun(n);
        apiJson(`/api/tickets/${n}/finish`, { method: "POST", body: { answers: byNum } }).then(applyServer).catch(e => console.error("Итог билета не сохранился:", e));
      } else finishGuestRun(n, correct, v.passed);
      const nextN = n % cfg.tickets + 1;
      return {
        html: `
          <div class="result ${v.passed ? "pass" : "fail"}">
            ${dial({ value: correct, max: 20, unit: "из 20" })}
            <h2>${v.title}</h2>
            <p>${v.text}</p>
            <div class="actions">
              <a class="btn primary" href="/bilet/${nextN}" data-link>Билет ${nextN}</a>
              <button type="button" class="btn" data-again>Решить заново</button>
            </div>
            <div class="actions result-home"><a class="btn" href="/" data-link>На главную</a></div>
          </div>
          ${mistakesList(questions, answers)}`,
        bind: el => el.querySelector("[data-again]").addEventListener("click", () => { resetRun(n); route(); }),
        celebrate: { kind: v.wrong === 0 ? "perfect" : v.passed ? "pass" : "fail", sub: finishSub },
      };
    },
  });
}

/* ---------- экзамен ----------
   Как в ГИБДД: случайный билет, 20 вопросов в 4 блоках по 5, 20 минут.
   Правильность не показывается до конца. Ошибка в блоке — после основных
   вопросов ещё 5 из этого же блока другого билета и +5 минут. Две ошибки в
   одном блоке, три всего, ошибка в дополнительных или конец времени —
   экзамен заканчивается сразу. Итог пересчитывает сервер (lib/store.js). */

const EXAM_REASON = {
  block: "Две ошибки в одном блоке — на экзамене это «не сдал».",
  many: "Третья ошибка — на экзамене это «не сдал».",
  extra: "Ошибка в дополнительных вопросах — на экзамене это «не сдал».",
  timeout: "Время вышло — на экзамене это «не сдал».",
};

async function renderExam() {
  const cfg = await loadConfig();
  document.title = `Экзамен ПДД онлайн как в ГИБДД — ${SERVICE_NAME}`;
  quizShell({ title: "Экзамен", restart: false, extraHeader: `<span class="timer" id="tTimer" role="timer" aria-live="off">20:00</span>` }, cfg);

  const pick = (except = []) => {
    const pool = Array.from({ length: cfg.tickets }, (_, i) => i + 1).filter(t => !except.includes(t));
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const mainT = pick();
  let main;
  try { main = await loadTicket(mainT); } catch (e) { console.error(e); return loadFailed(); }
  if (!stillOn("/ekzamen")) return;

  const questions = main.map(q => ({ ...q, block: Math.ceil(q.num / 5), extra: false }));
  const usedTickets = [mainT];
  const wrongByBlock = [0, 0, 0, 0];
  const pendingExtra = [];     // блоки, за которые ещё не выданы доп. вопросы
  const started = Date.now();
  let deadline = started + 20 * 60 * 1000;
  let stopReason = null;

  const quiz = runQuiz(cfg, {
    questions, mode: "exam", grouped: true, feedback: false,
    onAnswer(i, a, answers) {
      const q = questions[i];
      if (a !== q.correct) {
        if (q.extra) { stopReason = "extra"; return { stop: true }; }
        wrongByBlock[q.block - 1]++;
        const total = wrongByBlock.reduce((x, y) => x + y, 0);
        if (wrongByBlock[q.block - 1] >= 2) { stopReason = "block"; return { stop: true }; }
        if (total > 2) { stopReason = "many"; return { stop: true }; }
        pendingExtra.push(q.block);
      }
      // Основные отвечены — выдаём доп. вопросы за каждую ошибку, +5 минут на блок.
      const mainDone = questions.filter((x, k) => !x.extra && k in answers).length === 20;
      if (mainDone && pendingExtra.length) return { wait: addExtras() };
      return null;
    },
    result(answers, extra) {
      const timeout = !!extra.timeout;
      const reason = timeout ? "timeout" : stopReason;
      const passed = !reason;
      const wrong = questions.filter((q, i) => i in answers && answers[i] !== q.correct).length;
      const answeredN = Object.keys(answers).length;
      const seconds = Math.round((Date.now() - started) / 1000);
      const items = questions.map((q, i) => i in answers ? { questionId: q.id, chosen: answers[i], block: q.block, extra: q.extra } : null).filter(Boolean);
      if (me) apiJson("/api/exams", { method: "POST", body: { items, seconds, timeout } }).then(applyServer).catch(e => console.error("Экзамен не сохранился:", e));
      else recordGuestExam({ passed, reason, wrong });
      const mm = Math.floor(seconds / 60), ss = String(seconds % 60).padStart(2, "0");
      return {
        html: `
          <div class="result ${passed ? "pass" : "fail"}">
            ${dial({ value: answeredN - wrong, max: questions.length, unit: `из ${questions.length}` })}
            <h2>${passed ? "Сдал!" : "Не сдал"}</h2>
            <p>${passed ? (wrong ? "С дополнительными вопросами — но сдал." : "Без единой ошибки.") : EXAM_REASON[reason]} Время: ${mm}:${ss}.</p>
            <div class="actions">
              <a class="btn primary" href="/ekzamen" data-link data-again>Ещё экзамен</a>
              <a class="btn" href="/" data-link>На главную</a>
            </div>
          </div>
          ${mistakesList(questions, answers)}`,
        bind: el => el.querySelector("[data-again]").addEventListener("click", e => { e.preventDefault(); route(); }),
        celebrate: {
          kind: !passed ? "fail" : wrong === 0 ? "perfect" : "pass",
          sub: passed ? `Экзамен сдан за ${mm}:${ss}${wrong ? " — с дополнительными вопросами" : ""}` : EXAM_REASON[reason].replace(" — на экзамене это «не сдал».", ""),
        },
      };
    },
  });
  async function addExtras() {
    const blocks = pendingExtra.splice(0);
    for (const block of blocks) {
      const t = pick(usedTickets);
      usedTickets.push(t);
      let qs;
      try { qs = await loadTicket(t); } catch { continue; }
      for (const q of qs.filter(x => Math.ceil(x.num / 5) === block)) questions.push({ ...q, block, extra: true });
      deadline += 5 * 60 * 1000;
    }
    quiz.rerender();
  }

  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    const el = $("tTimer");
    if (el) {
      el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
      el.classList.toggle("low", left < 60000);
    }
    if (left <= 0 && !quiz.finished) quiz.finish({ timeout: true });
  };
  const timerId = setInterval(tick, 1000);
  quiz.setTimerCleanup(() => clearInterval(timerId));
  tick();
}

/* ---------- работа над ошибками ----------
   Вопросы, где ошибался и ещё не ответил верно дважды подряд. За подход — до
   20, сначала давние. Список берётся с сервера (/api/me/qstate) или у гостя. */

async function qState() {
  if (me) { try { return await apiJson("/api/me/qstate"); } catch (e) { console.error(e); } }
  return guestQState();
}

async function renderMistakes() {
  const cfg = await loadConfig();
  document.title = `Работа над ошибками — ${SERVICE_NAME}`;
  quizShell({ title: "Работа над ошибками", restart: false }, cfg);
  const { mistakes } = await qState();
  if (!stillOn("/oshibki")) return;
  if (!mistakes.length) {
    $("tStrip").innerHTML = "";
    $("tSub").textContent = "";
    $("tStage").innerHTML = `<div class="result pass"><h2>Ошибок нет</h2><p>Здесь собираются вопросы, в которых вы ошибались. Вопрос уходит отсюда, когда ответите на него верно дважды подряд.</p>
      <div class="actions"><a class="btn primary" href="/" data-link>На главную</a></div></div>`;
    return;
  }
  let questions;
  try { questions = (await (await fetch(`/api/questions?ids=${mistakes.slice(0, 20).join(",")}`)).json()).questions; }
  catch (e) { console.error(e); return loadFailed(); }
  if (!stillOn("/oshibki")) return;
  runQuiz(cfg, {
    questions, mode: "mistakes", showSource: true,
    result(answers) {
      const right = questions.filter((q, i) => answers[i] === q.correct).length;
      return {
        html: `
          <div class="result ${right === questions.length ? "pass" : "fail"}">
            ${dial({ value: right, max: questions.length, unit: `из ${questions.length}` })}
            <h2>Подход закончен</h2>
            <p>Вопрос уходит из ошибок после двух верных ответов подряд — те, что сейчас решены верно, вернутся ещё раз.</p>
            <div class="actions">
              <a class="btn primary" href="/oshibki" data-link data-again>Ещё подход</a>
              <a class="btn" href="/" data-link>На главную</a>
            </div>
          </div>
          ${mistakesList(questions, answers)}`,
        bind: el => el.querySelector("[data-again]").addEventListener("click", e => { e.preventDefault(); route(); }),
      };
    },
  });
}

/* ---------- мини-билет ----------
   N случайных вопросов из всей базы (5–20) — короткий подход, когда на
   целый билет нет времени. Ответ и пояснение — сразу, как в билете. */

const MINI_SIZES = [5, 10, 15];

async function renderMini(n) {
  const cfg = await loadConfig();
  document.title = `Мини-билет: ${n} случайных вопросов ПДД — ${SERVICE_NAME}`;
  quizShell({ title: `Мини-билет · ${n}`, restart: false }, cfg);
  let questions;
  try { questions = (await (await fetch(`/api/random?n=${n}`)).json()).questions; }
  catch (e) { console.error(e); return loadFailed(); }
  if (!stillOn(`/mini/${n}`)) return;
  runQuiz(cfg, {
    questions, mode: "mini", showSource: true,
    result(answers) {
      const right = questions.filter((q, i) => answers[i] === q.correct).length;
      return {
        html: `
          <div class="result ${right === questions.length ? "pass" : "fail"}">
            ${dial({ value: right, max: questions.length, unit: `из ${questions.length}` })}
            <h2>${right === questions.length ? "Без ошибок" : `${questions.length - right} ${plural(questions.length - right, "ошибка", "ошибки", "ошибок")}`}</h2>
            <p>${right === questions.length ? "Отличный подход." : "Ошибки попали в «работу над ошибками»."}</p>
            <div class="actions">
              <a class="btn primary" href="/mini/${n}" data-link data-again>Ещё ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}</a>
              <a class="btn" href="/" data-link>На главную</a>
            </div>
          </div>
          ${mistakesList(questions, answers)}`,
        bind: el => el.querySelector("[data-again]").addEventListener("click", e => { e.preventDefault(); route(); }),
      };
    },
  });
}

/* ---------- темы ---------- */

let topicsCache = null;
async function loadTopics() {
  if (!topicsCache) topicsCache = (await (await fetch("/api/topics")).json()).topics;
  return topicsCache;
}

async function renderTopics() {
  const cfg = await loadConfig();
  document.title = `Билеты ПДД по темам — ${SERVICE_NAME}`;
  view.innerHTML = `
    <div class="ex-header">
      <a class="back-btn" href="/" data-link aria-label="На главную">${backIcon}</a>
      <div class="titles"><h1>Темы</h1><p class="sub">Вопросы всех билетов, собранные по разделам правил</p></div>
    </div>
    <div class="topics" id="topics"><p class="loading">Загрузка…</p></div>`;
  let topics, st;
  try { [topics, st] = await Promise.all([loadTopics(), qState()]); } catch (e) { console.error(e); return; }
  if (!stillOn("/temy")) return;
  const learned = new Set(st.learned), wrong = new Set(st.mistakes);
  $("topics").innerHTML = topics
    .map(t => ({ ...t, done: t.ids.filter(id => learned.has(id)).length, bad: t.ids.filter(id => wrong.has(id)).length }))
    .map(t => `
      <a class="topic" href="/tema/${t.i}" data-link>
        <span class="t-name">${esc(t.name)}</span>
        <span class="t-meta">${t.done} из ${t.count}${t.bad ? ` · <b>${t.bad} ${plural(t.bad, "ошибка", "ошибки", "ошибок")}</b>` : ""}</span>
        <span class="t-bar"><i style="width:${(t.done / t.count * 100).toFixed(0)}%"></i></span>
      </a>`).join("");
}

async function renderTopic(i) {
  const cfg = await loadConfig();
  quizShell({ title: "Тема", backHref: "/temy", backLabel: "Все темы", restart: false }, cfg);
  let data, st;
  try { [data, st] = await Promise.all([fetch(`/api/topics/${i}`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }), qState()]); }
  catch (e) { console.error(e); return loadFailed(); }
  if (!stillOn(`/tema/${i}`)) return;
  document.title = `${data.name} — вопросы ПДД по теме — ${SERVICE_NAME}`;
  view.querySelector(".ex-header h1").textContent = data.name;
  // Подход — 20 вопросов: сначала ошибки, потом нерешённые, потом остальные.
  const learned = new Set(st.learned), wrong = new Set(st.mistakes);
  const rank = q => wrong.has(q.id) ? 0 : !learned.has(q.id) ? 1 : 2;
  const questions = [...data.questions].sort((a, b) => rank(a) - rank(b) || Math.random() - .5).slice(0, 20);
  runQuiz(cfg, {
    questions, mode: "topic", showSource: true,
    result(answers) {
      const right = questions.filter((q, k) => answers[k] === q.correct).length;
      return {
        html: `
          <div class="result ${right === questions.length ? "pass" : "fail"}">
            ${dial({ value: right, max: questions.length, unit: `из ${questions.length}` })}
            <h2>${esc(data.name)}</h2>
            <p>${right === questions.length ? "Всё верно." : "Ошибки попали в «работу над ошибками» — вернутся, пока не ответите верно дважды подряд."}</p>
            <div class="actions">
              <a class="btn primary" href="/tema/${i}" data-link data-again>Ещё 20 вопросов</a>
              <a class="btn" href="/temy" data-link>Все темы</a>
            </div>
          </div>
          ${mistakesList(questions, answers)}`,
        bind: el => el.querySelector("[data-again]").addEventListener("click", e => { e.preventDefault(); route(); }),
      };
    },
  });
}

// Вход — до первой отрисовки, чтобы вошедший сразу увидел свой огонёк,
// а не мелькнувший гостевой. Не вышло — рисуем как есть.
/* ---------- план ----------
   Готовые варианты и свой. «К дате экзамена» показывает норму сразу — ту же,
   что посчитает сервер (targetFor в progress.js и lib/store.js). */

async function renderPlan() {
  document.title = `План подготовки — ${SERVICE_NAME}`;
  const cfg = await loadConfig();
  const plan = currentPlan();
  const learned = currentSummary(cfg).learned;
  const todayKey = new Date().toLocaleDateString("sv-SE");
  const maxDate = (() => { const d = new Date(); d.setFullYear(d.getFullYear() + 2); return d.toLocaleDateString("sv-SE"); })();

  // Выбор на экране: kind + tickets / date. Пресеты — это daily с нужным числом.
  let sel = plan.kind === "exam_date"
    ? { kind: "exam_date", tickets: 2, date: plan.date }
    : { kind: "daily", tickets: plan.tickets, date: "" };
  const preset = t => sel.kind === "daily" && sel.tickets === t;
  const isCustom = () => sel.kind === "daily" && !preset(1) && !preset(3);

  const perDay = q => `${q} ${plural(q, "вопрос", "вопроса", "вопросов")} в день`;
  const examTarget = () => sel.date ? targetFor({ kind: "exam_date", date: sel.date }, learned, cfg.unique) : null;

  view.innerHTML = `
    <div class="ex-header">
      <a class="back-btn" href="/" data-link aria-label="На главную">${backIcon}</a>
      <div class="titles"><h1>План подготовки</h1><p class="sub">Сколько решать в день, чтобы горел огонёк</p></div>
    </div>
    <form class="plans" id="planForm">
      <label class="plan-opt"><input type="radio" name="p" value="d1">
        <span class="po-body"><b>Спокойно</b><span>1 билет в день — ${perDay(20)}</span></span></label>
      <label class="plan-opt"><input type="radio" name="p" value="d3">
        <span class="po-body"><b>Всерьёз</b><span>3 билета в день — ${perDay(60)}</span></span></label>
      <label class="plan-opt"><input type="radio" name="p" value="custom">
        <span class="po-body"><b>Свой темп</b><span id="customHint"></span></span>
        <span class="stepper" aria-label="Билетов в день">
          <button type="button" id="stMinus" aria-label="Меньше">−</button><output id="stVal"></output><button type="button" id="stPlus" aria-label="Больше">+</button>
        </span></label>
      <label class="plan-opt"><input type="radio" name="p" value="exam">
        <span class="po-body"><b>К дате экзамена</b><span id="examHint">Норма посчитается из того, что осталось выучить</span></span>
        <input type="date" id="examDate" min="${todayKey}" max="${maxDate}" value="${esc(sel.date)}" aria-label="Дата экзамена"></label>
      ${me ? `<label class="plan-opt remind">
        <span class="po-body"><b>Напоминание</b><span>Вечером, если огонёк под угрозой: серия есть, а норма ещё не выполнена</span></span>
        <select id="remindAt" aria-label="Время напоминания">
          ${[["", "Не напоминать"], ...["18:00", "19:00", "20:00", "21:00", "22:00"].map(t => [t, t])]
            .map(([v, l]) => `<option value="${v}" ${(me.remindAt || "") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
      <div class="plan-opt remind" id="pushRow">
        <span class="po-body"><b>Уведомления на это устройство</b><span id="pushHint">Проверяю…</span></span>
        <button type="button" class="btn-mini is-hidden" id="pushBtn"></button>
      </div>` : ""}
      <p class="plan-note">${me
        ? "План меняется с сегодняшнего дня — прошлые дни не пересчитываются, огонёк не пострадает."
        : "Без входа огонёк считается по текущему плану за все дни. Войдите — план будет честным, появятся заморозки."}</p>
      <div class="actions"><button class="btn primary" type="submit" id="planSave">Сохранить план</button>
        <a class="btn" href="/" data-link>Отмена</a></div>
      <p class="plan-err" id="planErr" role="alert"></p>
    </form>
  `;
  const form = $("planForm");
  const customT = { v: isCustom() ? sel.tickets : 2 };

  function sync() {
    const radio = sel.kind === "exam_date" ? "exam" : preset(1) ? "d1" : preset(3) ? "d3" : "custom";
    form.querySelector(`input[value="${radio}"]`).checked = true;
    for (const l of form.querySelectorAll(".plan-opt:not(.remind)")) l.classList.toggle("on", l.querySelector("input[type=radio]").checked);
    $("stVal").textContent = customT.v;
    $("customHint").textContent = `${customT.v} ${plural(customT.v, "билет", "билета", "билетов")} в день — ${perDay(customT.v * 20)}`;
    const t = examTarget();
    $("examHint").textContent = t
      ? `${perDay(t)} (≈ ${Math.ceil(t / 20)} ${plural(Math.ceil(t / 20), "билет", "билета", "билетов")}) — чтобы до экзамена решить всё`
      : "Норма посчитается из того, что осталось выучить";
    $("planSave").disabled = sel.kind === "exam_date" && !sel.date;
  }
  form.addEventListener("change", e => {
    if (e.target.name === "p") {
      const v = e.target.value;
      sel = v === "d1" ? { ...sel, kind: "daily", tickets: 1 } : v === "d3" ? { ...sel, kind: "daily", tickets: 3 }
        : v === "custom" ? { ...sel, kind: "daily", tickets: customT.v } : { ...sel, kind: "exam_date" };
    }
    if (e.target.id === "examDate") sel = { ...sel, kind: "exam_date", date: e.target.value };
    sync();
  });
  const step = d => { customT.v = Math.min(10, Math.max(1, customT.v + d)); sel = { ...sel, kind: "daily", tickets: customT.v }; sync(); };
  $("stMinus").addEventListener("click", () => step(-1));
  $("stPlus").addEventListener("click", () => step(1));
  $("examDate").addEventListener("focus", () => { sel = { ...sel, kind: "exam_date" }; sync(); });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const next = sel.kind === "exam_date" ? { kind: "exam_date", date: sel.date } : { kind: "daily", tickets: sel.tickets };
    $("planSave").disabled = true;
    try {
      if (me) {
        applyServer(await apiJson("/api/me/plan", { method: "PUT", body: { plan: next } }));
        const remindAt = $("remindAt").value || null;
        if (remindAt !== (me.remindAt ?? null)) { await apiJson("/api/me/settings", { method: "PUT", body: { remindAt } }); me.remindAt = remindAt; setMe(me); }
      }
      else setLocalPlan(next);
      navigate("/");
    } catch (err) {
      $("planErr").textContent = err.status === 400 ? "Такой план не подходит — проверьте дату." : "Не получилось сохранить — нет связи. Попробуйте ещё раз.";
      $("planSave").disabled = false;
    }
  });
  sync();
  if (me) setupPushRow();
}

/* ---------- уведомления на устройство (Web Push) ----------
   Подписка — на этом браузере/устройстве: сервер шлёт на неё толчки друзей и
   вечернее «огонёк гаснет» (lib/webpush.js), sw.js их показывает. Разрешение
   спрашиваем только по нажатию — браузеры не любят вопрос с порога. */

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
/** Готовый service worker — или null, если его нет за 5 секунд (выключены
 * в браузере, приватный режим и т.п.): иначе ready висел бы вечно. */
async function swReady() {
  return Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 5000))]);
}

async function setupPushRow() {
  const hint = $("pushHint"), btn = $("pushBtn");
  const show = (text, label, fn) => {
    hint.textContent = text;
    btn.classList.toggle("is-hidden", !label);
    if (label) { btn.textContent = label; btn.disabled = false; btn.onclick = fn; }
  };
  if (!pushSupported()) {
    return show(isIOS()
      ? "На iPhone уведомления работают, когда приложение установлено: «Поделиться» → «На экран „Домой“», потом откройте его оттуда."
      : "Этот браузер не умеет присылать уведомления.", null);
  }
  if (Notification.permission === "denied") {
    return show("Уведомления запрещены в настройках браузера для этого сайта — разрешите их там.", null);
  }
  const reg = await swReady();
  if (!reg) return show("Не получилось включить: браузер не дал запустить фоновую часть приложения.", null);
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") {
    // Переподписываем на сервере — подписка могла остаться от другого аккаунта.
    apiJson("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } }).catch(() => {});
    return show("Включены: толчки друзей и вечернее напоминание придут сюда.", "Выключить", async () => {
      btn.disabled = true;
      await apiJson("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
      setupPushRow();
    });
  }
  show("Толчки друзей и «огонёк гаснет» — в уведомления телефона или компьютера, даже когда сайт закрыт.", "Включить", async () => {
    btn.disabled = true;
    try {
      if (await Notification.requestPermission() !== "granted") return setupPushRow();
      const { publicKey } = await (await fetch("/api/push/key")).json();
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
      await apiJson("/api/push/subscribe", { method: "POST", body: { subscription: s.toJSON() } });
    } catch (e) {
      console.error("Push:", e);
      hint.textContent = "Не получилось включить уведомления — попробуйте ещё раз.";
      btn.disabled = false;
      return;
    }
    setupPushRow();
  });
}

initAuth().catch(e => console.error("Вход недоступен:", e)).finally(() => { route(); showIncoming(); });
