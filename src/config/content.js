// =====================================================
// ПУТЬ БОТ — КОНТЕНТ ИЗ GOOGLE SHEETS
// Замена content.js — читает тексты из таблицы
// =====================================================

const SHEET_ID = '1e6zksfuZZo9nnZ9glTKJBWVxc4Qud2In4UXAVSVT2Zg';

// Маппинг стопоров: название в таблице → код в боте
const STOPOR_MAP = {
  'Перегрев': 'burnout',
  'Деньги': 'money',
  'На мне': 'me',
  'Хаос': 'chaos',
};
const CODE_TO_LABEL = { burnout: 'Перегрев', money: 'Деньги не идут', me: 'Всё держится на мне', chaos: 'Хаос и ручной режим' };

// Маппинг ответов доп-квиза: текст кнопки → id для кода
const REFINE_ID_MAP = {
  burnout: {
    q1: { 'Тело сыпется': 'body', 'Голова не выключается': 'head', 'Вокруг дёргают': 'env', 'Тащу сам, снять не с кого': 'load' },
    q2: { 'К обеду уже пустой': 'empty', 'Ровно, к вечеру выжат': 'evening', 'Скачет без причины': 'jumps', 'Постоянный фон усталости': 'chronic' },
    q3: { 'Отдыхаю, не помогает': 'rest', 'Работаю, перетерплю': 'push', 'Ухожу в мелочёвку': 'scroll', 'Срываюсь': 'snap' },
    q4: { 'Нет времени': 'notime', 'Не могу отключить голову': 'head', 'Вина если не работаю': 'guilt', 'Если остановлюсь — посыплется': 'fear' },
  },
  money: {
    q1: { 'Мало кто узнаёт': 'few_leads', 'Не понимают что продаю': 'no_understand', 'Интересуются не покупают': 'no_buy', 'Покупают мало': 'low_sales' },
    q2: { 'Сарафан': 'sarafan', 'Контент без потока': 'content', 'Реклама не окупается': 'ads', 'Непонятно откуда': 'unknown' },
    q3: { 'Сложно объяснить отличие': 'diff', 'Путают с другими': 'confused', 'Непонятно что купить': 'unclear', 'Не цепляет': 'nocatch' },
    q4: { 'Подумаю': 'think', 'Дорого / не сейчас': 'expensive', 'Пропадают молча': 'silent', 'Не понял что получу': 'novalue' },
  },
  me: {
    q1: { 'Продажи без меня не идут': 'sales', 'Качество на мне': 'quality', 'Без меня стоит': 'decisions', 'Я и есть бизнес': 'all' },
    q2: { 'Передал с ошибками': 'errors', 'Нанял — больше вопросов': 'questions', 'Не пробовал боюсь': 'fear', 'Не знаю что передать': 'dunno' },
    q3: { 'Никто не сделает как я': 'trust', 'Нет человека': 'nobody', 'Не знаю как упаковать': 'nopack', 'Боюсь потерять контроль': 'control' },
    q4: { 'Продажи встанут': 'revenue', 'Качество просядет': 'quality', 'Команда зависнет': 'team', 'Всё перечисленное': 'all' },
  },
  chaos: {
    q1: { 'Не понимаю что главное': 'nopriority', 'Не вижу что работает': 'nometrics', 'Переключаюсь': 'switching', 'Нет плана по ситуации': 'noplan' },
    q2: { 'Примерно': 'approx', 'Есть но разбросаны': 'scattered', 'Нет на ощущениях': 'feelings', 'Есть не знаю что с ними': 'unused' },
    q3: { 'По ощущениям': 'feelings', 'Хватаюсь за горящее': 'fire', 'Планирую план не живёт': 'deadplan', 'Делаю что проще': 'easy' },
    q4: { 'Скатываюсь обратно': 'rollback', 'Не знаю с чего начать': 'nostart', 'Чиню одно вылезает другое': 'whack', 'План не выживает': 'planfail' },
  },
};

// =====================================================
// CSV ПАРСЕР
// =====================================================
function parseCSV(text) {
  const rows = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        row.push(cell.trim()); cell = '';
      } else {
        cell += ch;
      }
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

// =====================================================
// ЗАГРУЗКА ЛИСТА
// =====================================================
async function fetchSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${sheetName} (${res.status})`);
  const text = await res.text();
  const rows = parseCSV(text);
  return rows.slice(1).filter(r => r.some(c => c)); // убираем заголовок и пустые
}

// =====================================================
// СБОРКА КОНТЕНТА
// =====================================================
async function buildContent() {
  try {
    const [msgs, mids, amps, fins, quizzes, warmup, voices, alerts, settings] = await Promise.all([
      fetchSheet('Сообщения'),
      fetchSheet('Середины'),
      fetchSheet('Усилители'),
      fetchSheet('Финал'),
      fetchSheet('Доп-квизы'),
      fetchSheet('Прогрев'),
      fetchSheet('Войсы и VSL'),
      fetchSheet('Уведомления'),
      fetchSheet('Настройки'),
    ]);

    // --- НАСТРОЙКИ ---
    const cfg = {};
    for (const r of settings) { if (r[0]) cfg[r[0]] = r[1] || ''; }

    // --- СООБЩЕНИЯ: Старт ---
    const startRow = msgs.find(r => r[1] === '/start');
    const startText = startRow ? startRow[4] : '';

    // --- СООБЩЕНИЯ: Дубли по стопорам ---
    const duplicates = {};
    for (const r of msgs) {
      if (r[1] && r[1].includes('Дубль сообщ.1') && r[2]) {
        const code = STOPOR_MAP[r[2]];
        if (code) duplicates[code] = r[4] || '';
      }
    }

    // --- СООБЩЕНИЯ: CTA ---
    const voiceRow = msgs.find(r => r[1] === 'Голосовое');
    const callRow = msgs.find(r => r[1] === 'Разбор');
    const fallbackRow = msgs.find(r => r[1] === 'Не распознал');
    const vslRow = msgs.find(r => r[1] === 'VSL');

    // --- ФИНАЛЫ (сообщ.3) ---
    const closings = {};
    for (const r of fins) {
      const code = STOPOR_MAP[r[0]];
      if (code) closings[code] = { text: r[1] || '', btn1: r[2] || '', btn2: r[3] || '', btn3: r[4] || '' };
    }

    // --- СЕРЕДИНЫ ---
    const middles = {};
    for (const r of mids) {
      const code = STOPOR_MAP[r[0]];
      if (!code) continue;
      if (!middles[code]) middles[code] = {};
      // Находим id по тексту кнопки
      const answerText = r[1];
      const qMap = REFINE_ID_MAP[code]?.q1 || {};
      const id = qMap[answerText] || answerText;
      middles[code][id] = r[2] || '';
    }

    // --- УСИЛИТЕЛИ ---
    const enhancers = {};
    for (const r of amps) {
      const code = STOPOR_MAP[r[0]];
      if (!code) continue;
      if (!enhancers[code]) enhancers[code] = {};
      const qNum = r[1];
      const answerText = r[2];
      const qMap = REFINE_ID_MAP[code]?.[`q${qNum}`] || {};
      const id = qMap[answerText] || answerText;
      enhancers[code][id] = r[3] || '';
    }

    // --- ДОП-КВИЗЫ ---
    const refineQuestions = {};
    for (const r of quizzes) {
      const code = STOPOR_MAP[r[0]];
      if (!code) continue;
      if (!refineQuestions[code]) refineQuestions[code] = [];
      const qNum = r[1];
      const qId = `q${qNum}`;
      const qMap = REFINE_ID_MAP[code]?.[qId] || {};
      const options = [];
      const btnTexts = [r[3], r[4], r[5], r[6]].filter(Boolean);
      for (const btn of btnTexts) {
        const optId = qMap[btn] || btn;
        options.push({ id: optId, text: btn });
      }
      refineQuestions[code].push({ id: qId, text: r[2] || '', options });
    }

    // --- ПРОГРЕВ ---
    const followups = { quiz: {}, refine: {}, voice: {} };
    let currentDay = null;
    for (const r of warmup) {
      // Секции (заголовки) — пропускаем
      if (r[0] && r[0].startsWith('ДЕНЬ')) { continue; }
      const day = parseInt(r[0]);
      if (isNaN(day)) continue;
      const condition = r[1] || '';
      const text = r[3] || '';
      if (text.includes('Не отправлять')) continue;
      if (condition.includes('Не взаимод') || condition.includes('Молчун') || condition.includes('Не записался') || condition.includes('Кнопка:')) {
        if (!followups.quiz[day]) followups.quiz[day] = text;
      }
    }

    // --- ВОЙСЫ / VSL ---
    const voiceFiles = {};
    for (const r of voices) {
      const code = STOPOR_MAP[r[2]];
      const fileId = r[4] || '';
      if (r[1] && r[1].includes('VSL') && r[0] === '0' && code) {
        if (!voiceFiles.vsl) voiceFiles.vsl = {};
        voiceFiles.vsl[code] = fileId;
      }
      if (r[1] && r[1].includes('Войс') && code) {
        if (!voiceFiles.voice) voiceFiles.voice = {};
        voiceFiles.voice[code] = fileId;
      }
      if (r[2] === 'Общий') {
        voiceFiles.vslGeneral = fileId;
      }
    }

    // --- УВЕДОМЛЕНИЯ ---
    const alertTemplates = {};
    for (const r of alerts) {
      if (r[0]) alertTemplates[r[0]] = { level: r[1] || '', template: r[2] || '', target: r[3] || '' };
    }

    // --- СОБИРАЕМ STOPORS ---
    const STOPORS = {};
    for (const [name, code] of Object.entries(STOPOR_MAP)) {
      const closing = closings[code] || {};
      STOPORS[code] = {
        code,
        label: CODE_TO_LABEL[code] || name,
        duplicate: {
          m1: duplicates[code] || '',
          m2: '', // m2 собирается динамически из середин
          m3: closing.text || '',
        },
        buttons: {
          voice: closing.btn1 || 'Получить личное голосовое',
          refine: closing.btn2 || 'Уточнить диагноз',
          call: closing.btn3 || 'Записаться на разбор',
        },
        refine: {
          title: `Уточним: ${CODE_TO_LABEL[code] || name}`,
          questions: refineQuestions[code] || [],
        },
        superanswers: {
          primary: middles[code] || {},
          enhancers: enhancers[code] || {},
          closing: closing.text || '',
        },
      };
    }

    return {
      APP: { quizVersion: 'v1', miniAppButtonText: 'Пройти диагностику' },
      STOPORS,
      CTA_TEXT: {
        continueFromMiniApp: 'Получить углублённый разбор в Telegram',
        voiceRequestedUser: voiceRow ? voiceRow[4] : 'Принял. Я посмотрю твои ответы и запишу голосовое.',
        callRequestedUser: callRow ? callRow[4] : 'Отлично. Напиши мне — договоримся по времени 👇',
        fallbackUser: fallbackRow ? fallbackRow[4] : 'Принял. Передам Андрею.',
      },
      FOLLOWUPS: followups,
      START_TEXT: {
        newUser: startText,
        afterQuiz: 'Ты уже прошёл диагностику. Можешь пройти заново или продолжить по результату.',
      },
      ALERTS: {
        newLead: alertTemplates['Прошёл квиз']?.template || '📩 Новый лид',
        voice: alertTemplates['Получить голосовое']?.template || '🎧 Запрос голосового',
        call: alertTemplates['Записаться на разбор']?.template || '📞 Запрос разбора',
        refine: alertTemplates['Прошёл доп-квиз']?.template || '🧩 Уточнение диагноза',
        fallback: alertTemplates['Не распознан текст']?.template || '⚠️ Не распознано',
      },
      SETTINGS: cfg,
      VOICE_FILES: voiceFiles,
      ALERT_TEMPLATES: alertTemplates,
    };
  } catch (err) {
    console.error('Failed to fetch sheets:', err.message);
    return null;
  }
}

// =====================================================
// КЭШ
// =====================================================
let contentCache = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

async function getContent() {
  const now = Date.now();
  if (contentCache && (now - lastFetchTime) < CACHE_TTL) {
    return contentCache;
  }
  const fresh = await buildContent();
  if (fresh) {
    contentCache = fresh;
    lastFetchTime = now;
    console.log('✅ Content refreshed from Google Sheets');
  }
  return contentCache;
}

// =====================================================
// ЭКСПОРТ (совместимый с GPT-кодом)
// =====================================================

// Начальная загрузка
let _ready = false;
const _initPromise = getContent().then(() => { _ready = true; });

export async function ensureLoaded() {
  if (!_ready) await _initPromise;
}

// Прямой доступ к кэшу (для синхронного кода)
export function getCached() {
  return contentCache || {};
}

// Обновить кэш
export async function refreshContent() {
  return getContent();
}

// Совместимые экспорты (для GPT-кода без переписывания)
export function getSTOPORS() { return getCached().STOPORS || {}; }
export function getSTART_TEXT() { return getCached().START_TEXT || {}; }
export function getCTA_TEXT() { return getCached().CTA_TEXT || {}; }
export function getFOLLOWUPS() { return getCached().FOLLOWUPS || {}; }
export function getALERTS() { return getCached().ALERTS || {}; }
export function getSETTINGS() { return getCached().SETTINGS || {}; }
export function getVOICE_FILES() { return getCached().VOICE_FILES || {}; }

// Для обратной совместимости — экспортируем как константы
// (будут заполнены после первой загрузки)
export const APP = { quizVersion: 'v1', miniAppButtonText: 'Пройти диагностику' };

// Прокси-объекты для обратной совместимости
export const STOPORS = new Proxy({}, {
  get: (_, key) => (getCached().STOPORS || {})[key],
  ownKeys: () => Object.keys(getCached().STOPORS || {}),
  getOwnPropertyDescriptor: (_, key) => {
    const val = (getCached().STOPORS || {})[key];
    if (val) return { configurable: true, enumerable: true, value: val };
  },
});

export const START_TEXT = new Proxy({}, {
  get: (_, key) => (getCached().START_TEXT || {})[key],
});

export const CTA_TEXT = new Proxy({}, {
  get: (_, key) => (getCached().CTA_TEXT || {})[key],
});

export const FOLLOWUPS = new Proxy({}, {
  get: (_, key) => (getCached().FOLLOWUPS || {})[key],
});

export const ALERTS = new Proxy({}, {
  get: (_, key) => (getCached().ALERTS || {})[key],
});
