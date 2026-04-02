// ============================================================
// src/crmSync.js — CRM-интеграция ПУТЬ
// Отдельный слой. Бот не зависит от этого файла.
// При любой ошибке — только лог, бот продолжает работать.
// ============================================================

const CRM_URL    = process.env.CRM_WEBHOOK_URL || '';
const CRM_SECRET = process.env.CRM_SECRET || '';

// Стопор code → label (из formatter.js, не импортируем чтобы не создавать зависимость)
const STOPOR_LABELS = {
  burnout: 'Перегрев',
  money:   'Деньги',
  me:      'На мне',
  chaos:   'Хаос',
};

// stage → читаемый этап воронки
const STAGE_LABELS = {
  new:               'Новый',
  quiz_done:         'Квиз пройден',
  refine_in_progress:'Греется',
  refine_completed:  'Греется',
  voice_requested:   'Запросил голосовое',
  call_requested:    'Запросил разбор',
};

// ── Внутренний отправщик ──
async function send(type, data) {

  if (!CRM_URL || !CRM_SECRET) return; // CRM не настроена — молча пропускаем
  try {
    const res = await fetch(CRM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: CRM_SECRET, type, data }),
      signal: AbortSignal.timeout(8000), // 8 сек таймаут
    });
    if (!res.ok) {
      console.error('[crmSync] HTTP error', res.status);
    }
  } catch (err) {
    console.error('[crmSync] send error:', err.message);
    // Намеренно не бросаем ошибку дальше — бот продолжает работать
  }
}

function buildUserBase(user) {
  return {
    telegram_id:   user.userId,
    first_name:    user.firstName || '',
    username:      user.username  || '',
    stopor_label:  STOPOR_LABELS[user.stoporCode] || user.stoporLabel || '',
    stopor_code:   user.stoporCode || '',
    qualification: user.qualification || '',
    stage_label:   STAGE_LABELS[user.stage] || user.stage || '',
  };
}

// ============================================================
// ПУБЛИЧНЫЕ МЕТОДЫ — вызываются из index.js
// ============================================================

/**
 * Вызывать после saveQuizResult() в обработчике web_app_data
 */
export async function onQuizResult(user, payload) {
  try {
    const base = buildUserBase(user);

    // 1. Записать прохождение в Историю квизов
    await send('quiz_result', {
      ...base,
      answers:       payload.answers       || [],
      scores:        payload.scores        || {},
      result_variant:payload.resultVariant || '',
      result_payload:payload.resultPayload || {},
      quiz_passed_at:payload.timestamp
        ? new Date(payload.timestamp).toISOString()
        : new Date().toISOString(),
      pass_number: 1,
    });

    // 2. Обновить / создать строку в CRM
    await send('upsert_user', {
      ...base,
      last_event:     'Прошёл квиз',
      increment_pass: true,
    });

    // 3. Записать событие в Историю действий
    await send('action_event', {
      ...base,
      event_type:  'Квиз',
      event:       'Прошёл квиз',
      button_text: '',
    });

  } catch (err) {
    console.error('[crmSync] onQuizResult error:', err.message);
  }
}

/**
 * Вызывать после нажатия кнопки (voice / call / refine)
 */
export async function onButtonClick(user, buttonText, stageLabelOverride) {
  try {
    const base = buildUserBase(user);
    if (stageLabelOverride) base.stage_label = stageLabelOverride;

    await send('upsert_user', {
      ...base,
      last_event: `Нажал кнопку: ${buttonText}`,
    });

    await send('action_event', {
      ...base,
      event_type:  'Кнопка',
      event:       `Нажал кнопку: ${buttonText}`,
      button_text: buttonText,
    });

  } catch (err) {
    console.error('[crmSync] onButtonClick error:', err.message);
  }
}

/**
 * Вызывать после completeRefine()
 */
export async function onRefineComplete(user) {
  try {
    const base = buildUserBase(user);

    await send('refine_complete', {
      ...base,
      refine_answers:   user.refineAnswers  || {},
      refine_started_at: user.refineSession?.startedAt || '',
      last_event:       'Прошёл доп-квиз',
    });

    await send('action_event', {
      ...base,
      event_type:  'Доп-квиз',
      event:       'Прошёл доп-квиз',
      button_text: '',
    });

  } catch (err) {
    console.error('[crmSync] onRefineComplete error:', err.message);
  }
}

/**
 * Вызывать при входящем текстовом сообщении
 */
export async function onTextMessage(user, text) {
  try {
    const base = buildUserBase(user);

    await send('action_event', {
      ...base,
      event_type:  'Текст',
      event:       'Входящее текстовое сообщение',
      button_text: text,
    });

  } catch (err) {
    console.error('[crmSync] onTextMessage error:', err.message);
  }
}
