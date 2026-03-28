function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
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

export function stoporLabelToCode(label) {
  return {
    'Перегрев': 'burnout',
    'Деньги': 'money',
    'На мне': 'me',
    'Хаос': 'chaos',
  }[label] || label || null;
}

export function normalizeUserName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return name || user?.firstName || user?.username || 'Без имени';
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
  text = text.replace(/\{id\}/g, String(values.id || '—'));
  text = text.replace(/\{resultVariant\}/g, values.resultVariant || '—');
  text = text.replace(/\{путь\}/g, values.path || '—');

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

export function normalizeTelegramPrefillUrl(url) {
  if (!hasText(url)) return '';
  try {
    const raw = String(url).trim();
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '');

    if (host === 't.me' || host === 'telegram.me') {
      const username = parsed.pathname.replace(/^\/+/, '');
      const text = parsed.searchParams.get('text');

      if (!username) return parsed.toString();

      if (text == null) {
        return `https://t.me/${username}`;
      }

      const decoded = safeDecode(text).replace(/\+/g, ' ').trim();
      return `https://t.me/${username}?text=${encodeURIComponent(decoded)}`;
    }

    return parsed.toString();
  } catch {
    return String(url).trim();
  }
}
