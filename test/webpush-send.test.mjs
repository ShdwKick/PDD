// Отправка push целиком: настоящий send() → фальшивый push-сервис на
// localhost. Проверяем заголовки, подпись VAPID и что тело расшифровывается
// ключами «браузера».   node test/webpush-send.test.mjs
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createWebPush } = require("../lib/webpush.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};

const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
let got = null, status = 201;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => { got = { headers: req.headers, body: Buffer.concat(chunks) }; res.writeHead(status).end(); });
}).listen(0);
await new Promise(r => srv.on("listening", r));
const endpoint = `http://localhost:${srv.address().port}/push/abc`;

const wp = createWebPush({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "wp-")), subject: "https://pdd.burninghouse.ru" });
const sub = { endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
const msg = { title: "anya подталкивает: пора решить билеты", body: "Огонёк ждёт", url: "/", tag: "pdd-nudge" };
const r = await wp.send(sub, msg);
eq("push-сервис принял (201)", r, { ok: true });
eq("заголовки шифрования и TTL", [got.headers["content-encoding"], got.headers["content-type"], got.headers.ttl], ["aes128gcm", "application/octet-stream", "43200"]);

// VAPID: k= совпадает с публичным ключом, t= подписан им.
const m = /^vapid t=([^,]+), k=(.+)$/.exec(got.headers.authorization);
eq("Authorization: vapid t=…, k=…", !!m && m[2] === wp.publicKey, true);
const [h, c, s] = m[1].split(".");
const pub = Buffer.from(wp.publicKey, "base64url");
const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
eq("подпись VAPID проверяется", crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), true);

// Расшифровка тела «браузером».
const b = got.body, salt = b.subarray(0, 16), as = b.subarray(21, 21 + b[20]), data = b.subarray(21 + b[20]);
const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), as]);
const ikm = Buffer.from(crypto.hkdfSync("sha256", ua.computeSecret(as), authSecret, keyInfo, 32));
const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(data.subarray(-16));
const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
eq("сообщение расшифровано", JSON.parse(plain.subarray(0, -1).toString()), msg);

status = 410;
eq("отозванная подписка → gone", await wp.send(sub, msg), { gone: true });

srv.close();
console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
