FROM node:24-alpine

WORKDIR /app

# Зависимостей нет, как и у остальных сервисов BurningHouse: сервер на
# встроенных http и node:sqlite. Билеты (bank/) и их картинки (assets/q/) —
# часть образа: их готовит tools/import.mjs на машине разработчика, в рантайме
# сеть не нужна. Обновление билетов = новый образ.
COPY server.js auth-client.js ./
COPY lib/ ./lib/
COPY index.html sw.js manifest.webmanifest ./
COPY bank/ ./bank/
COPY assets/ ./assets/

# data/ — SQLite вошедших пользователей (ответы, план, огонёк). Volume.
RUN mkdir -p /app/data && chown -R node:node /app

RUN set -e; \
    for f in server.js auth-client.js lib/store.js lib/webpush.js index.html sw.js manifest.webmanifest assets/icons/icon-512.png bank/ab.json bank/meta.json bank/tips-own.json assets/app.js assets/motivation.js assets/auth-client.js; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    node --check server.js && node --check auth-client.js && node --check lib/store.js && node --check lib/webpush.js && node --check assets/motivation.js

USER node

ENV HOST=0.0.0.0
ENV PORT=8798
ENV DATA_DIR=/app/data

EXPOSE 8798
VOLUME ["/app/data"]

CMD ["node", "server.js"]
