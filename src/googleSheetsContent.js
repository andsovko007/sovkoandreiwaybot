
import * as XLSX from 'xlsx';
import { FALLBACK_SNAPSHOT } from './fallbackSnapshot.js';

const DEFAULT_REFRESH_MINUTES = Number(process.env.CONTENT_REFRESH_MINUTES || 5);
let cache = { loadedAt: 0, source: 'fallback', content: FALLBACK_SNAPSHOT };

function deriveExportUrl(input) {
  if (!input) return null;
  const match = String(input).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return null;
  const sheetId = match[1];
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
}

function rowsFromSheet(workbook, name) {
  const ws = workbook.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found`);
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

function normalizeStoporKey(value) {
  const map = {
    'Перегрев': 'burnout',
    'Деньги': 'money',
    'На мне': 'me',
    'Хаос': 'chaos',
    'Все': 'all',
    'Общий': 'all',
  };
  return map[value] || value;
}

function buildSnapshot(workbook) {
  const messagesRows = rowsFromSheet(workbook, 'Сообщения');
  const middlesRows = rowsFromSheet(workbook, 'Середины');
  const enhancersRows = rowsFromSheet(workbook, 'Усилители');
  const finalsRows = rowsFromSheet(workbook, 'Финал');
  const refineRows = rowsFromSheet(workbook, 'Доп-квизы');
  const followupRows = rowsFromSheet(workbook, 'Прогрев');
  const mediaRows = rowsFromSheet(workbook, 'Войсы и VSL');
  const alertRows = rowsFromSheet(workbook, 'Уведомления');
  const settingsRows = rowsFromSheet(workbook, 'Настройки');

  const startRow = messagesRows.find((r) => r['Событие'] === '/start');
  const duplicate1 = {};
  messagesRows
    .filter((r) => r['Событие'] === 'Дубль сообщ.1')
    .forEach((r) => {
      duplicate1[normalizeStoporKey(r['Стопор'])] = {
        text: r['Текст (TG format)'],
      };
    });

  const buttonsRow = messagesRows.find((r) => r['Событие'] === 'Кнопки');
  const messageEvents = {};
  ['Голосовое', 'Уточнить', 'Разбор', 'Не распознал', 'Написал хочу', 'VSL'].forEach((event) => {
    const row = messagesRows.find((r) => r['Событие'] === event);
    if (row) {
      messageEvents[event] = {
        text: row['Текст (TG format)'],
        button1: row['Кнопка 1'],
        button2: row['Кнопка 2'],
        button3: row['Кнопка 3'],
        condition: row['Условие'],
      };
    }
  });

  const middles = {};
  middlesRows.forEach((r) => {
    const stopor = normalizeStoporKey(r['Стопор']);
    middles[stopor] = middles[stopor] || {};
    middles[stopor][r['Ответ вопр.1']] = { text: r['Текст (TG format)'] };
  });

  const enhancers = {};
  enhancersRows.forEach((r) => {
    const stopor = normalizeStoporKey(r['Стопор']);
    const q = String(r['Вопрос']);
    enhancers[stopor] = enhancers[stopor] || {};
    enhancers[stopor][q] = enhancers[stopor][q] || {};
    enhancers[stopor][q][r['Ответ']] = r['Усиливающая фраза'];
  });

  const finals = {};
  finalsRows.forEach((r) => {
    finals[normalizeStoporKey(r['Стопор'])] = {
      text: r['Текст (TG format)'],
      buttons: [r['Кнопка 1'], r['Кнопка 2'], r['Кнопка 3']].filter(Boolean),
    };
  });

  const refineQuizzes = {};
  refineRows.forEach((r) => {
    const stopor = normalizeStoporKey(r['Стопор']);
    refineQuizzes[stopor] = refineQuizzes[stopor] || [];
    refineQuizzes[stopor].push({
      n: Number(r['№']),
      text: r['Текст вопроса'],
      options: [r['Кнопка А'], r['Кнопка Б'], r['Кнопка В'], r['Кнопка Г']].filter(Boolean),
      diagnostic: r['Диагностирует'],
    });
  });
  Object.values(refineQuizzes).forEach((list) => list.sort((a, b) => a.n - b.n));

  const followups = followupRows
    .filter((r) => typeof r['День'] === 'number' || /^\d+$/.test(String(r['День'] || '')))
    .map((r) => ({
      day: Number(r['День']),
      state: r['Состояние'],
      stopor: normalizeStoporKey(r['Стопор']),
      rawStopor: r['Стопор'],
      text: r['Текст (TG format)'],
      button1: r['Кнопка 1'],
      button2: r['Кнопка 2'],
      timing: r['Тайминг'],
    }));

  const media = mediaRows.map((r) => ({
    day: String(r['День']),
    type: r['Тип'],
    stopor: normalizeStoporKey(r['Стопор']),
    rawStopor: r['Стопор'],
    text: r['Сценарий (TG format)'],
    fileId: r['File ID'],
    status: r['Статус'],
  }));

  const alerts = {};
  alertRows.forEach((r) => {
    alerts[r['Событие']] = {
      level: r['Уровень'],
      template: r['Шаблон'],
      where: r['Куда'],
    };
  });

  const settings = {};
  settingsRows.forEach((r) => {
    settings[r['Параметр']] = r['Значение'];
  });

  return {
    start: {
      text: startRow?.['Текст (TG format)'] || FALLBACK_SNAPSHOT.start.text,
      button: startRow?.['Кнопка 1'] || FALLBACK_SNAPSHOT.start.button,
      condition: startRow?.['Условие'] || FALLBACK_SNAPSHOT.start.condition,
    },
    duplicate1,
    resultButtons: buttonsRow ? [buttonsRow['Кнопка 1'], buttonsRow['Кнопка 2'], buttonsRow['Кнопка 3']].filter(Boolean) : FALLBACK_SNAPSHOT.resultButtons,
    messageEvents,
    middles,
    enhancers,
    finals,
    refineQuizzes,
    followups,
    media,
    alerts,
    settings,
  };
}

export async function refreshContent(force = false) {
  const now = Date.now();
  const ttl = DEFAULT_REFRESH_MINUTES * 60 * 1000;
  if (!force && cache.content && now - cache.loadedAt < ttl) {
    return cache;
  }

  const sheetUrl = process.env.GOOGLE_SHEET_URL || '';
  const exportUrl = deriveExportUrl(sheetUrl);
  if (!exportUrl) {
    cache = { loadedAt: now, source: 'fallback', content: FALLBACK_SNAPSHOT };
    return cache;
  }

  try {
    const res = await fetch(exportUrl);
    if (!res.ok) throw new Error(`Google Sheets export failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const content = buildSnapshot(workbook);
    cache = { loadedAt: now, source: 'gsheets', content };
    return cache;
  } catch (error) {
    console.error('Failed to load Google Sheets content, using fallback snapshot.', error.message);
    cache = { loadedAt: now, source: 'fallback', content: FALLBACK_SNAPSHOT };
    return cache;
  }
}

export async function getContent() {
  if (!cache.content) {
    await refreshContent(true);
  }
  return cache.content;
}
