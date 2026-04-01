import 'dotenv/config';
import * as crmSync from './crmSync.js';
import cron from 'node-cron';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { getContent, refreshContent } from './googleSheetsContent.js';
import {
  toTelegramHtml,
  hasText,
  stoporCodeToLabel,
  normalizeUserName,
  fillTemplate,
  timingToHours,
  normalizeTelegramPrefillUrl,
} from './formatter.js';
import {
  getUser,
  upsertUser,
  saveQuizResult,
  markEngaged,
  markVoiceRequested,
  markCallRequested,
  startRefineSession,
  saveRefineAnswer,
  completeRefine,
  markFollowupSent,
  setWaitKeywordDay5,
  addNote,
  addEvent,
  allUsers,
  appendJourneyStep,
} from './store.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = String(process.env.BOT_USERNAME || '').replace('@', '');
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '');
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!BOT_USERNAME) throw new Error('BOT_USERNAME is required');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID is required');

const bot = new Bot(BOT_TOKEN);
const recentWebAppAt = new Map();

function htmlPayload(text, extra = {}) {
  return {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
    text: toTelegramHtml(text),
  };
}

async function sendText(ctxOrChatId, text, extra = {}) {
  if (!hasText(text)) return;
  const payload = htmlPayload(text, extra);
  const { text: renderedText, ...rest } = payload;
  if (typeof ctxOrChatId === 'number' || typeof ctxOrChatId === 'string') {
    await bot.api.sendMessage(ctxOrChatId, renderedText, rest);
  } else {
    await ctxOrChatId.reply(renderedText, rest);
  }
}

function miniAppKeyboard(buttonText, quizUrl, aboutUrl) {
  const kb = new Keyboard();

  if (hasText(quizUrl)) {
    kb.webApp(buttonText, quizUrl);
  }

  if (hasText(aboutUrl)) {
    kb.webApp('Обо мне и методе', aboutUrl);
  }

  return kb.resized().persistent();
}

function normalizePayload(raw, ctx) {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    type: payload.type || 'quiz_result',
    quizVersion: payload.quiz_version || payload.quizVersion || 'v1',
    stoporCode: payload.stopor_code || payload.stoporCode || payload.stopor || null,
    scores: payload.scores || {},
    answers: payload.answers || [],
    qualification: payload.qualification || null,
    resultVariant: payload.result_variant || payload.resultVariant || null,
    resultPayload: payload.result_payload || payload.resultPayload || null,
    ctaAction: payload.cta_action || payload.ctaAction || 'continue_tg',
    timestamp: payload.timestamp || Date.now(),
    username: ctx.from?.username || payload.username || '',
    firstName: ctx.from?.first_name || payload.user_name || '',
    userId: ctx.from?.id,
  };
}

function getQuizLink(content) {
  return String(content.settings['Ссылка: квиз'] || '').trim();
}

function normalizeMobileTelegramLink(url) {
  const normalized = normalizeTelegramPrefillUrl(url || '');
  return normalized.replace(/\+/g, '%20');
}

function getVoiceLink(content) {
  return normalizeMobileTelegramLink(content.settings['Ссылка: голосовое'] || '');
}

function getCallLink(content) {
  return normalizeMobileTelegramLink(content.settings['Ссылка: разбор'] || '');
}

function getAboutLink(content) {
  return String(content.settings['Ссылка: обо мне и методе'] || '').trim();
}

function userTemplateValues(user, overrides = {}) {
  return {
    id: user.userId || '—',
    name: normalizeUserName({ first_name: user.firstName, username: user.username }),
    username: user.username || 'без_username',
    stopor: user.stoporLabel || '—',
    qualification: user.qualification || '—',
    phone: user.phone || '',
    resultVariant: user.resultVariant || '—',
    path: formatJourneyPath(user.journey),
    ...overrides,
  };
}

function formatQuizAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return '—';
  return answers
    .map((row, idx) => {
      const text = Array.isArray(row) ? row.join(' / ') : String(row || '');
      return `${idx + 1}. ${text || '—'}`;
    })
    .join('\n');
}

function formatRefineAnswers(refineAnswers) {
  if (!refineAnswers || typeof refineAnswers !== 'object' || Object.keys(refineAnswers).length === 0) return '—';
  return Object.entries(refineAnswers)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => `${k}. ${v}`)
    .join('\n');
}

function formatJourneyPath(journey) {
  if (!Array.isArray(journey) || journey.length === 0) return '—';
  return journey.map((item) => item.step).join(' → ');
}

function buildAlertContext(user, button = '') {
  const quizAnswers = formatQuizAnswers(user.answers);
  const refineAnswers = formatRefineAnswers(user.refineAnswers);
  const lines = [
    '',
    `ID: ${user.userId || '—'}`,
    `Кнопка: ${button || '—'}`,
    `Вариант результата: ${user.resultVariant || '—'}`,
    `Путь: ${formatJourneyPath(user.journey)}`,
    '',
    'Ответы квиза:',
    quizAnswers,
  ];

  if (refineAnswers !== '—') {
    lines.push('', 'Ответы доп-квиза:', refineAnswers);
  }

  return lines.join('\n');
}

async function sendAdminAlert(eventName, user, content, overrides = {}) {
  const eventCfg = content.alerts[eventName];
  if (!eventCfg?.template) return;

  const text = fillTemplate(eventCfg.template, userTemplateValues(user, overrides));
  const extra = buildAlertContext(user, overrides.button || '');
  const finalText = `${text}\n${extra}`.trim();

  if (eventCfg.where && String(eventCfg.where).includes('TG')) {
    await bot.api.sendMessage(ADMIN_CHAT_ID, toTelegramHtml(finalText), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  if (eventCfg.where && String(eventCfg.where).toLowerCase().includes('таблица')) {
    await addEvent({ type: 'alert', eventName, userId: user.userId, stopor: user.stoporLabel, text: finalText });
  }
}

function appendResultActionRows(kb, buttons, options = {}) {
  const btns = buttons || [];
  const includeRefine = options.includeRefine !== false;
  const aboutUrl = options.aboutUrl || '';

  if (btns[0]) kb.text(btns[0], 'action:voice').row();
  if (includeRefine && btns[1]) kb.text(btns[1], 'action:refine').row();
  if (btns[2]) kb.text(btns[2], 'action:call').row();
  if (hasText(aboutUrl)) kb.url('Обо мне и методе', aboutUrl).row();

  return kb;
}

function resultActionKeyboard(buttons, options = {}) {
  return appendResultActionRows(new InlineKeyboard(), buttons, options);
}

function actionLinkKeyboard(text, url) {
  if (!hasText(url)) return undefined;
  return new InlineKeyboard().url(text, url);
}

function buildLinearFollowupKeyboard(entry, content) {
  const kb = new InlineKeyboard();

  const append = (text, type, link) => {
    const btnText = String(text || '').trim();
    const btnType = String(type || 'none').trim().toLowerCase();
    if (!btnText || btnType === 'none') return;

    if (btnType === 'call') {
      kb.text(btnText, 'action:call').row();
      return;
    }

    if (btnType === 'voice') {
      kb.text(btnText, 'action:voice').row();
      return;
    }

    if (btnType === 'about') {
      const aboutUrl = hasText(link) ? String(link).trim() : getAboutLink(content);
      if (hasText(aboutUrl)) kb.url(btnText, aboutUrl).row();
      return;
    }

    if (btnType === 'channel') {
      const channelUrl = String(link || '').trim();
      if (hasText(channelUrl)) kb.url(btnText, channelUrl).row();
    }
  };

  append(entry.button1, entry.buttonType1, entry.link1);
  append(entry.button2, entry.buttonType2, entry.link2);

  return kb.inline_keyboard.length ? kb : undefined;
}

function findMediaEntry(content, day, stoporLabel, typeNeedle) {
  return (content.media || []).find((m) => String(m.day) === String(day)
    && String(m.stopor || '').trim() === String(stoporLabel || '').trim()
    && String(m.type || '').toLowerCase().includes(String(typeNeedle).toLowerCase()));
}

async function sendMediaEntry(chatId, entry) {
  if (!entry) return;
  const caption = hasText(entry.text) ? toTelegramHtml(entry.text) : undefined;
  const type = String(entry.type || '').toLowerCase();
  const fileId = String(entry.fileId || '').trim();

  if (fileId) {
    if (type.includes('войс')) {
      await bot.api.sendVoice(chatId, fileId, {
        caption,
        parse_mode: caption ? 'HTML' : undefined,
      });
      return;
    }

    if (type.includes('vsl')) {
      await bot.api.sendVideo(chatId, fileId, {
        caption,
        parse_mode: caption ? 'HTML' : undefined,
        supports_streaming: true,
      });
      return;
    }
  }

  if (hasText(entry.text)) {
    await bot.api.sendMessage(chatId, toTelegramHtml(entry.text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

const REFINE_LOOKUP_ALIASES = {
  'Перегрев': {
    '1': {
      'Тащу сам, снять не с кого': 'Тащу сам',
    },
    '2': {
      'К обеду уже пустой': 'К обеду пустой',
    },
    '3': {
      'Работаю, перетерплю': 'Перетерплю',
    },
  },
  'На мне': {
    '1': {
      'Продажи без меня не идут': 'Продажи без меня',
    },
    '3': {
      'Не знаю как упаковать': 'Не знаю что передать',
    },
  },
  'Хаос': {
    '1': {
      'Нет плана по ситуации': 'Нет плана',
    },
    '2': {
      'Нет на ощущениях': 'На ощущениях',
    },
  },
};

function normalizeRefineLookupValue(stoporLabel, questionNumber, value) {
  if (!value) return value;
  return REFINE_LOOKUP_ALIASES[stoporLabel]?.[String(questionNumber)]?.[value] || value;
}

function refineQuestionKeyboard(question, questionIndex) {
  const kb = new InlineKeyboard();
  question.options.forEach((opt, optIndex) => {
    kb.text(opt, `refine:${questionIndex}:${optIndex}`).row();
  });
  return kb;
}

async function sendStart(ctx) {
  const content = await getContent();
  const quizLink = getQuizLink(content);
  const aboutLink = getAboutLink(content);
  const extra = hasText(quizLink) || hasText(aboutLink)
    ? { reply_markup: miniAppKeyboard(content.start.button || 'Пройти диагностику', quizLink, aboutLink) }
    : {};
  await sendText(ctx, content.start.text, extra);
}

function findEnhancer(content, stoporLabel, refineAnswers) {
  const stoporEnhancers = content.enhancers[stoporLabel] || {};

  for (const q of ['2', '3', '4']) {
    const rawAnswer = refineAnswers[q];
    const lookupAnswer = normalizeRefineLookupValue(stoporLabel, q, rawAnswer);
    if (rawAnswer && stoporEnhancers[q]?.[rawAnswer]) {
      return stoporEnhancers[q][rawAnswer];
    }
    if (lookupAnswer && stoporEnhancers[q]?.[lookupAnswer]) {
      return stoporEnhancers[q][lookupAnswer];
    }
  }

  for (const q of ['2', '3', '4']) {
    const rawAnswer = refineAnswers[q];
    const lookupAnswer = normalizeRefineLookupValue(stoporLabel, q, rawAnswer);
    for (const bucket of Object.values(stoporEnhancers)) {
      if (rawAnswer && bucket?.[rawAnswer]) return bucket[rawAnswer];
      if (lookupAnswer && bucket?.[lookupAnswer]) return bucket[lookupAnswer];
    }
  }

  return null;
}

async function sendDuplicateResult(ctx, user, content) {
  const first = content.duplicate1[user.stoporLabel]?.text || content.finals[user.stoporLabel]?.text || '';
  const aboutUrl = getAboutLink(content);
  if (hasText(first)) {
    await sendText(ctx, first, {
      reply_markup: resultActionKeyboard(content.resultButtons, { aboutUrl }),
    });
  }
}

async function askRefineQuestion(ctx, stoporLabel, questionIndex, content) {
  const questions = content.refineQuizzes[stoporLabel] || [];
  const question = questions[questionIndex];
  if (!question) return null;
  await sendText(ctx, question.text, {
    reply_markup: refineQuestionKeyboard(question, questionIndex),
  });
  return question;
}

async function sendSuperanswer(ctx, user, content) {
  const stoporLabel = user.stoporLabel;
  const q1Raw = user.refineAnswers?.['1'];
  const q1Lookup = normalizeRefineLookupValue(stoporLabel, '1', q1Raw);
  const middle = content.middles[stoporLabel]?.[q1Raw]?.text
    || content.middles[stoporLabel]?.[q1Lookup]?.text
    || '';
  const enhancer = findEnhancer(content, stoporLabel, user.refineAnswers || {});
  const finalCfg = content.finals[stoporLabel] || {};
  const aboutUrl = getAboutLink(content);
  if (hasText(middle)) await sendText(ctx, middle);
  if (hasText(enhancer)) await sendText(ctx, enhancer);
  if (hasText(finalCfg.text)) {
    await sendText(ctx, finalCfg.text, {
      reply_markup: resultActionKeyboard(finalCfg.buttons || content.resultButtons, { aboutUrl }),
    });
  }
}

function parseLinearDelayHours(entry) {
  return timingToHours(entry?.delay || '');
}

async function maybeSendVslAfterResult(userId, stoporLabel) {
  setTimeout(async () => {
    const user = await getUser(userId);
    if (!user || user.engaged || user.voiceRequested || user.callRequested || user.refineCompleted) return;
    const content = await getContent();
    const intro = content.messageEvents['VSL']?.text || '';
    if (hasText(intro)) {
      await bot.api.sendMessage(userId, toTelegramHtml(intro), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
    const media = findMediaEntry(content, '0', user.stoporLabel, 'vsl');
    await sendMediaEntry(userId, media);
  }, 30000);
}

bot.command('start', async (ctx) => {
  const startArg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  const lastWebAppTs = recentWebAppAt.get(ctx.from.id) || 0;

  if (startArg === 'quiz_result') {
    return;
  }

  if (Date.now() - lastWebAppTs < 15000) {
    return;
  }

  await upsertUser({
    userId: ctx.from.id,
    username: ctx.from.username || '',
    firstName: ctx.from.first_name || '',
  });
  await sendStart(ctx);
});

bot.on('message:web_app_data', async (ctx) => {
  const content = await getContent();
  let payload;
  try {
    payload = normalizePayload(ctx.message.web_app_data.data, ctx);
  } catch (error) {
    console.error('Bad web_app_data', error);
    return;
  }

  recentWebAppAt.set(ctx.from.id, Date.now());
  const stoporLabel = stoporCodeToLabel(payload.stoporCode);
  const user = await saveQuizResult({
    userId: payload.userId,
    username: payload.username,
    firstName: payload.firstName,
    stoporCode: payload.stoporCode,
    stoporLabel,
    scores: payload.scores,
    answers: payload.answers,
    qualification: payload.qualification,
    resultVariant: payload.resultVariant,
    resultPayload: payload.resultPayload,
    quizPassedAt: new Date(payload.timestamp).toISOString(),
  });

  const withJourney = await appendJourneyStep(user.userId, 'Прошёл квиз');
  await addEvent({ type: 'silent', eventName: 'Прошёл квиз', userId: user.userId, stopor: user.stoporLabel });
  await sendDuplicateResult(ctx, withJourney || user, content);
  // setImmediate(() => crmSync.onQuizResult(user, payload));
  await maybeSendVslAfterResult(user.userId, stoporLabel);
});

bot.callbackQuery(/^action:(voice|refine|call)$/, async (ctx) => {
  const action = ctx.match[1];
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  if (!user) {
    await ctx.answerCallbackQuery();
    return;
  }

  const buttonText = action === 'voice'
    ? (content.resultButtons[0] || 'Получить личное голосовое')
    : action === 'refine'
      ? (content.resultButtons[1] || 'Уточнить диагноз')
      : (content.resultButtons[2] || 'Записаться на разбор');

  const userWithJourney = await appendJourneyStep(user.userId, buttonText);
  await addEvent({ type: 'button', eventName: 'Нажал кнопку', userId: user.userId, stopor: user.stoporLabel, button: buttonText });
  await ctx.answerCallbackQuery();
  await sendAdminAlert('Нажал кнопку', userWithJourney || user, content, { button: buttonText });
  //setImmediate(() => crmSync.onButtonClick(userWithJourney || user, buttonText));

  if (action === 'voice') {
    await markVoiceRequested(user.userId);
    const text = content.messageEvents['Голосовое']?.text || '';
    const buttonLabel = content.messageEvents['Голосовое']?.button1 || content.resultButtons[0] || 'Получить личное голосовое';
    const kb = actionLinkKeyboard(buttonLabel, getVoiceLink(content));
    await sendText(ctx, text, kb ? { reply_markup: kb } : {});
    const fresh = await getUser(user.userId);
    await sendAdminAlert('Получить голосовое', fresh || userWithJourney || user, content, { button: buttonText });
    return;
  }

  if (action === 'call') {
    await markCallRequested(user.userId);
    const text = content.messageEvents['Разбор']?.text || '';
    const buttonLabel = content.messageEvents['Разбор']?.button1 || content.resultButtons[2] || 'Записаться на разбор';
    const kb = actionLinkKeyboard(buttonLabel, getCallLink(content));
    await sendText(ctx, text, kb ? { reply_markup: kb } : {});
    const fresh = await getUser(user.userId);
    await sendAdminAlert('Записаться на разбор', fresh || userWithJourney || user, content, { button: buttonText });
    return;
  }

  if (user.stage === 'refine_in_progress') {
    const currentQuestionIndex = Number(user.refineSession?.questionIndex || 0);
    await askRefineQuestion(ctx, user.stoporLabel, currentQuestionIndex, content);
    return;
  }

  await markEngaged(user.userId);
  await startRefineSession(user.userId, user.stoporLabel);
  await sendText(ctx, content.messageEvents['Уточнить']?.text || '');
  await askRefineQuestion(ctx, user.stoporLabel, 0, content);
});

bot.callbackQuery(/^refine:(\d+):(\d+)$/, async (ctx) => {
  const questionIndex = Number(ctx.match[1]);
  const optionIndex = Number(ctx.match[2]);
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  if (!user?.stoporLabel) {
    await ctx.answerCallbackQuery();
    return;
  }

  const questions = content.refineQuizzes[user.stoporLabel] || [];
  const question = questions[questionIndex];
  if (!question) {
    await ctx.answerCallbackQuery();
    return;
  }

  const answerText = question.options[optionIndex];
  if (!answerText) {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();
  await saveRefineAnswer(user.userId, questionIndex, answerText);
  await appendJourneyStep(user.userId, `Доп-квиз ${questionIndex + 1}: ${answerText}`);

  const nextQuestion = questions[questionIndex + 1];
  if (nextQuestion) {
    await askRefineQuestion(ctx, user.stoporLabel, questionIndex + 1, content);
  } else {
    await completeRefine(user.userId);
    const withJourney = await appendJourneyStep(user.userId, 'Прошёл доп-квиз');
    await addEvent({ type: 'silent', eventName: 'Прошёл доп-квиз', userId: user.userId, stopor: user.stoporLabel });
    const freshUser = (await getUser(user.userId)) || withJourney || user;
    await sendAdminAlert('Нажал кнопку', freshUser, content, { button: 'Завершил доп-квиз' });
    await sendSuperanswer(ctx, freshUser, content);
  //setImmediate(() => crmSync.onRefineComplete(freshUser));
  }
});

bot.hears(/^хочу$/i, async (ctx) => {
  const content = await getContent();
  const user = (await getUser(ctx.from.id)) || await upsertUser({
    userId: ctx.from.id,
    username: ctx.from.username || '',
    firstName: ctx.from.first_name || '',
  });

  await appendJourneyStep(user.userId, 'Написал хочу');
  const text = content.messageEvents['Написал хочу']?.text || '';
  const buttonLabel = content.messageEvents['Написал хочу']?.button1 || 'Написать Андрею';
  const kb = actionLinkKeyboard(buttonLabel, getVoiceLink(content));
  await sendText(ctx, text, kb ? { reply_markup: kb } : {});
  await markEngaged(user.userId);
  const fresh = await getUser(user.userId);
  await sendAdminAlert('Написал хочу', fresh || user, content, { button: 'Написал хочу' });
  //setImmediate(() => crmSync.onTextMessage(fresh || user, 'хочу'));
});

bot.on('message:text', async (ctx, next) => {
  const text = String(ctx.message.text || '').trim();
  if (text.startsWith('/')) return next();

  if (/^хочу$/i.test(text)) return;

  const content = await getContent();
  const user = await getUser(ctx.from.id);

  await addNote(ctx.from.id, `Не распознан текст: ${text}`);
  const currentUser = user || {
    userId: ctx.from.id,
    username: ctx.from.username || '',
    firstName: ctx.from.first_name || '',
    stoporLabel: '—',
    qualification: '—',
    answers: [],
    refineAnswers: {},
    journey: [],
  };
  await sendText(ctx, content.messageEvents['Не распознал']?.text || 'Принял. Передам Андрею.');
  await sendAdminAlert('Не распознан текст', currentUser, content, { text });
  //setImmediate(() => crmSync.onTextMessage(currentUser, text));
});

async function processFollowups() {
  const content = await getContent();
  const users = await allUsers();
  const now = Date.now();
  const entries = (content.followups30 || []).filter((row) => row.active && hasText(row.text));

  for (const user of users) {
    if (!user.quizPassedAt) continue;
    const quizTime = new Date(user.quizPassedAt).getTime();
    if (!quizTime) continue;
    const elapsedHours = (now - quizTime) / 36e5;

    for (const entry of entries) {
      const key = `d${entry.day}`;
      if (user.followupsSent?.[key]) continue;

      const targetHours = parseLinearDelayHours(entry);
      if (elapsedHours < targetHours) continue;

      const kb = buildLinearFollowupKeyboard(entry, content);
      await bot.api.sendMessage(user.userId, toTelegramHtml(entry.text), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(kb ? { reply_markup: kb } : {}),
      });

      await markFollowupSent(user.userId, key);
    }
  }
}

bot.catch((err) => {
  console.error('Bot error', err.error);
});

await refreshContent(true);
cron.schedule('*/5 * * * *', async () => {
  await refreshContent(true);
}, { timezone: TZ });

cron.schedule('* * * * *', async () => {
  await processFollowups();
}, { timezone: TZ });

bot.start();
console.log('PUT bot started');
