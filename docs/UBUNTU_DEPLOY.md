# Развёртывание TI 2026 Predictor на Ubuntu

Инструкция рассчитана на чистый VPS с Ubuntu 22.04 или 24.04, публичным IPv4 и минимум 2 ГБ RAM / 20 ГБ диска. Домен не нужен: сайт будет доступен по `http://IP_СЕРВЕРА`.

## 1. Подготовить сервер

Подключитесь по SSH и обновите пакеты:

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

Команды соответствуют официальному apt-репозиторию Docker:

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

## 3. Скачать проект и создать секреты

```bash
mkdir -p /opt/ti2026
git clone https://github.com/balance-loz/ti-2026.git /opt/ti2026
cd /opt/ti2026
cp .env.example .env
nano .env
```

Заполните `.env`:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ВСТАВЬТЕ_СЮДА_СВОЙ_ДЛИННЫЙ_ПАРОЛЬ
COOKIE_SECURE=false
PORT=80
SITE_URL=http://159.194.202.215
TI_LEAGUE_ID=19719
LIVE_SYNC_ENABLED=true
LIVE_SYNC_INTERVAL_MINUTES=10
SCHEDULE_SYNC_ENABLED=true
SCHEDULE_SOURCE_URL=https://www.cybersport.ru/tournaments/dota-2/the-international-2026
SCHEDULE_TIMEZONE_OFFSET=+03:00
AUTO_SNAPSHOT_ITERATIONS=1000000
AUTO_SNAPSHOT_MAX_ITERATIONS=1000000
AUTO_SNAPSHOT_BATCH_SIZE=250000
AUTO_SNAPSHOT_TOLERANCE_PP=0.10
TI_PLAYIN_START=2026-08-17T00:00:00+08:00
TI_PLAYOFF_START=2026-08-20T00:00:00+08:00
```

Защитите файл с паролем:

```bash
chmod 600 .env
```

`.env` исключён из Git. Пароль и база данных не попадут в репозиторий.

## 4. Запустить

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1/api/health
```

`web` и `api` используют один образ `ti2026-app`, поэтому приложение собирается один раз. `.dockerignore` исключает локальные `work/`, `node_modules`, `.git`, старые `dist/.next` и базы из build context. Повторная сборка также использует BuildKit-кэш npm. Обучающие базы и тяжёлые research-пайплайны в image build не запускаются.

Для диагностики медленной сборки используйте подробный вывод:

```bash
docker compose build --progress=plain web
```

Если изменился только исходный код, шаг `npm ci` должен показывать `CACHED`. Без изменения `package-lock.json` повторная сборка обычно тратит время только на `npm run build`.

Ожидаемый ответ проверки: `{"ok":true}`. После этого откройте в браузере:

```text
http://IP_СЕРВЕРА/
```

API раз в 10 минут проверяет два независимых источника. Cybersport.ru даёт опубликованные будущие пары: при первом обнаружении сервер сохраняет соперников, время и pre-match вероятность. OpenDota даёт сыгранные карты лиги `19719`: они объединяются по `series_id`; BO3 записывается после двух побед, BO5 — после трёх. После нового результата сервер самостоятельно выполняет 100 000 прогонов и сохраняет снимок истории. Кнопка «Проверить пары и результаты» запускает такую же проверку вручную.

Границы стадий заданы во времени Шанхая: с `TI_PLAYIN_START` матчи считаются стыковыми, с `TI_PLAYOFF_START` — плей-офф. Если организаторы изменят расписание, поправьте эти две переменные и выполните `docker compose up -d`.

## 5. Как безопасно входить в админку без домена

Обычный HTTP не шифрует пароль. Публичный просмотр по IP можно оставить, но для входа администратора лучше использовать SSH-туннель:

```bash
ssh -L 8080:127.0.0.1:80 root@IP_СЕРВЕРА
```

Пока SSH-сессия открыта, заходите в админку через `http://localhost:8080`, а не через публичный IP. Более удобный постоянный вариант — приватная сеть Tailscale/WireGuard. Если позже появится HTTPS, установите `COOKIE_SECURE=true` и перезапустите контейнеры.

## 6. Обновление сайта

```bash
cd /opt/ti2026
git pull --ff-only
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1/api/models/nextgen
```

Next-generation model artifacts are copied into the immutable `/app/model` directory, so the persistent `/app/public` volume cannot hide a newly built artifact. The endpoint above exposes them for production smoke tests, but they remain diagnostic-only: shadow CatBoost/Deep Sets and experimental BO3/BO5 calibration do not alter live forecasts.

Контейнеры имеют `restart: unless-stopped`, поэтому автоматически поднимутся после перезагрузки VPS. Именованные Docker volumes сохраняют SQLite, статистику и OpenDota-кэш при пересборке.

## 7. Диагностика

```bash
cd /opt/ti2026
docker compose ps
docker compose logs --tail=200 api
docker compose logs --tail=200 web
docker compose logs --tail=200 proxy
```

Проверить автосинхронизацию можно публичным запросом состояния:

```bash
curl -s http://127.0.0.1/api/state
```

В поле `liveSync.lastSync` будут время, число найденных будущих пар (`scheduledFound`), число карт и завершённых серий. Ошибка одного источника записывается отдельно в `scheduleError` или `resultError` и не мешает второму источнику обновиться.

## 8. Резервная копия данных

Для контрольной точки после третьего раунда предпочтительна согласованная online-копия с автоматической проверкой:

```bash
cd /opt/ti2026
docker compose exec -e CHECKPOINT_EXPECT_COMPLETED=24 api npm run checkpoint:r3
```

Команда не останавливает API и откажется создавать контрольную точку, если SQLite повреждён, число завершённых серий отличается от ожидаемого, найдены дубликаты или отсутствуют frozen pre-match вероятности. Результат появляется в persistent volume внутри `/app/data/checkpoints`: база SQLite, JSON-отчёт, модельные артефакты и SHA-256. Скопируйте весь каталог контрольной точки за пределы VPS после проверки отчёта.

Следующий вариант остаётся аварийной копией всего volume с короткой остановкой API.

Создайте каталог и на несколько секунд остановите API, чтобы получить согласованную копию SQLite:

```bash
cd /opt/ti2026
mkdir -p backups
docker compose stop api
docker run --rm -v ti2026_state:/data -v /opt/ti2026/backups:/backup alpine sh -c 'tar czf /backup/state.tar.gz -C /data .'
docker compose start api
ls -lh backups/state.tar.gz
```

Если Compose создал volume с другим префиксом, узнайте точное имя командой `docker volume ls` и замените `ti2026_state`.

Восстановление лучше выполнять только на остановленном API и после сохранения ещё одной копии текущего volume.
