import { STOPORS } from '../config/content.js';

function safeText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function getStoporConfig(code) {
  return STOPORS[code] || STOPORS.money;
}

export function buildDuplicateMessages(user) {
  const stopor = getStoporConfig(user.stoporCode);
  const rp = user.resultPayload || {};

  const intro = safeText(rp.telegram_intro) || safeText(rp.telegramIntro) || stopor.duplicate.m1;
  const why = safeText(rp.telegram_why) || safeText(rp.telegramWhy) || stopor.duplicate.m2;
  const next = safeText(rp.telegram_next) || safeText(rp.telegramNext) || stopor.duplicate.m3;

  return [intro, why, next];
}

export function buildSuperanswer(user) {
  const stopor = getStoporConfig(user.stoporCode);
  const answers = user.refineAnswers || {};
  const primaryAnswer = answers.q1;
  const enhancerAnswer = answers.q2 || answers.q3 || answers.q4;

  const m1 = stopor.superanswers.primary[primaryAnswer] || stopor.duplicate.m2;
  const enhancer = stopor.superanswers.enhancers[enhancerAnswer]
    ? `\n\n${stopor.superanswers.enhancers[enhancerAnswer]}`
    : '';
  const m2 = `${m1}${enhancer}`;
  const m3 = stopor.superanswers.closing;

  return [
    `**Уточнённый диагноз — ${stopor.label}.**`,
    m2,
    m3,
  ];
}

export function payloadSummary(payload) {
  const stopor = payload.stoporCode || payload.stopor || 'unknown';
  return [
    `stopor: ${stopor}`,
    `variant: ${payload.resultVariant || payload.result_variant || '-'}`,
    `action: ${payload.ctaAction || payload.cta_action || '-'}`,
  ].join('\n');
}
