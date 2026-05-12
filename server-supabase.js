const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const UNLOCK_CODE = '020818';
const ADMIN_UPLOAD_KEY = '135797531lol';
const TOKEN_EXPIRES_IN = '3650d'; // 10 Jahre â€“ Token lÃ¤uft praktisch nie ab
const PRO_BONUS_MS = 2 * 24 * 60 * 60 * 1000;
const PREMIUM_BONUS_MS = 30 * 24 * 60 * 60 * 1000;
const PREMIUM_OPENAI_MODEL = process.env.PREMIUM_OPENAI_MODEL || 'gpt-5-mini';
const SUPPORT_OPENAI_MODEL = process.env.SUPPORT_OPENAI_MODEL || 'gpt-5.4-mini';
const PLAN_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_CREDIT_GRANTS = { free: 30, pro: 200, premium: 1000 };
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || 'ehoser.de').toLowerCase();
const MAIL_INBOUND_SECRET = process.env.MAIL_INBOUND_SECRET || '';
const MAIL_SENDMAIL_PATH = process.env.MAIL_SENDMAIL_PATH || 'sendmail';

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;
const guestPresence = new Map();
const GUEST_WINDOW_MS = 5 * 60 * 1000;
const mailAccountsMemory = new Map();
const mailMessagesMemory = [];
let mailMessageMemoryId = 1;
const chatGroupMetaMemory = new Map();
const chatGroupAdminsMemory = new Map();
const MODERATION_SEQUENCE_STEPS = [
  { text: 'KI wird deaktiviert', seconds: 4 },
  { text: 'Wetter und Maps werden deaktiviert', seconds: 8 },
  { text: 'Chat Nachrichten werden endgültig gelöscht', seconds: 20 },
  { text: 'Apps werden gesperrt', seconds: 30 }
];

// Supabase Init
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('âŒ Fehler: SUPABASE_URL oder SUPABASE_KEY nicht gesetzt!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Admin-Client mit service_role key â€“ umgeht RLS fÃ¼r Server-seitige Operationen
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const CHAT_MEDIA_BUCKET = process.env.CHAT_MEDIA_BUCKET || 'chat-media';

// Auto-Migration: Tabellen anlegen wenn nicht vorhanden
async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL
    || process.env.SUPABASE_DB_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_PRISMA_URL;
  if (!dbUrl) {
    console.warn('âš ï¸  DATABASE_URL nicht gesetzt â€“ Auto-Migration Ã¼bersprungen.');
    console.warn('   Bitte folgendes SQL in Supabase > SQL-Editor ausfÃ¼hren:');
    console.warn(`
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NULL;
CREATE TABLE IF NOT EXISTS user_profiles (
  username TEXT PRIMARY KEY,
  settings JSONB DEFAULT '{}'::jsonb,
  pro_until TIMESTAMP NULL,
  premium_until TIMESTAMP NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS update_vote BOOLEAN DEFAULT FALSE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS update_unlocked BOOLEAN DEFAULT FALSE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS chat_token TEXT NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS ps_account BOOLEAN DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS referral_invites (
  code TEXT PRIMARY KEY,
  inviter_username TEXT NOT NULL,
  used_by TEXT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  used_at TIMESTAMP NULL
);
CREATE TABLE IF NOT EXISTS screen_sessions (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  offer TEXT,
  answer TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS desktop_login_requests (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  username TEXT,
  user_id TEXT,
  token TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL
);
CREATE TABLE IF NOT EXISTS chat_user_keys (
  username TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id UUID NOT NULL,
  username TEXT NOT NULL,
  encrypted_group_key TEXT,
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (group_id, username)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id UUID NOT NULL,
  sender TEXT NOT NULL,
  encrypted_content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_group_meta (
  group_id UUID PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'group',
  description TEXT,
  photo_url TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_group_admins (
  group_id UUID NOT NULL,
  username TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (group_id, username)
);
CREATE TABLE IF NOT EXISTS ehoser_mail_accounts (
  address TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  local_part TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ehoser_mail_messages (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  address TEXT NOT NULL,
  direction TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  raw TEXT,
  status TEXT DEFAULT 'received',
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NULL;
CREATE TABLE IF NOT EXISTS chat_reports (
  id BIGSERIAL PRIMARY KEY,
  group_id UUID NOT NULL,
  group_name TEXT,
  reported_by TEXT NOT NULL,
  target_username TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  messages JSONB DEFAULT '[]'::jsonb,
  action_type TEXT,
  action_description TEXT,
  action_by TEXT,
  action_at TIMESTAMP,
  ban_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS moderation_actions (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT,
  username TEXT NOT NULL,
  action_type TEXT NOT NULL,
  duration_hours INTEGER,
  reason TEXT,
  action_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);`);
    return;
  }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NULL;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until TIMESTAMP NULL;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP NULL;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP NULL;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NULL;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        username TEXT PRIMARY KEY,
        settings JSONB DEFAULT '{}'::jsonb,
        pro_until TIMESTAMP NULL,
        premium_until TIMESTAMP NULL
      );
    `);
    await pool.query(`
      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP NULL;
    `);
    await pool.query(`
      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS update_vote BOOLEAN DEFAULT FALSE;
    `);
    await pool.query(`
      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS update_unlocked BOOLEAN DEFAULT FALSE;
    `);
    await pool.query(`
      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS chat_token TEXT NULL;
    `);
    await pool.query(`
      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS ps_account BOOLEAN DEFAULT FALSE;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plan_requests (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        real_name TEXT NOT NULL,
        plan TEXT NOT NULL,
        price_eur INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        confirmed_at TIMESTAMP NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_invites (
        code TEXT PRIMARY KEY,
        inviter_username TEXT NOT NULL,
        used_by TEXT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        used_at TIMESTAMP NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS screen_sessions (
        id UUID PRIMARY KEY,
        username TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        offer TEXT,
        answer TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS desktop_login_requests (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        username TEXT,
        user_id TEXT,
        token TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_group_meta (
        group_id UUID PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'group',
        description TEXT,
        photo_url TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_group_admins (
        group_id UUID NOT NULL,
        username TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (group_id, username)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ehoser_mail_accounts (
        address TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        local_part TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ehoser_mail_messages (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        address TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender TEXT,
        recipient TEXT,
        subject TEXT,
        text_body TEXT,
        html_body TEXT,
        raw TEXT,
        status TEXT DEFAULT 'received',
        read_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_reports (
        id BIGSERIAL PRIMARY KEY,
        group_id UUID NOT NULL,
        group_name TEXT,
        reported_by TEXT NOT NULL,
        target_username TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        messages JSONB DEFAULT '[]'::jsonb,
        action_type TEXT,
        action_description TEXT,
        action_by TEXT,
        action_at TIMESTAMP,
        ban_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS moderation_actions (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT,
        username TEXT NOT NULL,
        action_type TEXT NOT NULL,
        duration_hours INTEGER,
        reason TEXT,
        action_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('âœ… Datenbank-Tabellen Ã¼berprÃ¼ft/erstellt.');
  } catch (err) {
    console.error('âš ï¸  Auto-Migration fehlgeschlagen:', err.message);
  } finally {
    await pool.end();
  }
}

initDatabase();

let _screenSessionsReady = false;
let _screenSessionsInitPromise = null;

async function ensureScreenSessionsTableExists() {
  if (_screenSessionsReady) return true;
  if (_screenSessionsInitPromise) return _screenSessionsInitPromise;

  _screenSessionsInitPromise = (async () => {
    const dbUrl = process.env.DATABASE_URL
      || process.env.SUPABASE_DB_URL
      || process.env.POSTGRES_URL
      || process.env.POSTGRES_PRISMA_URL;
    if (!dbUrl) return false;

    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS screen_sessions (
          id UUID PRIMARY KEY,
          username TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          offer TEXT,
          answer TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      _screenSessionsReady = true;
      return true;
    } catch (e) {
      console.error('screen_sessions auto-create failed:', e?.message || e);
      return false;
    } finally {
      await pool.end();
      _screenSessionsInitPromise = null;
    }
  })();

  return _screenSessionsInitPromise;
}

const isRateLimited = (key) => {
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current) return false;
  if (now - current.first > AUTH_WINDOW_MS) {
    authAttempts.delete(key);
    return false;
  }
  return current.count >= AUTH_MAX_ATTEMPTS;
};

const registerFailedAttempt = (key) => {
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || (now - current.first > AUTH_WINDOW_MS)) {
    authAttempts.set(key, { count: 1, first: now });
    return;
  }
  current.count += 1;
  authAttempts.set(key, current);
};

const clearAttempts = (key) => {
  authAttempts.delete(key);
};


const PUBLIC_API_PATHS = new Set([
  '/api/config',
  '/api/register',
  '/api/login',
  '/api/auth/google',
  '/api/request-code-reset',
  '/api/code-reset-status',
  '/api/code-reset-complete',
  '/api/desktop-login/start',
  '/api/support/chat',
  '/api/unlock-code',
  '/api/verify-token'
]);

function isPublicApiPath(pathname) {
  return PUBLIC_API_PATHS.has(pathname)
    || pathname.startsWith('/api/admin/')
    || pathname === '/api/mail/inbound'
    || pathname.startsWith('/api/ki')
    || pathname === '/api/apps'
    || pathname.startsWith('/api/apps/')
    || pathname === '/api/games'
    || pathname === '/api/news'
    || pathname === '/api/repo/version'
    || pathname.startsWith('/api/desktop-login/status/')
    || pathname.startsWith('/api/pixabay')
    || pathname === '/api/online-users'
    || pathname === '/api/guest-heartbeat'
    || pathname === '/api/vote/status';
}

const createLoginCode = () => {
  const value = Math.floor(100000 + Math.random() * 900000);
  return String(value);
};

const createSecureToken = () => crypto.randomBytes(24).toString('hex');
const normalizeUnlockCodeInput = (value) => String(value || '').replace(/\s+/g, '');

function slugifyUsernamePart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_\-.]/g, '')
    .replace(/[\-.]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 20);
}

async function createAvailableGoogleUsername(email, name) {
  const emailPart = slugifyUsernamePart(String(email || '').split('@')[0]);
  const namePart = slugifyUsernamePart(name);
  const base = namePart || emailPart || `user_${crypto.randomBytes(3).toString('hex')}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `_${Math.floor(100 + Math.random() * 900)}`;
    const username = `${base}${suffix}`.slice(0, 28);
    const { data, error } = await supabase.from('users').select('id').eq('username', username).single();
    if (error || !data) return username;
  }
  return `user_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeMailLocalPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(new RegExp(`@${MAIL_DOMAIN.replace(/\./g, '\\.')}$`, 'i'), '');
}

function isValidMailLocalPart(value) {
  return /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(value)
    && !value.includes('..')
    && !value.startsWith('.')
    && !value.endsWith('.');
}

function buildMailAddress(localPart) {
  return `${localPart}@${MAIL_DOMAIN}`;
}

function escapeMailHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
}

async function listMailAccounts(username) {
  const { data, error } = await supabaseAdmin
    .from('ehoser_mail_accounts')
    .select('*')
    .eq('username', username)
    .order('created_at', { ascending: true });
  if (!error) return data || [];
  return [...mailAccountsMemory.values()].filter((account) => account.username === username);
}

async function getMailAccount(address) {
  const normalized = String(address || '').trim().toLowerCase();
  const { data, error } = await supabaseAdmin
    .from('ehoser_mail_accounts')
    .select('*')
    .eq('address', normalized)
    .single();
  if (!error && data) return data;
  return mailAccountsMemory.get(normalized) || null;
}

async function createMailAccount(username, localPart) {
  const address = buildMailAddress(localPart);
  const payload = { address, username, local_part: localPart };
  const { data, error } = await supabaseAdmin
    .from('ehoser_mail_accounts')
    .insert([payload])
    .select('*')
    .single();
  if (!error && data) return data;
  if (error?.code === '23505') {
    const err = new Error('Diese Adresse ist schon vergeben.');
    err.code = 'MAIL_EXISTS';
    throw err;
  }
  if (mailAccountsMemory.has(address)) {
    const existing = mailAccountsMemory.get(address);
    const err = new Error(existing.username === username ? 'Adresse existiert bereits.' : 'Diese Adresse ist schon vergeben.');
    err.code = 'MAIL_EXISTS';
    throw err;
  }
  mailAccountsMemory.set(address, { ...payload, created_at: new Date().toISOString() });
  return mailAccountsMemory.get(address);
}

async function saveMailMessage(payload) {
  const message = {
    username: payload.username,
    address: String(payload.address || '').toLowerCase(),
    direction: payload.direction || 'inbound',
    sender: payload.sender || null,
    recipient: payload.recipient || null,
    subject: payload.subject || '',
    text_body: payload.text_body || '',
    html_body: payload.html_body || '',
    raw: payload.raw || '',
    status: payload.status || (payload.direction === 'outbound' ? 'sent' : 'received')
  };
  const { data, error } = await supabaseAdmin
    .from('ehoser_mail_messages')
    .insert([message])
    .select('*')
    .single();
  if (!error && data) return data;
  const local = { ...message, id: mailMessageMemoryId++, created_at: new Date().toISOString(), read_at: null };
  mailMessagesMemory.unshift(local);
  return local;
}

async function listMailMessages(username, address) {
  let query = supabaseAdmin
    .from('ehoser_mail_messages')
    .select('*')
    .eq('username', username)
    .order('created_at', { ascending: false })
    .limit(100);
  if (address) query = query.eq('address', String(address).toLowerCase());
  const { data, error } = await query;
  if (!error) return data || [];
  return mailMessagesMemory
    .filter((message) => message.username === username && (!address || message.address === String(address).toLowerCase()))
    .slice(0, 100);
}

function sendRawMailWithSendmail(rawMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(MAIL_SENDMAIL_PATH, ['-t', '-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `sendmail beendet mit Code ${code}`));
    });
    child.stdin.write(rawMessage);
    child.stdin.end();
  });
}

// Fallback fÃ¼r Serverless/fehlende Tabellen
const memoryProfiles = new Map();
const memoryReferralCodes = new Map();
const memoryPlanRequests = [];

function readAuthUser(req, res) {
  if (req.authUser) {
    return req.authUser;
  }
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Nicht angemeldet' });
    return null;
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'UngÃ¼ltiger Token' });
    return null;
  }
}

function uniqueStrings(values, limit = 6) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = String(value || '').trim().slice(0, 32);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizePersonalization(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const allowedTone = new Set(['neutral', 'calm', 'focused', 'playful']);
  const allowedLayout = new Set(['standard', 'simple', 'explore']);
  const allowedModes = new Set(['store', 'games', 'facewarp', 'chat', 'images', 'weather', 'map', 'youtube', 'ki', 'ps', 'gameCreator']);
  const highlightModes = uniqueStrings(src.highlightModes, 6).filter(mode => allowedModes.has(mode));
  return {
    tone: allowedTone.has(src.tone) ? src.tone : 'neutral',
    layout: allowedLayout.has(src.layout) ? src.layout : 'standard',
    simplifySearch: Boolean(src.simplifySearch),
    prioritizePs: Boolean(src.prioritizePs),
    heroLine: typeof src.heroLine === 'string' ? src.heroLine.trim().slice(0, 180) : '',
    summary: typeof src.summary === 'string' ? src.summary.trim().slice(0, 280) : '',
    interests: uniqueStrings(src.interests, 6),
    highlightModes,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : null
  };
}

function normalizeModerationSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const allowedStatus = new Set(['none', 'pending', 'shown', 'resolved']);
  const allowedType = new Set(['warn', 'ban', 'delete', 'none']);
  const status = allowedStatus.has(String(src.status || '').trim()) ? String(src.status).trim() : 'none';
  const type = allowedType.has(String(src.type || '').trim()) ? String(src.type).trim() : 'none';
  const reportId = Number(src.reportId);
  return {
    status,
    type,
    reason: typeof src.reason === 'string' ? src.reason.trim().slice(0, 500) : '',
    banUntil: typeof src.banUntil === 'string' ? src.banUntil : null,
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : null,
    reportId: Number.isFinite(reportId) && reportId > 0 ? Math.trunc(reportId) : null
  };
}

function normalizeCustomPlan(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const featuresSrc = (src.features && typeof src.features === 'object' && !Array.isArray(src.features)) ? src.features : {};
  const creditsAdded = Math.max(0, Math.min(1000000, Math.trunc(Number(src.creditsAdded) || 0)));
  const priceEur = Math.max(0, Math.min(100000, Math.round((Number(src.priceEur) || 0) * 100) / 100));
  return {
    enabled: Boolean(src.enabled),
    label: typeof src.label === 'string' && src.label.trim() ? src.label.trim().slice(0, 40) : 'Individuell',
    priceEur,
    creditsAdded,
    features: {
      premiumKi: Boolean(featuresSrc.premiumKi),
      videoGenerator: Boolean(featuresSrc.videoGenerator),
      proFeatures: Boolean(featuresSrc.proFeatures),
      psAccount: Boolean(featuresSrc.psAccount),
      updateUnlocked: Boolean(featuresSrc.updateUnlocked)
    },
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : null
  };
}

function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    language: typeof src.language === 'string' ? src.language : 'de',
    design: typeof src.design === 'string' ? src.design : 'standard',
    energySaver: Boolean(src.energySaver),
    displayName: typeof src.displayName === 'string' ? src.displayName.trim().slice(0, 40) : '',
    avatarUrl: typeof src.avatarUrl === 'string' ? src.avatarUrl.trim().slice(0, 2048) : '',
    premiumUntil: typeof src.premiumUntil === 'string' ? src.premiumUntil : null,
    personalizationEnabled: src.personalizationEnabled !== false,
    personalization: normalizePersonalization(src.personalization),
    moderation: normalizeModerationSettings(src.moderation),
    credits: (src.credits && typeof src.credits === 'object' && !Array.isArray(src.credits)) ? src.credits : undefined,
    customPlan: src.customPlan ? normalizeCustomPlan(src.customPlan) : undefined,
    planRequests: Array.isArray(src.planRequests) ? src.planRequests.slice(-10) : undefined,
    passwordHash: typeof src.passwordHash === 'string' ? src.passwordHash : undefined,
    _emailPending: (src._emailPending && typeof src._emailPending === 'object') ? src._emailPending : undefined
  };
}

function parseChatMessagePreview(encryptedContent) {
  const raw = String(encryptedContent || '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.t === 'txt' && typeof parsed.v === 'string') return parsed.v.slice(0, 400);
      if (parsed.t === 'img' && parsed.url) return `[Bild] ${String(parsed.url).slice(0, 180)}`;
      if (parsed.t === 'file' && parsed.name) return `[Datei] ${String(parsed.name).slice(0, 180)}`;
      if (parsed.t === 'audio') return '[Audio]';
      if (parsed.t === 'video') return '[Video]';
    }
  } catch {}
  return raw.slice(0, 400);
}

function toModerationPayload(state) {
  if (!state || !state.type || state.type === 'none') return null;
  if (state.type === 'warn') {
    return {
      type: 'warn',
      reason: state.reason || 'Dein Verhalten wurde gemeldet. Bitte beachte die Regeln.',
      reportId: state.reportId || null,
      createdAt: state.createdAt || new Date().toISOString()
    };
  }
  const finalStepText = state.type === 'delete' ? 'Account wird gelöscht' : 'Account wird gebannt';
  return {
    type: state.type,
    reason: state.reason || '',
    banUntil: state.banUntil || null,
    reportId: state.reportId || null,
    createdAt: state.createdAt || new Date().toISOString(),
    sequence: [
      ...MODERATION_SEQUENCE_STEPS,
      { text: finalStepText, seconds: 10 }
    ]
  };
}

function getActiveModerationState(userRow, profile) {
  const moderation = normalizeModerationSettings(profile?.settings?.moderation);
  const bannedUntilMs = userRow?.banned_until ? Date.parse(userRow.banned_until) : NaN;
  if (Number.isFinite(bannedUntilMs) && bannedUntilMs > Date.now()) {
    return {
      type: 'ban',
      reason: userRow?.ban_reason || moderation.reason || '',
      banUntil: userRow?.banned_until || moderation.banUntil || null,
      reportId: moderation.reportId || null,
      createdAt: moderation.createdAt || new Date().toISOString()
    };
  }
  if (moderation.status === 'pending' && moderation.type !== 'none') {
    if (moderation.type === 'ban' && moderation.banUntil) {
      const untilMs = Date.parse(moderation.banUntil);
      if (Number.isFinite(untilMs) && untilMs <= Date.now()) return null;
    }
    return {
      type: moderation.type,
      reason: moderation.reason,
      banUntil: moderation.banUntil,
      reportId: moderation.reportId,
      createdAt: moderation.createdAt
    };
  }
  return null;
}

function mergePersonalization(currentRaw, patchRaw) {
  const current = normalizePersonalization(currentRaw);
  const patch = normalizePersonalization({ ...current, ...patchRaw, updatedAt: new Date().toISOString() });
  return normalizePersonalization({
    ...current,
    ...patch,
    interests: uniqueStrings([...(current.interests || []), ...(patch.interests || [])], 6),
    highlightModes: uniqueStrings([...(patch.highlightModes || []), ...(current.highlightModes || [])], 6),
    heroLine: patch.heroLine || current.heroLine,
    summary: patch.summary || current.summary,
    simplifySearch: Boolean(current.simplifySearch || patch.simplifySearch),
    prioritizePs: Boolean(current.prioritizePs || patch.prioritizePs),
    updatedAt: new Date().toISOString()
  });
}

async function patchProfilePersonalization(username, patch) {
  if (!username || !patch || typeof patch !== 'object') return null;
  const profile = await getProfile(username);
  if (profile.settings?.personalizationEnabled === false) return profile;
  const settings = normalizeSettings({
    ...profile.settings,
    personalization: mergePersonalization(profile.settings?.personalization, patch)
  });
  return upsertProfile(username, { settings });
}

async function inferPersonalizationPatch(groqKey, currentPersonalization, source, content) {
  const text = String(content || '').trim();
  if (!groqKey || !text) return null;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Du extrahierst nur UI-Personalisierung fÃ¼r ehoser. Antworte NUR mit JSON. Erlaube nur diese Felder: tone (neutral|calm|focused|playful), layout (standard|simple|explore), simplifySearch (boolean), prioritizePs (boolean), heroLine (string <= 180), summary (string <= 280), interests (Array bis 6 kurze Strings), highlightModes (Array aus store,games,facewarp,chat,images,weather,map,youtube,ki,ps,gameCreator). Erfinde nichts ohne klare Signale.'
          },
          {
            role: 'user',
            content: JSON.stringify({ source, currentPersonalization, content: text.slice(0, 1600) })
          }
        ],
        temperature: 0.2,
        max_tokens: 220,
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    return normalizePersonalization(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function personalizeFromInteraction(groqKey, username, source, content, fallbackPatch = null) {
  if (!username) return null;
  const profile = await getProfile(username);
  if (profile.settings?.personalizationEnabled === false) return profile;
  const inferred = await inferPersonalizationPatch(groqKey, profile.settings?.personalization, source, content);
  return patchProfilePersonalization(username, inferred || fallbackPatch || {});
}

function normalizeProfileRow(username, row) {
  const profile = row || memoryProfiles.get(username) || {};
  const proUntil = profile.pro_until || profile.proUntil || null;
  const premiumUntil = profile.premium_until || profile.premiumUntil || profile.settings?.premiumUntil || null;
  const ms = proUntil ? Date.parse(proUntil) : 0;
  const premiumMs = premiumUntil ? Date.parse(premiumUntil) : 0;
  const isPremium = Number.isFinite(premiumMs) && premiumMs > Date.now();
  const settings = normalizeSettings(profile.settings || profile.user_settings);
  const customPlan = normalizeCustomPlan(settings.customPlan);
  const hasCustom = customPlan.enabled === true;
  const capabilities = {
    premiumKi: isPremium || (hasCustom && customPlan.features.premiumKi),
    videoGenerator: isPremium || (hasCustom && customPlan.features.videoGenerator),
    proFeatures: isPremium || (Number.isFinite(ms) && ms > Date.now()) || (hasCustom && customPlan.features.proFeatures),
    psAccount: hasCustom && customPlan.features.psAccount,
    updateUnlocked: hasCustom && customPlan.features.updateUnlocked
  };
  return {
    username,
    settings,
    proUntil: proUntil || null,
    premiumUntil: premiumUntil || null,
    isCustom: hasCustom,
    customPlan: hasCustom ? customPlan : null,
    capabilities,
    isPremium,
    isPro: capabilities.proFeatures
  };
}

function getPlanKey(profile) {
  if (profile?.isPremium) return 'premium';
  if (profile?.isCustom) return 'free';
  if (profile?.isPro) return 'pro';
  return 'free';
}

function currentCreditPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function ensurePlanCredits(username, profile = null) {
  const current = profile || await getProfile(username);
  const plan = getPlanKey(current);
  const settings = { ...(current.settings || {}) };
  const credits = settings.credits || (Number.isFinite(Number(current.credits)) ? { balance: Number(current.credits) } : {});
  const period = currentCreditPeriod();
  let balance = Number(credits.balance);
  if (!Number.isFinite(balance)) balance = 0;

  if (plan === 'free') {
    if (!credits.freeGranted) {
      balance += PLAN_CREDIT_GRANTS.free;
      settings.credits = { ...credits, balance, freeGranted: true, plan, period };
      return upsertProfile(username, { settings });
    }
    return { ...current, settings: { ...settings, credits: { ...credits, balance, plan, period } }, credits: balance };
  }

  if (credits.plan !== plan || credits.period !== period) {
    balance += PLAN_CREDIT_GRANTS[plan];
    settings.credits = { ...credits, balance, plan, period, freeGranted: true };
    return upsertProfile(username, { settings });
  }
  return { ...current, settings: { ...settings, credits: { ...credits, balance, plan, period } }, credits: balance };
}

function countTextCredits(messages) {
  const last = [...messages].reverse().find((msg) => msg.role === 'user');
  const text = typeof last?.content === 'string'
    ? last.content
    : Array.isArray(last?.content)
      ? last.content.map((part) => part?.text || '').join(' ')
      : '';
  const letters = (String(text).match(/\p{L}/gu) || []).length;
  return Math.max(1, Math.ceil(letters / 5));
}

async function changeCredits(username, delta) {
  const profile = await ensurePlanCredits(username);
  const settings = { ...(profile.settings || {}) };
  const credits = { ...(settings.credits || {}) };
  const currentBalance = Number.isFinite(Number(credits.balance)) ? Number(credits.balance) : Number(profile.credits || 0);
  const balance = Math.max(0, currentBalance + delta);
  settings.credits = { ...credits, balance, updatedAt: new Date().toISOString() };
  return upsertProfile(username, { settings });
}

async function chargeCredits(username, amount) {
  const profile = await ensurePlanCredits(username);
  const rawBalance = profile.settings?.credits?.balance ?? profile.credits ?? 0;
  const balance = Number.isFinite(Number(rawBalance)) ? Number(rawBalance) : 0;
  if (balance < amount) {
    const err = new Error(`Keine Credits mehr verfuegbar. Du brauchst ${amount} Credits, hast aber ${balance}. Bitte upgrade deinen Plan.`);
    err.status = 402;
    err.credits = balance;
    throw err;
  }
  return changeCredits(username, -amount);
}

async function getProfile(username) {
  // PrimÃ¤r: users Tabelle (existiert immer), optional: user_profiles fÃ¼r Settings
  let proUntil = null;
  let premiumUntil = null;
  let settings = null;
  let psAccount = false;

  // Pro-Status aus users Tabelle holen (primary storage)
  try {
    let { data, error } = await supabase
      .from('users')
      .select('pro_until, premium_until')
      .eq('username', username)
      .single();
    if (error) {
      const fallback = await supabase.from('users').select('pro_until').eq('username', username).single();
      data = fallback.data;
    }
    if (data?.pro_until) proUntil = data.pro_until;
    if (data?.premium_until) premiumUntil = data.premium_until;
  } catch {}

  // Settings aus user_profiles holen (optional)
  try {
    let { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('settings, pro_until, premium_until, ps_account')
      .eq('username', username)
      .single();
    if (error) {
      const fallback = await supabaseAdmin
        .from('user_profiles')
        .select('settings, pro_until, ps_account')
        .eq('username', username)
        .single();
      data = fallback.data;
      error = fallback.error;
    }
    if (!error && data) {
      settings = data.settings;
      psAccount = data.ps_account === true;
      const settingsPremiumUntil = settings?.premiumUntil || null;
      if (settingsPremiumUntil) {
        const a = premiumUntil ? Date.parse(premiumUntil) : 0;
        const b = Date.parse(settingsPremiumUntil);
        if (b > a) premiumUntil = settingsPremiumUntil;
      }
      if (data.premium_until) {
        const a = premiumUntil ? Date.parse(premiumUntil) : 0;
        const b = Date.parse(data.premium_until);
        if (b > a) premiumUntil = data.premium_until;
      }
      // Wenn user_profiles einen spÃ¤teren pro_until hat, nutze den
      if (data.pro_until) {
        const a = proUntil ? Date.parse(proUntil) : 0;
        const b = Date.parse(data.pro_until);
        if (b > a) proUntil = data.pro_until;
      }
    }
  } catch {}

  // Memory-Fallback
  const mem = memoryProfiles.get(username);
  if (mem?.proUntil) {
    const a = proUntil ? Date.parse(proUntil) : 0;
    const b = Date.parse(mem.proUntil);
    if (b > a) proUntil = mem.proUntil;
  }
  if (mem?.premiumUntil) {
    const a = premiumUntil ? Date.parse(premiumUntil) : 0;
    const b = Date.parse(mem.premiumUntil);
    if (b > a) premiumUntil = mem.premiumUntil;
  }

  const ms = proUntil ? Date.parse(proUntil) : 0;
  const premiumMs = premiumUntil ? Date.parse(premiumUntil) : 0;
  const isPremium = Number.isFinite(premiumMs) && premiumMs > Date.now();
  const normalizedSettings = normalizeSettings({ ...(settings || mem?.settings || {}), premiumUntil: premiumUntil || null });
  const customPlan = normalizeCustomPlan(normalizedSettings.customPlan);
  const hasCustom = customPlan.enabled === true;
  const proByDate = Number.isFinite(ms) && ms > Date.now();
  const capabilities = {
    premiumKi: isPremium || (hasCustom && customPlan.features.premiumKi),
    videoGenerator: isPremium || (hasCustom && customPlan.features.videoGenerator),
    proFeatures: isPremium || proByDate || (hasCustom && customPlan.features.proFeatures),
    psAccount: psAccount || (hasCustom && customPlan.features.psAccount),
    updateUnlocked: hasCustom && customPlan.features.updateUnlocked
  };
  return {
    username,
    settings: normalizedSettings,
    proUntil: proUntil || null,
    premiumUntil: premiumUntil || null,
    isCustom: hasCustom,
    customPlan: hasCustom ? customPlan : null,
    capabilities,
    isPremium,
    isPro: capabilities.proFeatures,
    ps_account: capabilities.psAccount,
    credits: Number(normalizedSettings?.credits?.balance || 0)
  };
}

async function upsertProfile(username, patch) {
  const current = await getProfile(username);
  const newProUntil = Object.prototype.hasOwnProperty.call(patch, 'proUntil') ? patch.proUntil : current.proUntil;
  const newPremiumUntil = Object.prototype.hasOwnProperty.call(patch, 'premiumUntil') ? patch.premiumUntil : current.premiumUntil;
  const newSettings = normalizeSettings({ ...(current.settings || {}), ...(patch.settings || {}), premiumUntil: newPremiumUntil || null });

  // Pro-Status in users Tabelle schreiben (primary â€“ existiert garantiert)
  let savedToUsers = false;
  try {
    const { error } = await supabase
      .from('users')
      .update({ pro_until: newProUntil, premium_until: newPremiumUntil })
      .eq('username', username);
    if (!error) savedToUsers = true;
  } catch {}
  if (!savedToUsers) {
    try {
      const { error } = await supabase
        .from('users')
        .update({ pro_until: newProUntil })
        .eq('username', username);
      if (!error) savedToUsers = true;
    } catch {}
  }

  // Wenn users.pro_until Spalte fehlt â†’ Auto-Spalte anlegen versuchen
  if (!savedToUsers) {
    try {
      // Spalte existiert nicht â†’ in user_profiles speichern
      await supabaseAdmin.from('user_profiles').upsert({
        username,
        settings: newSettings,
        pro_until: newProUntil,
        premium_until: newPremiumUntil
      });
    } catch {
      // Letzter Fallback: Memory
      memoryProfiles.set(username, { settings: newSettings, proUntil: newProUntil, pro_until: newProUntil, premiumUntil: newPremiumUntil, premium_until: newPremiumUntil });
    }
  }

  // Settings immer in user_profiles speichern (Fehler ignorieren)
  try {
    await supabaseAdmin.from('user_profiles').upsert({ username, settings: newSettings, pro_until: newProUntil, premium_until: newPremiumUntil });
  } catch {
    try {
      await supabaseAdmin.from('user_profiles').upsert({ username, settings: newSettings, pro_until: newProUntil });
    } catch {}
  }

  const ms = newProUntil ? Date.parse(newProUntil) : 0;
  const premiumMs = newPremiumUntil ? Date.parse(newPremiumUntil) : 0;
  const isPremium = Number.isFinite(premiumMs) && premiumMs > Date.now();
  const customPlan = normalizeCustomPlan(newSettings.customPlan);
  const hasCustom = customPlan.enabled === true;
  const proByDate = Number.isFinite(ms) && ms > Date.now();
  const capabilities = {
    premiumKi: isPremium || (hasCustom && customPlan.features.premiumKi),
    videoGenerator: isPremium || (hasCustom && customPlan.features.videoGenerator),
    proFeatures: isPremium || proByDate || (hasCustom && customPlan.features.proFeatures),
    psAccount: hasCustom && customPlan.features.psAccount,
    updateUnlocked: hasCustom && customPlan.features.updateUnlocked
  };
  return {
    username,
    settings: newSettings,
    proUntil: newProUntil || null,
    premiumUntil: newPremiumUntil || null,
    isCustom: hasCustom,
    customPlan: hasCustom ? customPlan : null,
    capabilities,
    isPremium,
    isPro: capabilities.proFeatures,
    ps_account: capabilities.psAccount,
    credits: Number(newSettings?.credits?.balance || 0)
  };
}

async function extendProFor(username, ms = PRO_BONUS_MS) {
  const profile = await getProfile(username);
  const from = profile.proUntil ? Date.parse(profile.proUntil) : 0;
  const base = Number.isFinite(from) && from > Date.now() ? from : Date.now();
  const next = new Date(base + ms).toISOString();
  return upsertProfile(username, { proUntil: next });
}

async function setModerationForUser(username, payload) {
  const profile = await getProfile(username);
  const settings = normalizeSettings({
    ...profile.settings,
    moderation: {
      ...payload,
      status: payload?.status || 'pending',
      createdAt: payload?.createdAt || new Date().toISOString()
    }
  });
  const updated = await upsertProfile(username, { settings });
  return normalizeModerationSettings(updated?.settings?.moderation);
}

async function createReferralCode(inviterUsername) {
  const code = crypto.randomBytes(5).toString('hex');
  memoryReferralCodes.set(code, {
    inviter: inviterUsername,
    usedBy: null,
    createdAt: Date.now()
  });

  try {
    await supabase.from('referral_invites').insert({
      code,
      inviter_username: inviterUsername
    });
  } catch {
    // Fallback bleibt in memoryReferralCodes
  }

  return code;
}

async function consumeReferralCode(code, newUsername) {
  if (!code) return null;
  const normalized = String(code).trim();
  if (!normalized) return null;

  try {
    const { data, error } = await supabase
      .from('referral_invites')
      .select('code, inviter_username, used_by')
      .eq('code', normalized)
      .single();

    if (!error && data && !data.used_by && data.inviter_username !== newUsername) {
      await supabase
        .from('referral_invites')
        .update({ used_by: newUsername, used_at: new Date().toISOString() })
        .eq('code', normalized)
        .is('used_by', null);
      return data.inviter_username;
    }
  } catch {
    // In-memory fallback unten
  }

  const local = memoryReferralCodes.get(normalized);
  if (!local || local.usedBy || local.inviter === newUsername) return null;
  local.usedBy = newUsername;
  return local.inviter;
}

// Middleware
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', (req, res, next) => {
  const apiPath = `/api${req.path === '/' ? '' : req.path}`;
  if (isPublicApiPath(apiPath)) {
    return next();
  }

  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login erforderlich' });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Login erforderlich' });
  }

  try {
    req.authUser = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Ungueltiger Token' });
  }
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    else if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    else if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
}));

// Ã–ffentliche Client-Konfiguration (kein Authentifizierungs-Token nÃ¶tig)
app.get('/api/config', (req, res) => {
  res.json({
    ytApiKey: process.env.YT_API_KEY || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    githubRepo: process.env.GITHUB_REPO || 'Partynilles0208/ehoser-store-co'
  });
});

// News-Proxy (NewsAPI.org blockiert direkte Browser-Requests via CORS)
app.get('/api/news', async (req, res) => {
  const apiKey = process.env.NEWS_API_KEY || '';
  if (!apiKey) return res.status(503).json({ error: 'NEWS_API_KEY nicht konfiguriert' });

  const { cat, q } = req.query;
  let url;
  if (q) {
    url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=de&sortBy=publishedAt&pageSize=20&apiKey=${apiKey}`;
  } else {
    const category = ['technology','science','business','sports','entertainment','health'].includes(cat) ? cat : null;
    if (category) {
      url = `https://newsapi.org/v2/top-headlines?country=de&category=${category}&pageSize=20&apiKey=${apiKey}`;
    } else {
      url = `https://newsapi.org/v2/top-headlines?country=de&pageSize=20&apiKey=${apiKey}`;
    }
  }

  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: err.message || 'NewsAPI Fehler' });
    }
    const data = await upstream.json();
    res.json({ articles: data.articles || [] });
  } catch (e) {
    res.status(502).json({ error: 'NewsAPI nicht erreichbar' });
  }
});

app.get('/api/repo/version', async (req, res) => {
  const repo = process.env.GITHUB_REPO || 'Partynilles0208/ehoser-store-co';
  const currentSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ehoser-store/1.0'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!ghRes.ok) return res.status(502).json({ error: 'GitHub nicht erreichbar' });
    const commits = await ghRes.json();
    const latestSha = commits?.[0]?.sha || null;
    res.json({
      repo,
      currentSha,
      latestSha,
      hasUpdate: Boolean(currentSha && latestSha && currentSha !== latestSha)
    });
  } catch {
    res.status(502).json({ error: 'Versionscheck fehlgeschlagen' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) return res.status(503).json({ error: 'GOOGLE_CLIENT_ID nicht konfiguriert' });

  const idToken = String(req.body?.idToken || '').trim();
  const unlockCode = normalizeUnlockCodeInput(req.body?.unlockCode);
  if (!idToken) return res.status(400).json({ error: 'idToken fehlt' });
  if (unlockCode !== UNLOCK_CODE) return res.status(403).json({ error: 'Entsperrcode ist falsch.' });

  try {
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(8000)
    });
    const payload = await verifyRes.json();
    if (!verifyRes.ok || payload.aud !== googleClientId || !payload.email) {
      return res.status(401).json({ error: 'Google-Token ungÃ¼ltig' });
    }

    const googleSub = String(payload.sub || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const name = String(payload.name || payload.given_name || '').trim();
    let user = null;

    try {
      const { data } = await supabase.from('users').select('*').eq('email', email).single();
      user = data || null;
    } catch {}

    if (!user) {
      const username = await createAvailableGoogleUsername(email, name);
      const loginCode = createLoginCode();
      const { data, error } = await supabase
        .from('users')
        .insert([{ username, email, access_code: loginCode, verified: 1 }])
        .select()
        .single();
      if (error || !data) throw error || new Error('Google-Nutzer konnte nicht erstellt werden');
      user = data;
    }

    const profile = await getProfile(user.username);
    const settings = normalizeSettings({
      ...profile.settings,
      googleSub,
      googleEmail: email
    });
    const nextProfile = await upsertProfile(user.username, { settings });

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: false },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      userId: user.id,
      profile: nextProfile,
      redirectToAdmin: false,
      username: user.username
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Google-Anmeldung fehlgeschlagen' });
  }
});

// API Routes

// Registrierung
app.post('/api/register', async (req, res) => {
  const { unlockCode, username, email, referralCode, password } = req.body;
  const clientKey = `register:${req.ip || 'unknown'}`;

  if (isRateLimited(clientKey)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte spaeter erneut probieren.' });
  }

  if (normalizeUnlockCodeInput(unlockCode) !== UNLOCK_CODE) {
    registerFailedAttempt(clientKey);
    return res.status(403).json({ error: 'Entsperrcode ist falsch.' });
  }

  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Benutzername muss mindestens 3 Zeichen lang sein' });
  }

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein' });
  }

  const loginCode = createLoginCode();
  const passwordHash = await bcrypt.hash(password, 12);

  // Versuche zuerst mit password_hash Spalte zu registrieren
  let insertPayload = { username, email: email || null, access_code: loginCode, password_hash: passwordHash, verified: 1 };

  try {
    let { data, error } = await supabase.from('users').insert([insertPayload]).select();

    // Falls password_hash Spalte nicht existiert â†’ nochmal ohne versuchen
    if (error && (error.message.includes('password_hash') || error.message.includes('column'))) {
      const fallbackPayload = { username, email: email || null, access_code: loginCode, verified: 1 };
      const retry = await supabase.from('users').insert([fallbackPayload]).select();
      data = retry.data;
      error = retry.error;
      // Passwort in user_profiles.settings als Backup speichern
      if (!error && retry.data) {
        upsertProfile(username, { settings: { passwordHash } }).catch(() => {});
      }
    }

    if (error) {
      if (error.message.includes('duplicate') || error.message.includes('users_username_key')) {
        return res.status(400).json({ error: 'Benutzername existiert bereits' });
      }
      throw error;
    }

    clearAttempts(clientKey);

    const userId = data[0].id;
    const token = jwt.sign(
      { id: userId, username, isAdmin: false },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    const inviterUsername = await consumeReferralCode(referralCode, username);
    if (inviterUsername) {
      await Promise.all([
        extendProFor(username, PRO_BONUS_MS),
        extendProFor(inviterUsername, PRO_BONUS_MS)
      ]);
    }

    const profile = await getProfile(username);

    res.json({
      success: true,
      message: 'Erfolgreich registriert!',
      token,
      userId,
      loginCode,
      profile,
      referralApplied: Boolean(inviterUsername),
      redirectToAdmin: false
    });
  } catch (error) {
    console.error('Register Error:', error);
    const msg = error?.message || error?.details || error?.hint || JSON.stringify(error) || 'Unbekannter Fehler';
    res.status(500).json({ error: `Registrierung fehlgeschlagen: ${msg}` });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, loginCode, unlockCode, password } = req.body;
  const clientKey = `login:${req.ip || 'unknown'}`;

  if (isRateLimited(clientKey)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte spaeter erneut probieren.' });
  }

  if (normalizeUnlockCodeInput(unlockCode) !== UNLOCK_CODE) {
    registerFailedAttempt(clientKey);
    return res.status(403).json({ error: 'Entsperrcode ist falsch.' });
  }

  if (!username) {
    return res.status(400).json({ error: 'Benutzername erforderlich' });
  }

  // Mindestens Passwort oder Login-Code muss angegeben sein
  if (!password && !loginCode) {
    return res.status(400).json({ error: 'Passwort oder Login-Code erforderlich' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !data) {
      registerFailedAttempt(clientKey);
      return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
    }

    // Passwort-Authentifizierung: entweder password_hash in DB oder in user_profiles.settings
    if (password) {
      const hashFromDb = data.password_hash || null;
      // Backup-Hash aus user_profiles.settings holen falls Spalte fehlt
      const profileForHash = hashFromDb ? null : await getProfile(username);
      const hashToCheck = hashFromDb || profileForHash?.settings?.passwordHash || null;

      if (hashToCheck) {
        let passwordOk = false;
        try { passwordOk = await bcrypt.compare(password, hashToCheck); } catch {}
        if (!passwordOk) {
          // Wenn auch ein loginCode mitgeschickt wurde, noch den probieren
          if (!loginCode || data.access_code !== loginCode) {
            registerFailedAttempt(clientKey);
            return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
          }
          // loginCode stimmt â†’ durchlassen
        }
        // passwordOk â†’ weiter
      } else if (loginCode && data.access_code === loginCode) {
        // Altes Konto ohne Passwort, aber Login-Code stimmt â†’ OK
      } else if (loginCode) {
        registerFailedAttempt(clientKey);
        return res.status(401).json({ error: 'Login-Code ist falsch' });
      } else {
        // Kein Passwort-Hash & kein Login-Code
        return res.status(401).json({ error: 'Dieses Konto hat noch kein Passwort. Bitte Login-Code verwenden.' });
      }
    } else if (loginCode) {
      // Nur Login-Code (kein Passwort)
      if (data.access_code !== loginCode) {
        registerFailedAttempt(clientKey);
        return res.status(401).json({ error: 'Benutzername oder Login-Code falsch' });
      }
    }

    clearAttempts(clientKey);

    try { await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', data.id); } catch {}

    const isAdmin = false;
    const token = jwt.sign(
      { id: data.id, username: data.username, isAdmin },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    const profile = await getProfile(data.username);

    const moderationState = getActiveModerationState(data, profile);
    if (moderationState && moderationState.type !== 'warn') {
      return res.status(423).json({
        error: 'Konto ist moderiert',
        moderation: toModerationPayload(moderationState)
      });
    }

    res.json({
      success: true,
      token,
      userId: data.id,
      profile,
      moderationWarning: moderationState?.type === 'warn' ? toModerationPayload(moderationState) : null,
      redirectToAdmin: isAdmin
    });
  } catch (error) {
    console.error('Login Error:', error);
    const msg = error?.message || JSON.stringify(error) || 'Unbekannter Fehler';
    res.status(500).json({ error: `Anmeldung fehlgeschlagen: ${msg}` });
  }
});

async function createUniqueDesktopLoginCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const { data } = await supabaseAdmin
      .from('screen_sessions')
      .select('id')
      .eq('username', 'desktop-login')
      .eq('offer', code)
      .maybeSingle();
    if (!data) return code;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

app.post('/api/desktop-login/start', async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const code = await createUniqueDesktopLoginCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin.from('screen_sessions').insert({
      id,
      username: 'desktop-login',
      status: 'pending',
      offer: code,
      answer: JSON.stringify({ type: 'desktop-login', expiresAt })
    });
    if (error) throw error;
    res.json({ sessionId: id, code, expiresAt });
  } catch (error) {
    console.error('Desktop Login Start Error:', error);
    res.status(500).json({ error: 'Desktop-Code konnte nicht erstellt werden' });
  }
});

app.get('/api/desktop-login/status/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Session fehlt' });

  try {
    const { data, error } = await supabaseAdmin
      .from('screen_sessions')
      .select('*')
      .eq('id', id)
      .eq('username', 'desktop-login')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Session nicht gefunden' });

    const answerPayload = data.answer ? JSON.parse(data.answer) : {};
    if (new Date(answerPayload.expiresAt).getTime() < Date.now()) {
      try {
        await supabaseAdmin.from('screen_sessions').update({ status: 'expired' }).eq('id', id);
      } catch {}
      return res.json({ status: 'expired' });
    }

    if (data.status === 'approved' && answerPayload.token) {
      await supabaseAdmin
        .from('screen_sessions')
        .update({ status: 'used' })
        .eq('id', id);
      const profile = await getProfile(answerPayload.username);
      return res.json({
        status: 'approved',
        token: answerPayload.token,
        userId: answerPayload.userId,
        username: answerPayload.username,
        profile
      });
    }

    res.json({ status: data.status || 'pending' });
  } catch (error) {
    console.error('Desktop Login Status Error:', error);
    res.status(500).json({ error: 'Desktop-Login Status konnte nicht geladen werden' });
  }
});

app.post('/api/desktop-login/confirm', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length < 6) return res.status(400).json({ error: 'Code ist ungueltig' });

  try {
    const { data: request, error } = await supabaseAdmin
      .from('screen_sessions')
      .select('*')
      .eq('username', 'desktop-login')
      .eq('offer', code)
      .eq('status', 'pending')
      .maybeSingle();
    if (error) throw error;
    if (!request) return res.status(404).json({ error: 'Desktop-Code nicht gefunden oder bereits benutzt' });
    const answerPayload = request.answer ? JSON.parse(request.answer) : {};
    if (new Date(answerPayload.expiresAt).getTime() < Date.now()) {
      await supabaseAdmin.from('screen_sessions').update({ status: 'expired' }).eq('id', request.id);
      return res.status(410).json({ error: 'Desktop-Code ist abgelaufen' });
    }

    const token = jwt.sign(
      { id: auth.id, username: auth.username, isAdmin: Boolean(auth.isAdmin) },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );
    const { error: updateError } = await supabaseAdmin
      .from('screen_sessions')
      .update({
        status: 'approved',
        answer: JSON.stringify({
          type: 'desktop-login',
          expiresAt: answerPayload.expiresAt,
          token,
          userId: auth.id,
          username: auth.username
        })
      })
      .eq('id', request.id);
    if (updateError) throw updateError;
    res.json({ ok: true });
  } catch (error) {
    console.error('Desktop Login Confirm Error:', error);
    res.status(500).json({ error: 'Desktop-Login konnte nicht bestaetigt werden' });
  }
});

// Hilfe anfordern: Code-Reset an Admin senden
app.post('/api/request-code-reset', async (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Benutzername erforderlich' });
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, username')
      .eq('username', username)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'Benutzername nicht gefunden' });
    }

    await supabase
      .from('code_reset_requests')
      .update({ status: 'cancelled' })
      .eq('username', username)
      .eq('status', 'pending');

    const lookupToken = createSecureToken();
    const { data, error } = await supabase
      .from('code_reset_requests')
      .insert([{ username, status: 'pending', lookup_token: lookupToken }])
      .select('id, lookup_token')
      .single();

    if (error) throw error;

    res.json({
      success: true,
      requestId: data.id,
      lookupToken: data.lookup_token,
      message: 'Anfrage wurde an den Admin gesendet.'
    });
  } catch (error) {
    console.error('Request Code Reset Error:', error);
    res.status(500).json({ error: 'Anfrage konnte nicht erstellt werden. Stelle sicher, dass die Tabelle code_reset_requests existiert.' });
  }
});

// Status einer Reset-Anfrage (Nutzer-seitig polling)
app.post('/api/code-reset-status', async (req, res) => {
  const { requestId, lookupToken } = req.body;
  if (!requestId || !lookupToken) {
    return res.status(400).json({ error: 'requestId und lookupToken erforderlich' });
  }

  try {
    const { data, error } = await supabase
      .from('code_reset_requests')
      .select('id, status, reset_token')
      .eq('id', requestId)
      .eq('lookup_token', lookupToken)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Anfrage nicht gefunden' });
    }

    if (data.status === 'approved') {
      return res.json({ status: 'approved', resetToken: data.reset_token });
    }

    return res.json({ status: data.status });
  } catch (error) {
    console.error('Code Reset Status Error:', error);
    res.status(500).json({ error: 'Status konnte nicht geladen werden' });
  }
});

// Nutzer setzt neuen Login-Code nach Admin-Freigabe
app.post('/api/code-reset-complete', async (req, res) => {
  const { requestId, resetToken, newCode, confirmCode } = req.body;

  if (!requestId || !resetToken) {
    return res.status(400).json({ error: 'requestId und resetToken erforderlich' });
  }

  if (!newCode || newCode.length < 6) {
    return res.status(400).json({ error: 'Neuer Code muss mindestens 6 Zeichen haben' });
  }

  if (newCode !== confirmCode) {
    return res.status(400).json({ error: 'Codes stimmen nicht ueberein' });
  }

  try {
    const { data: requestData, error: requestError } = await supabase
      .from('code_reset_requests')
      .select('id, username, status, reset_token')
      .eq('id', requestId)
      .eq('reset_token', resetToken)
      .single();

    if (requestError || !requestData) {
      return res.status(404).json({ error: 'Reset-Anfrage nicht gefunden' });
    }

    if (requestData.status !== 'approved') {
      return res.status(400).json({ error: 'Anfrage ist nicht freigegeben' });
    }

    const { error: updateUserError } = await supabase
      .from('users')
      .update({ access_code: newCode })
      .eq('username', requestData.username);

    if (updateUserError) throw updateUserError;

    const { error: completeError } = await supabase
      .from('code_reset_requests')
      .update({ status: 'completed' })
      .eq('id', requestData.id);

    if (completeError) throw completeError;

    res.json({ success: true, message: 'Dein neuer Login-Code wurde gespeichert.' });
  } catch (error) {
    console.error('Code Reset Complete Error:', error);
    res.status(500).json({ error: 'Code konnte nicht aktualisiert werden' });
  }
});

// Ã–ffentlicher Endpoint: Zugangscode abrufen
app.get('/api/unlock-code', (req, res) => {
  res.json({ code: UNLOCK_CODE });
});

// Token verifizieren + last_seen aktualisieren
app.post('/api/verify-token', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Kein Token vorhanden' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    let userRow = null;
    try {
      const { data } = await supabase
        .from('users')
        .select('id,username,banned_until,ban_reason')
        .eq('id', decoded.id)
        .single();
      userRow = data || null;
    } catch {}

    // last_seen aktualisieren (Fehler ignorieren)
    try { await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', decoded.id); } catch {}
    const refreshedToken = jwt.sign(
      { id: decoded.id, username: decoded.username, isAdmin: Boolean(decoded.isAdmin) },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );
    const effectiveUsername = userRow?.username || decoded.username;
    const profile = await getProfile(effectiveUsername);
    const moderationState = getActiveModerationState(userRow, profile);
    if (moderationState && moderationState.type !== 'warn') {
      return res.status(423).json({
        error: 'Konto ist moderiert',
        moderation: toModerationPayload(moderationState)
      });
    }
    res.json({
      valid: true,
      user: decoded,
      token: refreshedToken,
      profile,
      moderationWarning: moderationState?.type === 'warn' ? toModerationPayload(moderationState) : null
    });
  } catch (err) {
    res.status(401).json({ error: 'UngÃ¼ltiger Token' });
  }
});

// Login-Code des eingeloggten Nutzers abrufen
app.get('/api/me/login-code', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('access_code')
      .eq('id', auth.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ loginCode: data.access_code });
  } catch {
    res.status(500).json({ error: 'Fehler beim Abrufen des Login-Codes' });
  }
});

// Eigenes Profil (inkl. Pro + Einstellungen)
app.get('/api/me', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const profile = await ensurePlanCredits(auth.username);
  // email aus users-Tabelle lesen
  let email = null;
  let userRow = null;
  try {
    const { data } = await supabase.from('users').select('email,banned_until,ban_reason').eq('id', auth.id).single();
    email = data?.email || null;
    userRow = data || null;
  } catch {}
  res.json({
    user: {
      id: auth.id,
      username: auth.username,
      isAdmin: Boolean(auth.isAdmin),
      email
    },
    profile,
    moderation: toModerationPayload(getActiveModerationState(userRow, profile))
  });
});

// Einstellungen speichern
app.put('/api/me/settings', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const current = await getProfile(auth.username);
  const settings = normalizeSettings({
    ...(req.body || {}),
    personalization: current.settings?.personalization,
    moderation: current.settings?.moderation,
    credits: current.settings?.credits,
    planRequests: current.settings?.planRequests
  });
  const profile = await upsertProfile(auth.username, { settings });
  res.json({ ok: true, profile });
});

app.get('/api/mail/status', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  res.json({
    domain: MAIL_DOMAIN,
    sendmailPath: MAIL_SENDMAIL_PATH,
    inboundConfigured: Boolean(MAIL_INBOUND_SECRET)
  });
});

app.get('/api/mail/accounts', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const accounts = await listMailAccounts(auth.username);
    res.json({ accounts, domain: MAIL_DOMAIN });
  } catch (error) {
    console.error('Mail Accounts Error:', error);
    res.status(500).json({ error: 'E-Mail-Adressen konnten nicht geladen werden.' });
  }
});

app.post('/api/mail/accounts', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const localPart = normalizeMailLocalPart(req.body?.localPart || req.body?.address);
  if (!isValidMailLocalPart(localPart)) {
    return res.status(400).json({ error: 'Nutze 3-32 Zeichen: a-z, 0-9, Punkt, Minus oder Unterstrich.' });
  }
  try {
    const ownAccounts = await listMailAccounts(auth.username);
    if (ownAccounts.length >= 5) {
      return res.status(400).json({ error: 'Maximal 5 E-Mail-Adressen pro Account.' });
    }
    const account = await createMailAccount(auth.username, localPart);
    res.json({ ok: true, account });
  } catch (error) {
    console.error('Mail Account Create Error:', error);
    res.status(409).json({ error: error.message || 'Adresse ist schon vergeben.' });
  }
});

app.get('/api/mail/messages', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const address = req.query.address ? String(req.query.address).trim().toLowerCase() : '';
  try {
    if (address) {
      const account = await getMailAccount(address);
      if (!account || account.username !== auth.username) {
        return res.status(403).json({ error: 'Diese Mailbox gehoert dir nicht.' });
      }
    }
    const messages = await listMailMessages(auth.username, address);
    res.json({ messages });
  } catch (error) {
    console.error('Mail Messages Error:', error);
    res.status(500).json({ error: 'Nachrichten konnten nicht geladen werden.' });
  }
});

app.post('/api/mail/send', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const from = String(req.body?.from || '').trim().toLowerCase();
  const to = String(req.body?.to || '').trim();
  const subject = escapeMailHeader(req.body?.subject || '(ohne Betreff)');
  const body = String(req.body?.body || '').slice(0, 20000);
  if (!from || !to || !body.trim()) {
    return res.status(400).json({ error: 'Absender, Empfaenger und Text sind erforderlich.' });
  }
  const account = await getMailAccount(from);
  if (!account || account.username !== auth.username) {
    return res.status(403).json({ error: 'Diese Absender-Adresse gehoert dir nicht.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Empfaenger-Adresse ist ungueltig.' });
  }

  const now = new Date().toUTCString();
  const messageId = `<${crypto.randomBytes(16).toString('hex')}@${MAIL_DOMAIN}>`;
  const raw = [
    `From: ${from}`,
    `To: ${escapeMailHeader(to)}`,
    `Subject: ${subject}`,
    `Date: ${now}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ].join('\r\n');

  try {
    await sendRawMailWithSendmail(raw);
    const message = await saveMailMessage({
      username: auth.username,
      address: from,
      direction: 'outbound',
      sender: from,
      recipient: to,
      subject,
      text_body: body,
      raw,
      status: 'sent'
    });
    res.json({ ok: true, message });
  } catch (error) {
    console.error('Mail Send Error:', error);
    const message = await saveMailMessage({
      username: auth.username,
      address: from,
      direction: 'outbound',
      sender: from,
      recipient: to,
      subject,
      text_body: body,
      raw,
      status: 'sendmail-error'
    });
    res.status(500).json({
      error: `sendmail konnte nicht senden: ${error.message}. Installiere/konfiguriere Postfix oder setze MAIL_SENDMAIL_PATH.`,
      message
    });
  }
});

app.post('/api/mail/inbound', async (req, res) => {
  if (!MAIL_INBOUND_SECRET || req.body?.secret !== MAIL_INBOUND_SECRET) {
    return res.status(403).json({ error: 'Inbound Secret ungueltig.' });
  }
  const recipient = String(req.body?.recipient || req.body?.to || '').trim().toLowerCase();
  const account = await getMailAccount(recipient);
  if (!account) {
    return res.status(404).json({ error: 'Mailbox nicht gefunden.' });
  }
  const message = await saveMailMessage({
    username: account.username,
    address: account.address,
    direction: 'inbound',
    sender: String(req.body?.sender || req.body?.from || '').trim(),
    recipient,
    subject: escapeMailHeader(req.body?.subject || '(ohne Betreff)'),
    text_body: String(req.body?.text || req.body?.body || '').slice(0, 20000),
    html_body: String(req.body?.html || '').slice(0, 50000),
    raw: String(req.body?.raw || '').slice(0, 100000),
    status: 'received'
  });
  res.json({ ok: true, id: message.id });
});

app.post('/api/me/plan-request', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const plan = String(req.body?.plan || '').trim().toLowerCase();
  const realName = String(req.body?.realName || '').trim().slice(0, 80);
  const meta = {
    pro: { price: 10, label: 'Pro' },
    premium: { price: 20, label: 'Premium' }
  }[plan];
  if (!meta) return res.status(400).json({ error: 'Tarif ist ungueltig' });
  if (realName.length < 3) return res.status(400).json({ error: 'Bitte echten Namen eingeben' });

  const request = {
    id: Date.now(),
    username: auth.username,
    real_name: realName,
    plan,
    price_eur: meta.price,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  try {
    const { data, error } = await supabaseAdmin
      .from('plan_requests')
      .insert({
        username: auth.username,
        real_name: realName,
        plan,
        price_eur: meta.price
      })
      .select('id,username,real_name,plan,price_eur,status,created_at')
      .single();
    if (error) throw error;
    return res.json({ ok: true, request: data });
  } catch {
    memoryPlanRequests.push(request);
    const profile = await getProfile(auth.username);
    const settings = { ...(profile.settings || {}) };
    settings.planRequests = [...(settings.planRequests || []), request].slice(-10);
    await upsertProfile(auth.username, { settings }).catch(() => {});
    return res.json({ ok: true, request });
  }
});

app.post('/api/me/personalization/event', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const currentProfile = await getProfile(auth.username);
  if (currentProfile.settings?.personalizationEnabled === false) {
    return res.json({ ok: true, profile: currentProfile });
  }

  const type = String(req.body?.type || '').trim();
  const query = String(req.body?.query || '').trim();
  const category = String(req.body?.category || '').trim();
  if (!type) return res.status(400).json({ error: 'type fehlt' });

  let patch = null;
  if (type === 'search-empty') {
    patch = {
      layout: 'simple',
      simplifySearch: true,
      heroLine: query ? `Ich passe ehoser an, damit du "${query.slice(0, 40)}" schneller findest.` : 'Ich mache ehoser gerade einfacher fÃ¼r dich.',
      summary: category ? `Mehr Hilfe bei Suchen in ${category}.` : 'Mehr Hilfe bei leeren Suchergebnissen.',
      highlightModes: ['store', 'ki'],
      interests: query ? [query] : []
    };
  } else {
    return res.status(400).json({ error: 'Unbekannter Event-Typ' });
  }

  const profile = await patchProfilePersonalization(auth.username, patch);
  res.json({ ok: true, profile });
});

app.get('/api/me/moderation', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const [{ data: userRow }, profile] = await Promise.all([
      supabase.from('users').select('banned_until,ban_reason').eq('id', auth.id).single(),
      getProfile(auth.username)
    ]);
    const moderation = toModerationPayload(getActiveModerationState(userRow, profile));
    res.json({ moderation });
  } catch (error) {
    res.status(500).json({ error: 'Moderationsstatus konnte nicht geladen werden' });
  }
});

app.post('/api/me/moderation/ack', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const profile = await getProfile(auth.username);
  const current = normalizeModerationSettings(profile?.settings?.moderation);
  if (current.type === 'none') return res.json({ ok: true, moderation: null });
  const updated = await setModerationForUser(auth.username, {
    ...current,
    status: 'shown'
  });
  res.json({ ok: true, moderation: updated });
});

app.post('/api/me/moderation/finalize-delete', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const profile = await getProfile(auth.username);
    const moderation = normalizeModerationSettings(profile?.settings?.moderation);
    if (moderation.type !== 'delete' || moderation.status === 'none') {
      return res.status(400).json({ error: 'Keine Löschaktion aktiv' });
    }
    await supabase.from('installations').delete().eq('user_id', auth.id);
    await supabaseAdmin.from('chat_group_members').delete().eq('username', auth.username);
    await supabaseAdmin.from('chat_messages').delete().eq('sender', auth.username);
    await supabaseAdmin.from('user_profiles').delete().eq('username', auth.username);
    const { error } = await supabase.from('users').delete().eq('id', auth.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Konto konnte nicht gelöscht werden' });
  }
});

// Referral-Link erstellen
app.post('/api/referral/create', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const code = await createReferralCode(auth.username);
  const inviteUrl = `${req.protocol}://${req.get('host')}/?ref=${encodeURIComponent(code)}`;
  res.json({ code, inviteUrl, rewardDays: 2 });
});

// Pixabay Proxy (verhindert CORS-Fehler im Browser)
app.get('/api/pixabay', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const PIXABAY_KEY = process.env.PIXABAY_KEY || '50190970-65ec83f509b70f19f8665f4a1';
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query) return res.status(400).json({ error: 'Kein Suchbegriff' });

  try {
    const params = new URLSearchParams({
      key: PIXABAY_KEY,
      q: query,
      image_type: 'all',
      safesearch: 'true',
      per_page: '18'
    });
    const response = await fetch(`https://pixabay.com/api/?${params.toString()}`);
    if (!response.ok) throw new Error(`Pixabay HTTP ${response.status}`);
    const data = await response.json();
    res.json({ hits: Array.isArray(data.hits) ? data.hits : [], total: data.totalHits || 0 });
  } catch (err) {
    res.status(502).json({ error: `Pixabay Fehler: ${err.message}` });
  }
});

// Pixabay Bild-Proxy (fÃ¼r Canvas â€“ CORS-freies Laden)
app.get('/api/pixabay/image', async (req, res) => {
  const url = String(req.query.url || '').trim();
  const isAllowed = url.startsWith('https://cdn.pixabay.com/') || url.startsWith('https://pixabay.com/');
  if (!url || !isAllowed) {
    return res.status(400).json({ error: 'UngÃ¼ltige Bild-URL' });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: `Bild konnte nicht geladen werden: ${err.message}` });
  }
});

// Pro-Status fÃ¼r mehrere Nutzer
app.get('/api/users/pro-badges', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const raw = String(req.query.usernames || '').trim();
  const users = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .slice(0, 100);

  const map = {};
  for (const username of users) {
    const profile = await getProfile(username);
    map[username] = {
      isPro: profile.isPro,
      proUntil: profile.proUntil
    };
  }

  res.json({ users: map });
});

// Online-Nutzer (letzte 5 Minuten)
app.get('/api/online-users', async (req, res) => {
  const authUser = optionalAuth(req);

  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('users')
    .select('username')
    .gte('last_seen', since)
    .order('last_seen', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  pruneGuestPresence();
  const guestCount = guestPresence.size;

  const users = [];
  if (authUser) {
    for (const row of (data || [])) {
      users.push({ username: row.username, kind: 'user' });
    }
  }
  for (let i = 0; i < guestCount; i += 1) {
    users.push({ username: 'Gast', kind: 'guest' });
  }

  res.json({ users, guestCount });
});

// Guest Heartbeat: anonyme Besucher online markieren
app.post('/api/guest-heartbeat', async (req, res) => {
  const guestId = String(req.body?.guestId || '').trim().slice(0, 64);
  if (!guestId) return res.status(400).json({ error: 'guestId fehlt' });
  guestPresence.set(guestId, Date.now());
  pruneGuestPresence();
  res.json({ ok: true, guestCount: guestPresence.size });
});

// Heartbeat: last_seen aktualisieren
app.post('/api/heartbeat', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', decoded.id);
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'UngÃ¼ltiger Token' });
  }
});

// Alle Apps abrufen
app.get('/api/apps', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('apps')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Apps Error:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Apps' });
  }
});

// App Details
app.get('/api/apps/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('apps')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'App nicht gefunden' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('App Detail Error:', error);
    res.status(500).json({ error: 'Fehler beim Laden der App' });
  }
});

// Signed Upload URLs generieren (Dateien werden direkt vom Browser zu Supabase hochgeladen)
app.post('/api/admin/upload-url', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const { iconName, apkName } = req.body;
  if (!iconName || !apkName) {
    return res.status(400).json({ error: 'iconName und apkName erforderlich' });
  }

  const safe = (n) => n.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ts = Date.now();
  const iconPath = `${ts}-${safe(iconName)}`;
  const apkPath = `${ts + 1}-${safe(apkName)}`;

  try {
    const [iconResult, apkResult] = await Promise.all([
      supabase.storage.from('app-icons').createSignedUploadUrl(iconPath),
      supabase.storage.from('app-apks').createSignedUploadUrl(apkPath)
    ]);

    if (iconResult.error) throw new Error('Icon URL: ' + iconResult.error.message);
    if (apkResult.error) throw new Error('APK URL: ' + apkResult.error.message);

    const iconPublicUrl = supabase.storage.from('app-icons').getPublicUrl(iconPath).data.publicUrl;
    const apkPublicUrl = supabase.storage.from('app-apks').getPublicUrl(apkPath).data.publicUrl;

    res.json({
      icon: { signedUrl: iconResult.data.signedUrl, publicUrl: iconPublicUrl },
      apk: { signedUrl: apkResult.data.signedUrl, publicUrl: apkPublicUrl }
    });
  } catch (error) {
    console.error('Upload URL Error:', error);
    res.status(500).json({ error: error.message || 'Fehler beim Erstellen der Upload-URLs' });
  }
});

// Admin: Code verifizieren (ohne Passwort im Frontend zu speichern)
app.post('/api/admin/verify', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }
  res.json({ ok: true });
});

// Admin: registrierte Nutzer anzeigen (nur Benutzername + Zeit)
app.get('/api/admin/users', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const users = [];
    for (const userRow of (data || [])) {
      const profile = await getProfile(userRow.username);
      const { data: up } = await supabaseAdmin
        .from('user_profiles')
        .select('update_unlocked, ps_account')
        .eq('username', userRow.username)
        .single();
      users.push({
        ...userRow,
        pro_until: profile.proUntil,
        premium_until: profile.premiumUntil,
        has_pro: profile.proUntil ? Date.parse(profile.proUntil) > Date.now() : false,
        is_pro: profile.isPro,
        is_premium: profile.isPremium,
        is_custom: profile.isCustom,
        custom_plan: profile.customPlan,
        credits: profile.credits,
        update_unlocked: up?.update_unlocked === true || profile.capabilities?.updateUnlocked === true,
        ps_account: up?.ps_account === true || profile.capabilities?.psAccount === true
      });
    }
    res.json(users);
  } catch (error) {
    console.error('Admin Users Error:', error);
    res.setHeader('x-admin-offline', '1');
    res.json([]);
  }
});

app.get('/api/admin/plan-requests', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungueltiger Admin-Key' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('plan_requests')
      .select('id,username,real_name,plan,price_eur,status,created_at,confirmed_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ requests: data || [] });
  } catch {
    try {
      const { data } = await supabaseAdmin.from('user_profiles').select('username,settings');
      const requests = [];
      for (const row of (data || [])) {
        for (const req of (row.settings?.planRequests || [])) {
          if (req.status === 'pending') requests.push({ ...req, username: req.username || row.username });
        }
      }
      return res.json({ requests: [...requests, ...memoryPlanRequests.filter((r) => r.status === 'pending')] });
    } catch {
      res.json({ requests: memoryPlanRequests.filter((r) => r.status === 'pending') });
    }
  }
});

app.post('/api/admin/plan-requests/:id/confirm', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungueltiger Admin-Key' });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige Anfrage-ID' });
  let request = null;
  try {
    const { data } = await supabaseAdmin
      .from('plan_requests')
      .select('id,username,real_name,plan,price_eur,status')
      .eq('id', id)
      .maybeSingle();
    request = data || null;
  } catch {}
  if (!request) request = memoryPlanRequests.find((r) => Number(r.id) === id);
  if (!request) {
    try {
      const { data: profiles } = await supabaseAdmin.from('user_profiles').select('username,settings');
      for (const row of (profiles || [])) {
        const found = (row.settings?.planRequests || []).find((r) => Number(r.id) === id);
        if (found) {
          request = { ...found, username: found.username || row.username };
          break;
        }
      }
    } catch {}
  }
  if (!request || request.status !== 'pending') return res.status(404).json({ error: 'Anfrage nicht gefunden' });

  const until = new Date(Date.now() + PLAN_MONTH_MS).toISOString();
  const profile = request.plan === 'premium'
    ? await upsertProfile(request.username, { proUntil: until, premiumUntil: until })
    : await upsertProfile(request.username, { proUntil: until });
  await ensurePlanCredits(request.username, profile);

  const confirmedAt = new Date().toISOString();
  try {
    const { data: updatedRows, error: updateError } = await supabaseAdmin
      .from('plan_requests')
      .update({ status: 'confirmed', confirmed_at: confirmedAt })
      .eq('id', id)
      .select('id');
    if (updateError) throw updateError;
    if (!updatedRows?.length) {
      try {
        await supabaseAdmin.from('plan_requests').delete().eq('id', id);
      } catch {}
    }
  } catch (error) {
    try {
      await supabaseAdmin.from('plan_requests').delete().eq('id', id);
    } catch {}
  }
  request.status = 'confirmed';
  request.confirmed_at = confirmedAt;
  try {
    const requestProfile = await getProfile(request.username);
    const settings = { ...(requestProfile.settings || {}) };
    settings.planRequests = (settings.planRequests || [])
      .map((r) => Number(r.id) === id ? { ...r, status: 'confirmed', confirmed_at: confirmedAt } : r)
      .filter((r) => !(Number(r.id) === id && r.status === 'confirmed'));
    await upsertProfile(request.username, { settings });
  } catch {}
  res.json({ ok: true, username: request.username, plan: request.plan });
});

app.post('/api/admin/users/:id/custom-benefits', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungueltiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Ungueltige Nutzer-ID' });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('username')
      .eq('id', userId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const featuresBody = (req.body?.features && typeof req.body.features === 'object') ? req.body.features : {};
    const creditsAdded = Math.max(0, Math.min(1000000, Math.trunc(Number(req.body?.creditsAdded) || 0)));
    const priceEur = Math.max(0, Math.min(100000, Math.round((Number(req.body?.priceEur) || 0) * 100) / 100));
    const enabled = req.body?.enabled !== false;

    const profile = await getProfile(data.username);
    const settings = { ...(profile.settings || {}) };
    const currentCredits = Number(settings.credits?.balance ?? profile.credits ?? 0);
    const balance = Math.max(0, (Number.isFinite(currentCredits) ? currentCredits : 0) + creditsAdded);
    settings.credits = {
      ...(settings.credits || {}),
      balance,
      updatedAt: new Date().toISOString()
    };
    settings.customPlan = normalizeCustomPlan({
      enabled,
      label: 'Individuell',
      priceEur,
      creditsAdded,
      features: {
        premiumKi: Boolean(featuresBody.premiumKi),
        videoGenerator: Boolean(featuresBody.videoGenerator),
        proFeatures: Boolean(featuresBody.proFeatures),
        psAccount: Boolean(featuresBody.psAccount),
        updateUnlocked: Boolean(featuresBody.updateUnlocked)
      },
      updatedAt: new Date().toISOString()
    });

    const updated = await upsertProfile(data.username, { settings });
    if (settings.customPlan.features.psAccount) {
      await supabaseAdmin.from('user_profiles').update({ ps_account: true }).eq('username', data.username).catch(() => {});
    }
    if (settings.customPlan.features.updateUnlocked) {
      await supabaseAdmin.from('user_profiles').update({ update_unlocked: true }).eq('username', data.username).catch(() => {});
    }

    res.json({ ok: true, username: data.username, profile: updated, creditsAdded, priceEur });
  } catch (err) {
    console.error('Admin Custom Benefits Error:', err);
    res.status(500).json({ error: err.message || 'Vorteile konnten nicht gespeichert werden' });
  }
});

app.post('/api/admin/users/:id/add-month', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungueltiger Admin-Key' });
  }
  const userId = Number(req.params.id);
  const plan = String(req.body?.plan || 'pro').toLowerCase();
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Ungueltige Nutzer-ID' });
  try {
    const { data, error } = await supabase.from('users').select('username').eq('id', userId).single();
    if (error || !data) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const profile = await getProfile(data.username);
    const proBase = profile.proUntil && Date.parse(profile.proUntil) > Date.now() ? Date.parse(profile.proUntil) : Date.now();
    const patch = { proUntil: new Date(proBase + PLAN_MONTH_MS).toISOString() };
    if (plan === 'premium') {
      const premiumBase = profile.premiumUntil && Date.parse(profile.premiumUntil) > Date.now() ? Date.parse(profile.premiumUntil) : Date.now();
      patch.premiumUntil = new Date(premiumBase + PLAN_MONTH_MS).toISOString();
    }
    const updated = await upsertProfile(data.username, patch);
    res.json({ ok: true, username: data.username, profile: updated });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Monat konnte nicht hinzugefuegt werden' });
  }
});

// Admin: Pro aktivieren/deaktivieren
app.post('/api/admin/users/:id/pro', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = Boolean(req.body?.enabled);
  const days = Math.max(1, Math.min(30, Number(req.body?.days) || 2));

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige Nutzer-ID' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('username')
      .eq('id', userId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const username = data.username;
    if (enabled) {
      const profile = await extendProFor(username, days * 24 * 60 * 60 * 1000);
      return res.json({ ok: true, profile });
    }

    const profile = await upsertProfile(username, { proUntil: null });
    return res.json({ ok: true, profile });
  } catch (error) {
    console.error('Admin Pro Toggle Error:', error);
    return res.status(500).json({ error: 'Pro-Status konnte nicht geÃ¤ndert werden' });
  }
});

// Admin: Premium aktivieren/deaktivieren
app.post('/api/admin/users/:id/premium', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = Boolean(req.body?.enabled);
  const days = Math.max(1, Math.min(365, Number(req.body?.days) || 30));

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige Nutzer-ID' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('username')
      .eq('id', userId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const username = data.username;
    if (enabled) {
      const profile = await extendPremiumFor(username, days * 24 * 60 * 60 * 1000);
      return res.json({ ok: true, username, profile });
    }

    const profile = await upsertProfile(username, { premiumUntil: null });
    return res.json({ ok: true, username, profile });
  } catch (error) {
    console.error('Admin Premium Toggle Error:', error);
    return res.status(500).json({ error: 'Premium-Status konnte nicht geÃ¤ndert werden' });
  }
});

// Admin: Update fÃ¼r bestimmten User freischalten/sperren
app.post('/api/admin/users/:id/unlock-update', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = req.body?.enabled !== false; // default true

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige Nutzer-ID' });
  }

  try {
    const { data, error } = await supabase.from('users').select('username').eq('id', userId).single();
    if (error || !data) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const { error: upsertErr } = await supabaseAdmin
      .from('user_profiles')
      .upsert({ username: data.username, update_unlocked: enabled }, { onConflict: 'username' });

    if (upsertErr) return res.status(500).json({ error: upsertErr.message });
    return res.json({ ok: true, username: data.username, update_unlocked: enabled });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin: PS-Account fÃ¼r bestimmten User setzen/entfernen
app.post('/api/admin/users/:id/ps-account', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = req.body?.enabled !== false;

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige Nutzer-ID' });
  }

  try {
    const { data, error } = await supabase.from('users').select('username').eq('id', userId).single();
    if (error || !data) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const { error: upsertErr } = await supabaseAdmin
      .from('user_profiles')
      .upsert({ username: data.username, ps_account: enabled }, { onConflict: 'username' });

    if (upsertErr) return res.status(500).json({ error: upsertErr.message });
    return res.json({ ok: true, username: data.username, ps_account: enabled });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin: offene Code-Reset-Anfragen
app.get('/api/admin/reset-requests', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  try {
    const { data, error } = await supabase
      .from('code_reset_requests')
      .select('id, username, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Admin Reset Requests Error:', error);
    res.setHeader('x-admin-offline', '1');
    res.json([]);
  }
});

// Admin: Code-Reset annehmen
app.post('/api/admin/reset-requests/:id/approve', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige Anfrage-ID' });
  }

  const resetToken = createSecureToken();

  try {
    const { error } = await supabase
      .from('code_reset_requests')
      .update({ status: 'approved', reset_token: resetToken })
      .eq('id', requestId)
      .eq('status', 'pending');

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Approve Reset Error:', error);
    res.status(500).json({ error: 'Anfrage konnte nicht angenommen werden' });
  }
});

// Admin: Code-Reset ablehnen
app.post('/api/admin/reset-requests/:id/reject', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige Anfrage-ID' });
  }

  try {
    const { error } = await supabase
      .from('code_reset_requests')
      .update({ status: 'rejected' })
      .eq('id', requestId)
      .eq('status', 'pending');

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Reject Reset Error:', error);
    res.status(500).json({ error: 'Anfrage konnte nicht abgelehnt werden' });
  }
});

// Admin: Chat-Meldungen abrufen
app.get('/api/admin/chat-reports', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }
  const status = String(req.query.status || 'open').trim();
  try {
    let query = supabaseAdmin
      .from('chat_reports')
      .select('id,group_id,group_name,reported_by,target_username,status,messages,action_type,action_description,action_by,action_at,ban_until,created_at')
      .order('created_at', { ascending: false })
      .limit(120);
    if (status && status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ reports: data || [] });
  } catch (error) {
    res.setHeader('x-admin-offline', '1');
    res.json({ reports: [] });
  }
});

// Admin: Chat-Meldung bearbeiten/abschließen
app.post('/api/admin/chat-reports/:id/resolve', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }
  const reportId = Number(req.params.id);
  if (!Number.isInteger(reportId) || reportId <= 0) return res.status(400).json({ error: 'UngÃ¼ltige Report-ID' });

  const actionType = String(req.body?.actionType || '').trim().toLowerCase();
  const targetUsername = String(req.body?.targetUsername || '').trim();
  const reason = String(req.body?.description || '').trim().slice(0, 500);
  const banHours = Math.max(1, Math.min(24 * 365, Number(req.body?.banHours) || 24));

  try {
    const { data: reportRow } = await supabaseAdmin
      .from('chat_reports')
      .select('id,status')
      .eq('id', reportId)
      .single();
    if (!reportRow) return res.status(404).json({ error: 'Meldung nicht gefunden' });

    if (actionType === 'dismiss') {
      const { error: dismissErr } = await supabaseAdmin
        .from('chat_reports')
        .update({
          status: 'dismissed',
          action_type: 'dismiss',
          action_description: reason || null,
          action_by: 'admin-panel',
          action_at: new Date().toISOString(),
          target_username: targetUsername || null
        })
        .eq('id', reportId);
      if (dismissErr) throw dismissErr;
      return res.json({ ok: true });
    }

    if (!['warn', 'ban', 'delete'].includes(actionType)) {
      return res.status(400).json({ error: 'UngÃ¼ltiger Aktionstyp' });
    }
    if (!targetUsername) return res.status(400).json({ error: 'Zielnutzer fehlt' });

    const { data: targetUser } = await supabase
      .from('users')
      .select('id,username')
      .eq('username', targetUsername)
      .single();
    if (!targetUser) return res.status(404).json({ error: 'Zielnutzer nicht gefunden' });

    let banUntilIso = null;
    if (actionType === 'ban') {
      banUntilIso = new Date(Date.now() + (banHours * 60 * 60 * 1000)).toISOString();
      const { error: banErr } = await supabase
        .from('users')
        .update({ banned_until: banUntilIso, ban_reason: reason || 'Regelverstoß im Chat' })
        .eq('id', targetUser.id);
      if (banErr) throw banErr;
    }
    if (actionType === 'warn') {
      await supabase.from('users').update({ banned_until: null, ban_reason: null }).eq('id', targetUser.id);
    }

    await setModerationForUser(targetUsername, {
      status: 'pending',
      type: actionType,
      reason: reason || '',
      banUntil: banUntilIso,
      reportId
    });

    const { error: reportErr } = await supabaseAdmin
      .from('chat_reports')
      .update({
        status: 'resolved',
        target_username: targetUsername,
        action_type: actionType,
        action_description: reason || null,
        action_by: 'admin-panel',
        action_at: new Date().toISOString(),
        ban_until: banUntilIso
      })
      .eq('id', reportId);
    if (reportErr) throw reportErr;

    await supabaseAdmin.from('moderation_actions').insert({
      report_id: reportId,
      username: targetUsername,
      action_type: actionType,
      duration_hours: actionType === 'ban' ? banHours : null,
      reason: reason || null,
      action_by: 'admin-panel'
    });

    res.json({ ok: true, banUntil: banUntilIso });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Meldung konnte nicht bearbeitet werden' });
  }
});

// Admin: Nutzer entbannen
app.post('/api/admin/users/unban', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }
  const { username } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Benutzername fehlt' });
  }
  const uname = username.trim();
  try {
    const { data: user, error: findErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('username', uname)
      .single();
    if (findErr || !user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    await supabaseAdmin
      .from('users')
      .update({ banned_until: null, ban_reason: null })
      .eq('id', user.id);

    await setModerationForUser(uname, { type: 'none', status: 'resolved', reason: '' });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Entbannen fehlgeschlagen' });
  }
});

// Admin: Nutzerkonto loeschen
app.delete('/api/admin/users/:id', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Ungültige Nutzer-ID' });
  }

  try {
    await supabase.from('installations').delete().eq('user_id', userId);

    const { error } = await supabase.from('users').delete().eq('id', userId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Admin Delete User Error:', error);
    res.status(500).json({ error: 'Nutzer konnte nicht gelÃ¶scht werden' });
  }
});

// App lÃ¶schen
app.delete('/api/admin/apps/:id', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const appId = Number(req.params.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return res.status(400).json({ error: 'UngÃ¼ltige App-ID' });
  }

  try {
    await supabase.from('installations').delete().eq('app_id', appId);
    const { error } = await supabase.from('apps').delete().eq('id', appId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Admin Delete App Error:', error);
    res.status(500).json({ error: 'App konnte nicht gelÃ¶scht werden' });
  }
});

// Neue App speichern (nur Metadaten, Dateien wurden direkt zu Supabase hochgeladen)
app.post('/api/admin/apps', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }

  const { name, description, category, version, sourceUrl, iconUrl, downloadUrl } = req.body;

  if (!name || !description || !category || !version) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfÃ¼llen.' });
  }

  if (!iconUrl || !downloadUrl) {
    return res.status(400).json({ error: 'Icon und APK URLs sind Pflicht.' });
  }

  try {
    const { data, error: insertError } = await supabase
      .from('apps')
      .insert([{ name, description, category, version, icon_url: iconUrl, download_url: downloadUrl, source_url: sourceUrl || null }])
      .select();

    if (insertError) throw insertError;

    res.status(201).json({ success: true, message: 'App erfolgreich gespeichert.', app: data[0] });
  } catch (error) {
    console.error('Admin Save Error:', error);
    res.status(500).json({ error: error.message || 'Fehler beim Speichern' });
  }
});

// App installieren
app.post('/api/install', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { appId } = req.body;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const { error } = await supabase
      .from('installations')
      .insert([
        {
          user_id: decoded.id,
          app_id: appId
        }
      ]);

    if (error) {
      if (error.message.includes('duplicate')) {
        return res.status(400).json({ error: 'App ist bereits installiert' });
      }
      throw error;
    }

    res.json({ success: true, message: 'App erfolgreich installiert!' });
  } catch (error) {
    console.error('Install Error:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Authentifizierung erforderlich' });
    }
    res.status(500).json({ error: 'Installation fehlgeschlagen' });
  }
});

// Meine Apps
app.get('/api/my-apps', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const { data, error } = await supabase
      .from('apps')
      .select('apps.*, installations!inner(user_id)')
      .eq('installations.user_id', decoded.id);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error('My Apps Error:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Authentifizierung erforderlich' });
    }
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// Error handling
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message || 'Unbekannter Fehler' });
  }

  next();
});

// â”€â”€â”€ Screen Share Signaling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /api/admin/screenshare/request  { username, offer }
app.post('/api/admin/screenshare/request', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });

  const { username, offer } = req.body;
  if (!username || !offer) return res.status(400).json({ error: 'username und offer erforderlich' });

  await ensureScreenSessionsTableExists();

  // End existing sessions for this user
  await supabaseAdmin.from('screen_sessions')
    .update({ status: 'ended' })
    .eq('username', username)
    .in('status', ['pending', 'active']);

  const sessionId = crypto.randomUUID();
  const { error } = await supabaseAdmin.from('screen_sessions').insert({
    id: sessionId, username, status: 'pending', offer: JSON.stringify(offer)
  });

  if (error) {
    console.error('Screen session error:', error);
    return res.status(500).json({ error: `screen_sessions Fehler: ${error.message}` });
  }
  res.json({ sessionId });
});

// GET /api/screenshare/pending  â€” Nutzer fragt ob Anfrage vorliegt
app.get('/api/screenshare/pending', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    await ensureScreenSessionsTableExists();
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { data } = await supabaseAdmin
      .from('screen_sessions')
      .select('id, offer, status')
      .eq('username', decoded.username)
      .in('status', ['pending'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (!data || !data.length) return res.json({ pending: false });
    const s = data[0];
    res.json({ pending: true, sessionId: s.id, offer: JSON.parse(s.offer) });
  } catch {
    return res.status(401).json({ error: 'UngÃ¼ltiges Token' });
  }
});

// POST /api/screenshare/respond  { sessionId, answer, accept }
app.post('/api/screenshare/respond', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    await ensureScreenSessionsTableExists();
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { sessionId, answer, accept } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId fehlt' });

    const { data: session } = await supabaseAdmin
      .from('screen_sessions').select('username').eq('id', sessionId).single();
    if (!session || session.username !== decoded.username)
      return res.status(403).json({ error: 'Session nicht gefunden' });

    if (!accept) {
      await supabaseAdmin.from('screen_sessions').update({ status: 'declined' }).eq('id', sessionId);
      return res.json({ ok: true });
    }
    await supabaseAdmin.from('screen_sessions')
      .update({ status: 'active', answer: JSON.stringify(answer) }).eq('id', sessionId);
    res.json({ ok: true });
  } catch {
    return res.status(401).json({ error: 'Fehler' });
  }
});

// GET /api/admin/screenshare/session/:sessionId  â€” Admin fragt Status ab
app.get('/api/admin/screenshare/session/:sessionId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });

  await ensureScreenSessionsTableExists();

  const { data } = await supabaseAdmin
    .from('screen_sessions').select('status, answer').eq('id', req.params.sessionId).single();
  if (!data) return res.status(404).json({ error: 'Session nicht gefunden' });
  res.json({ status: data.status, answer: data.answer ? JSON.parse(data.answer) : null });
});

// POST /api/admin/screenshare/end/:sessionId  â€” Admin beendet Session
app.post('/api/admin/screenshare/end/:sessionId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureScreenSessionsTableExists();
  await supabaseAdmin.from('screen_sessions').update({ status: 'ended' }).eq('id', req.params.sessionId);
  res.json({ ok: true });
});

// POST /api/screenshare/end  â€” Nutzer beendet Session
app.post('/api/screenshare/end', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    await ensureScreenSessionsTableExists();
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { sessionId } = req.body;
    if (sessionId) {
      await supabaseAdmin.from('screen_sessions')
        .update({ status: 'ended' }).eq('id', sessionId).eq('username', decoded.username);
    }
    res.json({ ok: true });
  } catch {
    return res.status(401).json({ error: 'Fehler' });
  }
});

// â”€â”€â”€ Chat API (E2E verschlÃ¼sselt) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Multer â€“ memory storage fÃ¼r Supabase-Upload
const CHAT_ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/gif','image/webp',
  'video/mp4','video/webm','video/quicktime',
  'audio/webm','audio/ogg','audio/mpeg','audio/wav',
  'application/pdf','text/plain','text/csv',
  'application/zip','application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint'
]);
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, CHAT_ALLOWED_MIME.has(file.mimetype));
  }
});

// Helper: JWT aus Request lesen + verifizieren
function chatAuth(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { res.status(401).json({ error: 'Nicht angemeldet' }); return null; }
  try { return jwt.verify(token, JWT_SECRET); }
  catch { res.status(401).json({ error: 'UngÃ¼ltiger Token' }); return null; }
}

function optionalAuth(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function pruneGuestPresence() {
  const now = Date.now();
  for (const [guestId, ts] of guestPresence.entries()) {
    if (now - ts > GUEST_WINDOW_MS) guestPresence.delete(guestId);
  }
}

function memorySetGroupAdmin(groupId, username) {
  if (!chatGroupAdminsMemory.has(groupId)) chatGroupAdminsMemory.set(groupId, new Set());
  chatGroupAdminsMemory.get(groupId).add(username);
}

function memoryUnsetGroupAdmin(groupId, username) {
  if (!chatGroupAdminsMemory.has(groupId)) return;
  chatGroupAdminsMemory.get(groupId).delete(username);
}

async function getGroupMeta(groupId, fallback) {
  const { data, error } = await supabaseAdmin
    .from('chat_group_meta')
    .select('type,description,photo_url')
    .eq('group_id', groupId)
    .maybeSingle();

  if (!error && data) {
    return {
      type: data.type || fallback.type,
      description: data.description || '',
      photoUrl: data.photo_url || ''
    };
  }

  const mem = chatGroupMetaMemory.get(groupId) || {};
  return {
    type: mem.type || fallback.type,
    description: mem.description || '',
    photoUrl: mem.photoUrl || ''
  };
}

async function setGroupMeta(groupId, patch) {
  const payload = {
    group_id: groupId,
    type: patch.type || 'group',
    description: patch.description || '',
    photo_url: patch.photoUrl || ''
  };
  const { error } = await supabaseAdmin
    .from('chat_group_meta')
    .upsert(payload, { onConflict: 'group_id' });
  if (error) {
    chatGroupMetaMemory.set(groupId, {
      type: payload.type,
      description: payload.description,
      photoUrl: payload.photo_url
    });
  }
}

async function ensureGroupAdmin(groupId, username) {
  const { error } = await supabaseAdmin
    .from('chat_group_admins')
    .upsert({ group_id: groupId, username }, { onConflict: 'group_id,username' });
  if (error) memorySetGroupAdmin(groupId, username);
}

async function removeGroupAdmin(groupId, username) {
  const { error } = await supabaseAdmin
    .from('chat_group_admins')
    .delete()
    .eq('group_id', groupId)
    .eq('username', username);
  if (error) memoryUnsetGroupAdmin(groupId, username);
}

async function listGroupAdmins(groupId, createdBy) {
  const { data, error } = await supabaseAdmin
    .from('chat_group_admins')
    .select('username')
    .eq('group_id', groupId);

  if (!error && Array.isArray(data)) {
    const admins = [...new Set(data.map(x => x.username).filter(Boolean))];
    if (createdBy && !admins.includes(createdBy)) admins.push(createdBy);
    return admins;
  }

  const mem = chatGroupAdminsMemory.get(groupId);
  const admins = mem ? [...mem] : [];
  if (createdBy && !admins.includes(createdBy)) admins.push(createdBy);
  return admins;
}

async function isGroupAdmin(groupId, username, createdBy) {
  if (username === createdBy) return true;
  const admins = await listGroupAdmins(groupId, createdBy);
  return admins.includes(username);
}

async function ensureChatUploadBucket() {
  const fallbackBuckets = ['app-icons', 'app-apks'];

  const { data: mainBucket, error: mainErr } = await supabaseAdmin.storage.getBucket(CHAT_MEDIA_BUCKET);
  if (!mainErr && mainBucket) {
    return { bucket: CHAT_MEDIA_BUCKET };
  }

  const { error: createErr } = await supabaseAdmin.storage.createBucket(CHAT_MEDIA_BUCKET, { public: true });
  if (!createErr) {
    return { bucket: CHAT_MEDIA_BUCKET };
  }

  for (const fallback of fallbackBuckets) {
    const { data, error } = await supabaseAdmin.storage.getBucket(fallback);
    if (!error && data) {
      return { bucket: fallback, warning: `Fallback-Bucket verwendet: ${fallback}` };
    }
  }

  return {
    error: createErr?.message || mainErr?.message || 'Kein Upload-Bucket verfÃ¼gbar'
  };
}

// POST /api/chat/upload â€” Mediendatei hochladen (Bild / Video / Audio)
app.post('/api/chat/upload', chatUpload.single('file'), async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  if (!req.file) return res.status(400).json({ error: 'Keine Datei oder Typ nicht erlaubt (max 50 MB)' });

  const bucketCheck = await ensureChatUploadBucket();
  if (bucketCheck.error) {
    return res.status(500).json({ error: 'Upload fehlgeschlagen: ' + bucketCheck.error });
  }
  const targetBucket = bucketCheck.bucket;

  const ext = req.file.originalname.split('.').pop().replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
  const filename = `${crypto.randomUUID()}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(targetBucket)
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });

  if (error) return res.status(500).json({ error: 'Upload fehlgeschlagen: ' + error.message });

  const { data: { publicUrl } } = supabaseAdmin.storage.from(targetBucket).getPublicUrl(filename);
  res.json({ url: publicUrl, mime: req.file.mimetype, size: req.file.size, name: req.file.originalname });
});

// POST /api/chat/key â€” eigenen ECDH Public Key hochladen/aktualisieren
app.post('/api/chat/key', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { publicKey } = req.body;
  if (!publicKey || typeof publicKey !== 'string' || publicKey.length > 4096) {
    return res.status(400).json({ error: 'UngÃ¼ltiger Public Key' });
  }
  try { JSON.parse(publicKey); } catch { return res.status(400).json({ error: 'Public Key muss valides JSON sein' }); }
  const { error } = await supabaseAdmin.from('chat_user_keys').upsert({ username: user.username, public_key: publicKey });
  if (error) return res.status(500).json({ error: 'Fehler beim Speichern' });
  res.json({ ok: true });
});

// GET /api/chat/key/:username â€” Public Key eines Nutzers abrufen
app.get('/api/chat/key/:username', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { username } = req.params;
  if (!/^[a-zA-Z0-9_\-]{1,32}$/.test(username)) return res.status(400).json({ error: 'UngÃ¼ltiger Nutzername' });
  const { data } = await supabaseAdmin.from('chat_user_keys').select('public_key').eq('username', username).single();
  if (!data) return res.status(404).json({ error: 'Kein Public Key gefunden â€“ Nutzer muss Chat einmal geÃ¶ffnet haben' });
  res.json({ publicKey: data.public_key });
});

// GET /api/chat/users/search?q= â€” Nutzer suchen (min. 2 Zeichen)
app.get('/api/chat/users/search', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const q = String(req.query.q || '').trim();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 60));
  let query = supabase.from('users').select('username').order('username', { ascending: true }).limit(limit);
  if (q) query = query.ilike('username', `%${q}%`);
  const { data } = await query;
  const users = (data || []).map(u => u.username).filter(u => u !== user.username);
  res.json({ users });
});

// POST /api/chat/groups â€” neue Gruppe erstellen
// Body: { name, members?: string[], memberKeys?: { username: encryptedGroupKeyJson }, description?, photoUrl? }
app.post('/api/chat/groups', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const rawName = String(req.body?.name || '').trim();
  const incomingMembers = Array.isArray(req.body?.members) ? req.body.members : [];
  const memberKeys = (req.body?.memberKeys && typeof req.body.memberKeys === 'object' && !Array.isArray(req.body.memberKeys))
    ? req.body.memberKeys
    : {};

  const normalizedMembers = [...new Set(
    incomingMembers
      .map(v => String(v || '').trim())
      .filter(v => /^[a-zA-Z0-9_\-]{1,32}$/.test(v))
      .filter(v => v !== user.username)
  )];

  if (Object.keys(memberKeys).length) {
    for (const username of Object.keys(memberKeys)) {
      const clean = String(username || '').trim();
      if (/^[a-zA-Z0-9_\-]{1,32}$/.test(clean) && clean !== user.username && !normalizedMembers.includes(clean)) {
        normalizedMembers.push(clean);
      }
    }
  }

  if (!normalizedMembers.length) {
    return res.status(400).json({ error: 'Mindestens ein weiterer Nutzer ist erforderlich' });
  }

  const type = normalizedMembers.length === 1 ? 'private' : 'group';
  const name = (rawName || (type === 'private' ? normalizedMembers[0] : `Gruppe (${normalizedMembers.length + 1})`)).slice(0, 50);

  const id = crypto.randomUUID();
  const { error: gErr } = await supabaseAdmin.from('chat_groups').insert({ id, name, created_by: user.username });
  if (gErr) return res.status(500).json({ error: 'Fehler beim Erstellen der Gruppe: ' + gErr.message });

  const allMembers = [user.username, ...normalizedMembers];
  const rows = allMembers.map((username) => ({
    group_id: id,
    username,
    encrypted_group_key: String(memberKeys[username] || 'plain').substring(0, 8192)
  }));
  const { error: mErr } = await supabaseAdmin.from('chat_group_members').insert(rows);
  if (mErr) {
    await supabaseAdmin.from('chat_groups').delete().eq('id', id);
    return res.status(500).json({ error: 'Fehler beim HinzufÃ¼gen der Mitglieder: ' + mErr.message });
  }

  await ensureGroupAdmin(id, user.username);
  await setGroupMeta(id, {
    type,
    description: String(req.body?.description || '').slice(0, 300),
    photoUrl: String(req.body?.photoUrl || '').slice(0, 2048)
  });

  res.json({ id, name, type });
});

// GET /api/chat/groups â€” eigene Gruppen abrufen
app.get('/api/chat/groups', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { data: memberships } = await supabaseAdmin.from('chat_group_members').select('group_id').eq('username', user.username);
  if (!memberships?.length) return res.json({ groups: [] });
  const ids = memberships.map(m => m.group_id);

  const [{ data: groups }, { data: members }] = await Promise.all([
    supabaseAdmin.from('chat_groups').select('id,name,created_by,created_at').in('id', ids).order('created_at', { ascending: false }),
    supabaseAdmin.from('chat_group_members').select('group_id,username').in('group_id', ids)
  ]);

  const membersByGroup = new Map();
  for (const row of (members || [])) {
    if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
    membersByGroup.get(row.group_id).push(row.username);
  }

  const enriched = [];
  for (const group of (groups || [])) {
    const groupMembers = membersByGroup.get(group.id) || [];
    const fallbackType = groupMembers.length <= 2 ? 'private' : 'group';
    const meta = await getGroupMeta(group.id, { type: fallbackType });
    const admins = await listGroupAdmins(group.id, group.created_by);
    enriched.push({
      ...group,
      type: meta.type || fallbackType,
      description: meta.description || '',
      photo_url: meta.photoUrl || '',
      member_count: groupMembers.length,
      is_admin: admins.includes(user.username)
    });
  }

  res.json({ groups: enriched });
});

// GET /api/chat/groups/:id/key â€” eigenen verschlÃ¼sselten GruppenschlÃ¼ssel abrufen
app.get('/api/chat/groups/:id/key', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { data } = await supabaseAdmin.from('chat_group_members').select('encrypted_group_key').eq('group_id', id).eq('username', user.username).single();
  if (!data) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  res.json({ encryptedGroupKey: data.encrypted_group_key });
});

// GET /api/chat/groups/:id/members â€” Mitgliederliste abrufen
app.get('/api/chat/groups/:id/members', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  const [{ data }, { data: groupRow }] = await Promise.all([
    supabaseAdmin.from('chat_group_members').select('username,joined_at').eq('group_id', id),
    supabaseAdmin.from('chat_groups').select('created_by').eq('id', id).maybeSingle()
  ]);
  const admins = await listGroupAdmins(id, groupRow?.created_by);
  const members = (data || []).map((m) => ({ ...m, is_admin: admins.includes(m.username) }));
  res.json({ members });
});

// GET /api/chat/groups/:id/admins — Gruppenadmins abrufen
app.get('/api/chat/groups/:id/admins', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const [{ data: self }, { data: groupRow }] = await Promise.all([
    supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).maybeSingle(),
    supabaseAdmin.from('chat_groups').select('created_by').eq('id', id).maybeSingle()
  ]);
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  const admins = await listGroupAdmins(id, groupRow?.created_by);
  res.json({ admins });
});

// POST /api/chat/groups/:id/settings — Gruppe bearbeiten (Admin)
app.post('/api/chat/groups/:id/settings', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { data: groupRow } = await supabaseAdmin.from('chat_groups').select('id,created_by').eq('id', id).maybeSingle();
  if (!groupRow) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  const admin = await isGroupAdmin(id, user.username, groupRow.created_by);
  if (!admin) return res.status(403).json({ error: 'Nur Admins dürfen die Gruppe bearbeiten' });

  const nextName = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').slice(0, 300);
  const photoUrl = String(req.body?.photoUrl || '').slice(0, 2048);
  const type = String(req.body?.type || '').trim();

  if (nextName) {
    const { error: nameErr } = await supabaseAdmin.from('chat_groups').update({ name: nextName.slice(0, 50) }).eq('id', id);
    if (nameErr) return res.status(500).json({ error: nameErr.message });
  }

  const meta = await getGroupMeta(id, { type: 'group' });
  await setGroupMeta(id, {
    type: (type === 'private' || type === 'group') ? type : meta.type,
    description,
    photoUrl
  });
  res.json({ ok: true });
});

// POST /api/chat/groups/:id/admins — Admin vergeben
app.post('/api/chat/groups/:id/admins', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_\-]{1,32}$/.test(username)) return res.status(400).json({ error: 'Ungültiger Nutzername' });

  const { data: groupRow } = await supabaseAdmin.from('chat_groups').select('created_by').eq('id', id).maybeSingle();
  if (!groupRow) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  const admin = await isGroupAdmin(id, user.username, groupRow.created_by);
  if (!admin) return res.status(403).json({ error: 'Nur Admins dürfen weitere Admins setzen' });

  const { data: member } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', username).maybeSingle();
  if (!member) return res.status(404).json({ error: 'Nutzer ist nicht Mitglied dieser Gruppe' });

  await ensureGroupAdmin(id, username);
  res.json({ ok: true });
});

// DELETE /api/chat/groups/:id/members/:username — Mitglied entfernen (Admin)
app.delete('/api/chat/groups/:id/members/:username', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id, username } = req.params;
  const { data: groupRow } = await supabaseAdmin.from('chat_groups').select('created_by').eq('id', id).maybeSingle();
  if (!groupRow) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  const admin = await isGroupAdmin(id, user.username, groupRow.created_by);
  if (!admin) return res.status(403).json({ error: 'Nur Admins dürfen Mitglieder entfernen' });
  if (username === groupRow.created_by) return res.status(400).json({ error: 'Ersteller kann nicht entfernt werden' });

  const { error: delErr } = await supabaseAdmin.from('chat_group_members').delete().eq('group_id', id).eq('username', username);
  if (delErr) return res.status(500).json({ error: delErr.message });

  await removeGroupAdmin(id, username);

  const { data: afterMembers } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id);
  const nextType = (afterMembers || []).length <= 2 ? 'private' : 'group';
  const currentMeta = await getGroupMeta(id, { type: nextType });
  await setGroupMeta(id, { type: nextType, description: currentMeta.description, photoUrl: currentMeta.photoUrl });

  res.json({ ok: true });
});

// DELETE /api/chat/groups/:id — Gruppe löschen (Admin)
app.delete('/api/chat/groups/:id', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;

  const { data: groupRow } = await supabaseAdmin
    .from('chat_groups')
    .select('id,created_by')
    .eq('id', id)
    .maybeSingle();
  if (!groupRow) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  const admin = await isGroupAdmin(id, user.username, groupRow.created_by);
  if (!admin) return res.status(403).json({ error: 'Nur Admins dürfen Gruppen löschen' });

  const deleteTasks = [
    supabaseAdmin.from('chat_messages').delete().eq('group_id', id),
    supabaseAdmin.from('chat_group_members').delete().eq('group_id', id),
    supabaseAdmin.from('chat_group_admins').delete().eq('group_id', id),
    supabaseAdmin.from('chat_group_meta').delete().eq('group_id', id),
    supabaseAdmin.from('chat_groups').delete().eq('id', id)
  ];

  const results = await Promise.allSettled(deleteTasks);
  const rejected = results.find(r => r.status === 'rejected');
  if (rejected) return res.status(500).json({ error: 'Gruppe konnte nicht gelöscht werden' });
  const firstErr = results.find(r => r.status === 'fulfilled' && r.value?.error)?.value?.error;
  if (firstErr) return res.status(500).json({ error: 'Gruppe konnte nicht gelöscht werden: ' + firstErr.message });

  chatGroupMetaMemory.delete(id);
  chatGroupAdminsMemory.delete(id);

  res.json({ ok: true });
});

// POST /api/chat/groups/:id/report — Gruppe melden (letzte 10 Nachrichten)
app.post('/api/chat/groups/:id/report', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const targetUsername = String(req.body?.targetUsername || '').trim().slice(0, 32) || null;

  const [{ data: self }, { data: groupRow }] = await Promise.all([
    supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).maybeSingle(),
    supabaseAdmin.from('chat_groups').select('id,name').eq('id', id).maybeSingle()
  ]);
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  if (!groupRow) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  const { data: latest } = await supabaseAdmin
    .from('chat_messages')
    .select('id,sender,encrypted_content,created_at')
    .eq('group_id', id)
    .order('id', { ascending: false })
    .limit(10);

  const messages = (latest || [])
    .slice()
    .reverse()
    .map((m, idx) => ({
      order: idx + 1,
      sender: m.sender,
      created_at: m.created_at,
      preview: parseChatMessagePreview(m.encrypted_content),
      raw: String(m.encrypted_content || '').slice(0, 2000)
    }));

  const { data, error } = await supabaseAdmin
    .from('chat_reports')
    .insert({
      group_id: id,
      group_name: groupRow.name || '',
      reported_by: user.username,
      target_username: targetUsername,
      status: 'open',
      messages,
      action_description: reason || null
    })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: 'Meldung konnte nicht gespeichert werden: ' + error.message });
  res.json({ ok: true, reportId: data.id });
});

// POST /api/chat/groups/:id/members â€” neues Mitglied hinzufÃ¼gen
// Body: { username, encryptedGroupKey }
app.post('/api/chat/groups/:id/members', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { username, encryptedGroupKey } = req.body;
  if (!username || !encryptedGroupKey) return res.status(400).json({ error: 'username und encryptedGroupKey erforderlich' });

  const { data: groupRow } = await supabaseAdmin.from('chat_groups').select('created_by').eq('id', id).maybeSingle();
  if (!groupRow) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  const admin = await isGroupAdmin(id, user.username, groupRow.created_by);
  if (!admin) return res.status(403).json({ error: 'Nur Admins dürfen Mitglieder hinzufügen' });

  // Ziel-Nutzer muss existieren
  const { data: target } = await supabase.from('users').select('username').eq('username', username).single();
  if (!target) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  // Bereits Mitglied?
  const { data: existing } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', username).single();
  if (existing) return res.status(409).json({ error: 'Nutzer ist bereits Mitglied' });
  const { error } = await supabaseAdmin.from('chat_group_members').insert({ group_id: id, username, encrypted_group_key: String(encryptedGroupKey).substring(0, 8192) });
  if (error) return res.status(500).json({ error: 'Fehler beim HinzufÃ¼gen' });

  const { data: afterMembers } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id);
  const nextType = (afterMembers || []).length <= 2 ? 'private' : 'group';
  const currentMeta = await getGroupMeta(id, { type: nextType });
  await setGroupMeta(id, { type: nextType, description: currentMeta.description, photoUrl: currentMeta.photoUrl });

  res.json({ ok: true });
});

// POST /api/chat/messages â€” Nachricht senden (verschlÃ¼sselt)
app.post('/api/chat/messages', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId, encryptedContent } = req.body;
  if (!groupId || !encryptedContent || typeof encryptedContent !== 'string' || encryptedContent.length > 65536) {
    return res.status(400).json({ error: 'UngÃ¼ltige Nachricht' });
  }
  // Muss Mitglied sein
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  const { data, error } = await supabaseAdmin.from('chat_messages').insert({ group_id: groupId, sender: user.username, encrypted_content: encryptedContent }).select('id,created_at').single();
  if (error) return res.status(500).json({ error: 'Fehler beim Senden' });
  res.json({ id: data.id, created_at: data.created_at });
});

// GET /api/chat/messages/:groupId?after=<id> â€” Nachrichten abrufen (polling)
app.get('/api/chat/messages/:groupId', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId } = req.params;
  const after = parseInt(req.query.after) || 0;
  // Muss Mitglied sein
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  let query = supabaseAdmin.from('chat_messages').select('id,sender,encrypted_content,created_at').eq('group_id', groupId).order('id', { ascending: true }).limit(50);
  if (after) query = query.gt('id', after);
  const { data } = await query;
  res.json({ messages: data || [] });
});

// â”€â”€â”€ VirusTotal Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const VT_API_KEY = process.env.VIRUSTOTAL_API_KEY;
const VT_BASE = 'https://www.virustotal.com/api/v3';

// POST /api/admin/vt-scan  { url: <string> }
app.post('/api/admin/vt-scan', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }

  if (!VT_API_KEY) {
    return res.status(503).json({ error: 'VIRUSTOTAL_API_KEY nicht konfiguriert' });
  }

  const { url } = req.body;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'UngÃ¼ltige URL' });
  }

  try {
    const body = new URLSearchParams({ url });
    const response = await fetch(`${VT_BASE}/urls`, {
      method: 'POST',
      headers: {
        'x-apikey': VT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('VT submit error:', errText);
      return res.status(502).json({ error: 'VirusTotal Anfrage fehlgeschlagen' });
    }

    const data = await response.json();
    const analysisId = data?.data?.id;
    if (!analysisId) {
      return res.status(502).json({ error: 'Keine Analyse-ID erhalten' });
    }

    res.json({ analysisId });
  } catch (err) {
    console.error('VT scan error:', err.message);
    res.status(502).json({ error: 'VirusTotal nicht erreichbar' });
  }
});

// GET /api/admin/vt-result/:analysisId
app.get('/api/admin/vt-result/:analysisId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }

  if (!VT_API_KEY) {
    return res.status(503).json({ error: 'VIRUSTOTAL_API_KEY nicht konfiguriert' });
  }

  const { analysisId } = req.params;
  if (!analysisId || !/^[A-Za-z0-9_\-=+]+$/.test(analysisId)) {
    return res.status(400).json({ error: 'UngÃ¼ltige Analyse-ID' });
  }

  try {
    const response = await fetch(`${VT_BASE}/analyses/${encodeURIComponent(analysisId)}`, {
      headers: { 'x-apikey': VT_API_KEY },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Ergebnis nicht verfÃ¼gbar' });
    }

    const data = await response.json();
    const attrs = data?.data?.attributes || {};
    const stats = attrs.stats || {};
    const status = attrs.status || 'unknown';

    res.json({
      status,
      stats: {
        malicious: stats.malicious || 0,
        suspicious: stats.suspicious || 0,
        harmless: stats.harmless || 0,
        undetected: stats.undetected || 0,
        timeout: stats.timeout || 0
      }
    });
  } catch (err) {
    console.error('VT result error:', err.message);
    res.status(502).json({ error: 'Ergebnis konnte nicht abgerufen werden' });
  }
});

// â”€â”€â”€ Games Feed Proxy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let gamesCache = null;
let gamesCacheTime = 0;
const GAMES_CACHE_TTL = 10 * 60 * 1000; // 10 Minuten
const LEGACY_GAMEMONETIZE_FEED = 'https://gamemonetize.com/feed.php?format=0&page=1';

app.get('/api/games', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `games_p${page}`;

  // Einfaches In-Memory-Cache
  if (gamesCache && gamesCache[cacheKey] && Date.now() - gamesCacheTime < GAMES_CACHE_TTL) {
    return res.json(gamesCache[cacheKey]);
  }

  try {
    const feedUrlObj = new URL(LEGACY_GAMEMONETIZE_FEED);
    feedUrlObj.searchParams.set('page', String(page));
    const feedUrl = feedUrlObj.toString();
    const response = await fetch(feedUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Feed nicht erreichbar' });
    }

    const text = await response.text();
    let games;
    try {
      games = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'Feed-Format ungÃ¼ltig' });
    }

    if (!gamesCache) gamesCache = {};
    gamesCache[cacheKey] = games;
    gamesCacheTime = Date.now();

    res.json(games);
  } catch (err) {
    console.error('Games feed error:', err.message);
    res.status(502).json({ error: 'Fehler beim Laden des Feeds' });
  }
});

// Server starten (lokal) oder als Vercel-Handler exportieren
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`ðŸš€ ehoser lÃ¤uft auf http://localhost:${PORT}`);
    console.log(`ðŸ“Š Connected to Supabase: ${SUPABASE_URL}`);
  });
}

// â”€â”€â”€ reCAPTCHA Enterprise Verify â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/verify-captcha', async (req, res) => {
  const { token, action } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token fehlt' });

  const projectId = process.env.RECAPTCHA_PROJECT_ID;
  const apiKey    = process.env.RECAPTCHA_SECRET_KEY;
  const siteKey   = '6Lf6esksAAAAAA7p5xYYHCrJze9a_ng_BUKHXyom';

  // Ohne Konfiguration: immer erlauben (Fallback fÃ¼r lokale Entwicklung)
  if (!projectId || !apiKey) {
    console.warn('[reCAPTCHA] RECAPTCHA_PROJECT_ID oder RECAPTCHA_SECRET_KEY fehlt â€“ Verifikation Ã¼bersprungen');
    return res.json({ success: true, score: 1.0 });
  }

  try {
    const response = await fetch(
      `https://recaptchaenterprise.googleapis.com/v1/projects/${projectId}/assessments?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: { token, siteKey, expectedAction: action || 'VISIT' }
        })
      }
    );
    const data = await response.json();

    if (!data.tokenProperties?.valid) {
      return res.json({ success: false, blocked: true, reason: 'invalid_token' });
    }

    const score = data.riskAnalysis?.score ?? 0.5;
    // Score < 0.3 â†’ wahrscheinlich Bot
    if (score < 0.3) {
      return res.json({ success: false, blocked: true, score, reason: 'low_score' });
    }

    res.json({ success: true, score });
  } catch (err) {
    console.error('reCAPTCHA Enterprise error:', err.message);
    // Bei API-Fehler: Zugang erlauben (nicht blockieren wegen Backend-Fehler)
    res.json({ success: true, score: 0.5 });
  }
});

// â”€â”€â”€ Email-VerknÃ¼pfung â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Codes werden in user_profiles.settings._emailPending gespeichert (serverless-safe)

async function getPendingEmailCode(username) {
  const profile = await getProfile(username);
  return profile?.settings?._emailPending || null;
}

async function setPendingEmailCode(username, data) {
  const profile = await getProfile(username);
  const settings = { ...(profile?.settings || {}), _emailPending: data };
  await supabaseAdmin.from('user_profiles').upsert({ username, settings });
}

async function clearPendingEmailCode(username) {
  const profile = await getProfile(username);
  const settings = { ...(profile?.settings || {}) };
  delete settings._emailPending;
  await supabaseAdmin.from('user_profiles').upsert({ username, settings });
}

app.post('/api/me/link-email', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return res.status(503).json({ error: 'E-Mail-Versand ist auf diesem Server nicht konfiguriert.' });
  }

  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'UngÃ¼ltige E-Mail-Adresse.' });
  }

  // Rate limit: max 1 neuer Code pro 60s
  const existing = await getPendingEmailCode(auth.username);
  if (existing && existing.expires && (existing.expires - 9 * 60 * 1000) > Date.now()) {
    return res.status(429).json({ error: 'Bitte warte 60 Sekunden, bevor du einen neuen Code anforderst.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await setPendingEmailCode(auth.username, { code, email, expires: Date.now() + 10 * 60 * 1000, attempts: 0 });

  try {
    const mailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ehoser <noreply@ehoser.de>',
        to: [email],
        subject: 'Dein ehoser BestÃ¤tigungscode',
        html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#0a1828;color:#fff;border-radius:16px">
          <div style="font-size:2rem;font-weight:900;color:#4d9fff">E</div>
          <h2 style="margin:8px 0 20px;font-size:1.4rem">E-Mail BestÃ¤tigung</h2>
          <p style="color:#aaa;margin:0 0 8px">Dein BestÃ¤tigungscode fÃ¼r ehoser:</p>
          <div style="font-size:2.8rem;font-weight:900;letter-spacing:0.35em;color:#4d9fff;padding:20px;background:#111827;border-radius:12px;text-align:center;margin:12px 0">${code}</div>
          <p style="color:#666;font-size:12px;margin-top:20px">GÃ¼ltig fÃ¼r 10 Minuten. Wenn du das nicht angefordert hast, ignoriere diese Mail.</p>
        </div>`
      })
    });
    if (!mailRes.ok) {
      const err = await mailRes.text();
      console.error('Resend error:', err);
      return res.status(502).json({ error: 'E-Mail konnte nicht gesendet werden.' });
    }
    res.json({ success: true });
  } catch {
    res.status(502).json({ error: 'E-Mail konnte nicht gesendet werden.' });
  }
});

app.post('/api/me/verify-email', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const { code } = req.body;
  if (!code || String(code).trim().length !== 6) {
    return res.status(400).json({ error: 'Bitte einen 6-stelligen Code eingeben.' });
  }

  const stored = await getPendingEmailCode(auth.username);

  if (!stored || !stored.expires || stored.expires < Date.now()) {
    await clearPendingEmailCode(auth.username).catch(() => {});
    return res.status(400).json({ error: 'Code abgelaufen. Bitte neuen Code anfordern.' });
  }

  const attempts = (stored.attempts || 0) + 1;
  if (attempts > 5) {
    await clearPendingEmailCode(auth.username).catch(() => {});
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte neuen Code anfordern.' });
  }

  if (stored.code !== String(code).trim()) {
    // Fehlversuch in DB speichern
    await setPendingEmailCode(auth.username, { ...stored, attempts }).catch(() => {});
    return res.status(400).json({ error: `Falscher Code. Noch ${6 - attempts} Versuche.` });
  }

  await clearPendingEmailCode(auth.username).catch(() => {});

  const { error } = await supabase.from('users').update({ email: stored.email }).eq('id', auth.id);
  if (error) return res.status(500).json({ error: 'E-Mail konnte nicht gespeichert werden.' });

  res.json({ success: true, email: stored.email });
});

app.delete('/api/me/unlink-email', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const { error } = await supabase.from('users').update({ email: null }).eq('id', auth.id);
  if (error) return res.status(500).json({ error: 'E-Mail konnte nicht entfernt werden.' });
  res.json({ success: true });
});

// Chat Token: abrufen
app.get('/api/me/chat-token', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const { data } = await supabaseAdmin.from('user_profiles').select('chat_token').eq('username', auth.username).single();
  res.json({ token: data?.chat_token || null });
});

// Chat Token: neu erstellen
app.post('/api/me/chat-token', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const token = 'ect_' + crypto.randomBytes(32).toString('hex');
  const { error } = await supabaseAdmin
    .from('user_profiles')
    .upsert({ username: auth.username, chat_token: token }, { onConflict: 'username' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ token });
});

// â”€â”€â”€ Update-Abstimmung â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Stimmen werden in user_profiles.settings._updateVote gespeichert (per User)
// Gesamtstatus wird in einem speziellen Supabase-Eintrag gehalten

const VOTE_THRESHOLD = 10;

// Votes werden in einer eigenen Spalte `update_vote` in user_profiles gespeichert
async function getVoteStatus() {
  const { data } = await supabaseAdmin
    .from('user_profiles')
    .select('username, update_vote')
    .eq('update_vote', true);

  const voters = (data || []).map(r => r.username);
  const count = voters.length;
  return { count, unlocked: count >= VOTE_THRESHOLD, voters };
}

// Ã–ffentlich: Vote-Status abrufen (fÃ¼r Frontend-Polling)
app.get('/api/vote/status', async (req, res) => {
  try {
    const status = await getVoteStatus();
    let myVote = false;
    let myUnlocked = false;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const auth = jwt.verify(token, JWT_SECRET);
        const { data } = await supabaseAdmin
          .from('user_profiles')
          .select('update_vote, update_unlocked')
          .eq('username', auth.username)
          .single();
        myVote = data?.update_vote === true;
        myUnlocked = data?.update_unlocked === true;
      } catch {}
    }
    // unlocked = globale Schwelle erreicht ODER User hat persÃ¶nliche Freischaltung
    const unlocked = status.unlocked || myUnlocked;
    res.json({ ...status, unlocked, myVote, myUnlocked });
  } catch {
    res.status(500).json({ error: 'Fehler beim Laden des Abstimmungsstatus.' });
  }
});

// Eingeloggte User: abstimmen
app.post('/api/vote', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  // PrÃ¼fen ob bereits abgestimmt (direkt aus DB, nicht Ã¼ber normalizeSettings)
  const { data: existing } = await supabaseAdmin
    .from('user_profiles')
    .select('update_vote')
    .eq('username', auth.username)
    .single();

  if (existing?.update_vote === true) {
    return res.status(409).json({ error: 'Du hast bereits abgestimmt.' });
  }

  // Stimme setzen (upsert, andere Felder unberÃ¼hrt lassen)
  const { error: upsertError } = await supabaseAdmin
    .from('user_profiles')
    .upsert({ username: auth.username, update_vote: true }, { onConflict: 'username' });

  if (upsertError) {
    return res.status(500).json({ error: 'Datenbankfehler: ' + upsertError.message });
  }

  const status = await getVoteStatus();
  res.json({ success: true, ...status, myVote: true });
});

// Admin: Abstimmungs-Ãœbersicht
app.get('/api/admin/votes', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'UngÃ¼ltiger Admin-Key' });
  }
  try {
    const status = await getVoteStatus();
    res.json({ ...status, threshold: VOTE_THRESHOLD, remaining: Math.max(0, VOTE_THRESHOLD - status.count) });
  } catch {
    res.setHeader('x-admin-offline', '1');
    res.json({ count: 0, unlocked: false, voters: [], threshold: VOTE_THRESHOLD, remaining: VOTE_THRESHOLD });
  }
});

// â”€â”€â”€ Psychologischer Support (PS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// PS: 4 initiale Antworten analysieren â†’ 5 personalisierte Folgefragen
app.post('/api/ps/analyze', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'KI nicht verfÃ¼gbar' });

  const { name, answers } = req.body;
  if (!Array.isArray(answers) || answers.length < 4) {
    return res.status(400).json({ error: 'Antworten fehlen' });
  }

  const answersText = answers.map((a, i) => `Frage ${i + 1}: ${a.question}\nAntwort: ${a.answer}`).join('\n\n');

  const systemPrompt = `Du bist ein einfÃ¼hlsamer, psychologisch geschulter KI-Assistent.\nAnalysiere die Umfrageantworten von "${name || 'dem Nutzer'}" und erstelle genau 10 personalisierte Folgefragen auf Deutsch, die tiefer auf emotionale BedÃ¼rfnisse und Sorgen eingehen.\nAntworte NUR mit einem JSON-Array mit 10 Strings. Kein anderer Text.\nBeispiel: ["Frage 1?", "Frage 2?", "Frage 3?", "Frage 4?", "Frage 5?", "Frage 6?", "Frage 7?", "Frage 8?", "Frage 9?", "Frage 10?"]`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Bisherige Antworten:\n\n${answersText}\n\nErstelle 10 personalisierte Folgefragen.` }
        ],
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      await changeCredits(username, creditCost).catch(() => {});
      return res.status(groqRes.status).json(data);
    }

    const text = data.choices?.[0]?.message?.content || '[]';
    let questions;
    try {
      const match = text.match(/\[[\s\S]*?\]/);
      questions = match ? JSON.parse(match[0]) : [];
    } catch {
      questions = text.split('\n').filter(l => l.trim()).slice(0, 10).map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^["']|["']$/g, '').trim());
    }

    const fallbacks = [
      'Was beschÃ¤ftigt dich gerade am meisten?',
      'Gibt es Menschen in deinem Leben, mit denen du Ã¼ber deine GefÃ¼hle sprechen kannst?',
      'Wie schlÃ¤fst du momentan?',
      'Was wÃ¼rde dir helfen, dich besser zu fÃ¼hlen?',
      'Hast du das GefÃ¼hl, dass du UnterstÃ¼tzung brauchst?',
      'Gibt es Situationen, in denen du dich besonders unwohl fÃ¼hlst?',
      'Wie gehst du normalerweise mit Stress um?',
      'Gibt es etwas, das du dir selbst gegenÃ¼ber wÃ¼nschst?',
      'Wie wichtig sind dir enge Beziehungen zu anderen Menschen?',
      'Was macht dich glÃ¼cklich, auch wenn es gerade schwer fÃ¤llt?'
    ];
    while (questions.length < 10) questions.push(fallbacks[questions.length]);
    questions = questions.slice(0, 10);

    res.json({ questions });
  } catch {
    res.status(502).json({ error: 'KI-Verbindungsfehler' });
  }
});

// PS: Chat mit spezialisiertem psychologischen System-Prompt
app.post('/api/ps/chat', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'KI nicht verfÃ¼gbar' });

  const { name, messages, allAnswersSummary } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  const systemPrompt = `Du bist ein einfÃ¼hlsamer, psychologisch geschulter KI-Assistent auf der Plattform ehoser.\nDu hilfst ${name ? `"${name}"` : 'dem Nutzer'} dabei, GefÃ¼hle, Ã„ngste und Sorgen zu verarbeiten.\nSei immer verstÃ¤ndnisvoll, nicht wertend und ermutigend. Rede auf Deutsch, warm und natÃ¼rlich.\nWenn ernsthafte psychische Probleme beschrieben werden: empfehle professionelle Hilfe.\nKrisentelefon Deutschland: 0800 111 0 111 (kostenlos, 24/7 erreichbar).\n${allAnswersSummary ? `\nHintergrund â€“ Umfrageantworten des Nutzers:\n${allAnswersSummary}` : ''}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.8,
        max_tokens: 1000
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(groqRes.status).json(data);
    await personalizeFromInteraction(
      groqKey,
      auth.username,
      'ps_chat',
      `${allAnswersSummary || ''}\n${messages.slice(-4).map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n')}`,
      {
        tone: 'calm',
        prioritizePs: true,
        layout: 'simple',
        highlightModes: ['ps', 'ki'],
        heroLine: 'ehoser stellt gerade ruhigere, hilfreichere Wege fÃ¼r dich nach vorne.',
        summary: 'PS-UnterstÃ¼tzung wurde genutzt.'
      }
    );
    res.json({ reply: data.choices?.[0]?.message?.content || '' });
  } catch {
    res.status(502).json({ error: 'KI-Verbindungsfehler' });
  }
});

// â”€â”€â”€ Spiele-KI: Spiel generieren â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/game/create', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  // Pro-Check
  const profile = await getProfile(auth.username);
  if (!profile.isPro) return res.status(403).json({ error: 'Diese Funktion erfordert PRO.' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'KI nicht verfÃ¼gbar' });

  const { prompt, currentCode } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Kein Prompt' });

  const systemPrompt = `Du bist ein Experte fÃ¼r HTML5-Spieleentwicklung.
Erstelle ein vollstÃ¤ndiges, spielbares Browserspiel als EINE einzige HTML-Datei.
Das Spiel muss alle CSS-Styles und JavaScript INLINE enthalten (kein externes Laden).
Anforderungen:
- VollstÃ¤ndig spielbar im Browser, kein Laden externer Ressourcen
- Canvas oder DOM-basiert, je nach Spieltyp
- Sauberer, moderner Code
- Spiel-Loop mit requestAnimationFrame wenn nÃ¶tig
- Steuerung klar beschriftet (Tastatur/Maus)
- Responsives Layout (passt in iframe)
- Deutscher Text fÃ¼r UI-Elemente erlaubt
- Kein alert(), confirm() oder prompt() verwenden
WICHTIG: Antworte NUR mit dem kompletten HTML-Code. Kein erklÃ¤render Text davor oder danach. Beginne mit <!DOCTYPE html>.`;

  const userMsg = currentCode
    ? `Hier ist das aktuelle Spiel:\n\`\`\`html\n${currentCode.slice(0, 80000)}\n\`\`\`\n\nVerbesserungsanfrage: ${prompt}`
    : `Erstelle dieses Spiel: ${prompt}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.7,
        max_tokens: 6000
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      // Fallback auf llama wenn Modell nicht verfÃ¼gbar
      if (groqRes.status === 400 || groqRes.status === 404) {
        const fallback = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.7,
            max_tokens: 16000
          })
        });
        const fdata = await fallback.json();
        if (!fallback.ok) return res.status(fallback.status).json({ error: typeof fdata?.error === 'object' ? (fdata.error?.message || JSON.stringify(fdata.error)) : (fdata?.error || 'KI-Fehler') });
        let code = fdata.choices?.[0]?.message?.content || '';
        code = code.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();
        return res.json({ code });
      }
      return res.status(groqRes.status).json({ error: typeof data?.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data?.error || 'KI-Fehler') });
    }

    let code = data.choices?.[0]?.message?.content || '';
    // Strip markdown code fences if present
    code = code.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!code.toLowerCase().startsWith('<!doctype') && !code.toLowerCase().startsWith('<html')) {
      const match = code.match(/<!DOCTYPE[\s\S]*/i) || code.match(/<html[\s\S]*/i);
      if (match) code = match[0];
    }
    res.json({ code });
  } catch (err) {
    res.status(502).json({ error: 'KI-Verbindungsfehler' });
  }
});

// In-Memory Safeguard Violations: username -> { count, blockedUntil }
const kiSafeguardViolations = new Map();

function responseOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
      if (typeof content?.output_text === 'string') chunks.push(content.output_text);
    }
  }
  return chunks.join('\n').trim();
}

async function extendPremiumFor(username, ms = PREMIUM_BONUS_MS) {
  const profile = await getProfile(username);
  const from = profile.premiumUntil ? Date.parse(profile.premiumUntil) : 0;
  const base = Number.isFinite(from) && from > Date.now() ? from : Date.now();
  const next = new Date(base + ms).toISOString();
  return upsertProfile(username, { premiumUntil: next });
}

function toOpenAIResponsesInput(messages) {
  const input = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      input.push({ role, content: msg.content });
      continue;
    }
    if (Array.isArray(msg.content)) {
      const content = msg.content.map((part) => {
        if (part?.type === 'text') return { type: 'input_text', text: String(part.text || '') };
        if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url || part.image_url || '', detail: 'auto' };
        return { type: 'input_text', text: String(part?.text || '') };
      }).filter((part) => part.type !== 'input_image' || part.image_url);
      input.push({ role, content });
    }
  }
  return input;
}

// â”€â”€â”€ KI Proxy (Groq) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/ki/premium', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const profile = await ensurePlanCredits(auth.username);
  if (!profile.isPremium && profile.capabilities?.premiumKi !== true) {
    return res.status(403).json({ error: 'Premium Ehoser ist nur mit Premium freigeschaltet.' });
  }

  const openAIKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.API_KEY;
  if (!openAIKey) return res.status(500).json({ error: 'OPENAI_API_KEY nicht konfiguriert' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  const creditCost = 5;
  try {
    await chargeCredits(auth.username, creditCost);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, credits: err.credits || 0 });
  }

  try {
    const systemPrompt = messages.find((msg) => msg.role === 'system')?.content
      || 'Du bist Premium Ehoser, ein hilfreicher, klarer KI-Assistent. Antworte auf Deutsch, wenn der Nutzer Deutsch schreibt.';

    const aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAIKey}`
      },
      body: JSON.stringify({
        model: PREMIUM_OPENAI_MODEL,
        instructions: String(systemPrompt),
        input: toOpenAIResponsesInput(messages),
        max_output_tokens: 900
      })
    });

    const data = await aiRes.json().catch(() => ({}));
    if (!aiRes.ok) {
      await changeCredits(auth.username, creditCost).catch(() => {});
      const message = typeof data?.error === 'object'
        ? (data.error?.message || JSON.stringify(data.error))
        : (data?.error || 'Premium-KI-Fehler');
      return res.status(aiRes.status).json({ error: message });
    }

    const content = responseOutputText(data);
    res.json({
      choices: [{ message: { role: 'assistant', content: content || 'Keine Antwort erhalten.' } }],
      model: PREMIUM_OPENAI_MODEL,
      premium: true,
      creditsUsed: creditCost
    });
  } catch (err) {
    await changeCredits(auth.username, creditCost).catch(() => {});
    console.error('Premium KI Error:', err);
    res.status(502).json({ error: 'Premium-KI-Verbindungsfehler' });
  }
});

app.post('/api/support/chat', async (req, res) => {
  const openAIKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.API_KEY;
  if (!openAIKey) return res.status(500).json({ error: 'OPENAI_API_KEY nicht konfiguriert' });

  let username = null;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) username = jwt.verify(token, JWT_SECRET)?.username || null;
  } catch {}

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  try {
    const systemPrompt = messages.find((msg) => msg.role === 'system')?.content
      || 'Du bist Ehoser Support. Antworte auf Deutsch, freundlich, kurz und praktisch. Verrate keine Secrets, Tokens, Codes oder Admin-Interna.';
    const supportContext = username ? `Angemeldeter Nutzer: ${username}` : 'Nutzer ist nicht angemeldet oder Gast.';

    const aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAIKey}`
      },
      body: JSON.stringify({
        model: SUPPORT_OPENAI_MODEL,
        instructions: `${String(systemPrompt)}\n\n${supportContext}`,
        input: toOpenAIResponsesInput(messages),
        max_output_tokens: 700
      })
    });

    const data = await aiRes.json().catch(() => ({}));
    if (!aiRes.ok) {
      const message = typeof data?.error === 'object'
        ? (data.error?.message || JSON.stringify(data.error))
        : (data?.error || 'Support konnte nicht antworten');
      return res.status(aiRes.status).json({ error: message });
    }

    const content = responseOutputText(data);
    res.json({
      choices: [{ message: { role: 'assistant', content: content || 'Keine Antwort erhalten.' } }],
      model: SUPPORT_OPENAI_MODEL
    });
  } catch (err) {
    console.error('Support OpenAI Error:', err);
    res.status(502).json({ error: 'Support nicht erreichbar' });
  }
});

app.post('/api/ki', async (req, res) => {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  // Nutzer optional identifizieren
  let username = null;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) username = jwt.verify(token, JWT_SECRET)?.username || null;
  } catch {}
  if (!username) {
    return res.status(401).json({ error: 'Login erforderlich, damit Credits abgezogen werden koennen.' });
  }

  const creditCost = countTextCredits(messages);
  try {
    await chargeCredits(username, creditCost);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, credits: err.credits || 0 });
  }

  // Gesperrt?
  if (username) {
    const v = kiSafeguardViolations.get(username);
    if (v?.blockedUntil && v.blockedUntil > Date.now()) {
      const days = Math.ceil((v.blockedUntil - Date.now()) / 86400000);
      await changeCredits(username, creditCost).catch(() => {});
      return res.status(200).json({ choices: [{ message: { role: 'assistant',
        content: `ðŸš« Dein Zugang zur KI ist wegen mehrfacher VerstÃ¶ÃŸe fÃ¼r noch ${days} Tag(e) gesperrt.`
      }}]});
    }
  }

  try {
    // Safeguard: letzte Nutzer-Nachricht prÃ¼fen
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      const userText = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : '';
      if (userText.trim()) {
        try {
          const sgRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
            body: JSON.stringify({
              model: 'openai/gpt-oss-safeguard-20b',
              messages: [{ role: 'user', content: userText }],
              max_tokens: 10
            })
          });
          if (sgRes.ok) {
            const sgData = await sgRes.json();
            const verdict = sgData.choices?.[0]?.message?.content?.trim().toLowerCase() || '';
            if (verdict.startsWith('unsafe')) {
              // VerstoÃŸ zÃ¤hlen
              let count = 1;
              if (username) {
                const prev = kiSafeguardViolations.get(username) || { count: 0 };
                count = prev.count + 1;
                if (count >= 3) {
                  kiSafeguardViolations.set(username, { count, blockedUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 });
                  return res.status(200).json({ choices: [{ message: { role: 'assistant',
                    content: 'ðŸš« Du wurdest wegen 3 VerstÃ¶ÃŸen gegen die Nutzungsrichtlinien fÃ¼r 7 Tage von der KI gesperrt.'
                  }}]});
                }
                kiSafeguardViolations.set(username, { count, blockedUntil: null });
                if (count === 2) {
                  return res.status(200).json({ choices: [{ message: { role: 'assistant',
                    content: 'âš ï¸ **Letzte Warnung:** Deine Anfrage verstÃ¶ÃŸt gegen die Nutzungsrichtlinien. Bei einem weiteren VerstoÃŸ wird dein KI-Zugang fÃ¼r 7 Tage gesperrt.'
                  }}]});
                }
              }
              // 1. VerstoÃŸ: KI antwortet Ã¼ber das Hauptmodell mit Ablehnung
              const refusalMessages = [
                ...messages.slice(0, -1),
                { role: 'system', content: 'Die Anfrage des Nutzers wurde von unserem Sicherheitssystem als problematisch eingestuft. ErklÃ¤re dem Nutzer freundlich aber bestimmt, dass du bei diesem Thema nicht helfen kannst. Gib keine Informationen zu dem angeforderten Thema.' },
                lastUserMsg
              ];
              try {
                const refRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
                  body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: refusalMessages, stream: false, max_tokens: 300 })
                });
                if (refRes.ok) return res.json(await refRes.json());
              } catch {}
              return res.status(200).json({ choices: [{ message: { role: 'assistant',
                content: 'Entschuldigung, bei diesem Thema kann ich leider nicht helfen. Bitte stelle eine andere Frage.'
              }}]});
            }
          }
        } catch {}
      }
    }

    // Bildnachrichten brauchen ein Vision-Modell
    const hasImage = messages.some(m =>
      Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')
    );
    const model = hasImage ? 'llama-3.2-11b-vision-preview' : 'llama-3.3-70b-versatile';

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(groqRes.status).json(data);
    if (username && lastUserMsg) {
      const userText = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : '';
      await personalizeFromInteraction(groqKey, username, 'ki_chat', userText, {
        tone: 'focused',
        highlightModes: ['ki'],
        summary: 'ehoser KI wurde genutzt.'
      });
    }
    res.json(data);
  } catch (err) {
    await changeCredits(username, creditCost).catch(() => {});
    res.status(502).json({ error: 'Verbindungsfehler zur Groq API' });
  }
});

function normalizeVideoOptions(body = {}) {
  const quality = ['low', 'medium', 'high'].includes(String(body.quality)) ? String(body.quality) : 'medium';
  const secondsRaw = Number(body.seconds) || 4;
  const seconds = secondsRaw <= 4 ? 4 : secondsRaw <= 8 ? 8 : 12;
  const multipliers = { low: 1, medium: 2, high: 3 };
  const sizes = { low: '1280x720', medium: '1280x720', high: '1920x1080' };
  const model = quality === 'low' ? 'sora-2' : 'sora-2-pro';
  return {
    quality,
    seconds,
    model,
    size: sizes[quality],
    cost: seconds * 10 * multipliers[quality]
  };
}

app.post('/api/ki/video/create', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const openAIKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.API_KEY;
  if (!openAIKey) return res.status(500).json({ error: 'OPENAI_API_KEY nicht konfiguriert' });

  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Kein Prompt' });
  const profile = await ensurePlanCredits(auth.username);
  if (!profile.isPremium && profile.capabilities?.videoGenerator !== true) {
    return res.status(403).json({ error: 'Es tut mir leid, Video KI ist ab 20 Euro im Shop erhaeltlich.' });
  }
  const opts = normalizeVideoOptions(req.body);
  try {
    await chargeCredits(auth.username, opts.cost);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, credits: err.credits || 0, cost: opts.cost });
  }

  try {
    const createRes = await fetch('https://api.openai.com/v1/videos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAIKey}`
      },
      body: JSON.stringify({
        model: opts.model,
        prompt: String(prompt).slice(0, 1000),
        seconds: String(opts.seconds),
        size: opts.size
      })
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !created.id) {
      await changeCredits(auth.username, opts.cost).catch(() => {});
      const message = created?.error?.message || created?.error || 'Sora konnte nicht gestartet werden';
      return res.status(createRes.status || 502).json({ error: message, refunded: opts.cost });
    }

    let job = created;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !['completed', 'failed', 'cancelled'].includes(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const statusRes = await fetch(`https://api.openai.com/v1/videos/${created.id}`, {
        headers: { Authorization: `Bearer ${openAIKey}` }
      });
      job = await statusRes.json().catch(() => job);
      if (!statusRes.ok) {
        await changeCredits(auth.username, opts.cost).catch(() => {});
        return res.status(statusRes.status).json({ error: job?.error?.message || 'Video-Status konnte nicht geladen werden', refunded: opts.cost });
      }
    }

    if (job.status !== 'completed') {
      await changeCredits(auth.username, opts.cost).catch(() => {});
      return res.status(502).json({ error: job?.error?.message || 'Video-Generierung fehlgeschlagen oder abgelaufen', refunded: opts.cost });
    }

    const contentRes = await fetch(`https://api.openai.com/v1/videos/${created.id}/content`, {
      headers: { Authorization: `Bearer ${openAIKey}` }
    });
    if (!contentRes.ok) {
      await changeCredits(auth.username, opts.cost).catch(() => {});
      return res.status(contentRes.status).json({ error: 'Video konnte nicht heruntergeladen werden', refunded: opts.cost });
    }
    const contentType = contentRes.headers.get('content-type') || 'video/mp4';
    const buffer = await contentRes.arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-credits-used', String(opts.cost));
    res.send(Buffer.from(buffer));
  } catch (err) {
    await changeCredits(auth.username, opts.cost).catch(() => {});
    res.status(502).json({ error: `Fehler bei Video-Generierung: ${err.message || err}`, refunded: opts.cost });
  }
});

app.get('/api/ki/video/:id/status', async (req, res) => {
  res.status(410).json({ error: 'Status-Polling wird nicht verwendet.' });
});

// Bild-Generierung mit OpenAI GPT Image 1 Mini
app.get('/api/ki/image', async (req, res) => {
  const prompt = req.query.prompt;
  if (!prompt || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Kein Prompt angegeben' });
  }
  const openAIKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.API_KEY;
  if (!openAIKey) return res.status(500).json({ error: 'OPENAI_API_KEY nicht konfiguriert' });

  try {
    const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAIKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-image-1-mini',
        prompt: prompt.slice(0, 1000),
        size: '1024x1024',
        quality: 'low',
        output_format: 'png'
      })
    });

    if (!aiRes.ok) {
      const errorText = await aiRes.text().catch(() => '');
      console.error('[OpenAI Image] Status:', aiRes.status, errorText);
      return res.status(aiRes.status).json({ error: 'Bildgenerierung mit OpenAI fehlgeschlagen' });
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('[OpenAI Image] Keine Bilddaten erhalten:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'OpenAI hat keine Bilddaten geliefert' });
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(b64, 'base64'));
  } catch (err) {
    console.error('[OpenAI Image] Fehler:', err.message || err);
    res.status(502).json({ error: 'Bildgenerierung fehlgeschlagen' });
  }
});

module.exports = app;

