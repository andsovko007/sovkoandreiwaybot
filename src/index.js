
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
  allUsers,
} from './store.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = String(process.env.BOT_USERNAME || '').replace('@', '');
const MINI_APP_URL = process.env.MINI_APP_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!BOT_USERNAME) throw new Error('BOT_USERNAME is required');
if (!MINI_APP_URL) throw new Error('MINI_APP_URL is required');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID is required');

const bot = new Bot(BOT_TOKEN);

function miniAppKeyboard(buttonText, url) {
  return new Keyboard().webApp(buttonText, url).resized().persistent();
}

function html(text) {
  return { parse_mode: 'HTML', disable_web_page_preview: true, text: toTelegramHtml(text) };
}

async function sendText(ctxOrChatId, text, extra = {}) {
  if (!hasText(text)) return;
  const payload = { ...html(text), ...extra };
  if (typeof ctxOrChatId === 'number' || typeof ctxOrChatId === 'string') {
    await bot.api.sendMessage(ctxOrChatId, payload.text, payload);
  } else {
    await ctxOrChatId.reply(payload.text, payload);
  }
}

function buttonId(text) {
  return String(text || '').toLowerCase();
}

function getVoiceLink(content) {
  return content.settings['Ссылка: голосовое'] || '';
}

function getCallLink(content) {
  return content.settings['Ссылка: разбор'] || '';
}

function getQuizLink(content) {
  return MINI_APP_URL || content.settings['Ссылка: квиз'] || '';
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

async function sendAdminAlert(eventName, values = {}, content = null) {
  const cfg = content || await getContent();
  const eventCfg = cfg.alerts[eventName];
  if (!eventCfg?.template) return;
  const text = fillTemplate(eventCfg.template, values);
  await bot.api.sendMessage(ADMIN_CHAT_ID, toTelegramHtml(text), { parse_mode: 'HTML' });
}

function userTemplateValues(user, overrides = {}) {
  return {
    name: normalizeUserName({ first_name: user.firstName, username: user.username }),
    username: user.username || 'без_username',
    stopor: user.stoporLabel || '—',
    qualification: user.qualification || '—',
    phone: user.phone || '—',
    ...overrides,
  };
}

function getStoporLabelByCode(code) {
  return stoporCodeToLabel(code);
}

function resultActionKeyboard(content) {
  const buttons = content.resultButtons || [];
  const kb = new InlineKeyboard();
  if (buttons[0]) kb.text(buttons[0], 'action:voice');
  if (buttons[1]) kb.text(buttons[1], 'action:refine');
  if (buttons[2]) kb.row().text(buttons[2], 'action:call');
  return kb;
}

function refineQuestionKeyboard(question, qIndex) {
  const kb = new InlineKeyboard();
  question.options.forEach((opt, idx) => {
    kb.text(opt, `refine:${qIndex}:${idx}`).row();
  });
  return kb;
}

function textRow(content, event) {
  return content.messageEvents[event]?.text || '';
}

function buttonRow(content, event) {
  return content.messageEvents[event]?.button1 || '';
}

async function sendStart(ctx) {
  const content = await getContent();
  const text = content.start.text;
  const btn = content.start.button || 'Пройти диагностику';
  await sendText(ctx, text, {
    reply_markup: miniAppKeyboard(btn, getQuizLink(content)),
  });
}

function firstSelectedAnswerText(payloadAnswers, questionIndex) {
  const arr = payloadAnswers?.[questionIndex];
  if (Array.isArray(arr)) return arr[0] || null;
  return null;
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
  const stoporLabel = user.stoporLabel;
  const first = content.duplicate1[stoporLabel]?.text;
  await sendText(ctx, first, { reply_markup: resultActionKeyboard(content) });
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
  const middle = content.middles[stoporLabel]?.[q1]?.text;
  const enhancer = findEnhancer(content, stoporLabel, user.refineAnswers || {});
  const finalText = content.finals[stoporLabel]?.text;
  if (hasText(middle)) await sendText(ctx, middle);
  if (hasText(enhancer)) await sendText(ctx, enhancer);
  if (hasText(finalText)) {
    await sendText(ctx, finalText, {
      reply_markup: resultActionKeyboard(content),
    });
  }
}

function parseDayHours(content, dayNumber) {
  const value = content.settings[`День ${dayNumber}`];
  return timingToHours(value);
}

function shouldSkipDay1(user) {
  return Boolean(user.refineCompleted || user.voiceRequested || user.callRequested);
}

function isBooked(user) {
  return Boolean(user.callRequested);
}

async function handleDay5Keyword(ctx, user, content) {
  const normalized = String(ctx.message?.text || '').trim().toLowerCase();
  const allowed = ['клиенты', 'продажи', 'хаос', 'всё на мне', 'все на мне', 'на мне'];
  if (!allowed.includes(normalized)) return false;

  const row = content.followups.find((r) => r.day === 5 && r.state === 'Ответил словом' && r.stopor === 'all');
  if (row?.text) {
    const generalVsl = content.media.find((m) => String(m.day) === '5' && m.type === 'VSL 2мин' && m.stopor === 'all')?.text || '';
    const out = row.text.replace('[VSL общий]', generalVsl);
    await sendText(ctx, out);
  }
  await setWaitKeywordDay5(user.userId, false);
  await markEngaged(user.userId);
  return true;
}

async function maybeSendVslAfterResult(userId, stoporLabel) {
  setTimeout(async () => {
    const user = await getUser(userId);
    if (!user || user.engaged || user.voiceRequested || user.callRequested || user.refineCompleted) return;
    const content = await getContent();
    const row = content.messageEvents['VSL']?.text;
    if (hasText(row)) {
      await bot.api.sendMessage(userId, toTelegramHtml(row), { parse_mode: 'HTML' });
    }
    const media = content.media.find((m) => String(m.day) === '0' && m.type === 'VSL 60с' && m.stopor === user.stoporCode);
    if (media?.text) {
      await bot.api.sendMessage(userId, toTelegramHtml(media.text), { parse_mode: 'HTML' });
    }
  }, 30000);
}

bot.command('start', async (ctx) => {
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

  const stoporLabel = getStoporLabelByCode(payload.stoporCode);
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

  await sendAdminAlert('Нажал кнопку', userTemplateValues(user, { button: action }), content);
  await ctx.answerCallbackQuery();

  if (action === 'voice') {
    await markVoiceRequested(user.userId);
    const link = getVoiceLink(content);
    const kb = hasText(link) ? new InlineKeyboard().url('Написать Андрею', link) : undefined;
    await sendText(ctx, textRow(content, 'Голосовое'), kb ? { reply_markup: kb } : {});
    await sendAdminAlert('Получить голосовое', userTemplateValues(user), content);
    return;
  }

  if (action === 'call') {
    await markCallRequested(user.userId);
    const link = getCallLink(content);
    const kb = hasText(link) ? new InlineKeyboard().url(buttonRow(content, 'Разбор') || 'Написать Андрею', link) : undefined;
    await sendText(ctx, textRow(content, 'Разбор'), kb ? { reply_markup: kb } : {});
    await sendAdminAlert('Записаться на разбор', userTemplateValues(user), content);
    return;
  }

  if (action === 'refine') {
    await markEngaged(user.userId);
    await startRefineSession(user.userId, user.stoporCode);
    await sendText(ctx, textRow(content, 'Уточнить'));
    await askRefineQuestion(ctx, user.stoporLabel, 0, content);
  }
});

bot.callbackQuery(/^refine:(\d+):(\d+)$/, async (ctx) => {
  const qIndex = Number(ctx.match[1]);
  const optIndex = Number(ctx.match[2]);
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  if (!user?.stoporLabel) {
    await ctx.answerCallbackQuery();
    return;
  }

  const questions = content.refineQuizzes[user.stoporLabel] || [];
  const question = questions[qIndex];
  if (!question) {
    await ctx.answerCallbackQuery();
    return;
  }

  const answerText = question.options[optIndex];
  if (!answerText) {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();
  await saveRefineAnswer(user.userId, qIndex, answerText);

  const nextQuestion = questions[qIndex + 1];
  if (nextQuestion) {
    await askRefineQuestion(ctx, user.stoporLabel, qIndex + 1, content);
  } else {
    await completeRefine(user.userId);
    const freshUser = await getUser(user.userId);
    await sendSuperanswer(ctx, freshUser, content);
  }
});

bot.hears(/^хочу$/i, async (ctx) => {
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  if (!user) {
    await upsertUser({ userId: ctx.from.id, username: ctx.from.username || '', firstName: ctx.from.first_name || '' });
  }
  const currentUser = (await getUser(ctx.from.id)) || { userId: ctx.from.id, username: ctx.from.username || '', firstName: ctx.from.first_name || '', stoporLabel: '—', qualification: '—' };
  const link = getVoiceLink(content);
  const kb = hasText(link) ? new InlineKeyboard().url(buttonRow(content, 'Написал хочу') || 'Написать Андрею', link) : undefined;
  await sendText(ctx, textRow(content, 'Написал хочу'), kb ? { reply_markup: kb } : {});
  await markEngaged(ctx.from.id);
  await sendAdminAlert('Написал хочу', userTemplateValues(currentUser), content);
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
  const currentUser = user || { userId: ctx.from.id, username: ctx.from.username || '', firstName: ctx.from.first_name || '', stoporLabel: '—', qualification: '—' };
  await sendText(ctx, textRow(content, 'Не распознал'));
  await sendAdminAlert('Не распознан текст', userTemplateValues(currentUser, { text }), content);
});

bot.callbackQuery(/^day1:(money|overload)$/, async (ctx) => {
  const content = await getContent();
  const user = await getUser(ctx.from.id);
  if (!user?.stoporLabel) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  const state = ctx.match[1] === 'money' ? 'Кнопка: Деньги' : 'Кнопка: Не вывожу';
  const row = content.followups.find((r) => r.day === 1 && r.state === state && r.rawStopor === user.stoporLabel);
  if (row?.text) {
    await sendText(ctx, row.text);
    await markEngaged(user.userId);
  }
});

async function processFollowups() {
  const content = await getContent();
  const users = await allUsers();
  const now = Date.now();

  for (const user of users) {
    if (!user.quizPassedAt) continue;
    const quizTime = new Date(user.quizPassedAt).getTime();
    if (!quizTime) continue;
    const elapsedHours = (now - quizTime) / 36e5;

    // Day 1
    if (!user.followupsSent?.day1 && elapsedHours >= parseDayHours(content, 1)) {
      if (!shouldSkipDay1(user)) {
        const row = content.followups.find((r) => r.day === 1 && r.state === 'Не взаимод. + не записался' && r.stopor === 'all');
        if (row?.text) {
          const kb = new InlineKeyboard()
            .text(row.button1 || 'Денег/клиентов не хватает', 'day1:money')
            .row()
            .text(row.button2 || 'Я уже не вывожу', 'day1:overload');
          await bot.api.sendMessage(user.userId, toTelegramHtml(row.text), { parse_mode: 'HTML', reply_markup: kb });
        }
      }
      await markFollowupSent(user.userId, 'day1');
    }

    // Day 3
    if (!user.followupsSent?.day3 && elapsedHours >= parseDayHours(content, 3)) {
      if (!(user.refineCompleted || user.voiceRequested)) {
        if (user.engaged) {
          const voice = content.media.find((m) => m.day === '3' && m.stopor === user.stoporCode);
          const row = content.followups.find((r) => r.day === 3 && r.state === 'Взаимодействовал + не записался' && r.stopor === 'all');
          if (voice?.text) {
            await bot.api.sendMessage(user.userId, toTelegramHtml(voice.text), { parse_mode: 'HTML' });
          }
          if (row?.text) {
            const text = row.text.replace('[ВОЙС по стопору]', '').trim();
            const kb = row.button1 ? new InlineKeyboard().text(row.button1, 'want:call') : undefined;
            await bot.api.sendMessage(user.userId, toTelegramHtml(text), { parse_mode: 'HTML', reply_markup: kb });
          }
        } else {
          const row = content.followups.find((r) => r.day === 3 && r.state === 'Молчун' && r.rawStopor === user.stoporLabel);
          if (row?.text) {
            await bot.api.sendMessage(user.userId, toTelegramHtml(row.text), { parse_mode: 'HTML' });
          }
        }
      }
      await markFollowupSent(user.userId, 'day3');
    }

    // Day 5
    if (!user.followupsSent?.day5 && elapsedHours >= parseDayHours(content, 5)) {
      if (!isBooked(user)) {
        const row = content.followups.find((r) => r.day === 5 && r.state === 'Не записался' && r.stopor === 'all');
        if (row?.text) {
          await bot.api.sendMessage(user.userId, toTelegramHtml(row.text), { parse_mode: 'HTML' });
          await setWaitKeywordDay5(user.userId, true);
        }
      }
      await markFollowupSent(user.userId, 'day5');
    }

    // Day 7
    if (!user.followupsSent?.day7 && elapsedHours >= parseDayHours(content, 7)) {
      if (!isBooked(user)) {
        const row = content.followups.find((r) => r.day === 7 && r.state === 'Не записался' && r.stopor === 'all');
        if (row?.text) {
          await bot.api.sendMessage(user.userId, toTelegramHtml(row.text), { parse_mode: 'HTML' });
        }
      }
      await markFollowupSent(user.userId, 'day7');
    }
  }
}

bot.callbackQuery('want:call', async (ctx) => {
  await ctx.answerCallbackQuery();
  const content = await getContent();
  const link = getCallLink(content);
  const kb = hasText(link) ? new InlineKeyboard().url('Написать Андрею', link) : undefined;
  await sendText(ctx, textRow(content, 'Написал хочу'), kb ? { reply_markup: kb } : {});
  const user = await getUser(ctx.from.id);
  if (user) {
    await markEngaged(user.userId);
    await sendAdminAlert('Написал хочу', userTemplateValues(user), content);
  }
});

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
