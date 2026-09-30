"use strict";
/**
 * Web Push без зависимостей — только node:crypto. Два стандарта:
 *
 *   VAPID (RFC 8292) — подпись «кто шлёт»: JWT на ES256 от ключа сервиса.
 *     Push-сервис браузера (FCM, Mozilla, Apple) по нему пускает запрос и
 *     сверяет с applicationServerKey, с которым браузер подписывался.
 *   aes128gcm (RFC 8291 + RFC 8188) — шифрование содержимого ключами
 *     подписки (p256dh + auth): push-сервис переносит сообщение, но
 *     прочитать его не может.
 *
 * Ключи VAPID генерируются один раз и лежат в data/vapid.json (или задаются
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Сменить их — значит обнулить все
 * подписки: браузеры подписаны на старый публичный ключ.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const b64u = buf => Buffer.from(buf).toString("base64url");
const unb64u = s => Buffer.from(String(s), "base64url");

/** Ключи VAPID: из окружения, из файла или новые (и сразу в файл). */
function loadVapid(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(dataDir, "vapid.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/** Приватный ключ P-256 из «сырого» вида (d + несжатая точка) — через JWK. */
function privateKeyObject({ publicKey, privateKey }) {
  const pub = unb64u(publicKey); // 0x04 || X(32) || Y(32)
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** VAPID JWT для push-сервиса endpoint'а. aud — его origin. */
function vapidJwt(endpoint, vapid, subject, keyObj) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: keyObj, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64u(sig)}`;
}

/** Шифрование по RFC 8291 (одна запись aes128gcm). salt и серверную пару
 * можно передать снаружи — только для тестов. */
function encrypt(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("bad subscription keys");
  if (!ecdh) { ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys(); }
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // Одна запись: данные + разделитель 0x02 («последняя запись»), без паддинга.
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);   // rs — размер записи
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function createWebPush({ dataDir, subject }) {
  const vapid = loadVapid(dataDir);
  const keyObj = privateKeyObject(vapid);

  /** Отправить одно уведомление. Возвращает { ok } или { gone: true }, если
   * подписка больше не действует (удалили в браузере, отозвали разрешение) —
   * такую надо стереть. */
  async function send(sub, message, { ttl = 12 * 3600, urgency = "normal" } = {}) {
    const body = encrypt(JSON.stringify(message), sub.keys);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: String(ttl),
        Urgency: urgency,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: `vapid t=${vapidJwt(sub.endpoint, vapid, subject, keyObj)}, k=${vapid.publicKey}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) throw new Error(`push ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ok: true };
  }

  return { publicKey: vapid.publicKey, send };
}

module.exports = { createWebPush, internals: { encrypt, vapidJwt, privateKeyObject, loadVapid } };
