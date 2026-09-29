FROM node:24-alpine

WORKDIR /app

# Зависимостей нет, как и у остальных сервисов BurningHouse: сервер — один
# файл на встроенном http. Билеты (bank/) и их картинки (assets/q/) — часть
# образа: их готовит tools/import.mjs на машине разработчика, в рантайме сеть
# не нужна. Обновление билетов = новый образ.
COPY server.js ./
COPY index.html ./
COPY bank/ ./bank/
COPY assets/ ./assets/

# data/ — под SQLite этапа 2 (вход, огонёк). Уже сейчас volume, чтобы
# потом не менять compose на сервере.
RUN mkdir -p /app/data && chown -R node:node /app

RUN set -e; \
    for f in server.js index.html bank/ab.json bank/meta.json assets/app.js; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    node --check server.js

USER node

ENV HOST=0.0.0.0
ENV PORT=8798
ENV DATA_DIR=/app/data

EXPOSE 8798
VOLUME ["/app/data"]

CMD ["node", "server.js"]
