
import * as XLSX from 'xlsx';
import { FALLBACK_SNAPSHOT } from './fallbackSnapshot.js';

const DEFAULT_REFRESH_MINUTES = Number(process.env.CONTENT_REFRESH_MINUTES || 5);
let cache = { loadedAt: 0, source: 'fallback', content: FALLBACK_SNAPSHOT };

function deriveExportUrl(input) {
  if (!input) return null;
  const source = String(input).trim();
  const idMatch = source.match(/^[a-zA-Z0-9-_]{20,}$/);
  if (idMatch && !source.includes('/')) {
    return `https://docs.google.com/spreadsheets/d/${source}/export?format=xlsx`;
  }
  const match = source.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return null;
  const sheetId = match[1];
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
}

function rowsFromSheet(workbook, name) {
  const ws = workbook.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found`);
  return XLSX.utils.sheet_to_json(ws, { defval: null });
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

  const startRow = messagesRows.find((r) => r['Событие'] === '/start') || {};

  const duplicate1 = {};
  messagesRows
    .filter((r) => r['Событие'] === 'Дубль сообщ.1')
    .forEach((r) => {
      duplicate1[r['Стопор']] = { text: r['Текст (TG format)'] };
    });

  const buttonsRow = messagesRows.find((r) => r['Событие'] === 'Кнопки') || {};

  const messageEvents = {};
  messagesRows.forEach((r) => {
    const event = r['Событие'];
    if (!event || event === '/start' || event === 'Дубль сообщ.1' || event === 'Кнопки') return;
    if (!r['Текст (TG format)'] && !r['Кнопка 1'] && !r['Кнопка 2'] && !r['Кнопка 3']) return;
    messageEvents[event] = {
      text: r['Текст (TG format)'],
      button1: r['Кнопка 1'],
      button2: r['Кнопка 2'],
      button3: r['Кнопка 3'],
      condition: r['Условие'],
      stopor: r['Стопор'],
    };
  });

  const middles = {};
  middlesRows.forEach((r) => {
    const stopor = r['Стопор'];
    middles[stopor] = middles[stopor] || {};
    middles[stopor][r['Ответ вопр.1']] = {
      text: r['Текст (TG format)'],
      enhancerLabel: r['Усилитель (1 фраза)'],
      condition: r['Условие'],
    };
  });

  const enhancers = {};
  enhancersRows.forEach((r) => {
    const stopor = r['Стопор'];
    const q = String(r['Вопрос']);
    enhancers[stopor] = enhancers[stopor] || {};
    enhancers[stopor][q] = enhancers[stopor][q] || {};
    enhancers[stopor][q][r['Ответ']] = r['Усиливающая фраза'];
  });

  const finals = {};
  finalsRows.forEach((r) => {
    finals[r['Стопор']] = {
      text: r['Текст (TG format)'],
      buttons: [r['Кнопка 1'], r['Кнопка 2'], r['Кнопка 3']].filter(Boolean),
    };
  });

  const refineQuizzes = {};
  refineRows.forEach((r) => {
    const stopor = r['Стопор'];
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
      stopor: r['Стопор'],
      text: r['Текст (TG format)'],
      button1: r['Кнопка 1'],
      button2: r['Кнопка 2'],
      timing: r['Тайминг'],
    }));

  const media = mediaRows
    .filter((r) => r['Тип'])
    .map((r) => ({
      day: String(r['День']),
      type: r['Тип'],
      stopor: r['Стопор'],
      text: r['Сценарий (TG format)'],
      fileId: r['File ID'],
      status: r['Статус'],
    }));

  const alerts = {};
  alertRows.forEach((r) => {
    if (!r['Событие']) return;
    alerts[r['Событие']] = {
      level: r['Уровень'],
      template: r['Шаблон'],
      where: r['Куда'],
    };
  });

  const settings = {};
  settingsRows.forEach((r) => {
    if (!r['Параметр']) return;
    settings[r['Параметр']] = r['Значение'];
  });

  return {
    start: {
      text: startRow['Текст (TG format)'] || FALLBACK_SNAPSHOT.start.text,
      button: startRow['Кнопка 1'] || FALLBACK_SNAPSHOT.start.button,
      condition: startRow['Условие'] || FALLBACK_SNAPSHOT.start.condition,
    },
    duplicate1,
    resultButtons: [buttonsRow['Кнопка 1'], buttonsRow['Кнопка 2'], buttonsRow['Кнопка 3']].filter(Boolean),
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

  const source = process.env.GOOGLE_SHEET_URL || process.env.GOOGLE_SHEET_ID || '';
  const exportUrl = deriveExportUrl(source);
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
