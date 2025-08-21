// server.js
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*', // при желании ограничь своим доменом/приложением
}));

// ====== БД (SQLite) ======
const db = new Database('data.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    userId TEXT PRIMARY KEY,
    expoPushToken TEXT NOT NULL,
    language TEXT DEFAULT 'english',
    tz TEXT DEFAULT 'UTC',
    utcOffsetMin INTEGER DEFAULT 0,
    appVersion TEXT,
    updatedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS schedules (
    userId TEXT PRIMARY KEY,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    daysOfWeek TEXT,   -- JSON array [0..6] или NULL (каждый день)
    lastSentKey TEXT,  -- 'YYYY-MM-DDTHH:mm' в TZ пользователя
    updatedAt TEXT
  );
`);

const upsertDevice = db.prepare(`
  INSERT INTO devices (userId, expoPushToken, language, tz, utcOffsetMin, appVersion, updatedAt)
  VALUES (@userId, @expoPushToken, @language, @tz, @utcOffsetMin, @appVersion, @updatedAt)
  ON CONFLICT(userId) DO UPDATE SET
    expoPushToken=excluded.expoPushToken,
    language=excluded.language,
    tz=excluded.tz,
    utcOffsetMin=excluded.utcOffsetMin,
    appVersion=excluded.appVersion,
    updatedAt=excluded.updatedAt
`);

const upsertSchedule = db.prepare(`
  INSERT INTO schedules (userId, hour, minute, daysOfWeek, lastSentKey, updatedAt)
  VALUES (@userId, @hour, @minute, @daysOfWeek, @lastSentKey, @updatedAt)
  ON CONFLICT(userId) DO UPDATE SET
    hour=excluded.hour,
    minute=excluded.minute,
    daysOfWeek=excluded.daysOfWeek,
    updatedAt=excluded.updatedAt
`);

const deleteSchedule = db.prepare(`DELETE FROM schedules WHERE userId=?`);
const getAllDueJoin = db.prepare(`
  SELECT s.userId, s.hour, s.minute, s.daysOfWeek, s.lastSentKey,
         d.expoPushToken, d.language, d.tz
  FROM schedules s
  JOIN devices d ON d.userId = s.userId
`);

const setLastSentKey = db.prepare(`
  UPDATE schedules SET lastSentKey=?, updatedAt=? WHERE userId=?
`);

// ====== локализация текста уведомления ======
function buildMessage(language = 'english') {
  switch ((language || '').toLowerCase()) {
    case 'русский':
    case 'ru':
      return { title: 'Это Verbify!', body: 'Не забудь потренироваться!\nСегодня практика — завтра уверенность! 💪' };
    case 'français':
    case 'fr':
      return { title: 'C’est Verbify !', body: 'N’oublie pas de t’entraîner !\nAujourd’hui entraînement — demain confiance ! 💪' };
    case 'español':
    case 'es':
      return { title: '¡Esto es Verbify!', body: '¡No olvides practicar!\n¡Hoy práctica — mañana confianza! 💪' };
    case 'português':
    case 'pt':
      return { title: 'Este é o Verbify!', body: 'Não se esqueça de praticar!\nHoje prática — amanhã confiança! 💪' };
    case 'العربية':
    case 'ar':
      return { title: 'هذا هو Verbify!', body: 'لا تنسَ التدرّب!\nتمرّن اليوم — ثقة غدًا! 💪' };
    case 'አማርኛ':
    case 'am':
      return { title: 'ይህ Verbify ነው!', body: 'ማስተማርን አትርሳ!\nዛሬ ማስተማር — ነገ እምነት! 💪' };
    default:
      return { title: 'This is Verbify!', body: 'Don’t forget to practice!\nPractice today — confidence tomorrow! 💪' };
  }
}

// ====== отправка пачки в Expo Push ======
async function sendExpoBatch(messages) {
  if (!messages.length) return { ok: true, status: 200, sent: 0 };
  const resp = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data, sent: messages.length };
}

// ====== проверка «к кому пора» и отправка ======
async function processDueNow() {
  const nowUtc = DateTime.utc();
  const rows = getAllDueJoin.all();

  const toSend = [];
  for (const row of rows) {
    const tz = row.tz || 'UTC';
    let local = nowUtc.setZone(tz);
    if (!local.isValid) local = nowUtc; // fallback

    // проверка дня недели (если ограничен)
    let days = null;
    if (row.daysOfWeek) {
      try { days = JSON.parse(row.daysOfWeek); } catch {}
    }
    if (Array.isArray(days) && days.length) {
      // Luxon: weekday 1..7 (Mon..Sun) -> 0..6 (Sun..Sat)
      const lux = local.weekday; // 1..7
      const dow06 = (lux === 7) ? 0 : lux; // 0..6
      if (!days.includes(dow06)) continue;
    }

    // совпала ли минута
    if (local.hour !== row.hour || local.minute !== row.minute) continue;

    // защита от дублей
    const sentKey = local.toFormat("yyyy-LL-dd'T'HH:mm");
    if (row.lastSentKey === sentKey) continue;

    const msg = buildMessage(row.language);
    toSend.push({
      to: row.expoPushToken,
      sound: 'default',
      title: msg.title,
      body: msg.body,
      data: { kind: 'daily-reminder', ts: nowUtc.toISO() },
      priority: 'high',
    });

    setLastSentKey.run(sentKey, new Date().toISOString(), row.userId);
  }

  // отправляем батчами по 100
  const CHUNK = 100;
  for (let i = 0; i < toSend.length; i += CHUNK) {
    const batch = toSend.slice(i, i + CHUNK);
    const res = await sendExpoBatch(batch);
    console.log(`[PUSH] batch sent=${res.sent} status=${res.status}`);
    if (!res.ok) console.error('[PUSH] error payload:', res.data);
  }

  return { matched: toSend.length };
}

// ====== API ======

// healthcheck для Render
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// регистрация девайса/токена
app.post('/registerDevice', (req, res) => {
  const { userId, expoPushToken, language, tz, utcOffsetMin, appVersion } = req.body || {};
  if (!userId || !expoPushToken) return res.status(400).json({ error: 'userId and expoPushToken are required' });

  upsertDevice.run({
    userId,
    expoPushToken,
    language: language || 'english',
    tz: tz || 'UTC',
    utcOffsetMin: Number.isFinite(utcOffsetMin) ? utcOffsetMin : 0,
    appVersion: appVersion || 'unknown',
    updatedAt: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// создать/обновить расписание
app.post('/schedule', (req, res) => {
  const { userId, hour, minute, daysOfWeek } = req.body || {};
  if (!userId || hour == null || minute == null) return res.status(400).json({ error: 'userId, hour, minute required' });

  const payload = {
    userId,
    hour: Math.max(0, Math.min(23, Number(hour))),
    minute: Math.max(0, Math.min(59, Number(minute))),
    daysOfWeek: daysOfWeek ? JSON.stringify(daysOfWeek) : null,
    lastSentKey: null,
    updatedAt: new Date().toISOString(),
  };
  upsertSchedule.run(payload);
  res.json({ ok: true });
});

// удалить расписание
app.delete('/schedule/:userId', (req, res) => {
  deleteSchedule.run(req.params.userId);
  res.json({ ok: true });
});

// (опционально) посмотреть все записи — удобно для отладки
app.get('/debug/all', (_req, res) => {
  const devs = db.prepare('SELECT * FROM devices').all();
  const sch = db.prepare('SELECT * FROM schedules').all();
  res.json({ devices: devs, schedules: sch });
});

// основной триггер, который будет вызывать Render Cron Job
app.post('/cron', async (_req, res) => {
  try {
    const out = await processDueNow();
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('cron error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// === если у тебя гарантированно «не спящий» инстанс, можно включить node-cron:
// import cron from 'node-cron';
// cron.schedule('* * * * *', () => processDueNow().catch(console.error));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server up on :' + PORT));
