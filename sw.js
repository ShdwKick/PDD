"use strict";
/* Service worker «Когда на права?» — чтобы приложение ставилось на экран и
   решало билеты без сети. Лежит в корне: scope по умолчанию — каталог, откуда
   загружен, а нужна вся страница ("/").

   Что кэшируем и как:
   - оболочка (index.html, стили, скрипты, иконки) — при установке; дальше
     «сеть, при неудаче — кэш», чтобы обновления доходили сразу;
   - картинки вопросов (/assets/q/) — кэш-первым: имена — хеш содержимого;
   - билеты и темы (/api/tickets, /api/topics, /api/config) — «сеть, при
     неудаче — кэш»: без сети решать можно то, что уже открывали;
   - личное (/api/me, /api/answers, ...) и всё не-GET — никогда: ответы без
     сети и так уходят в очередь (outbox в app.js).
   Навигация без сети — закэшированный index.html, путь разберёт роутер. */

const CACHE = "pdd-v14";
const SHELL = [
  "/", "/assets/styles.css", "/assets/brand.css", "/assets/app.js", "/assets/progress.js", "/assets/motivation.js",
  "/assets/auth-client.js", "/assets/favicon.svg", "/manifest.webmanifest",
  "/assets/icons/icon-192.png", "/assets/icons/icon-512.png", "/api/config",
];
const CACHEABLE_API = /^\/api\/(tickets\/\d+|topics(\/\d+)?|config)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

function networkFirst(req, fallbackKey) {
  return fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(fallbackKey || req, copy)); }
    return res;
  }).catch(() => caches.match(fallbackKey || req));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === "navigate") return e.respondWith(networkFirst(req, "/"));
  if (url.pathname.startsWith("/assets/q/")) {
    return e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
  if (url.pathname.startsWith("/api/")) {
    if (CACHEABLE_API.test(url.pathname)) e.respondWith(networkFirst(req));
    return; // остальное API — мимо кэша
  }
  if (url.pathname.startsWith("/assets/") || url.pathname === "/manifest.webmanifest") e.respondWith(networkFirst(req));
});

/* ---------- уведомления на устройство (Web Push) ----------
   Сервер шлёт зашифрованное сообщение { title, body, url, tag } (lib/webpush.js);
   браузер расшифровывает сам и отдаёт сюда. tag — чтобы второй толчок за вечер
   заменил первый, а не лёг рядом. */
self.addEventListener("push", e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || "Когда на права?", {
    body: m.body || "",
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/icon-192.png",
    tag: m.tag || "pdd",
    renotify: true,
    data: { url: m.url || "/" },
  }));
});

// Нажали на уведомление — открыть приложение: уже открытую вкладку/окно
// выводим вперёд, иначе открываем новое.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (same) { await same.focus(); if ("navigate" in same) await same.navigate(url).catch(() => {}); return; }
    await self.clients.openWindow(url);
  })());
});
