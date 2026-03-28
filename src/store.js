import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

function defaultDb() {
  return { users: {}, events: [], meta: { createdAt: new Date().toISOString() } };
}

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
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
  } catch {
    return defaultDb();
  }
}

async function writeDb(db) {
  await ensureStore();
  await fs.writeFile(STORE_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function baseUser(userId) {
  return {
    userId,
    username: '',
    firstName: '',
    phone: null,
    stoporCode: null,
    stoporLabel: null,
    scores: {},
    answers: [],
    qualification: null,
    resultVariant: null,
    resultPayload: null,
    quizPassedAt: null,
    stage: 'new',
    engaged: false,
    voiceRequested: false,
    callRequested: false,
    refineCompleted: false,
    refineSession: null,
    refineAnswers: {},
    followupsSent: {},
    waitKeywordDay5: false,
    notes: [],
    journey: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function getUser(userId) {
  const db = await readDb();
  return db.users[String(userId)] || null;
}

export async function upsertUser(partial) {
  const db = await readDb();
  const key = String(partial.userId);
  const existing = db.users[key] || baseUser(partial.userId);
  db.users[key] = {
    ...existing,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await writeDb(db);
  return db.users[key];
}

export async function appendJourneyStep(userId, step) {
  const user = await getUser(userId);
  if (!user || !step) return user;
  const journey = Array.isArray(user.journey) ? [...user.journey] : [];
  const last = journey.at(-1)?.step;
  if (last !== step) {
    journey.push({ at: new Date().toISOString(), step });
  }
  return upsertUser({ userId, journey });
}

export async function saveQuizResult(data) {
  const user = await upsertUser({
    userId: data.userId,
    username: data.username || '',
    firstName: data.firstName || '',
    stoporCode: data.stoporCode,
    stoporLabel: data.stoporLabel,
    scores: data.scores || {},
    answers: data.answers || [],
    qualification: data.qualification || null,
    resultVariant: data.resultVariant || null,
    resultPayload: data.resultPayload || null,
    quizPassedAt: data.quizPassedAt || new Date().toISOString(),
    stage: 'quiz_done',
    engaged: false,
    voiceRequested: false,
    callRequested: false,
    refineCompleted: false,
    refineSession: null,
    refineAnswers: {},
    followupsSent: {},
    waitKeywordDay5: false,
    journey: [],
  });
  return user;
}

export async function markEngaged(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  return upsertUser({ userId, engaged: true });
}

export async function markVoiceRequested(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  return upsertUser({ userId, voiceRequested: true, engaged: true, stage: 'voice_requested' });
}

export async function markCallRequested(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  return upsertUser({ userId, callRequested: true, engaged: true, stage: 'call_requested' });
}

export async function startRefineSession(userId, stoporLabel) {
  const user = await getUser(userId);
  if (!user) return null;
  return upsertUser({
    userId,
    engaged: true,
    stage: 'refine_in_progress',
    refineSession: { stoporLabel, questionIndex: 0, startedAt: new Date().toISOString() },
    refineAnswers: {},
  });
}

export async function saveRefineAnswer(userId, questionIndex, answerText) {
  const user = await getUser(userId);
  if (!user) return null;
  const refineAnswers = { ...(user.refineAnswers || {}) };
  refineAnswers[String(questionIndex + 1)] = answerText;
  const refineSession = user.refineSession ? { ...user.refineSession, questionIndex: questionIndex + 1 } : null;
  return upsertUser({ userId, refineAnswers, refineSession });
}

export async function completeRefine(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  return upsertUser({
    userId,
    refineCompleted: true,
    engaged: true,
    stage: 'refine_completed',
    refineSession: null,
  });
}

export async function markFollowupSent(userId, key) {
  const user = await getUser(userId);
  if (!user) return null;
  const followupsSent = { ...(user.followupsSent || {}), [key]: new Date().toISOString() };
  return upsertUser({ userId, followupsSent });
}

export async function setWaitKeywordDay5(userId, value) {
  return upsertUser({ userId, waitKeywordDay5: value });
}

export async function addNote(userId, note) {
  const user = await getUser(userId);
  if (!user) return null;
  const notes = Array.isArray(user.notes) ? [...user.notes] : [];
  notes.push({ at: new Date().toISOString(), note });
  return upsertUser({ userId, notes });
}

export async function addEvent(event) {
  const db = await readDb();
  db.events.push({ at: new Date().toISOString(), ...event });
  await writeDb(db);
}

export async function allUsers() {
  const db = await readDb();
  return Object.values(db.users);
}
