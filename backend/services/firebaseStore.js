const admin = require('firebase-admin');
const { randomUUID } = require('crypto');

function normalizePrivateKey(value = '') {
  let key = String(value).trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  return key.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
}

function getFirebaseConfig() {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || ''),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  };
}

function ensureFirebaseInitialized() {
  if (admin.apps.length) return;

  const cfg = getFirebaseConfig();
  const missing = [];

  if (!cfg.projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!cfg.clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!cfg.privateKey) missing.push('FIREBASE_PRIVATE_KEY');
  if (!cfg.databaseURL) missing.push('FIREBASE_DATABASE_URL');

  if (missing.length) {
    throw new Error(`Missing Firebase env vars: ${missing.join(', ')}`);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: cfg.projectId,
      clientEmail: cfg.clientEmail,
      privateKey: cfg.privateKey
    }),
    databaseURL: cfg.databaseURL,
    storageBucket: cfg.storageBucket || undefined
  });
}

ensureFirebaseInitialized();

const db = admin.database();

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefined(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripUndefined(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }

  return value === undefined ? undefined : value;
}

function sanitizeId(id) {
  return String(id || '').replace(/[.#$\[\]/]/g, '_');
}

async function getCollection(name) {
  const snap = await db.ref(name).get();
  return snap.exists() ? snap.val() : {};
}

async function listCollection(name) {
  const data = await getCollection(name);
  return Object.entries(data).map(([id, value]) => ({ id, _id: id, ...value }));
}

async function getDoc(name, id) {
  const cleanId = sanitizeId(id);
  const snap = await db.ref(`${name}/${cleanId}`).get();
  if (!snap.exists()) return null;
  return { id: cleanId, _id: cleanId, ...snap.val() };
}

async function setDoc(name, id, value) {
  const cleanId = sanitizeId(id || randomUUID());
  const payload = stripUndefined(value);
  await db.ref(`${name}/${cleanId}`).set(payload);
  return { id: cleanId, _id: cleanId, ...payload };
}

async function updateDoc(name, id, patch) {
  const cleanId = sanitizeId(id);
  const payload = stripUndefined(patch);
  await db.ref(`${name}/${cleanId}`).update(payload);
  return getDoc(name, cleanId);
}

function nowIso() {
  return new Date().toISOString();
}

async function createUser(data) {
  const id = randomUUID();
  return setDoc('users', id, { ...data, createdAt: nowIso(), updatedAt: nowIso() });
}

async function updateUser(id, patch) {
  return updateDoc('users', id, { ...patch, updatedAt: nowIso() });
}

async function findUserByEmail(email) {
  const users = await listCollection('users');
  return users.find((u) => (u.email || '').toLowerCase() === String(email || '').toLowerCase()) || null;
}

async function listUsers(filterFn) {
  const users = await listCollection('users');
  return typeof filterFn === 'function' ? users.filter(filterFn) : users;
}

async function getUserById(id) {
  return getDoc('users', id);
}

async function createNotification(data) {
  const id = randomUUID();
  return setDoc('notifications', id, {
    ...data,
    createdAt: nowIso(),
    isRead: false
  });
}

async function listNotificationsByUser(userId) {
  const notifications = await listCollection('notifications');
  return notifications
    .filter((n) => String(n.user) === String(userId))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function updateNotification(id, patch) {
  return updateDoc('notifications', id, patch);
}

async function getNotificationById(id) {
  return getDoc('notifications', id);
}

async function createFile({ originalName, contentType, size, dataBuffer, uploadedBy, purpose }) {
  const id = randomUUID();
  const payload = {
    originalName,
    contentType,
    size,
    data: Buffer.from(dataBuffer).toString('base64'),
    uploadedBy: uploadedBy || null,
    purpose: purpose || null,
    createdAt: nowIso()
  };
  return setDoc('files', id, payload);
}

async function getFileById(id) {
  return getDoc('files', id);
}

async function createPerson(data) {
  const id = randomUUID();
  return setDoc('people', id, { ...data, createdAt: nowIso(), updatedAt: nowIso() });
}

async function updatePerson(id, patch) {
  return updateDoc('people', id, { ...patch, updatedAt: nowIso() });
}

async function getPersonById(id) {
  return getDoc('people', id);
}

async function listPeople(filterFn) {
  const people = await listCollection('people');
  return typeof filterFn === 'function' ? people.filter(filterFn) : people;
}

async function createTip(data) {
  const id = randomUUID();
  return setDoc('tips', id, { ...data, createdAt: nowIso(), updatedAt: nowIso() });
}

async function updateTip(id, patch) {
  return updateDoc('tips', id, { ...patch, updatedAt: nowIso() });
}

async function getTipById(id) {
  return getDoc('tips', id);
}

async function listTips() {
  return listCollection('tips');
}

async function createPersonUpdateRequest(data) {
  const id = randomUUID();
  return setDoc('person_update_requests', id, { ...data, createdAt: nowIso(), updatedAt: nowIso() });
}

async function updatePersonUpdateRequest(id, patch) {
  return updateDoc('person_update_requests', id, { ...patch, updatedAt: nowIso() });
}

async function getPersonUpdateRequestById(id) {
  return getDoc('person_update_requests', id);
}

async function listPersonUpdateRequests(filterFn) {
  const requests = await listCollection('person_update_requests');
  return typeof filterFn === 'function' ? requests.filter(filterFn) : requests;
}

async function createActivityLog(data) {
  const id = randomUUID();
  return setDoc('activity_logs', id, { ...data, createdAt: nowIso() });
}

async function listActivityLogs(filterFn) {
  const logs = await listCollection('activity_logs');
  return typeof filterFn === 'function' ? logs.filter(filterFn) : logs;
}
// module exports
module.exports = {
  createUser,
  updateUser,
  findUserByEmail,
  listUsers,
  getUserById,
  createNotification,
  listNotificationsByUser,
  updateNotification,
  getNotificationById,
  createFile,
  getFileById,
  createPerson,
  updatePerson,
  getPersonById,
  listPeople,
  createTip,
  updateTip,
  getTipById,
  listTips,
  createPersonUpdateRequest,
  updatePersonUpdateRequest,
  getPersonUpdateRequestById,
  listPersonUpdateRequests,
  createActivityLog,
  listActivityLogs
};
