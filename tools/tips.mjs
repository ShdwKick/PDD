#!/usr/bin/env node
/**
 * Работа со своими пояснениями (bank/tips-own.json).
 *
 *   node tools/tips.mjs status              сколько билетов переписано
 *   node tools/tips.mjs dump 3 4            вопросы билетов для работы: текст,
 *                                           варианты, правильный, картинка,
 *                                           датасетное пояснение (как справка
 *                                           по фактам, не для пересказа)
 *   node tools/tips.mjs merge batch.json    влить пачку { id: { tip, ref } }:
 *                                           проверяет, что id есть в базе, что
 *                                           текст не пустой и не слишком
 *                                           похож на датасетный
 *   node tools/tips.mjs review 3 4 > f.md   «было / стало» для вычитки
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const OWN = path.join(ROOT, "bank", "tips-own.json");
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "ab.json"), "utf8"));
const own = fs.existsSync(OWN) ? JSON.parse(fs.readFileSync(OWN, "utf8")) : {};
const [cmd, ...args] = process.argv.slice(2);
const tickets = args.map(Number).filter(Boolean);

// Доля общих слов из 4 подряд — грубая проверка «не пересказ ли это».
function overlap(a, b) {
  const grams = s => {
    const w = String(s).toLowerCase().replace(/[^а-яёa-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const out = new Set();
    for (let i = 0; i + 3 < w.length; i++) out.add(w.slice(i, i + 4).join(" "));
    return out;
  };
  const A = grams(a), B = grams(b);
  if (!A.size) return 0;
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return n / A.size;
}

if (cmd === "status") {
  const done = new Map();
  for (const q of bank) {
    const t = done.get(q.ticket) || [0, 0];
    t[1]++; if (own[q.id]) t[0]++;
    done.set(q.ticket, t);
  }
  const full = [...done].filter(([, [a, b]]) => a === b).map(([t]) => t);
  const part = [...done].filter(([, [a, b]]) => a && a < b).map(([t, [a, b]]) => `${t} (${a}/${b})`);
  console.log(`Готово билетов: ${full.length}/40 — ${full.join(", ") || "—"}`);
  if (part.length) console.log(`Частично: ${part.join(", ")}`);
  console.log(`Пояснений: ${Object.keys(own).length}`);
} else if (cmd === "dump") {
  for (const q of bank.filter(q => tickets.includes(q.ticket))) {
    if (own[q.id]) continue; // уже переписан (например, дубль из другого билета)
    console.log(`\n## Б${q.ticket} В${q.num} ${q.id}${q.image ? ` IMG assets/q/${q.image}` : ""}`);
    console.log(q.text);
    q.answers.forEach((a, i) => console.log(`${i === q.correct ? "✔" : " "} ${i + 1}. ${a}`));
    console.log(`• ${q.tip}${q.ref ? ` [${q.ref}]` : ""}`);
  }
} else if (cmd === "merge") {
  const batch = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const byId = new Map(bank.map(q => [q.id, q]));
  let ok = 0;
  for (const [id, v] of Object.entries(batch)) {
    const q = byId.get(id);
    if (!q) { console.log(`ПРОПУСК ${id}: нет в базе`); continue; }
    if (!v || typeof v.tip !== "string" || v.tip.length < 40 || typeof v.ref !== "string" || !v.ref) { console.log(`ПРОПУСК Б${q.ticket}В${q.num}: пустое/короткое`); continue; }
    const ov = overlap(v.tip, q.tip);
    if (ov > 0.35) console.log(`ВНИМАНИЕ Б${q.ticket}В${q.num}: похоже на датасет (${Math.round(ov * 100)}%) — перепиши`);
    own[id] = { tip: v.tip.trim(), ref: v.ref.trim() };
    ok++;
  }
  fs.writeFileSync(OWN, JSON.stringify(own, null, 2) + "\n");
  console.log(`Влито: ${ok}. Всего пояснений: ${Object.keys(own).length}`);
} else if (cmd === "review") {
  let md = `# Пояснения: было и стало — билеты ${tickets.join(", ")}\n`;
  for (const q of bank.filter(q => tickets.includes(q.ticket))) {
    const o = own[q.id];
    md += `\n## Билет ${q.ticket}, вопрос ${q.num}\n\n**${q.text}**  \nПравильно: ${q.answers[q.correct]}\n\n`;
    md += `- **Было:** ${q.tip}${q.ref ? ` _(${q.ref})_` : ""}\n- **Стало:** ${o ? `${o.tip} _(${o.ref})_` : "— ещё нет —"}\n`;
  }
  process.stdout.write(md);
} else {
  console.log("Команды: status | dump <билеты> | merge <файл> | review <билеты>");
}
