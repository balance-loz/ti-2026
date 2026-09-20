# Развёртывание Dota Predictor на Ubuntu

Инструкция рассчитана на чистый VPS с Ubuntu 22.04 или 24.04, публичным IPv4 и
минимум 2 ГБ RAM / 20 ГБ диска. Домен не нужен: сайт будет доступен по
`http://IP_СЕРВЕРА`.

## 1. Подготовить сервер

```bash
ssh root@IP_СЕРВЕРА
apt update && apt upgrade -y
apt install -y ca-certificates curl git ufw
```

Откройте SSH и HTTP, затем включите firewall:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw enable
ufw status
```

## 2. Установить Docker Engine и Compose

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
```

## 3. Забрать код и настроить окружение

```bash
mkdir -p /opt/dota-predictor
cd /opt/dota-predictor
git clone <адрес-репозитория> .
cp .env.example .env
nano .env
```

Минимум, который стоит поменять:

```ini
SITE_URL=http://IP_СЕРВЕРА
PORT=80

# Не обязателен, но сильно ускоряет первичный сбор истории.
OPENDOTA_API_KEY=

# Нужен только чтобы запускать задачи вручную через API. Пусто — админ-ручки
# отключены полностью.
ADMIN_TOKEN=
```

Остальные значения в `.env.example` — рабочие по умолчанию. Ни один турнир
нигде не зашит: система сама находит всё, что идёт.

Защитите файл:

```bash
chmod 600 .env
```

`.env` исключён из Git.

## 4. Запустить

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1/api/health
```

`web` и `api` используют один образ `dota-predictor`, поэтому приложение
собирается один раз. `.dockerignore` исключает `work/`, `node_modules`, `.git`,
`dist/.next` и базы из build context, а BuildKit кэширует `npm ci`.

Ожидаемый ответ — JSON с `"ok": true`. Пока база пустая, счётчики будут нулевые.

## 5. Первичное наполнение

Сервер стартует полностью пустым: ни базы, ни моделей. Ничего обученного в
образе нет — рейтинги и модель драфта он считает сам на матчах, которые сам же
скачает. Планировщик делает это без ручного вмешательства:

| Когда после старта | Что появляется |
| --- | --- |
| ~30 секунд | первые матчи и список идущих турниров |
| ~1 минута | собственные рейтинги команд, прогнозы серий и турниров |
| ~сутки | собственная модель драфта (нужно 1500 карт с пиками, по 1 запросу на карту) |

До появления своей модели драфта live-матчи предсказываются по рейтингам — на
карточке матча это написано прямо.

Разовый bootstrap делает то же самое, но сразу и в правильном порядке:

```bash
docker compose exec api node scripts/predictor.mjs bootstrap
```

Команда находит идущие турниры, добирает свежие матчи, тянет историю, собирает
серии, обучает модели и строит первые прогнозы. Её можно прервать и запустить
снова: курсор сбора сохраняется.

### Архив пиков со старой машины (опционально)

Если на вашем компьютере сохранился `work/draft-training.sqlite` из прошлой
версии проекта, он даёт 53 000 карт с пиками за два года без единого
API-запроса. Модель драфта тогда обучится в первый же час вместо суток.

Просто положите файл в каталог импорта — **больше ничего делать не нужно**,
сервер сам его увидит, разберёт и переобучится в течение 10 минут.

С вашего компьютера:

```bash
scp work/draft-training.sqlite root@IP_СЕРВЕРА:/tmp/
```

На сервере:

```bash
cd /opt/dota-predictor
docker compose cp /tmp/draft-training.sqlite api:/app/data/import/
```

Всё. Проверить, что файл замечен и обработан:

```bash
docker compose exec api node scripts/predictor.mjs status
```

В блоке `archives in …` будет `PENDING` (ещё не обработан) или `imported`.
Хотите не ждать десять минут — запустите разбор сразу:

```bash
docker compose exec api node scripts/predictor.mjs import
```

Файл импортируется ровно один раз: перезапуск контейнера ничего не повторит.
Положите туда новый файл — он будет обработан как новый. Архив с непонятной
схемой система отклонит целиком, а не импортирует наполовину.

## 6. Что происходит дальше само

| Задача | Интервал | Что делает |
| --- | --- | --- |
| `live` | 20 с — 5 мин | идущие матчи; на драфте опрос учащается |
| `resolve` | 10 мин | закрывает прогнозы, у которых появился результат |
| `syncActive` | 15 мин | перезагружает идущие турниры целиком |
| `forecast` | 20 мин | пересчитывает прогнозы на чемпионство |
| `discover` | 60 мин | ищет новые турниры и проставляет им имена |
| `collectRecent` | 3 ч | добирает завершённые матчи |
| `backfill` | 30 мин | фоновая догрузка исторического окна |
| `draftDetail` | 30 мин | подтягивает пики/баны |
| `retrain` | 24 ч | переобучает рейтинги и модель драфта |

Состояние задач видно на `/model` и в `docker compose logs api`.

### Про бесплатный тариф OpenDota

Без ключа доступно около 2000 запросов в сутки с жёстким троттлингом. Клиент
следит за дневным бюджетом и при 429 отступает целиком, а сбор истории сохраняет
курсор после каждой страницы — прерванный прогон продолжится с того же места.
Полная догрузка на бесплатном тарифе занимает несколько дней, с ключом — часы.

## 7. Обновление

```bash
cd /opt/dota-predictor
git pull --ff-only
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1/api/health
```

Обученные модели лежат в volume `state` по пути `/app/data/models`, а не внутри
образа: пересборка контейнера их не затирает и не подменяет чужими.

Контейнеры имеют `restart: unless-stopped` и поднимутся после перезагрузки VPS.

## 8. Ручной запуск задач

Через CLI внутри контейнера:

```bash
docker compose exec api node scripts/predictor.mjs status
docker compose exec api node scripts/predictor.mjs discover
docker compose exec api node scripts/predictor.mjs train
docker compose exec api node scripts/predictor.mjs forecast --force
```

Либо через API, если задан `ADMIN_TOKEN`:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1/api/admin/jobs/retrain
```

Публичного HTTP достаточно для просмотра сайта, но токен по нему передавать
не стоит. Для админ-запросов используйте SSH-туннель:

```bash
ssh -L 8080:127.0.0.1:80 root@IP_СЕРВЕРА
```

Пока сессия открыта, обращайтесь к `http://localhost:8080`.

## 9. Диагностика

```bash
cd /opt/dota-predictor
docker compose ps
docker compose logs --tail=200 api
docker compose logs --tail=200 web
docker compose logs --tail=200 proxy
curl -s http://127.0.0.1/api/model
```

`/api/model` показывает версии моделей, последний запуск каждой задачи, ошибки и
остаток дневного бюджета OpenDota.

## 10. Резервная копия

Вся база и модели лежат в одном volume:

```bash
cd /opt/dota-predictor
mkdir -p backups
docker compose stop api
docker run --rm -v dota-predictor_state:/data -v /opt/dota-predictor/backups:/backup \
  alpine sh -c 'tar czf /backup/state.tar.gz -C /data .'
docker compose start api
ls -lh backups/state.tar.gz
```

Если Compose создал volume с другим префиксом, узнайте точное имя через
`docker volume ls`. Восстановление выполняйте только при остановленном API и
сохранив ещё одну копию текущего volume.
