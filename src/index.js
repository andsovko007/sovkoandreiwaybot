import 'dotenv/config';
import cron from 'node-cron';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { getContent, refreshContent } from './googleSheetsContent.js';
import { toTelegramHtml, hasText, stoporCodeToLabel, normalizeUserName, fillTemplate, timingToHours } from './formatter.js';
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
} from './store.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = String(process.env.BOT_USERNAME || '').replace('@', '');
const MINI_APP_URL = process.env.MINI_APP_URL;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '');
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!BOT_USERNAME) throw new Error('BOT_USERNAME is required');
if (!MINI_APP_URL) throw new Error('MINI_APP_URL is required');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID is required');

const bot = new Bot(BOT_TOKEN);

function htmlPayload(text, extra = {}) {
  return {
    text: toTelegramHtml(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  };
}

async function sendText(ctxOrChatId, text, extra = {}) {
  if (!hasText(text)) return;
  const payload = htmlPayload(text, extra);
  if (typeof ctxOrChatId === 'number' || typeof ctxOrChatId === 'string') {
    await bot.api.sendMessage(ctxOrChatId, payload.text, payload);
  } else {
    await ctxOrChatId.reply(payload.text, payload);
  }
}

function miniAppKeyboard(buttonText, url) {
  return new Keyboard().webApp(buttonText, url).resized().persistent();
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
  return content.settings['Ссылка: квиз'] || MINI_APP_URL || '';
}

function sanitizeTelegramLink(url) {
  if (!hasText(url)) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 't.me') {
      const username = u.pathname.replace(/^\//, '');
      const text = u.searchParams.get('text');
      if (username && text != null) {
        return `https://t.me/${username}?text=${encodeURIComponent(text)}`;
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

function getVoiceLink(content) {
  return sanitizeTelegramLink(content.settings['Ссылка: голосовое'] || '');
}

function getCallLink(content) {
  return sanitizeTelegramLink(content.settings['Ссылка: разбор'] || '');
}

function userTemplateValues(user, overrides = {}) {
  return {
    name: normalizeUserName({ first_name: user.firstName, username: user.username }),
    username: user.username || 'без_username',
    stopor: user.stoporLabel || '—',
    qualification: user.qualification || '—',
    phone: user.phone || '',
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

function buildAlertContext(user, button = '') {
  const quizAnswers = formatQuizAnswers(user.answers);
  const refineAnswers = formatRefineAnswers(user.refineAnswers);
  const lines = [
    '',
    `ID: ${user.userId || '—'}`,
    `Кнопка: ${button || '—'}`,
    `Вариант результата: ${user.resultVariant || '—'}`,
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
  if (eventCfg.where && String(eventCfg.where).includes('таблица')) {
    await addEvent({ type: 'alert', eventName, userId: user.userId, stopor: user.stoporLabel, text: finalText });
  }
}

function resultActionKeyboard(buttons) {
  const btns = buttons || [];
  const kb = new InlineKeyboard();
  if (btns[0]) kb.text(btns[0], 'action:voice').row();
  if (btns[1]) kb.text(btns[1], 'action:refine').row();
  if (btns[2]) kb.text(btns[2], 'action:call');
  return kb;
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

function refineQuestionKeyboard(question, questionIndex) {
  const kb = new InlineKeyboard();
  question.options.forEach((opt, optIndex) => {
    kb.text(opt, `refine:${questionIndex}:${optIndex}`).row();
  });
  return kb;
}

async function sendStart(ctx) {
  const content = await getContent();
  await sendText(ctx, content.start.text, {
    reply_markup: miniAppKeyboard(content.start.button || 'Пройти диагностику', getQuizLink(content)),
  });
}

function findEnhancer(content, stoporLabel, refineAnswers) {
  const stoporEnhancers = content.enhancers[stoporLabel] || {};
  for (const q of ['2', '3', '4']) {
    const answer = refineAnswers[q];
    if (answer && stoporEnhancers[q] && stoporEnhancers[q][answer]) {
      return stoporEnhancers[q][answer];
    }
  }
  return null;
}

async function sendDuplicateResult(ctx, user, content) {
  const first = content.duplicate1[user.stoporLabel]?.text;
  await sendText(ctx, first, {
    reply_markup: resultActionKeyboard(content.resultButtons),
  });
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
  const q1 = user.refineAnswers?.['1'];
  const middle = content.middles[stoporLabel]?.[q1]?.text || '';
  const enhancer = findEnhancer(content, stoporLabel, user.refineAnswers || {});
  const finalCfg = content.finals[stoporLabel] || {};
  if (hasText(middle)) await sendText(ctx, middle);
  if (hasText(enhancer)) await sendText(ctx, enhancer);
  if (hasText(finalCfg.text)) {
    await sendText(ctx, finalCfg.text, {
      reply_markup: resultActionKeyboard(finalCfg.buttons || content.resultButtons),
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
      await bot.api.sendMessage(userId, toTelegramHtml(intro), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const media = content.media.find((m) => m.day === '0' && m.type === 'VSL 60с' && m.stopor === user.stoporLabel);
    if (media?.text) {
      await bot.api.sendMessage(userId, toTelegramHtml(media.text), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
  }, 30000);
}

async function handleDay5Keyword(ctx, user, content) {
  const normalized = String(ctx.message?.text || '').trim().toLowerCase();
  const allowed = ['клиенты', 'продажи', 'хаос', 'всё на мне', 'все на мне'];
  if (!allowed.includes(normalized)) return false;

  const row = content.followups.find((r) => r.day === 5 && r.state === 'Ответил словом' && r.stopor === 'Все');
  if (row?.text) {
    const media = content.media.find((m) => m.day === '5' && m.type === 'VSL 2мин' && m.stopor === 'Общий');
    const out = row.text.replace('[VSL общий]', media?.text || '');
    await sendText(ctx, out);
  }
  await setWaitKeywordDay5(user.userId, false);
  await markEngaged(user.userId);
  return true;
}

bot.command('start', async (ctx) => {
  const startArg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  const existing = await getUser(ctx.from.id);
  if (startArg === 'quiz_result' && existing?.quizPassedAt) {
    const elapsedMs = Date.now() - new Date(existing.quizPassedAt).getTime();
    if (elapsedMs < 5 * 60 * 1000) {
      return;
    }
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

  await addEvent({ type: 'silent', eventName: 'Прошёл квиз', userId: user.userId, stopor: user.stoporLabel });
  await sendDuplicateResult(ctx, user, content);
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

  await sendAdminAlert('Нажал кнопку', user, content, { button: buttonText });
  await ctx.answerCallbackQuery();

  if (action === 'voice') {
    await markVoiceRequested(user.userId);
    const text = content.messageEvents['Голосовое']?.text || '';
    const buttonLabel = content.messageEvents['Голосовое']?.button1 || content.resultButtons[0] || 'Получить личное голосовое';
    const kb = actionLinkKeyboard(buttonLabel, getVoiceLink(content));
    await sendText(ctx, text, kb ? { reply_markup: kb } : {});
    const fresh = await getUser(user.userId);
    await sendAdminAlert('Получить голосовое', fresh || user, content, { button: buttonText });
    return;
  }

  if (action === 'call') {
    await markCallRequested(user.userId);
    const text = content.messageEvents['Разбор']?.text || '';
    const buttonLabel = content.messageEvents['Разбор']?.button1 || content.resultButtons[2] || 'Записаться на разбор';
    const kb = actionLinkKeyboard(buttonLabel, getCallLink(content));
    await sendText(ctx, text, kb ? { reply_markup: kb } : {});
    const fresh = await getUser(user.userId);
    await sendAdminAlert('Записаться на разбор', fresh || user, content, { button: buttonText });
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

  const nextQuestion = questions[questionIndex + 1];
  if (nextQuestion) {
    await askRefineQuestion(ctx, user.stoporLabel, questionIndex + 1, content);
  } else {
    await completeRefine(user.userId);
    await addEvent({ type: 'silent', eventName: 'Прошёл доп-квиз', userId: user.userId, stopor: user.stoporLabel });
    const freshUser = await getUser(user.userId);
    await sendSuperanswer(ctx, freshUser, content);
  }
});

bot.hears(/^хочу$/i, async (ctx) => {
  const content = await getContent();
  const user = (await getUser(ctx.from.id)) || await upsertUser({
    userId: ctx.from.id,
    username: ctx.from.username || '',
    firstName: ctx.from.first_name || '',
  });

  const text = content.messageEvents['Написал хочу']?.text || '';
  const buttonLabel = content.messageEvents['Написал хочу']?.button1 || 'Написать Андрею';
  const kb = actionLinkKeyboard(buttonLabel, getVoiceLink(content));
  await sendText(ctx, text, kb ? { reply_markup: kb } : {});
  await markEngaged(user.userId);
  const fresh = await getUser(user.userId);
  await sendAdminAlert('Написал хочу', fresh || user, content, { button: 'Написал хочу' });
});

bot.on('message:text', async (ctx, next) => {
  const text = String(ctx.message.text || '').trim();
  if (text.startsWith('/')) return next();

  const content = await getContent();
  const user = await getUser(ctx.from.id);

  if (user?.waitKeywordDay5) {
    const handled = await handleDay5Keyword(ctx, user, content);
    if (handled) return;
  }

  if (/^хочу$/i.test(text)) return;

  await addNote(ctx.from.id, `Не распознан текст: ${text}`);
  const currentUser = user || { userId: ctx.from.id, username: ctx.from.username || '', firstName: ctx.from.first_name || '', stoporLabel: '—', qualification: '—', answers: [], refineAnswers: {} };
  await sendText(ctx, content.messageEvents['Не распознал']?.text || 'Принял. Передам Андрею.');
  await sendAdminAlert('Не распознан текст', currentUser, content, { text });
});

bot.callbackQuery(/^day1:(money|overload)$/, async (ctx) => {
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  if (!user?.stoporLabel) {
    await ctx.answerCallbackQuery();
    return;
  }

  const state = ctx.match[1] === 'money' ? 'Кнопка: Деньги' : 'Кнопка: Не вывожу';
  const row = content.followups.find((r) => r.day === 1 && r.state === state && r.stopor === user.stoporLabel);
  await ctx.answerCallbackQuery();
  if (row?.text) {
    await sendText(ctx, row.text);
    await markEngaged(user.userId);
  }
});

bot.callbackQuery('want:call', async (ctx) => {
  await ctx.answerCallbackQuery();
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  const text = content.messageEvents['Написал хочу']?.text || '';
  const buttonLabel = content.messageEvents['Написал хочу']?.button1 || 'Написать Андрею';
  const kb = actionLinkKeyboard(buttonLabel, getCallLink(content));
  await sendText(ctx, text, kb ? { reply_markup: kb } : {});
  if (user) {
    await markEngaged(user.userId);
    const fresh = await getUser(user.userId);
    await sendAdminAlert('Написал хочу', fresh || user, content, { button: 'Написал хочу' });
  }
});

async function processFollowups() {
  const content = await getContent();
  const users = await allUsers();
  const now = Date.now();
  const entries = (content.followups30 || []).filter((row) => row.active);

  if (!entries.length) return;

  for (const user of users) {
    if (!user.quizPassedAt) continue;
    const quizTime = new Date(user.quizPassedAt).getTime();
    if (!quizTime) continue;

    for (const entry of entries) {
      const key = `d${entry.day}`;
      if (user.followupsSent?.[key]) continue;

      const delayHours = parseLinearDelayHours(entry);
      const elapsedHours = (now - quizTime) / 36e5;
      if (elapsedHours < delayHours) continue;

      if (hasText(entry.text)) {
        const replyMarkup = buildLinearFollowupKeyboard(entry, content);
        await bot.api.sendMessage(user.userId, toTelegramHtml(entry.text), {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }

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
