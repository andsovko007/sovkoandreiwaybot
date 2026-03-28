# PUT Telegram Bot — 1:1 Google Sheets runtime

## Что делает
- читает контент из Google Sheets
- использует `put_v1_final.xlsx` как fallback snapshot
- хранит state локально в `data/store.json`
- не трогает Mini App

## Переменные окружения
- `BOT_TOKEN`
- `BOT_USERNAME`
- `ADMIN_CHAT_ID`
- `GOOGLE_SHEET_URL`
- `CONTENT_REFRESH_MINUTES`
- `TZ`

## Запуск
```bash
npm install
npm start
```

## Важно
- контент меняется только через Google Sheets
- после `web_app_data` старт повторно не отправляется
- алерты уходят в `ADMIN_CHAT_ID`
