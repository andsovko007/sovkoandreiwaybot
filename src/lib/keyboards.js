import { InlineKeyboard, Keyboard } from 'grammy';
import { APP } from '../config/content.js';

export function miniAppKeyboard(url) {
  return new Keyboard().webApp(APP.miniAppButtonText, url).resized().persistent();
}

export function resultActionsKeyboard() {
  return new InlineKeyboard()
    .text('Получить личное голосовое', 'action:voice').row()
    .text('Уточнить диагноз', 'action:refine').row()
    .text('Записаться на разбор', 'action:call');
}

export function refineQuestionKeyboard(question) {
  const kb = new InlineKeyboard();
  question.options.forEach((option) => {
    kb.text(option.text, `refine:${question.id}:${option.id}`).row();
  });
  return kb;
}
