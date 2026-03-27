# PUT Bot V1

Новый бот V1 с нуля под логику проекта ПУТЬ.

## Что уже есть
- новый `/start` без запроса контакта
- кнопка Mini App
- приём `web_app_data` из Mini App
- дубль результата в Telegram
- 3 кнопки после результата
- 4 уточняющих доп-квиза
- суперответы по 4 стопорам
- fallback на непонятный ввод
- state-based followup scheduler (дни 1/3/5/7)
- админ-алерты
- файловое runtime-хранилище (`data/store.json`)

## Важно
Это версия `EXCEL_FIRST`.
Контент уже структурирован в `src/config/content.js` по утверждённой логике.
Следующим проходом можно подключить Google Sheets как внешний контент-слой без переписывания всей логики.

## Настройка
1. Скопируй `.env.example` в `.env`
2. Заполни `BOT_TOKEN`
3. Проверь `BOT_USERNAME`, `MINI_APP_URL`, `ADMIN_CHAT_ID`
4. Установи зависимости:
   ```bash
   npm install
   ```
5. Запусти:
   ```bash
   npm start
   ```

## Переменные окружения
- `BOT_TOKEN` — токен бота
- `BOT_USERNAME` — username бота без `@`
- `MINI_APP_URL` — production URL Mini App
- `ADMIN_CHAT_ID` — chat_id для алертов
- `TZ` — таймзона планировщика

## Структура
- `src/index.js` — основной runtime бота
- `src/config/content.js` — весь контент V1
- `src/lib/store.js` — хранение состояний
- `src/lib/result.js` — дубль результата и суперответы
- `src/lib/keyboards.js` — клавиатуры
- `src/lib/payload.js` — нормализация payload из Mini App

## Что дальше
Когда проверишь рабочий путь end-to-end, следующим шагом можно вынести `content.js` в Google Sheets loader, чтобы менять тексты без редактирования кода.
