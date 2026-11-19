# AGENTS.md

NekoriGram Web — Telegram-подобный веб-мессенджер. Node.js + SQLite (`node:sqlite`) + `ws`.

## Запуск

```bash
./start-all.sh   # оба узла в фоне, логи в logs/, идемпотентно
./stop-all.sh    # остановить
node /tmp/cross-node-test.js   # проверка realtime между узлами (см. ниже)
```

`start-node1.sh` → :12000, `start-node2.sh` → :12001. Оба читают `.env` (`TOKEN_SECRET`).
`start-all.sh` создаёт `.env` с общим случайным секретом, если его нет.

Демо-аккаунты: `guest` / `guest123`, `maria` / `maria123`.

## Архитектура

- `server.js` — HTTP API + WebSocket на одном сервере; токены HMAC на `TOKEN_SECRET`.
- `db.js` — SQLite в WAL, общий файл `data/nekorigram.db` для всех узлов.
- `bus.js` — межпроцессная шина на мультикаст UDP (239.255.77.77:12100). Узлы обмениваются
  событиями чата, поэтому клиент видит сообщения, отправленные на другом узле.

## Важные правила

- WebSocket-клиенты живут в памяти процесса. Любое новое событие чата должно идти через
  `bus` (publish) + локальную доставку. Не вызывать `notifyChatMembers` напрямую.
- DTO сообщения персонализирован: `eventPayloadFor(userId, event)` выставляет `is_me`.
  Нельзя рассылать один объект с захардкоженным `is_me`.
- Отправитель тоже получает своё событие — клиент дедуплицирует по `msg.id`.
- `public/style.css` содержит `[hidden] { display: none !important; }` — не удалять,
  иначе модалки и палитра эмодзи видны при загрузке.

## Проверка realtime

Запустить два WS-клиента на разных портах, отправить сообщение через API одного узла и
убедиться, что второй клиент получил его без polling (`/tmp/cross-node-test.js`).

## Окружение

Контейнер без systemd; автозапуск — `cron` `@reboot /workspace/project/start-all.sh`.
Установка cron: `sudo apt-get update && sudo apt-get install -y cron`, затем `sudo cron`.
