
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function toTelegramHtml(text) {
  const escaped = escapeHtml(text ?? '');
  return escaped.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
}

export function hasText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

export function stoporCodeToLabel(code) {
  return {
    burnout: 'Перегрев',
    money: 'Деньги',
    me: 'На мне',
    chaos: 'Хаос',
  }[code] || code || '—';
}

export function normalizeUserName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return name || user?.username || 'Без имени';
}

export function fillTemplate(template, values = {}) {
  if (!template) return '';
  let text = String(template);

  if (values.phone) {
    text = text.replace(/\{тел\|опционально\}/g, values.phone);
  } else {
    text = text.replace(/^.*\{тел\|опционально\}.*\n?/m, '');
  }

  text = text.replace(/\{имя\}/g, values.name || 'Без имени');
  text = text.replace(/\{username\}/g, values.username || 'без_username');
  text = text.replace(/\{стопор\}/g, values.stopor || '—');
  text = text.replace(/\{квал\}/g, values.qualification || '—');
  text = text.replace(/\{кнопка\}/g, values.button || '—');
  text = text.replace(/\{текст\}/g, values.text || '—');

  return text.trim();
}

export function timingToHours(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s.includes('24')) return 24;
  if (s.includes('72')) return 72;
  if (s.includes('120')) return 120;
  if (s.includes('168')) return 168;
  return 0;
}
