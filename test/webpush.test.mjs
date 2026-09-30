// Проверка Web Push без сети: шифруем, как сервер, и расшифровываем, как
// браузер (RFC 8291/8188) — если хоть байт не так, расшифровка упадёт.
// Плюс VAPID JWT проверяется публичным ключом.   node test/webpush.test.mjs
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { internals } = require("../lib/webpush.js");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ок  " : "FAIL"} ${name}${ok ? "" : `: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`}`);
};

// «Браузер»: пара ключей подписки и auth-секрет.
const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const sub = { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };

const message = JSON.stringify({ title: "Огонёк гаснет: 3 дня подряд", body: "Осталось 12 вопросов", url: "/" });
const packet = internals.encrypt(message, sub);

// Расшифровка на стороне браузера.
function decrypt(buf) {
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const data = buf.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return { rs, idlen, text: plain.subarray(0, plain.length - 1).toString(), delim: plain[plain.length - 1] };
}
const out = decrypt(packet);
eq("браузер расшифровал сообщение", out.text, message);
eq("заголовок записи: rs=4096, ключ 65 байт, разделитель 0x02", [out.rs, out.idlen, out.delim], [4096, 65, 2]);

// Подмена хоть одного байта — расшифровка должна упасть (GCM-тег).
const broken = Buffer.from(packet); broken[broken.length - 20] ^= 1;
let threw = false; try { decrypt(broken); } catch { threw = true; }
eq("испорченный пакет не расшифровывается", threw, true);

// Эталон из RFC 8291, приложение A: фиксированные ключи, соль и ожидаемый
// пакет байт в байт. Ловит ошибку, которую круговой тест выше не заметит:
// одинаково неверный вывод ключей и в шифровании, и в расшифровке.
{
  const as = crypto.createECDH("prime256v1");
  as.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const got = internals.encrypt("When I grow up, I want to be a watermelon", {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), ecdh: as });
  eq("совпадает с эталоном RFC 8291", got.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
}

// VAPID: ключи создаются и переживают перезапуск; JWT проверяется публичным ключом.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vapid-"));
const k1 = internals.loadVapid(dir), k2 = internals.loadVapid(dir);
eq("ключи VAPID сохраняются между запусками", k1.publicKey, k2.publicKey);
const jwt = internals.vapidJwt("https://fcm.googleapis.com/fcm/send/abc", k1, "https://pdd.burninghouse.ru", internals.privateKeyObject(k1));
const [h, c, s] = jwt.split(".");
const pub = Buffer.from(k1.publicKey, "base64url");
const pubKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
eq("подпись VAPID JWT верна", crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), true);
eq("aud — origin push-сервиса", JSON.parse(Buffer.from(c, "base64url")).aud, "https://fcm.googleapis.com");

console.log(fails ? `\nПровалено: ${fails}` : "\nВсё прошло.");
process.exit(fails ? 1 : 0);
