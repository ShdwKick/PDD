// Скриншоты для Google Play: Edge без окна через DevTools Protocol.
// Запуск (нужен node dev.mjs на 8798): node android/store/make-screenshots.mjs android/store android/store/feature-graphic.html
// Гостевой профиль с примерным прогрессом, 1080×1920 (360×640 при DPR 3).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SITE = "http://localhost:8798";
const OUT = process.argv[2];
const FEATURE = process.argv[3];
const PORT = 9333;
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-shots-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let targets;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250);
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {}
}
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { ok, bad } = pending.get(m.id); pending.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); }
};
const cdp = (method, params = {}) => new Promise((ok, bad) => { const id = ++seq; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })); });
const run = async expr => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const go = async (url, wait = 3500) => { await cdp("Page.navigate", { url }); await sleep(wait); };
const shot = async name => {
  // Тосты значков/огонька и праздники — не на скриншот.
  await run(`document.querySelectorAll('.lit-toast,.finish-overlay,#installBtn').forEach(e => e.remove()); if (location.pathname === '/garazh') document.getElementById('car').style.display = 'none'; window.scrollTo(0, 0); true`);
  await sleep(300);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  console.log("готово:", name);
};

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 3, mobile: true });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await go(SITE + "/", 2500);

  // Примерный прогресс гостя: 12 дней огонька, 14 билетов сдано, тюнинг машины.
  const imageTicket = await run(`(async () => {
    const day = k => new Date(Date.now() - k * 864e5).toLocaleDateString("sv-SE");
    const d = { v: 1, q: {}, t: {}, days: {}, dok: {}, rec: { combo: 9, bestCombo: 46, night: false, early: true },
      runs: {}, exams: [], plan: { kind: "daily", tickets: 1 }, car: { paint: "white", stripes: "black", spoiler: "on", plate: "ЗА РУЛЁМ" },
      examStats: { count: 5, passed: 4, perfect: 1, fastest: 512 } };
    let withImage = null;
    for (let n = 1; n <= 40; n++) {
      const qs = (await (await fetch("/api/tickets/" + n)).json()).questions;
      if (!withImage && qs[0].image) withImage = n;
      if (n > 14) continue;
      qs.forEach((q, i) => { d.q[q.id] = { n: 2, ok: 2, last: i % 9 ? 1 : 0, streak: i % 9 ? 2 : 0, at: Date.now() }; });
      d.t[n] = { best: n % 3 ? 19 : 20, last: n % 3 ? 19 : 20, passed: true, everPassed: true, runs: 1, at: Date.now() };
    }
    for (let k = 0; k < 12; k++) { d.days[day(k)] = 20 + (k % 3) * 10; d.dok[day(k)] = 18 + (k % 3) * 9; }
    for (let k = 0; k < 5; k++) d.exams.push({ at: Date.now() - k * 864e5, passed: k !== 3, reason: k === 3 ? "block" : null, wrong: k % 2, seconds: 600 + k * 40 });
    localStorage.setItem("bh-pdd-v1", JSON.stringify(d));
    localStorage.setItem("bh-theme", "dark");
    sessionStorage.setItem("bh-pdd-ignition", "1");
    return withImage || 1;
  })()`);

  await go(SITE + "/", 4500);
  await shot("screenshot-1-glavnaya.png");
  await go(SITE + `/bilet/${imageTicket}`, 4000);
  await shot("screenshot-2-bilet.png");
  await go(SITE + "/ekzamen", 4000);
  await shot("screenshot-3-ekzamen.png");
  await go(SITE + "/garazh", 4000);
  await shot("screenshot-4-garazh.png");
  await go(SITE + "/znachki", 4000);
  await shot("screenshot-5-znachki.png");

  if (FEATURE) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1024, height: 500, deviceScaleFactor: 1, mobile: false });
    await go("file:///" + path.resolve(FEATURE).replace(/\\/g, "/"), 3000);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "feature-graphic.png"), Buffer.from(data, "base64"));
    console.log("готово: feature-graphic.png");
  }
} finally {
  ws.close();
  edge.kill();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
}
