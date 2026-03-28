# PUT bot gsheets v1 final 1:1

Бот читает контент из Google Sheets.
Если Google Sheets недоступен, использует fallback snapshot, собранный из `put_v1_final.xlsx`.

## Переменные окружения
- BOT_TOKEN
- BOT_USERNAME
- MINI_APP_URL
- ADMIN_CHAT_ID
- GOOGLE_SHEET_URL
- CONTENT_REFRESH_MINUTES
- TZ

## Запуск
```bash
npm install
npm start
```
