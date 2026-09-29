#!/usr/bin/env node
/**
 * Импорт билетов ПДД (категория A/B) из открытого датасета
 * github.com/etspring/pdd_russia в свой формат.
 *
 *   node tools/import.mjs              последний коммит master
 *   node tools/import.mjs <sha>        конкретный коммит (воспроизводимо)
 *
 * Что делает:
 *   - качает 40 файлов «Билет N.json» и приводит к компактному виду:
 *     bank/ab.json — все вопросы, bank/meta.json — версия и темы;
 *   - качает ТОЛЬКО картинки, на которые ссылаются билеты (в папке датасета
 *     их вдвое больше — старые версии), в assets/q/<hash>.jpg;
 *   - удаляет картинки, которые больше не нужны;
 *   - печатает diff против прошлого импорта: какие вопросы ушли и пришли.
 *
 * Ключ вопроса — id из датасета (md5 от текста вопроса и ответов). Если в
 * квартальном обновлении поменяли формулировку, id тоже меняется: это
 * фактически новый вопрос, и история ответов на старый к нему не относится.
 * Так и задумано — см. ARCHITECTURE.md, «База билетов».
 *
 * Сеть нужна только здесь. В рантайме сервер отдаёт уже сохранённые файлы.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "etspring/pdd_russia";
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const BANK_DIR = path.join(ROOT, "bank");
const IMG_DIR = path.join(ROOT, "assets", "q");
const TICKETS = 40;

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "burninghouse-pdd-import" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
async function getBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "burninghouse-pdd-import" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const raw = (sha, p) => `https://raw.githubusercontent.com/${REPO}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`;

/** «Правильный ответ: 2» и is_correct должны сходиться — если нет, датасет
 * сломан, и лучше упасть на импорте, чем учить людей неправильному. */
function correctIndex(q) {
  const flags = q.answers.map(a => a.is_correct);
  const idx = flags.indexOf(true);
  if (idx < 0 || flags.lastIndexOf(true) !== idx) throw new Error(`Вопрос ${q.id}: не ровно один правильный ответ`);
  const m = /(\d+)/.exec(q.correct_answer || "");
  if (m && Number(m[1]) - 1 !== idx) throw new Error(`Вопрос ${q.id}: correct_answer расходится с is_correct`);
  return idx;
}

/** Пояснения в датасете склеены со ссылкой на пункт без пробела:
 * «…на дороге.(Пункт 1.2 ПДД)». Разделяем, ссылку показываем отдельно. */
function splitTip(tip) {
  const t = String(tip || "").trim();
  const m = /^(.*?)[\s.]*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\.?$/s.exec(t);
  if (m && /пункт|ПДД|статья|КоАП|знак|разметк|перечень|«|"/i.test(m[2])) return { tip: m[1].trim().replace(/\.?$/, "."), ref: m[2].trim() };
  return { tip: t, ref: null };
}

async function main() {
  let sha = process.argv[2];
  if (!sha) {
    sha = (await getJson(`https://api.github.com/repos/${REPO}/commits/master`)).sha;
  }
  const commit = await getJson(`https://api.github.com/repos/${REPO}/commits/${sha}`);
  // «2026.q3.0: квартальное обновление ПДД (#31)» → версия «2026.q3.0»
  const subject = commit.commit.message.split("\n")[0];
  const version = subject.split(":")[0].trim();
  console.log(`Датасет: ${sha.slice(0, 7)} — ${subject} (${commit.commit.committer.date})`);

  const questions = [];
  for (let n = 1; n <= TICKETS; n++) {
    const list = await getJson(raw(sha, `questions/A_B/tickets/Билет ${n}.json`));
    if (list.length !== 20) throw new Error(`Билет ${n}: ${list.length} вопросов вместо 20`);
    list.forEach((q, i) => {
      const img = q.image && !q.image.includes("no_image") ? path.basename(q.image) : null;
      const { tip, ref } = splitTip(q.answer_tip);
      questions.push({
        id: q.id,
        ticket: n,
        num: i + 1,
        text: q.question.trim(),
        image: img,
        answers: q.answers.map(a => a.answer_text.trim()),
        correct: correctIndex(q),
        tip,
        ref,
        topics: q.topic,
      });
    });
  }
  console.log(`Билеты: ${TICKETS} × 20`);

  // Один и тот же вопрос в двух билетах — не ошибка датасета (в 2026.q3 таких
  // шесть). id у копий одинаковый, значит и статистика по ним общая: ответил
  // верно в 9-м билете — вопрос считается выученным и в 17-м. Это правильно.
  const dup = questions.filter((q, i) => questions.findIndex(x => x.id === q.id) !== i);
  if (dup.length) console.log(`Вопросы, которые есть в двух билетах (статистика у них общая): ${dup.map(q => `${q.id} (б${q.ticket} в${q.num})`).join(", ")}`);

  // Картинки: качаем недостающие, удаляем лишние.
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const need = new Set(questions.map(q => q.image).filter(Boolean));
  const have = new Set(fs.readdirSync(IMG_DIR));
  let fetched = 0;
  for (const img of need) {
    if (have.has(img)) continue;
    fs.writeFileSync(path.join(IMG_DIR, img), await getBuffer(raw(sha, `images/A_B/${img}`)));
    fetched++;
  }
  let removed = 0;
  for (const f of have) if (!need.has(f)) { fs.unlinkSync(path.join(IMG_DIR, f)); removed++; }
  console.log(`Картинки: нужно ${need.size}, скачано ${fetched}, удалено ${removed}`);

  // Diff против прошлого импорта.
  fs.mkdirSync(BANK_DIR, { recursive: true });
  const bankPath = path.join(BANK_DIR, "ab.json");
  if (fs.existsSync(bankPath)) {
    const old = new Set(JSON.parse(fs.readFileSync(bankPath, "utf8")).map(q => q.id));
    const now = new Set(questions.map(q => q.id));
    const gone = [...old].filter(id => !now.has(id));
    const added = [...now].filter(id => !old.has(id));
    console.log(`Изменения: ушло ${gone.length}, пришло ${added.length}`);
    for (const id of added) { const q = questions.find(x => x.id === id); console.log(`  + б${q.ticket} в${q.num}: ${q.text.slice(0, 70)}`); }
  }

  const topics = [...new Set(questions.flatMap(q => q.topics))].sort((a, b) => a.localeCompare(b, "ru"));
  fs.writeFileSync(bankPath, JSON.stringify(questions));
  fs.writeFileSync(path.join(BANK_DIR, "meta.json"), JSON.stringify({
    source: `https://github.com/${REPO}`,
    sha,
    version,
    importedAt: new Date().toISOString(),
    tickets: TICKETS,
    questions: questions.length,
    topics,
  }, null, 2) + "\n");
  console.log(`Готово: ${questions.length} вопросов, ${topics.length} тем → bank/`);
}

main().catch(e => { console.error("\n" + e.message); process.exit(1); });
