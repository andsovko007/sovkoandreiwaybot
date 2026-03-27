export function normalizePayload(raw) {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    type: payload.type || 'quiz_result',
    quizVersion: payload.quiz_version || payload.quizVersion || 'v1',
    stoporCode: payload.stopor_code || payload.stoporCode || payload.stopor || null,
    scores: payload.scores || {},
    answers: payload.answers || {},
    qualification: payload.qualification || null,
    resultVariant: payload.result_variant || payload.resultVariant || null,
    resultPayload: payload.result_payload || payload.resultPayload || null,
    ctaAction: payload.cta_action || payload.ctaAction || 'continue_tg',
    timestamp: payload.timestamp || Date.now(),
    tgUserId: payload.tg_user_id || payload.tgUserId || null,
    username: payload.username || null,
  };
}
