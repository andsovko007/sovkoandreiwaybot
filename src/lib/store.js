import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const defaultDb = () => ({ users: {}, meta: { createdAt: new Date().toISOString() } });

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, JSON.stringify(defaultDb(), null, 2), 'utf8');
  }
}

async function readDb() {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return defaultDb();
  }
}

async function writeDb(db) {
  await ensureStore();
  await fs.writeFile(STORE_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function baseUser(userId, username = '', firstName = '') {
  return {
    userId,
    username,
    firstName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: 'new',
    stoporCode: null,
    scores: {},
    answers: null,
    qualification: null,
    resultVariant: null,
    resultPayload: null,
    actions: [],
    refineSession: null,
    refineAnswers: null,
    followup: null,
    notes: [],
    phone: null,
  };
}

export async function getUser(userId) {
  const db = await readDb();
  return db.users[String(userId)] || null;
}

export async function upsertUser(partial) {
  const db = await readDb();
  const key = String(partial.userId);
  const existing = db.users[key] || baseUser(partial.userId, partial.username, partial.firstName);
  db.users[key] = {
    ...existing,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await writeDb(db);
  return db.users[key];
}

export async function appendAction(userId, action, extra = {}) {
  const user = (await getUser(userId)) || baseUser(userId);
  user.actions = Array.isArray(user.actions) ? user.actions : [];
  user.actions.push({ action, at: new Date().toISOString(), ...extra });
  return upsertUser(user);
}

export async function saveQuizResult(userId, payload, meta = {}) {
  const existing = (await getUser(userId)) || baseUser(userId, meta.username, meta.firstName);
  const user = {
    ...existing,
    username: meta.username ?? existing.username,
    firstName: meta.firstName ?? existing.firstName,
    stage: 'quiz_completed',
    stoporCode: payload.stoporCode || payload.stopor || existing.stoporCode || null,
    scores: payload.scores || {},
    answers: payload.answers || null,
    qualification: payload.qualification || null,
    resultVariant: payload.resultVariant || payload.result_variant || null,
    resultPayload: payload.resultPayload || payload.result_payload || null,
    lastQuizAt: new Date().toISOString(),
    followup: {
      track: 'quiz',
      anchorAt: new Date().toISOString(),
      sentDays: [],
    },
  };
  await upsertUser(user);
  await appendAction(userId, 'quiz_completed', {
    stoporCode: user.stoporCode,
    resultVariant: user.resultVariant,
  });
  return getUser(userId);
}

export async function setFollowupTrack(userId, track) {
  const user = (await getUser(userId)) || baseUser(userId);
  user.followup = {
    track,
    anchorAt: new Date().toISOString(),
    sentDays: [],
  };
  user.updatedAt = new Date().toISOString();
  return upsertUser(user);
}

export async function markFollowupSent(userId, day) {
  const user = await getUser(userId);
  if (!user?.followup) return user;
  const sentDays = new Set(user.followup.sentDays || []);
  sentDays.add(Number(day));
  user.followup.sentDays = [...sentDays];
  return upsertUser(user);
}

export async function listUsersDueFollowup() {
  const db = await readDb();
  const now = Date.now();
  const due = [];
  for (const user of Object.values(db.users)) {
    if (!user.followup?.track || !user.followup?.anchorAt) continue;
    const sent = new Set(user.followup.sentDays || []);
    const anchor = new Date(user.followup.anchorAt).getTime();
    if (Number.isNaN(anchor)) continue;
    const daysPassed = Math.floor((now - anchor) / (1000 * 60 * 60 * 24));
    for (const day of [1, 3, 5, 7]) {
      if (daysPassed >= day && !sent.has(day)) {
        due.push({ user, day, track: user.followup.track });
        break;
      }
    }
  }
  return due;
}

export async function startRefineSession(userId, stoporCode) {
  const user = (await getUser(userId)) || baseUser(userId);
  user.stage = 'refine_started';
  user.refineSession = {
    stoporCode,
    step: 0,
    startedAt: new Date().toISOString(),
  };
  user.refineAnswers = {};
  await upsertUser(user);
  await appendAction(userId, 'refine_started', { stoporCode });
  return getUser(userId);
}

export async function saveRefineAnswer(userId, questionId, optionId) {
  const user = await getUser(userId);
  if (!user) return null;
  user.refineAnswers = user.refineAnswers || {};
  user.refineAnswers[questionId] = optionId;
  if (user.refineSession) user.refineSession.step += 1;
  return upsertUser(user);
}

export async function completeRefine(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  user.stage = 'refine_completed';
  user.refineSession = null;
  user.followup = {
    track: 'refine',
    anchorAt: new Date().toISOString(),
    sentDays: [],
  };
  await upsertUser(user);
  await appendAction(userId, 'refine_completed', { stoporCode: user.stoporCode });
  return getUser(userId);
}

export async function markVoiceRequested(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  user.stage = 'voice_requested';
  user.followup = {
    track: 'voice',
    anchorAt: new Date().toISOString(),
    sentDays: [],
  };
  await upsertUser(user);
  await appendAction(userId, 'voice_requested', { stoporCode: user.stoporCode });
  return getUser(userId);
}

export async function markCallRequested(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  user.stage = 'call_requested';
  user.followup = null;
  await upsertUser(user);
  await appendAction(userId, 'call_requested', { stoporCode: user.stoporCode });
  return getUser(userId);
}

export async function addNote(userId, note) {
  const user = (await getUser(userId)) || baseUser(userId);
  user.notes = Array.isArray(user.notes) ? user.notes : [];
  user.notes.push({ ...note, at: new Date().toISOString() });
  return upsertUser(user);
}
