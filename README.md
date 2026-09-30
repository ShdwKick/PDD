# Когда на права?

Тренажёр билетов ПДД категории A/B — `pdd.burninghouse.ru`. План и решения —
[ARCHITECTURE.md](ARCHITECTURE.md).

## Запуск

```bash
node dev.mjs            # auth (8792) + сервис (8798), аккаунты dev и anya (друзья), пароль dev-parol-2026
node dev.mjs --reset    # то же с чистыми данными
node server.js          # только сервис — вход будет смотреть на auth.burninghouse.ru
node test/store.test.mjs          # логика огонька, заморозок, планов, друзей
node test/webpush.test.mjs        # шифрование push (сверка с эталоном RFC 8291)
node test/webpush-send.test.mjs   # отправка push на фальшивый push-сервис
```

Зависимостей нет. Превью `pdd` в корневом `.claude/launch.json` запускает
только сервис, без входа.

## Билеты

Лежат в `bank/` и `assets/q/`, в образ попадают как есть. Обновить до свежей
версии датасета (он обновляется раз в квартал):

```bash
node tools/import.mjs            # последний коммит etspring/pdd_russia
node tools/import.mjs <sha>      # конкретный — воспроизводимо
```

Импорт печатает, какие вопросы ушли и пришли, и сам докачивает/удаляет
картинки. Сейчас: `fa37933`, 2026.q3.0.

## Деплой

Как у остальных сервисов: пуш в `main` → GitHub Actions собирает
`shadowkick/pdd:latest` → Watchtower на сервере подтягивает сам.

Один раз на сервере:

1. Секреты репозитория: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (environment `env`).
2. Ключ для вечерних напоминаний — тот же `ADMIN_INTERNAL_KEY`, что у Admin,
   в `.env` рядом с compose. Без него напоминания только на устройства.
3. `docker compose -f docker-compose.prod.yml up -d`.
4. Регистрация в auth (один раз): `docker compose exec auth node server.js client-add pdd "Когда на права?" https://pdd.burninghouse.ru/`.
5. nginx и сертификат одной командой: скопировать `deploy/install-nginx.sh` на
   сервер и `sudo bash install-nginx.sh`. Скрипт убирает старые конфиги
   pdd.burninghouse.ru (копии в `/root/nginx-backup-pdd-*`), при необходимости
   получает сертификат, ставит новый, проверяет `nginx -t` (при ошибке откатывает)
   и что домен отвечает именно pdd, а не соседний сервис. Повторный запуск безопасен.

Уведомления на устройство (Web Push): ключи VAPID создаются сами при первом
запуске в `data/vapid.json` (volume — переживают обновления образа). Можно
задать `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` явно. Сменить ключи = отписать
всех: браузеры подписаны на старый публичный ключ.

Переменные: `INDEXABLE=1` пускает поисковики (в prod включено: пояснения свои,
`robots.txt` и `sitemap.xml` собираются сервером), `SHOW_TIPS=0` прячет пояснения совсем.
