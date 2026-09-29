# Когда на права?

Тренажёр билетов ПДД категории A/B — `pdd.burninghouse.ru`. План и решения —
[ARCHITECTURE.md](ARCHITECTURE.md).

## Запуск

```bash
node server.js          # http://localhost:8798
```

Зависимостей нет. Из корня BurningHouse то же самое поднимает превью `pdd`
в `.claude/launch.json`.

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
2. Сертификат: `certbot certonly --nginx -d pdd.burninghouse.ru`.
3. `deploy/nginx-pdd-443.conf` → `/etc/nginx/sites-available/pdd`, ссылка в
   `sites-enabled`, `nginx -t && systemctl reload nginx`.
4. `docker compose -f docker-compose.prod.yml up -d`.

Переменные: `INDEXABLE=1` пускает поисковики (пока `0` — пояснения к ответам
не свои), `SHOW_TIPS=0` прячет пояснения совсем.
