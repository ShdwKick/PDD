#!/usr/bin/env bash
# Ставит nginx-конфиг «Когда на права?» (pdd.burninghouse.ru -> 127.0.0.1:8798).
#
#   sudo bash install-nginx.sh
#
# Скрипт самодостаточный — конфиг внутри, репозиторий на сервере не нужен.
# Что делает:
#   1. находит ВСЕ старые конфиги с server_name pdd.burninghouse.ru
#      (sites-available, sites-enabled, conf.d), сохраняет копии в
#      /root/nginx-backup-pdd-<время>/ и удаляет их;
#   2. получает сертификат, если его ещё нет (certbot --nginx);
#   3. кладёт конфиг в sites-available/pdd и ссылку в sites-enabled;
#   4. nginx -t — если не прошло, возвращает всё как было;
#   5. reload и проверка: отвечает ли домен сервисом pdd, а не чем-то ещё.
set -euo pipefail

DOMAIN="pdd.burninghouse.ru"
PORT=8798
NAME="pdd"
AVAIL="/etc/nginx/sites-available/$NAME"
ENABLED="/etc/nginx/sites-enabled/$NAME"
BACKUP="/root/nginx-backup-$NAME-$(date +%Y%m%d-%H%M%S)"

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo."; exit 1; }
command -v nginx >/dev/null || { echo "nginx не найден."; exit 1; }

# ---------- 1. старые конфиги ----------
mkdir -p "$BACKUP"
mapfile -t FOUND < <(grep -rlE "server_name[^;]*[[:space:]]${DOMAIN//./\\.}([[:space:];]|$)" \
  /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true)

declare -A REAL=()
for f in "${FOUND[@]}" "$AVAIL" "$ENABLED"; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  r="$(readlink -f "$f" || echo "$f")"
  # Файл, где кроме pdd описаны и другие домены, не трогаем — иначе сломаем
  # соседний сервис. Такое нужно разнести руками.
  if [ -f "$r" ] && grep -E "^[[:space:]]*server_name" "$r" | grep -vq "$DOMAIN"; then
    echo "СТОП: в $r кроме $DOMAIN есть другие server_name:"
    grep -nE "^[[:space:]]*server_name" "$r"
    echo "Уберите блоки $DOMAIN из этого файла вручную и запустите скрипт снова."
    exit 1
  fi
  REAL["$r"]=1
  [ -L "$f" ] && { echo "Удаляю ссылку $f"; rm -f "$f"; }
done
for r in "${!REAL[@]}"; do
  [ -f "$r" ] || continue
  cp -a "$r" "$BACKUP/"
  echo "Удаляю $r (копия в $BACKUP)"
  rm -f "$r"
done
# Висячие ссылки в sites-enabled на удалённые файлы
find /etc/nginx/sites-enabled -xtype l -print -delete 2>/dev/null | sed 's/^/Удалена битая ссылка /' || true

restore() {
  echo "Откатываю: возвращаю старые конфиги из $BACKUP"
  rm -f "$AVAIL" "$ENABLED"
  for b in "$BACKUP"/*; do
    [ -e "$b" ] || continue
    cp -a "$b" /etc/nginx/sites-available/
    base="$(basename "$b")"
    ln -sf "/etc/nginx/sites-available/$base" "/etc/nginx/sites-enabled/$base"
  done
  nginx -t && systemctl reload nginx || true
}

# ---------- 2. сертификат ----------
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ ! -f "$CERT" ]; then
  echo "Сертификата для $DOMAIN нет — получаю через certbot…"
  certbot certonly --nginx -d "$DOMAIN" || { echo "certbot не справился (DNS $DOMAIN указывает на этот сервер?)"; restore; exit 1; }
fi

# ---------- 3. новый конфиг ----------
cat > "$AVAIL" <<EOF
# «Когда на права?» на $DOMAIN. Ставится deploy/install-nginx.sh из репозитория PDD.

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # Загрузок нет — дефолтного client_max_body_size хватает с запасом.

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
EOF
ln -sf "$AVAIL" "$ENABLED"
echo "Записан $AVAIL, ссылка $ENABLED"

# ---------- 4. проверка и reload ----------
if ! nginx -t; then
  echo "nginx -t не прошёл."
  restore
  exit 1
fi
systemctl reload nginx
echo "nginx перезагружен."

# ---------- 5. проверка ответа ----------
sleep 1
if ! curl -fsS -m 5 "http://127.0.0.1:$PORT/robots.txt" >/dev/null 2>&1; then
  echo "ВНИМАНИЕ: на 127.0.0.1:$PORT никто не отвечает — контейнер pdd запущен?"
  echo "  docker compose -f docker-compose.prod.yml up -d   (в папке с compose pdd)"
  exit 1
fi
BODY="$(curl -sk -m 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)"
if grep -q "Когда на права" <<<"$BODY"; then
  echo "Готово: https://$DOMAIN отвечает сервисом pdd."
else
  echo "ВНИМАНИЕ: https://$DOMAIN отвечает не pdd. Кто перехватывает домен:"
  nginx -T 2>/dev/null | grep -nE "server_name|default_server" | head -40
  exit 1
fi
