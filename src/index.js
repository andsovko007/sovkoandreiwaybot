import 'dotenv/config';
import cron from 'node-cron';
import { Bot, GrammyError, HttpError, session } from 'grammy';
import { START_TEXT, CTA_TEXT, FOLLOWUPS, ALERTS } from './config/content.js';
import { miniAppKeyboard, refineQuestionKeyboard, resultActionsKeyboard } from './lib/keyboards.js';
import {
  addNote,
  completeRefine,
  getUser,
  listUsersDueFollowup,
  markCallRequested,
  markFollowupSent,
  markVoiceRequested,
  saveQuizResult,
  saveRefineAnswer,
  setFollowupTrack,
  startRefineSession,
  upsertUser,
} from './lib/store.js';
import { buildDuplicateMessages, buildSuperanswer, getStoporConfig, payloadSummary } from './lib/result.js';
import { normalizePayload } from './lib/payload.js';

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

bot.use(session({ initial: () => ({}) }));

async function sendAdminAlert(title, lines = []) {
  const text = [title, ...lines.filter(Boolean)].join('\n');
  try {
    await bot.api.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Failed to send admin alert', error);
  }
}

function userLabel(ctx) {
  const user = ctx.from;
  if (!user) return 'unknown';
  const username = user.username ? `@${user.username}` : 'без username';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return `${name || 'Без имени'} · ${username} · id ${user.id}`;
}

function continueBotLink(start = 'quiz_result') {
  return `https://t.me/${BOT_USERNAME}?start=${start}`;
}

async function sendDuplicateResult(ctx, user) {
  const messages = buildDuplicateMessages(user);
  for (const text of messages) {
    if (text) {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
  }
  await ctx.reply('Что делаем дальше?', {
    reply_markup: resultActionsKeyboard(),
  });
}

async function sendRefineQuestion(ctx, user) {
  const stopor = getStoporConfig(user.stoporCode);
  const step = user.refineSession?.step || 0;
  const question = stopor.refine.questions[step];
  if (!question) {
    const refreshed = await completeRefine(user.userId);
    const messages = buildSuperanswer(refreshed);
    for (const text of messages) {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
    await ctx.reply('Что делаем дальше?', { reply_markup: resultActionsKeyboard() });
    return;
  }

  await ctx.reply(question.text, {
    reply_markup: refineQuestionKeyboard(question),
  });
}

async function onVoiceRequested(ctx, user) {
  await markVoiceRequested(user.userId);
  await ctx.reply(CTA_TEXT.voiceRequestedUser);
  await sendAdminAlert(ALERTS.voice, [
    userLabel(ctx),
    `Стопор: ${getStoporConfig(user.stoporCode).label}`,
    `Ссылка: ${continueBotLink('voice')}`,
  ]);
}

async function onCallRequested(ctx, user) {
  await markCallRequested(user.userId);
  await ctx.reply(CTA_TEXT.callRequestedUser);
  await sendAdminAlert(ALERTS.call, [
    userLabel(ctx),
    `Стопор: ${getStoporConfig(user.stoporCode).label}`,
    `Ссылка: ${continueBotLink('call')}`,
  ]);
}

bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const existing = await getUser(userId);
  const deepLink = (ctx.match || '').trim();

  await upsertUser({
    userId,
    username: ctx.from.username || '',
    firstName: ctx.from.first_name || '',
  });

  if (deepLink === 'quiz_result' && existing?.stoporCode) {
    await ctx.reply('Ты уже прошёл главный квиз. Ниже — твой следующий шаг.', {
      reply_markup: resultActionsKeyboard(),
    });
    return;
  }

  await ctx.reply(existing?.stoporCode ? START_TEXT.afterQuiz : START_TEXT.newUser, {
    parse_mode: 'Markdown',
    reply_markup: miniAppKeyboard(MINI_APP_URL),
  });
});

bot.on('message:web_app_data', async (ctx) => {
  try {
    const raw = ctx.message.web_app_data.data;
    const payload = normalizePayload(raw);
    const saved = await saveQuizResult(ctx.from.id, payload, {
      username: ctx.from.username || '',
      firstName: ctx.from.first_name || '',
    });

    await sendAdminAlert(ALERTS.newLead, [
      userLabel(ctx),
      `Стопор: ${getStoporConfig(saved.stoporCode).label}`,
      payloadSummary(payload),
    ]);

    await sendDuplicateResult(ctx, saved);
  } catch (error) {
    console.error('web_app_data error', error);
    await addNote(ctx.from.id, {
      type: 'web_app_data_error',
      raw: ctx.message.web_app_data.data,
      error: String(error?.message || error),
    });
    await ctx.reply(CTA_TEXT.fallbackUser);
  }
});

bot.callbackQuery(/^action:(voice|refine|call)$/, async (ctx) => {
  const action = ctx.match[1];
  const user = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();

  if (!user?.stoporCode) {
    await ctx.reply('Сначала пройди диагностику, чтобы я понял, с какого узла начинать.', {
      reply_markup: miniAppKeyboard(MINI_APP_URL),
    });
    return;
  }

  if (action === 'voice') {
    await onVoiceRequested(ctx, user);
    return;
  }

  if (action === 'call') {
    await onCallRequested(ctx, user);
    return;
  }

  if (action === 'refine') {
    await setFollowupTrack(user.userId, 'refine');
    const refreshed = await startRefineSession(user.userId, user.stoporCode);
    await sendAdminAlert(ALERTS.refine, [
      userLabel(ctx),
      `Стопор: ${getStoporConfig(refreshed.stoporCode).label}`,
    ]);
    await sendRefineQuestion(ctx, refreshed);
  }
});

bot.callbackQuery(/^refine:(q\d+):([a-z_]+)$/, async (ctx) => {
  const [, questionId, optionId] = ctx.match;
  const user = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();

  if (!user?.refineSession) {
    await ctx.reply('Уточняющий квиз не активен. Нажми «Уточнить диагноз» ещё раз.');
    return;
  }

  await saveRefineAnswer(user.userId, questionId, optionId);
  const refreshed = await getUser(user.userId);
  await sendRefineQuestion(ctx, refreshed);
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text?.trim();
  if (!text || text.startsWith('/')) return;

  const user = await getUser(ctx.from.id);

  // Freeform texts are not used for branching in V1. Forward to admin, ack to user.
  await addNote(ctx.from.id, {
    type: 'fallback_text',
    text,
    stoporCode: user?.stoporCode || null,
    stage: user?.stage || 'unknown',
  });

  await sendAdminAlert(ALERTS.fallback, [
    userLabel(ctx),
    `Этап: ${user?.stage || 'unknown'}`,
    `Стопор: ${user?.stoporCode || '-'}`,
    '',
    text,
  ]);

  await ctx.reply(CTA_TEXT.fallbackUser);
});

cron.schedule('*/10 * * * *', async () => {
  try {
    const dueItems = await listUsersDueFollowup();
    for (const item of dueItems) {
      const { user, day, track } = item;
      const text = FOLLOWUPS[track]?.[day];
      if (!text) continue;
      await bot.api.sendMessage(user.userId, text, {
        parse_mode: 'Markdown',
        reply_markup: resultActionsKeyboard(),
      });
      await markFollowupSent(user.userId, day);
    }
  } catch (error) {
    console.error('followup scheduler error', error);
  }
}, { timezone: TZ });

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error('Error in request:', e.description);
  } else if (e instanceof HttpError) {
    console.error('Could not contact Telegram:', e);
  } else {
    console.error('Unknown error:', e);
  }
});

bot.start();
console.log('PUT bot V1 started');
