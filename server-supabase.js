const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || !JWT_SECRET.trim()) throw new Error('JWT_SECRET must be configured');
const UNLOCK_CODE = process.env.UNLOCK_CODE || '';
const ADMIN_UPLOAD_KEY = process.env.ADMIN_UPLOAD_KEY || '';
// Der Eigentümerzugang ist absichtlich an den echten Account gebunden, nicht
// an ein Flag im Browser. Der Username kann bei Bedarf als Deployment-Variable
// geändert werden, ohne dass der Client angepasst werden muss.
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || 'meisterlool_707').trim().toLowerCase();
const TOKEN_EXPIRES_IN = '3650d'; // 10 Jahre – Token läuft praktisch nie ab
const PRO_BONUS_MS = 2 * 24 * 60 * 60 * 1000;
const PREMIUM_BONUS_MS = 30 * 24 * 60 * 60 * 1000;
const PREMIUM_OPENAI_MODEL = process.env.PREMIUM_OPENAI_MODEL || 'qwen/qwen3.8-27b';
const SUPPORT_OPENAI_MODEL = process.env.SUPPORT_OPENAI_MODEL || 'gpt-5.4-mini';
const PLAN_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_CREDIT_GRANTS = { free: 30, pro: 200, premium: 1000 };
const OASIS_DAILY_LIMIT_MS = Math.max(1000, Number(process.env.OASIS_DAILY_LIMIT_MS || 60000));
const OASIS_USAGE_TIME_ZONE = process.env.OASIS_USAGE_TIME_ZONE || 'Europe/Berlin';
const OASIS_PYTHON_BIN = process.env.OASIS_PYTHON_BIN || process.env.PYTHON_BIN || 'python';
const OASIS_BRIDGE_PATH = path.join(__dirname, 'scripts', 'oasis_bridge.py');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
const EHOSER_MAIL_DOMAIN = String(process.env.EHOSER_MAIL_DOMAIN || 'ehoser.de').trim().toLowerCase();
const ACCOUNT_DELETION_GRACE_MS = 72 * 60 * 60 * 1000;
const ACCOUNT_DELETION_CONFIRMATION = 'KONTO LÖSCHEN';
const CRON_SECRET = String(process.env.CRON_SECRET || '');

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;
const guestPresence = new Map();
const GUEST_WINDOW_MS = 5 * 60 * 1000;
// Active chat clients send a heartbeat every five seconds. The compatibility
// window also covers a still-open older browser tab that sends every minute.
const CHAT_PRESENCE_WINDOW_MS = 75 * 1000;
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
  console.error('✗ Fehler: SUPABASE_URL oder SUPABASE_KEY nicht gesetzt!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Admin-Client mit service_role key – umgeht RLS für Server-seitige Operationen
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
    console.warn('⚠️  DATABASE_URL nicht gesetzt – Auto-Migration übersprungen.');
    console.warn('   Bitte folgendes SQL in Supabase > SQL-Editor ausführen:');
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
CREATE TABLE IF NOT EXISTS chat_groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id UUID NOT NULL,
  username TEXT NOT NULL,
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
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_by TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS hide_edit_mark BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_by TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
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
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT NULL;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP NULL;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_by TEXT NULL;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS hide_edit_mark BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP NULL;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_by TEXT NULL;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ehoser_mailboxes (
        username TEXT PRIMARY KEY REFERENCES users(username) ON UPDATE CASCADE ON DELETE CASCADE,
        address TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ehoser_mail_messages (
        id BIGSERIAL PRIMARY KEY,
        provider_message_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        sender_username TEXT REFERENCES users(username) ON UPDATE CASCADE ON DELETE SET NULL,
        sender_address TEXT NOT NULL,
        recipient_username TEXT REFERENCES users(username) ON UPDATE CASCADE ON DELETE SET NULL,
        recipient_address TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        text_body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'failed', 'bounced')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at TIMESTAMPTZ NULL,
        CONSTRAINT ehoser_mail_messages_provider_direction_key UNIQUE (provider_message_id, direction)
      );
      CREATE INDEX IF NOT EXISTS ehoser_mail_messages_recipient_created_idx
        ON ehoser_mail_messages (recipient_username, created_at DESC);
      CREATE INDEX IF NOT EXISTS ehoser_mail_messages_sender_created_idx
        ON ehoser_mail_messages (sender_username, created_at DESC);
      CREATE INDEX IF NOT EXISTS ehoser_mail_messages_provider_message_idx
        ON ehoser_mail_messages (provider_message_id);
      ALTER TABLE ehoser_mailboxes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ehoser_mail_messages ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE ehoser_mailboxes, ehoser_mail_messages FROM anon, authenticated;
      REVOKE ALL ON SEQUENCE ehoser_mail_messages_id_seq FROM anon, authenticated;
    `);
    console.log('✓ Datenbank-Tabellen überprüft/erstellt.');
  } catch (err) {
    console.error('⚠️  Auto-Migration fehlgeschlagen:', err.message);
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
  '/api/learning/chat',
  '/api/unlock-code',
  '/api/verify-token',
  '/api/owner/status'
]);

function isPublicApiPath(pathname) {
  return PUBLIC_API_PATHS.has(pathname)
    || pathname.startsWith('/api/admin/')
    || pathname.startsWith('/api/ki')
    || pathname.startsWith('/api/learning')
    || pathname === '/api/apps'
    || pathname.startsWith('/api/apps/')
    || pathname === '/api/games'
    || pathname === '/api/news'
    || pathname === '/api/repo/version'
    || (pathname.startsWith('/api/oasis/session/') && pathname.endsWith('/stream'))
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

// Fallback für Serverless/fehlende Tabellen
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
    res.status(401).json({ error: 'Ungültiger Token' });
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
  const allowedModes = new Set(['store', 'games', 'facewarp', 'chat', 'images', 'weather', 'map', 'earth3d', 'oasis', 'youtube', 'ki', 'ps', 'gameCreator']);
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

function getOasisUsageDayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: OASIS_USAGE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function normalizeOasisUsage(raw) {
  const today = getOasisUsageDayKey();
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const day = typeof src.day === 'string' ? src.day : today;
  const usedMs = Math.max(0, Math.min(OASIS_DAILY_LIMIT_MS, Number(src.usedMs || 0)));
  return {
    day: day === today ? day : today,
    usedMs: day === today ? Math.round(usedMs) : 0,
    limitMs: OASIS_DAILY_LIMIT_MS,
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

function normalizeOwnerNotice(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const kind = ['notification', 'announcement'].includes(String(src.kind || '').trim())
    ? String(src.kind).trim()
    : 'announcement';
  const audience = ['all', 'user'].includes(String(src.audience || '').trim())
    ? String(src.audience).trim()
    : 'all';
  const targetUsername = audience === 'user'
    ? String(src.targetUsername || '').trim().slice(0, 40)
    : '';
  const expiresAt = typeof src.expiresAt === 'string' && Number.isFinite(Date.parse(src.expiresAt))
    ? new Date(src.expiresAt).toISOString()
    : null;
  return {
    id: String(src.id || '').trim().slice(0, 80),
    title: String(src.title || '').trim().slice(0, 120),
    message: String(src.message || '').trim().slice(0, 1200),
    kind,
    audience: targetUsername ? audience : 'all',
    targetUsername,
    active: src.active !== false,
    createdAt: typeof src.createdAt === 'string' && Number.isFinite(Date.parse(src.createdAt))
      ? new Date(src.createdAt).toISOString()
      : new Date().toISOString(),
    expiresAt
  };
}

function normalizeOwnerConsole(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const maintenanceSrc = (src.maintenance && typeof src.maintenance === 'object' && !Array.isArray(src.maintenance))
    ? src.maintenance
    : {};
  const notices = Array.isArray(src.notices)
    ? src.notices.map(normalizeOwnerNotice).filter((notice) => notice.id && notice.title && notice.message).slice(0, 80)
    : [];
  return {
    maintenance: {
      enabled: Boolean(maintenanceSrc.enabled),
      title: String(maintenanceSrc.title || 'Wir sind gleich wieder da').trim().slice(0, 120) || 'Wir sind gleich wieder da',
      message: String(maintenanceSrc.message || 'Die Webseite ist vorübergehend wegen Update, Programmierung oder sonstigen Gründen nicht verfügbar.').trim().slice(0, 800)
        || 'Die Webseite ist vorübergehend wegen Update, Programmierung oder sonstigen Gründen nicht verfügbar.',
      updatedAt: typeof maintenanceSrc.updatedAt === 'string' && Number.isFinite(Date.parse(maintenanceSrc.updatedAt))
        ? new Date(maintenanceSrc.updatedAt).toISOString()
        : null
    },
    notices
  };
}

const ADMIN_PRESENCE_USERNAME = OWNER_USERNAME;

function normalizePresenceOverride(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['automatic', 'force_online', 'force_offline'].includes(mode) ? mode : 'automatic';
}

function getPresenceOverride(username, settings) {
  if (String(username || '').trim().toLowerCase() !== ADMIN_PRESENCE_USERNAME) return 'automatic';
  return normalizePresenceOverride(settings?.presenceOverride);
}

function applyPresenceOverride(username, lastSeen, settings) {
  const mode = getPresenceOverride(username, settings);
  if (mode === 'force_online') return new Date().toISOString();
  if (mode === 'force_offline') return null;
  return lastSeen || null;
}

function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const rawAvatarUrl = typeof src.avatarUrl === 'string' ? src.avatarUrl.trim().slice(0, 2048) : '';
  let avatarUrl = '';
  try {
    const parsed = new URL(rawAvatarUrl);
    // Profilbilder werden auch für andere Nutzer gerendert. HTTPS verhindert
    // Mixed Content und ungültige Bildquellen in allen Chat-Clients.
    if (parsed.protocol === 'https:') avatarUrl = parsed.toString();
  } catch {}
  const ownerConsole = src.ownerConsole && typeof src.ownerConsole === 'object' && !Array.isArray(src.ownerConsole)
    ? normalizeOwnerConsole(src.ownerConsole)
    : undefined;
  return {
    language: typeof src.language === 'string' ? src.language : 'de',
    design: typeof src.design === 'string' ? src.design : 'standard',
    energySaver: Boolean(src.energySaver),
    chatEnterToSend: src.chatEnterToSend !== false,
    chatCompactMode: Boolean(src.chatCompactMode),
    chatShowPreviews: src.chatShowPreviews !== false,
    presenceOverride: normalizePresenceOverride(src.presenceOverride),
    displayName: typeof src.displayName === 'string' ? src.displayName.trim().slice(0, 40) : '',
    avatarUrl,
    googleSub: typeof src.googleSub === 'string' ? src.googleSub.trim().slice(0, 255) : '',
    googleEmail: typeof src.googleEmail === 'string' ? src.googleEmail.trim().toLowerCase().slice(0, 320) : '',
    googleDriveStorageMode: src.googleDriveStorageMode === 'google_one' ? 'google_one' : 'free',
    premiumUntil: typeof src.premiumUntil === 'string' ? src.premiumUntil : null,
    personalizationEnabled: false,
    personalization: normalizePersonalization({}),
    moderation: normalizeModerationSettings(src.moderation),
    credits: (src.credits && typeof src.credits === 'object' && !Array.isArray(src.credits)) ? src.credits : undefined,
    planRequests: Array.isArray(src.planRequests) ? src.planRequests.slice(-10) : undefined,
    oasisUsage: normalizeOasisUsage(src.oasisUsage),
    passwordHash: typeof src.passwordHash === 'string' ? src.passwordHash : undefined,
    _emailPending: (src._emailPending && typeof src._emailPending === 'object') ? src._emailPending : undefined,
    // Der Chat-Code wird nur als bcrypt-Hash gespeichert. So funktioniert er
    // mit demselben Account auf allen Geräten, ohne Klartext zu speichern.
    chatLockCodeHash: typeof src.chatLockCodeHash === 'string' ? src.chatLockCodeHash.slice(0, 255) : '',
    chatLockCodeSetAt: typeof src.chatLockCodeSetAt === 'string' && Number.isFinite(Date.parse(src.chatLockCodeSetAt))
      ? new Date(src.chatLockCodeSetAt).toISOString() : null,
    accountDeletion: normalizeAccountDeletion(src.accountDeletion),
    // Öffentliche E2EE-Schlüssel sind absichtlich profilweit abrufbar; private Schlüssel werden nie gespeichert.
    e2eePublicKey: (src.e2eePublicKey && typeof src.e2eePublicKey === 'object' && src.e2eePublicKey.kty === 'RSA') ? src.e2eePublicKey : undefined,
    e2eeKeyUpdatedAt: typeof src.e2eeKeyUpdatedAt === 'string' ? src.e2eeKeyUpdatedAt : undefined,
    ownerConsole
  };
}

function normalizeAccountDeletion(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const requestedAt = typeof src.requestedAt === 'string' && Number.isFinite(Date.parse(src.requestedAt))
    ? new Date(src.requestedAt).toISOString() : null;
  const deleteAfter = typeof src.deleteAfter === 'string' && Number.isFinite(Date.parse(src.deleteAfter))
    ? new Date(src.deleteAfter).toISOString() : null;
  return requestedAt && deleteAfter ? { requestedAt, deleteAfter } : null;
}

function accountDeletionIsDue(profile) {
  const deleteAfter = profile?.settings?.accountDeletion?.deleteAfter;
  return Boolean(deleteAfter && Number.isFinite(Date.parse(deleteAfter)) && Date.parse(deleteAfter) <= Date.now());
}

function parseChatMessagePreview(storedContent) {
  const raw = String(storedContent || '');
  // E2EE payloads must never be interpreted as message text by the server.
  if (raw.startsWith('{') && raw.includes('"e2ee":1')) return '[Ende-zu-Ende verschlüsselte Nachricht]';
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
            content: 'Du extrahierst nur UI-Personalisierung für ehoser. Antworte NUR mit JSON. Erlaube nur diese Felder: tone (neutral|calm|focused|playful), layout (standard|simple|explore), simplifySearch (boolean), prioritizePs (boolean), heroLine (string <= 180), summary (string <= 280), interests (Array bis 6 kurze Strings), highlightModes (Array aus store,games,facewarp,chat,images,weather,map,youtube,ki,ps,gameCreator). Erfinde nichts ohne klare Signale.'
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
  return {
    username,
    settings: normalizeSettings(profile.settings || profile.user_settings),
    proUntil: proUntil || null,
    premiumUntil: premiumUntil || null,
    isPremium,
    isPro: isPremium || (Number.isFinite(ms) && ms > Date.now())
  };
}

function getPlanKey(profile) {
  if (profile?.isPremium) return 'premium';
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
  const credits = settings.credits || {};
  const period = currentCreditPeriod();
  let balance = Number(credits.balance);
  if (!Number.isFinite(balance)) balance = 0;

  if (plan === 'free') {
    // Gratis-Credits werden nicht nur einmal vergeben: Jeder neue Kalendermonat
    // bringt dem Free-Plan automatisch das kostenlose Kontingent zurück.
    if (credits.plan !== 'free' || credits.period !== period) {
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
  const balance = Math.max(0, (Number(credits.balance) || 0) + delta);
  settings.credits = { ...credits, balance, updatedAt: new Date().toISOString() };
  return upsertProfile(username, { settings });
}

async function chargeCredits(username, amount) {
  const profile = await ensurePlanCredits(username);
  const balance = Number(profile.settings?.credits?.balance || 0);
  if (balance < amount) {
    const err = new Error('Keine Credits mehr verfügbar. Bitte upgrade deinen Plan.');
    err.status = 402;
    err.credits = balance;
    throw err;
  }
  return changeCredits(username, -amount);
}

async function getProfile(username) {
  // Primär: users Tabelle (existiert immer), optional: user_profiles für Settings
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
      // Wenn user_profiles einen späteren pro_until hat, nutze den
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
  return {
    username,
    settings: normalizeSettings({ ...(settings || mem?.settings || {}), premiumUntil: premiumUntil || null }),
    proUntil: proUntil || null,
    premiumUntil: premiumUntil || null,
    isPremium,
    isPro: isPremium || (Number.isFinite(ms) && ms > Date.now()),
    ps_account: psAccount || false,
    credits: Number((settings || mem?.settings || {})?.credits?.balance || 0)
  };
}

async function upsertProfile(username, patch) {
  const current = await getProfile(username);
  const newProUntil = Object.prototype.hasOwnProperty.call(patch, 'proUntil') ? patch.proUntil : current.proUntil;
  const newPremiumUntil = Object.prototype.hasOwnProperty.call(patch, 'premiumUntil') ? patch.premiumUntil : current.premiumUntil;
  const newSettings = normalizeSettings({ ...(current.settings || {}), ...(patch.settings || {}), premiumUntil: newPremiumUntil || null });

  // Pro-Status in users Tabelle schreiben (primary – existiert garantiert)
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

  // Wenn users.pro_until Spalte fehlt →’ Auto-Spalte anlegen versuchen
  if (!savedToUsers) {
    try {
      // Spalte existiert nicht →’ in user_profiles speichern
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
  return {
    username,
    settings: newSettings,
    proUntil: newProUntil || null,
    premiumUntil: newPremiumUntil || null,
    isPremium,
    isPro: isPremium || (Number.isFinite(ms) && ms > Date.now()),
    credits: Number(newSettings?.credits?.balance || 0)
  };
}

async function permanentlyDeleteAccount(username, userId = null) {
  const { data: userRow } = userId
    ? { data: { id: userId, username } }
    : await supabaseAdmin.from('users').select('id,username').eq('username', username).maybeSingle();
  if (!userRow?.id) return false;

  const { data: ownedGroups } = await supabaseAdmin.from('chat_groups').select('id').eq('created_by', username);
  const groupIds = (ownedGroups || []).map((group) => group.id).filter(Boolean);
  const ignore = (request) => Promise.resolve(request).catch(() => {});
  await Promise.all([
    ignore(supabaseAdmin.from('installations').delete().eq('user_id', userRow.id)),
    ignore(supabaseAdmin.from('desktop_login_requests').delete().eq('user_id', userRow.id)),
    ignore(supabaseAdmin.from('ehoser_mail_messages').delete().eq('sender_username', username)),
    ignore(supabaseAdmin.from('ehoser_mail_messages').delete().eq('recipient_username', username)),
    ignore(supabaseAdmin.from('ehoser_mailboxes').delete().eq('username', username)),
    ignore(supabaseAdmin.from('plan_requests').delete().eq('username', username)),
    ignore(supabaseAdmin.from('referral_invites').delete().eq('inviter_username', username)),
    ignore(supabaseAdmin.from('referral_invites').delete().eq('used_by', username)),
    ignore(supabaseAdmin.from('chat_reports').delete().eq('reported_by', username)),
    ignore(supabaseAdmin.from('chat_reports').delete().eq('target_username', username)),
    ignore(supabaseAdmin.from('chat_group_admins').delete().eq('username', username)),
    ignore(supabaseAdmin.from('chat_group_members').delete().eq('username', username)),
    ignore(supabaseAdmin.from('chat_messages').delete().eq('sender', username)),
    ignore(supabaseAdmin.from('chat_messages').delete().eq('sender', chatMemberStateSender(username, 'receipt'))),
    ignore(supabaseAdmin.from('chat_messages').delete().eq('sender', chatMemberStateSender(username, 'typing')))
  ]);
  if (groupIds.length) {
    await Promise.all([
      ignore(supabaseAdmin.from('chat_messages').delete().in('group_id', groupIds)),
      ignore(supabaseAdmin.from('chat_group_admins').delete().in('group_id', groupIds)),
      ignore(supabaseAdmin.from('chat_group_members').delete().in('group_id', groupIds)),
      ignore(supabaseAdmin.from('chat_group_meta').delete().in('group_id', groupIds)),
      ignore(supabaseAdmin.from('chat_groups').delete().in('id', groupIds))
    ]);
  }
  memoryProfiles.delete(username);
  await ignore(supabaseAdmin.from('user_profiles').delete().eq('username', username));
  const { error } = await supabaseAdmin.from('users').delete().eq('id', userRow.id);
  if (error) throw error;
  return true;
}

let accountDeletionCleanupRunning = false;
async function purgeExpiredAccountDeletions() {
  if (accountDeletionCleanupRunning) return 0;
  accountDeletionCleanupRunning = true;
  try {
    const { data, error } = await supabaseAdmin.from('user_profiles').select('username,settings');
    if (error) throw error;
    const due = (data || []).filter((row) => accountDeletionIsDue({ settings: normalizeSettings(row.settings || {}) }));
    let deleted = 0;
    for (const row of due) {
      try { if (await permanentlyDeleteAccount(row.username)) deleted += 1; } catch (error) { console.error('Scheduled account deletion failed:', row.username, error?.message || error); }
    }
    return deleted;
  } finally {
    accountDeletionCleanupRunning = false;
  }
}

// ─── Eigentümer-Konsole ────────────────────────────────────────────────────
// Die Konfiguration liegt im bestehenden, serverseitig geschriebenen Profil des
// Eigentümers. So funktioniert sie auch bei Deployments, bei denen keine
// DATABASE_URL für zusätzliche Auto-Migrationen hinterlegt ist.
let ownerConsoleCache = { value: null, expiresAt: 0 };

function isOwnerUsername(username) {
  return String(username || '').trim().toLowerCase() === OWNER_USERNAME;
}

function readOptionalAuthUser(req) {
  if (req.authUser) return req.authUser;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7).trim(), JWT_SECRET);
  } catch {
    return null;
  }
}

function readOwnerSessionCookie(req) {
  const rawCookie = String(req.headers.cookie || '');
  const match = rawCookie.match(/(?:^|;\s*)ehoser_owner_session=([^;]+)/);
  if (!match) return null;
  try {
    const token = decodeURIComponent(match[1]);
    const auth = jwt.verify(token, JWT_SECRET);
    return isOwnerUsername(auth?.username) ? auth : null;
  } catch {
    return null;
  }
}

function rememberOwnerBrowser(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return;
  const token = header.slice(7).trim();
  if (!token) return;
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  res.cookie('ehoser_owner_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  });
}

function maintenancePageHtml(maintenance) {
  const esc = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const title = esc(maintenance?.title || 'Wir sind gleich wieder da');
  const message = esc(maintenance?.message || 'Die Webseite ist vorübergehend wegen Update, Programmierung oder sonstigen Gründen nicht verfügbar.').replace(/\n/g, '<br>');
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ehoser – ${title}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:radial-gradient(circle at 18% 16%,#12436d 0,transparent 34%),radial-gradient(circle at 88% 78%,#0c736f 0,transparent 30%),#061525;color:#f8fbff;font-family:system-ui,sans-serif"><main style="max-width:560px;width:100%;box-sizing:border-box;padding:34px 28px;border:1px solid rgba(126,220,255,.3);border-radius:24px;background:rgba(5,24,43,.82);box-shadow:0 28px 80px rgba(0,0,0,.42);text-align:center"><div style="width:58px;height:58px;border-radius:18px;display:grid;place-items:center;margin:0 auto 20px;background:linear-gradient(135deg,#0ef0d0,#4d9fff);color:#042039;font-weight:900;font-size:2rem">E</div><h1 style="margin:0 0 14px;font-size:clamp(1.65rem,6vw,2.4rem);letter-spacing:-.04em">${title}</h1><p style="margin:0;color:#b9d5e6;font-size:1rem;line-height:1.65">${message}</p><p style="margin:24px 0 0;color:#78bddb;font-size:.9rem">Bitte schau später noch einmal vorbei.</p></main></body></html>`;
}

function requireOwner(req, res) {
  const auth = readAuthUser(req, res);
  if (!auth) return null;
  if (!isOwnerUsername(auth.username)) {
    res.status(403).json({ error: 'Dieser Bereich ist nur für den Eigentümer verfügbar.' });
    return null;
  }
  rememberOwnerBrowser(req, res);
  return auth;
}

async function getOwnerConsole({ force = false } = {}) {
  if (!force && ownerConsoleCache.value && ownerConsoleCache.expiresAt > Date.now()) {
    return ownerConsoleCache.value;
  }
  const profile = await getProfile(OWNER_USERNAME);
  const value = normalizeOwnerConsole(profile.settings?.ownerConsole);
  ownerConsoleCache = { value, expiresAt: Date.now() + 12_000 };
  return value;
}

async function saveOwnerConsole(nextValue) {
  const value = normalizeOwnerConsole(nextValue);
  await upsertProfile(OWNER_USERNAME, { settings: { ownerConsole: value } });
  ownerConsoleCache = { value, expiresAt: Date.now() + 12_000 };
  return value;
}

function isNoticeActive(notice, now = Date.now()) {
  if (!notice?.active) return false;
  return !notice.expiresAt || Date.parse(notice.expiresAt) > now;
}

function noticesForUser(notices, username) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  return (notices || [])
    .filter((notice) => isNoticeActive(notice))
    .filter((notice) => notice.audience === 'all'
      || (normalizedUsername && String(notice.targetUsername || '').trim().toLowerCase() === normalizedUsername))
    .map(({ targetUsername, ...notice }) => notice);
}

async function getOwnerStats() {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id,last_seen,created_at');
    if (error) throw error;
    const now = Date.now();
    const users = data || [];
    const online = users.filter((user) => {
      const seenAt = Date.parse(user.last_seen || '');
      return Number.isFinite(seenAt) && now - seenAt >= -60_000 && now - seenAt < CHAT_PRESENCE_WINDOW_MS;
    }).length;
    const activeToday = users.filter((user) => {
      const seenAt = Date.parse(user.last_seen || '');
      return Number.isFinite(seenAt) && now - seenAt < 24 * 60 * 60 * 1000;
    }).length;
    return { totalUsers: users.length, onlineUsers: online, activeToday };
  } catch {
    return { totalUsers: 0, onlineUsers: 0, activeToday: 0 };
  }
}

const oasisSessions = new Map();

function getOasisUsagePayload(profile) {
  const usage = normalizeOasisUsage(profile?.settings?.oasisUsage);
  return {
    day: usage.day,
    usedMs: usage.usedMs,
    limitMs: OASIS_DAILY_LIMIT_MS,
    remainingMs: Math.max(0, OASIS_DAILY_LIMIT_MS - usage.usedMs)
  };
}

async function getOasisUsageForUser(username) {
  const profile = await getProfile(username);
  return getOasisUsagePayload(profile);
}

async function persistOasisUsage(username, usedMs) {
  const profile = await getProfile(username);
  const current = normalizeOasisUsage(profile.settings?.oasisUsage);
  const nextUsedMs = Math.max(
    current.usedMs,
    Math.min(OASIS_DAILY_LIMIT_MS, Math.round(Number(usedMs || 0)))
  );
  const settings = {
    ...profile.settings,
    oasisUsage: {
      day: getOasisUsageDayKey(),
      usedMs: nextUsedMs,
      limitMs: OASIS_DAILY_LIMIT_MS,
      updatedAt: new Date().toISOString()
    }
  };
  const updated = await upsertProfile(username, { settings });
  return getOasisUsagePayload(updated);
}

function sendOasisEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastOasis(session, event, data) {
  for (const client of session.clients) {
    try {
      sendOasisEvent(client, event, data);
    } catch {}
  }
}

function findActiveOasisSession(username) {
  for (const session of oasisSessions.values()) {
    if (session.username === username && !session.closed) return session;
  }
  return null;
}

function startOasisBilling(session) {
  if (session.billingStarted || session.closed) return;
  session.billingStarted = true;
  session.lastBilledAt = Date.now();
  session.billingTimer = setInterval(() => {
    chargeOasisSession(session);
  }, 1000);
}

function chargeOasisSession(session, { endOnLimit = true } = {}) {
  if (!session || session.closed || !session.billingStarted) {
    return Math.max(0, OASIS_DAILY_LIMIT_MS - Number(session?.usedMs || 0));
  }
  const now = Date.now();
  const delta = Math.max(0, now - (session.lastBilledAt || now));
  session.lastBilledAt = now;
  if (delta > 0) {
    session.usedMs = Math.min(OASIS_DAILY_LIMIT_MS, Number(session.usedMs || 0) + delta);
  }
  const remainingMs = Math.max(0, OASIS_DAILY_LIMIT_MS - session.usedMs);
  if (now - (session.lastPersistedAt || 0) > 5000) {
    session.lastPersistedAt = now;
    persistOasisUsage(session.username, session.usedMs).catch(() => {});
  }
  if (remainingMs <= 0 && endOnLimit) {
    endOasisSession(session, 'daily-limit').catch(() => {});
  }
  return remainingMs;
}

async function endOasisSession(sessionOrId, reason = 'stopped') {
  const session = typeof sessionOrId === 'string' ? oasisSessions.get(sessionOrId) : sessionOrId;
  if (!session || session.closed) return;

  chargeOasisSession(session, { endOnLimit: false });
  session.closed = true;
  if (session.billingTimer) clearInterval(session.billingTimer);
  if (session.clientCloseTimer) clearTimeout(session.clientCloseTimer);

  const usage = await persistOasisUsage(session.username, session.usedMs).catch(() => ({
    usedMs: Math.round(session.usedMs || 0),
    limitMs: OASIS_DAILY_LIMIT_MS,
    remainingMs: Math.max(0, OASIS_DAILY_LIMIT_MS - Math.round(session.usedMs || 0)),
    day: getOasisUsageDayKey()
  }));

  broadcastOasis(session, 'ended', { reason, usage });
  for (const client of session.clients) {
    try { client.end(); } catch {}
  }
  session.clients.clear();

  try {
    session.child?.stdin?.write(JSON.stringify({ type: 'stop' }) + '\n');
  } catch {}
  setTimeout(() => {
    try {
      if (session.child && !session.child.killed) session.child.kill('SIGTERM');
    } catch {}
  }, 800);

  oasisSessions.delete(session.id);
}

function handleOasisBridgeMessage(session, msg) {
  if (!msg || typeof msg !== 'object' || session.closed) return;

  if (msg.type === 'status') {
    if (['prompted', 'running'].includes(msg.state)) {
      startOasisBilling(session);
    }
    broadcastOasis(session, 'status', {
      state: msg.state || 'running',
      message: msg.message || '',
      remainingMs: chargeOasisSession(session, { endOnLimit: false })
    });
    return;
  }

  if (msg.type === 'frame') {
    startOasisBilling(session);
    const remainingMs = chargeOasisSession(session);
    if (session.closed) return;
    broadcastOasis(session, 'frame', {
      encoding: msg.encoding || 'jpeg',
      mime: msg.mime || (msg.encoding === 'rgb' ? 'application/octet-stream' : 'image/jpeg'),
      width: msg.width,
      height: msg.height,
      data: msg.data,
      sequence: msg.sequence,
      frame: msg.frame,
      remainingMs
    });
    return;
  }

  if (msg.type === 'error') {
    broadcastOasis(session, 'error', {
      message: msg.message || 'Oasis konnte nicht gestartet werden.',
      code: msg.code || 'bridge_error'
    });
    endOasisSession(session, 'error').catch(() => {});
  }
}

function attachOasisBridge(session, prompt) {
  const child = spawn(OASIS_PYTHON_BIN, [OASIS_BRIDGE_PATH], {
    cwd: __dirname,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  session.child = child;

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          handleOasisBridgeMessage(session, JSON.parse(line));
        } catch {
          broadcastOasis(session, 'error', { message: 'Oasis Bridge hat ungueltige Daten gesendet.' });
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    session.lastStderr = `${session.lastStderr || ''}\n${text}`.slice(-4000);
    broadcastOasis(session, 'log', { message: text.slice(0, 500) });
  });

  child.on('error', (err) => {
    broadcastOasis(session, 'error', {
      message: `Python/Oasis Bridge konnte nicht gestartet werden: ${err.message}`
    });
    endOasisSession(session, 'bridge-error').catch(() => {});
  });

  child.on('exit', (code) => {
    if (session.closed) return;
    const detail = session.lastStderr ? ` (${session.lastStderr.split('\n').slice(-1)[0]})` : '';
    broadcastOasis(session, 'error', {
      message: `Oasis Bridge wurde beendet${typeof code === 'number' ? ` (Code ${code})` : ''}${detail}`
    });
    endOasisSession(session, 'bridge-exit').catch(() => {});
  });

  child.stdin.write(JSON.stringify({ type: 'start', prompt }) + '\n');
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
// This endpoint intentionally runs before express.json(): Resend's Svix
// signature is calculated over the exact raw request bytes.
app.post('/api/webhooks/resend', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  const rawPayload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!rawPayload || !resendWebhookSignatureIsValid(req.headers, rawPayload)) {
    return res.status(401).json({ error: 'Ungültige Webhook-Signatur' });
  }

  let event;
  try {
    event = JSON.parse(rawPayload);
  } catch {
    return res.status(400).json({ error: 'Ungültiger Webhook-Inhalt' });
  }

  try {
    if (event?.type === 'email.received') await storeResendInboundEmail(event);
    else await updateResendDeliveryStatus(event);
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Resend webhook failed:', error?.message || error);
    // A non-2xx response lets Resend retry a transient database/API failure.
    return res.status(500).json({ error: 'Webhook konnte nicht verarbeitet werden' });
  }
});
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

// Während eines Wartungsmodus sind alle normalen API-Funktionen gesperrt.
// Der Eigentümer wird ausschließlich über seinen signierten Login-Token
// erkannt. Bestehende Admin-Endpunkte behalten den separaten Admin-Code, damit
// sie bei einer laufenden Wartung weiter verwaltet werden können.
app.use('/api', async (req, res, next) => {
  const apiPath = `/api${req.path === '/' ? '' : req.path}`;
  if (apiPath === '/api/owner/status' || apiPath.startsWith('/api/owner/') || apiPath.startsWith('/api/admin/')) {
    return next();
  }
  try {
    const consoleState = await getOwnerConsole();
    if (!consoleState.maintenance.enabled || isOwnerUsername(readOptionalAuthUser(req)?.username)) {
      return next();
    }
    return res.status(503).json({
      error: consoleState.maintenance.message,
      code: 'site_maintenance',
      maintenance: consoleState.maintenance
    });
  } catch {
    // Eine kurz nicht erreichbare Konfiguration darf die gesamte Website nicht
    // aussperren. Der gespeicherte Status wird beim nächsten Request erneut
    // gelesen.
    return next();
  }
});

// Auch direkte Aufrufe wie /chat/, /group-call/ oder /skybreak-auth.html
// landen während der Wartung auf derselben verständlichen Hinweis-Seite. Die
// Eigentümer-Konsole bleibt erreichbar, damit der Besitzer den Modus jederzeit
// wieder ausschalten kann; alle anderen Inhalte benötigen die HttpOnly-Sitzung
// des Eigentümers.
app.use(async (req, res, next) => {
  const ownerConsoleAsset = ['/owner.css', '/owner.js', '/owner-notices.js'].includes(req.path);
  if (req.path.startsWith('/api/') || req.path === '/owner' || req.path === '/owner/' || req.path === '/owner.html' || req.path === '/maintenance' || ownerConsoleAsset) {
    return next();
  }
  try {
    const consoleState = await getOwnerConsole();
    if (!consoleState.maintenance.enabled || readOwnerSessionCookie(req)) return next();
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, '/maintenance');
  } catch {
    return next();
  }
});

app.get('/maintenance', async (req, res) => {
  try {
    const consoleState = await getOwnerConsole();
    if (!consoleState.maintenance.enabled) return res.redirect(302, '/chat/');
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(maintenancePageHtml(consoleState.maintenance));
  } catch {
    return res.type('html').send(maintenancePageHtml(null));
  }
});
// Der Chat ist der Standard-Einstieg. Das bisherige Control Center bleibt
// bewusst unter einer eigenen, stabilen Adresse erreichbar.
app.get(['/control-center', '/control-center/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const chatOnlyRedirectPaths = ['/', '/index.html'];
app.get(chatOnlyRedirectPaths, (req, res) => res.redirect(302, '/chat/'));

require('./lib/earthdrive').mountEarthDrive(app, { readAuthUser, getProfile });

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    else if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    else if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
}));

// Öffentliche Client-Konfiguration (kein Authentifizierungs-Token nötig)
app.get('/api/config', (req, res) => {
  res.json({
    ytApiKey: process.env.YT_API_KEY || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    // Dedicated client for user-owned Drive uploads. This is intentionally public: OAuth client IDs are safe to send to the browser.
    googleDriveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    githubRepo: process.env.GITHUB_REPO || 'Partynilles0208/ehoser-store-co'
  });
});

// Öffentlich lesbarer, aber vom Server gefilterter Status. Persönliche
// Mitteilungen werden nur zurückgegeben, wenn der passende Login-Token
// mitgesendet wurde.
app.get('/api/owner/status', async (req, res) => {
  const auth = readOptionalAuthUser(req);
  try {
    const consoleState = await getOwnerConsole();
    if (isOwnerUsername(auth?.username)) rememberOwnerBrowser(req, res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      isOwner: isOwnerUsername(auth?.username),
      maintenance: consoleState.maintenance,
      notices: noticesForUser(consoleState.notices, auth?.username)
    });
  } catch (error) {
    res.status(503).json({ error: 'Website-Status konnte nicht geladen werden.' });
  }
});

// Der Rest der Konsole ist niemals über einen reinen Client-Check geschützt:
// jeder Endpoint prüft den JWT-Account noch einmal serverseitig.
app.get('/api/owner/console', async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const [consoleState, stats] = await Promise.all([getOwnerConsole({ force: true }), getOwnerStats()]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...consoleState, stats, owner: OWNER_USERNAME });
  } catch (error) {
    res.status(500).json({ error: 'Eigentümer-Konsole konnte nicht geladen werden.' });
  }
});

app.put('/api/owner/maintenance', async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const current = await getOwnerConsole({ force: true });
    const input = req.body && typeof req.body === 'object' ? req.body : {};
    const next = normalizeOwnerConsole({
      ...current,
      maintenance: {
        ...current.maintenance,
        enabled: input.enabled === true,
        title: input.title,
        message: input.message,
        updatedAt: new Date().toISOString()
      }
    });
    const saved = await saveOwnerConsole(next);
    res.json({ ok: true, maintenance: saved.maintenance });
  } catch (error) {
    res.status(500).json({ error: 'Wartungsmodus konnte nicht gespeichert werden.' });
  }
});

app.post('/api/owner/notices', async (req, res) => {
  if (!requireOwner(req, res)) return;
  const input = req.body && typeof req.body === 'object' ? req.body : {};
  const title = String(input.title || '').trim().slice(0, 120);
  const message = String(input.message || '').trim().slice(0, 1200);
  const audience = input.audience === 'user' ? 'user' : 'all';
  const targetUsername = String(input.targetUsername || '').trim().slice(0, 40);
  if (!title || !message) return res.status(400).json({ error: 'Titel und Nachricht sind Pflicht.' });
  if (audience === 'user' && !targetUsername) return res.status(400).json({ error: 'Bitte wähle einen Benutzernamen aus.' });

  try {
    if (audience === 'user') {
      const { data, error } = await supabaseAdmin.from('users').select('id').eq('username', targetUsername).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Dieser Benutzername existiert nicht.' });
    }
    const expiresAt = input.expiresAt && Number.isFinite(Date.parse(input.expiresAt))
      ? new Date(input.expiresAt).toISOString()
      : null;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return res.status(400).json({ error: 'Das Ablaufdatum muss in der Zukunft liegen.' });
    }
    const notice = normalizeOwnerNotice({
      id: crypto.randomUUID(),
      title,
      message,
      kind: input.kind === 'notification' ? 'notification' : 'announcement',
      audience,
      targetUsername,
      active: true,
      createdAt: new Date().toISOString(),
      expiresAt
    });
    const current = await getOwnerConsole({ force: true });
    const notices = [notice, ...current.notices].slice(0, 80);
    await saveOwnerConsole({ ...current, notices });
    res.status(201).json({ ok: true, notice });
  } catch (error) {
    res.status(500).json({ error: 'Mitteilung konnte nicht gesendet werden.' });
  }
});

app.post('/api/owner/notices/:id/toggle', async (req, res) => {
  if (!requireOwner(req, res)) return;
  const id = String(req.params.id || '').trim();
  try {
    const current = await getOwnerConsole({ force: true });
    const found = current.notices.find((notice) => notice.id === id);
    if (!found) return res.status(404).json({ error: 'Mitteilung nicht gefunden.' });
    const notices = current.notices.map((notice) => notice.id === id
      ? { ...notice, active: !notice.active }
      : notice);
    const saved = await saveOwnerConsole({ ...current, notices });
    res.json({ ok: true, notice: saved.notices.find((notice) => notice.id === id) });
  } catch {
    res.status(500).json({ error: 'Status konnte nicht geändert werden.' });
  }
});

app.delete('/api/owner/notices/:id', async (req, res) => {
  if (!requireOwner(req, res)) return;
  const id = String(req.params.id || '').trim();
  try {
    const current = await getOwnerConsole({ force: true });
    if (!current.notices.some((notice) => notice.id === id)) {
      return res.status(404).json({ error: 'Mitteilung nicht gefunden.' });
    }
    const saved = await saveOwnerConsole({ ...current, notices: current.notices.filter((notice) => notice.id !== id) });
    res.json({ ok: true, noticeCount: saved.notices.length });
  } catch {
    res.status(500).json({ error: 'Mitteilung konnte nicht gelöscht werden.' });
  }
});

app.get('/admin-portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-entry.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get(['/owner', '/owner/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

app.get('/chat.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.png'));
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
  if (!UNLOCK_CODE || unlockCode !== UNLOCK_CODE) return res.status(403).json({ error: 'Entsperrcode ist falsch.' });

  try {
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(8000)
    });
    const payload = await verifyRes.json();
    if (!verifyRes.ok || payload.aud !== googleClientId || !payload.email) {
      return res.status(401).json({ error: 'Google-Token ungültig' });
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

  if (!UNLOCK_CODE || normalizeUnlockCodeInput(unlockCode) !== UNLOCK_CODE) {
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

    // Falls password_hash Spalte nicht existiert →’ nochmal ohne versuchen
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

  if (!UNLOCK_CODE || normalizeUnlockCodeInput(unlockCode) !== UNLOCK_CODE) {
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
          // loginCode stimmt →’ durchlassen
        }
        // passwordOk →’ weiter
      } else if (loginCode && data.access_code === loginCode) {
        // Altes Konto ohne Passwort, aber Login-Code stimmt →’ OK
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

    try { await supabaseAdmin.from('users').update({ last_seen: new Date().toISOString() }).eq('id', data.id); } catch {}

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

// Öffentlicher Endpoint: Zugangscode abrufen
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
      const { data } = await supabaseAdmin
        .from('users')
        .select('id,username,banned_until,ban_reason')
        .eq('id', decoded.id)
        .single();
      userRow = data || null;
    } catch {}

    // last_seen aktualisieren (Fehler ignorieren)
    try { await supabaseAdmin.from('users').update({ last_seen: new Date().toISOString() }).eq('id', decoded.id); } catch {}
    const refreshedToken = jwt.sign(
      { id: decoded.id, username: decoded.username, isAdmin: Boolean(decoded.isAdmin) },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );
    const effectiveUsername = userRow?.username || decoded.username;
    const profile = await getProfile(effectiveUsername);
    if (accountDeletionIsDue(profile)) {
      await permanentlyDeleteAccount(effectiveUsername, userRow?.id || decoded.id);
      return res.status(410).json({ error: 'Dieses Konto wurde nach Ablauf der 72-Stunden-Frist endgültig gelöscht.' });
    }
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
    res.status(401).json({ error: 'Ungültiger Token' });
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
  try {
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
  } catch (error) {
    console.error('Load own profile failed:', error.message);
    res.status(500).json({ error: 'Kontodaten konnten nicht geladen werden' });
  }
});

// ─── Reale @ehoser.de-Postfächer (Resend) ───────────────────────────────────
// Mail content never goes through the browser's Supabase client. Every query is
// scoped to the username inside the verified ehoser login token.
app.get('/api/mailbox', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const mailbox = await getMailboxForUsername(auth.username);
    if (!mailbox) return res.json({ mailbox: mailboxSummary(null), messages: [], unreadCount: 0, sendingEnabled: Boolean(RESEND_API_KEY) });

    const [{ data: incoming, error: incomingError }, { data: outgoing, error: outgoingError }] = await Promise.all([
      supabaseAdmin.from('ehoser_mail_messages')
        .select('id,direction,sender_username,sender_address,recipient_address,subject,text_body,status,created_at,read_at')
        .eq('recipient_username', auth.username)
        .order('created_at', { ascending: false })
        .limit(100),
      supabaseAdmin.from('ehoser_mail_messages')
        .select('id,direction,sender_username,sender_address,recipient_address,subject,text_body,status,created_at,read_at')
        .eq('sender_username', auth.username)
        .order('created_at', { ascending: false })
        .limit(100)
    ]);
    if (incomingError) throw incomingError;
    if (outgoingError) throw outgoingError;
    const messages = [...(incoming || []), ...(outgoing || [])]
      .sort((a, b) => new Date(b.created_at).valueOf() - new Date(a.created_at).valueOf())
      .slice(0, 150);
    const unreadCount = (incoming || []).filter((message) => !message.read_at).length;
    res.json({ mailbox: mailboxSummary(mailbox), messages, unreadCount, sendingEnabled: Boolean(RESEND_API_KEY) });
  } catch (error) {
    console.error('Mailbox load failed:', error?.message || error);
    res.status(503).json({ error: 'Das Postfach ist noch nicht eingerichtet.' });
  }
});

app.post('/api/mailbox/claim', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const localPart = normalizeEhoserMailboxLocalPart(req.body?.localPart);
  if (!localPart) return res.status(400).json({ error: 'Wähle 3–32 Zeichen: Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich.' });

  try {
    const current = await getMailboxForUsername(auth.username);
    if (current) return res.json({ mailbox: mailboxSummary(current), alreadyConfigured: true });
    const address = mailboxAddressForLocalPart(localPart);
    const { data: used, error: usedError } = await supabaseAdmin
      .from('ehoser_mailboxes')
      .select('username')
      .eq('address', address)
      .maybeSingle();
    if (usedError) throw usedError;
    if (used) return res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits vergeben.' });

    const { data: mailbox, error } = await supabaseAdmin
      .from('ehoser_mailboxes')
      .insert({ username: auth.username, address })
      .select('username,address,created_at')
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits vergeben.' });
      throw error;
    }
    res.status(201).json({ mailbox: mailboxSummary(mailbox) });
  } catch (error) {
    console.error('Mailbox claim failed:', error?.message || error);
    res.status(503).json({ error: 'Die E-Mail-Adresse konnte noch nicht angelegt werden.' });
  }
});

app.post('/api/mailbox/messages/:id/read', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Nachricht.' });
  try {
    const { error } = await supabaseAdmin
      .from('ehoser_mail_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('recipient_username', auth.username)
      .is('read_at', null);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Nachricht konnte nicht als gelesen markiert werden.' });
  }
});

app.post('/api/mailbox/messages', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'Der E-Mail-Versand ist noch nicht mit Resend konfiguriert.' });

  const recipientAddress = normalizeEmailAddress(req.body?.to);
  const subject = String(req.body?.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  const textBody = String(req.body?.text || '').replace(/\u0000/g, '').trim().slice(0, 200000);
  if (!recipientAddress) return res.status(400).json({ error: 'Bitte gib eine gültige Empfängeradresse ein.' });
  if (!subject) return res.status(400).json({ error: 'Bitte gib einen Betreff ein.' });
  if (!textBody) return res.status(400).json({ error: 'Bitte schreibe eine Nachricht.' });

  try {
    const mailbox = await getMailboxForUsername(auth.username);
    if (!mailbox) return res.status(409).json({ error: 'Richte zuerst dein @ehoser.de-Postfach ein.' });
    const displayName = String(auth.username || 'ehoser').replace(/[\r\n"<>]/g, '').slice(0, 48) || 'ehoser';
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'ehoser-mail/1.0',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({
        from: `${displayName} via ehoser <${mailbox.address}>`,
        to: [recipientAddress],
        reply_to: mailbox.address,
        subject,
        text: textBody
      })
    });
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) {
      const message = result?.message || result?.name || result?.error || 'Resend konnte die E-Mail nicht senden.';
      return res.status(response.status >= 400 && response.status < 500 ? 400 : 502).json({ error: message });
    }

    const providerMessageId = String(result?.id || result?.data?.id || '').trim() || null;
    const { data: message, error } = await supabaseAdmin
      .from('ehoser_mail_messages')
      .insert({
        provider_message_id: providerMessageId,
        direction: 'outbound',
        sender_username: auth.username,
        sender_address: mailbox.address,
        // Incoming mail is created by the signed Resend webhook. Keeping this
        // null prevents a sent message from appearing in somebody else's inbox
        // before that verified inbound event arrives.
        recipient_username: null,
        recipient_address: recipientAddress,
        subject,
        text_body: textBody,
        status: 'sent',
        read_at: new Date().toISOString()
      })
      .select('id,direction,sender_username,sender_address,recipient_address,subject,text_body,status,created_at,read_at')
      .single();
    if (error) throw error;
    res.status(201).json({ message });
  } catch (error) {
    console.error('Mailbox send failed:', error?.message || error);
    res.status(500).json({ error: 'Die E-Mail wurde nicht gespeichert. Bitte prüfe dein Postfach, bevor du es erneut versuchst.' });
  }
});

// Einstellungen speichern
app.put('/api/me/settings', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const current = await getProfile(auth.username);
    const canManagePresenceOverride = String(auth.username || '').trim().toLowerCase() === ADMIN_PRESENCE_USERNAME;
    const settings = normalizeSettings({
      ...(current.settings || {}),
      ...(req.body || {}),
      // This setting is deliberately server-authorized. No other account can
      // set a persistent online/offline override by sending a crafted request.
      presenceOverride: canManagePresenceOverride
        ? req.body?.presenceOverride
        : current.settings?.presenceOverride,
      personalization: current.settings?.personalization,
      moderation: current.settings?.moderation,
      credits: current.settings?.credits,
      planRequests: current.settings?.planRequests,
      oasisUsage: current.settings?.oasisUsage,
      passwordHash: current.settings?.passwordHash,
      _emailPending: current.settings?._emailPending,
      // Eigentümer-Einstellungen werden ausschließlich über /api/owner/*
      // geschrieben und dürfen durch normale Profileinstellungen nicht
      // überschrieben oder versehentlich entfernt werden.
      ownerConsole: current.settings?.ownerConsole,
      googleSub: current.settings?.googleSub,
      googleEmail: current.settings?.googleEmail,
      chatLockCodeHash: current.settings?.chatLockCodeHash,
      chatLockCodeSetAt: current.settings?.chatLockCodeSetAt,
      accountDeletion: current.settings?.accountDeletion
    });
    const profile = await upsertProfile(auth.username, { settings });
    res.json({ ok: true, profile });
  } catch (error) {
    console.error('Save own settings failed:', error.message);
    res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' });
  }
});

// ─── Accountweiter Chat-Sperrcode ───────────────────────────────────────────
app.get('/api/chat/lock-status', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const profile = await getProfile(auth.username);
  res.json({ configured: Boolean(profile.settings?.chatLockCodeHash), setAt: profile.settings?.chatLockCodeSetAt || null });
});

app.put('/api/chat/lock-code', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Der Chat-Code muss genau vier Ziffern haben.' });
  try {
    const current = await getProfile(auth.username);
    const settings = {
      ...(current.settings || {}),
      chatLockCodeHash: await bcrypt.hash(code, 12),
      chatLockCodeSetAt: new Date().toISOString()
    };
    await upsertProfile(auth.username, { settings });
    res.json({ ok: true, configured: true });
  } catch {
    res.status(500).json({ error: 'Chat-Code konnte nicht gespeichert werden.' });
  }
});

app.post('/api/chat/lock/unlock', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const code = String(req.body?.code || '').replace(/\D/g, '');
  const profile = await getProfile(auth.username);
  const hash = profile.settings?.chatLockCodeHash;
  if (!hash) return res.json({ ok: true, configured: false });
  const valid = /^\d{4}$/.test(code) && await bcrypt.compare(code, hash).catch(() => false);
  if (!valid) return res.status(401).json({ error: 'Der Chat-Code ist nicht korrekt.' });
  res.json({ ok: true, configured: true });
});

// ─── Konto-Löschung mit 72-Stunden-Wiederherstellung ────────────────────────
app.post('/api/me/delete-request', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  if (String(req.body?.confirmation || '').trim().toUpperCase() !== ACCOUNT_DELETION_CONFIRMATION) {
    return res.status(400).json({ error: 'Bestätige die Löschung mit „KONTO LÖSCHEN“.' });
  }
  try {
    const current = await getProfile(auth.username);
    const requestedAt = new Date();
    const settings = { ...(current.settings || {}), accountDeletion: {
      requestedAt: requestedAt.toISOString(),
      deleteAfter: new Date(requestedAt.valueOf() + ACCOUNT_DELETION_GRACE_MS).toISOString()
    } };
    const profile = await upsertProfile(auth.username, { settings });
    res.json({ ok: true, profile, deleteAfter: profile.settings.accountDeletion.deleteAfter });
  } catch {
    res.status(500).json({ error: 'Die Konto-Löschung konnte nicht vorgemerkt werden.' });
  }
});

app.post('/api/me/delete-cancel', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const current = await getProfile(auth.username);
    const settings = { ...(current.settings || {}) };
    delete settings.accountDeletion;
    const profile = await upsertProfile(auth.username, { settings });
    res.json({ ok: true, profile });
  } catch {
    res.status(500).json({ error: 'Die Konto-Wiederherstellung konnte nicht gespeichert werden.' });
  }
});

app.get('/api/internal/account-deletion-cleanup', async (req, res) => {
  const authorization = String(req.headers.authorization || '');
  if (!CRON_SECRET || authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Nicht autorisiert' });
  try {
    const deleted = await purgeExpiredAccountDeletions();
    res.json({ ok: true, deleted });
  } catch {
    res.status(500).json({ error: 'Bereinigung fehlgeschlagen' });
  }
});

app.get('/api/oasis/usage', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const usage = await getOasisUsageForUser(auth.username);
    res.json({ usage });
  } catch (err) {
    res.status(500).json({ error: 'Oasis-Verbrauch konnte nicht geladen werden' });
  }
});

app.post('/api/oasis/session', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const prompt = String(req.body?.prompt || '').trim().slice(0, 600);
  if (prompt.length < 3) {
    return res.status(400).json({ error: 'Bitte beschreibe kurz, wo du landen willst.' });
  }
  if (!process.env.DECART_API_KEY) {
    return res.status(503).json({ error: 'DECART_API_KEY ist auf dem Server nicht konfiguriert.' });
  }

  try {
    const existing = findActiveOasisSession(auth.username);
    if (existing) await endOasisSession(existing, 'replaced');

    const usage = await getOasisUsageForUser(auth.username);
    if (usage.remainingMs <= 0) {
      return res.status(429).json({ error: 'Deine Oasis-Minute fuer heute ist aufgebraucht.', usage });
    }

    const session = {
      id: crypto.randomUUID(),
      username: auth.username,
      userId: auth.id,
      prompt,
      usedMs: usage.usedMs,
      createdAt: Date.now(),
      lastBilledAt: null,
      lastPersistedAt: Date.now(),
      billingStarted: false,
      billingTimer: null,
      clientCloseTimer: null,
      clients: new Set(),
      closed: false,
      child: null,
      lastStderr: ''
    };
    oasisSessions.set(session.id, session);
    attachOasisBridge(session, prompt);

    res.json({
      ok: true,
      sessionId: session.id,
      usage,
      dailyLimitMs: OASIS_DAILY_LIMIT_MS
    });
  } catch (err) {
    console.error('Oasis Session Error:', err);
    res.status(500).json({ error: 'Oasis-Session konnte nicht gestartet werden' });
  }
});

app.get('/api/oasis/session/:id/stream', (req, res) => {
  const token = String(req.query.token || '');
  let auth = null;
  try {
    auth = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Ungueltiger Token' });
  }

  const session = oasisSessions.get(req.params.id);
  if (!session || session.closed || session.username !== auth.username) {
    return res.status(404).json({ error: 'Oasis-Session nicht gefunden' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  session.clients.add(res);
  if (session.clientCloseTimer) {
    clearTimeout(session.clientCloseTimer);
    session.clientCloseTimer = null;
  }

  sendOasisEvent(res, 'status', {
    state: 'connecting',
    message: 'Oasis wird verbunden...',
    remainingMs: Math.max(0, OASIS_DAILY_LIMIT_MS - session.usedMs)
  });

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    session.clients.delete(res);
    if (!session.closed && session.clients.size === 0) {
      session.clientCloseTimer = setTimeout(() => {
        if (!session.closed && session.clients.size === 0) {
          endOasisSession(session, 'viewer-disconnected').catch(() => {});
        }
      }, 5000);
    }
  });
});

app.post('/api/oasis/session/:id/action', (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const session = oasisSessions.get(req.params.id);
  if (!session || session.closed || session.username !== auth.username) {
    return res.status(404).json({ error: 'Oasis-Session nicht gefunden' });
  }

  const clamp = (value) => Math.max(-1, Math.min(1, Number(value) || 0));
  const throttle = clamp(req.body?.throttle);
  const steering = clamp(req.body?.steering);
  const remainingMs = chargeOasisSession(session);
  if (session.closed || remainingMs <= 0) {
    return res.status(429).json({ error: 'Deine Oasis-Minute fuer heute ist aufgebraucht.' });
  }

  try {
    session.child?.stdin?.write(JSON.stringify({ type: 'control', throttle, steering }) + '\n');
    res.json({ ok: true, remainingMs });
  } catch {
    res.status(502).json({ error: 'Oasis Bridge nimmt gerade keine Steuerung an.' });
  }
});

app.delete('/api/oasis/session/:id', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const session = oasisSessions.get(req.params.id);
  if (!session || session.username !== auth.username) {
    return res.json({ ok: true });
  }
  await endOasisSession(session, 'user-disconnect');
  res.json({ ok: true, usage: await getOasisUsageForUser(auth.username) });
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
      heroLine: query ? `Ich passe ehoser an, damit du "${query.slice(0, 40)}" schneller findest.` : 'Ich mache ehoser gerade einfacher für dich.',
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
    await supabaseAdmin.from('chat_messages').delete().eq('sender', chatMemberStateSender(auth.username, 'receipt'));
    await supabaseAdmin.from('chat_messages').delete().eq('sender', chatMemberStateSender(auth.username, 'typing'));
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

  const PIXABAY_KEY = process.env.PIXABAY_KEY || '';
  if (!PIXABAY_KEY) return res.status(503).json({ error: 'Bildersuche ist nicht eingerichtet.' });
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

// Pixabay Bild-Proxy (für Canvas – CORS-freies Laden)
app.get('/api/pixabay/image', async (req, res) => {
  const url = String(req.query.url || '').trim();
  const isAllowed = url.startsWith('https://cdn.pixabay.com/') || url.startsWith('https://pixabay.com/');
  if (!url || !isAllowed) {
    return res.status(400).json({ error: 'Ungültige Bild-URL' });
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

// Pro-Status für mehrere Nutzer
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

// Online-Nutzer (letzte 75 Sekunden)
app.get('/api/online-users', async (req, res) => {
  const authUser = optionalAuth(req);

  const since = new Date(Date.now() - CHAT_PRESENCE_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('username,last_seen')
    .gte('last_seen', since)
    .order('last_seen', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  pruneGuestPresence();
  const guestCount = guestPresence.size;

  const visibleRows = [...(data || [])];
  let ownerPresenceMode = 'automatic';
  // The ehoser owner may choose a visible status independently from the last
  // heartbeat. It is read from the profile rather than changing last_seen.
  try {
    const { data: ownerProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('settings')
      .eq('username', ADMIN_PRESENCE_USERNAME)
      .maybeSingle();
    const mode = getPresenceOverride(ADMIN_PRESENCE_USERNAME, normalizeSettings(ownerProfile?.settings || {}));
    ownerPresenceMode = mode;
    const ownerIndex = visibleRows.findIndex((row) => String(row?.username || '').toLowerCase() === ADMIN_PRESENCE_USERNAME);
    if (mode === 'force_offline' && ownerIndex >= 0) {
      visibleRows.splice(ownerIndex, 1);
    } else if (mode === 'force_online') {
      if (ownerIndex >= 0) {
        visibleRows[ownerIndex] = { ...visibleRows[ownerIndex], last_seen: new Date().toISOString() };
      } else {
        const { data: owner } = await supabaseAdmin
          .from('users')
          .select('username,last_seen')
          .eq('username', ADMIN_PRESENCE_USERNAME)
          .maybeSingle();
        if (owner?.username) visibleRows.unshift({ ...owner, last_seen: new Date().toISOString() });
      }
    }
  } catch {}

  // A signed-in chat session is active right now, even when the database read
  // races the heartbeat update by a few milliseconds. Include that account in
  // the same response so the F8 list can never claim that nobody is online
  // while the current person is using the chat. The owner's explicit
  // "always offline" setting still wins.
  if (authUser?.username) {
    const ownName = String(authUser.username).trim();
    const ownKey = ownName.toLowerCase();
    const ownerForcedOffline = ownKey === ADMIN_PRESENCE_USERNAME && ownerPresenceMode === 'force_offline';
    if (!ownerForcedOffline) {
      const ownIndex = visibleRows.findIndex((row) => String(row?.username || '').trim().toLowerCase() === ownKey);
      if (ownIndex >= 0) {
        visibleRows[ownIndex] = { ...visibleRows[ownIndex], last_seen: new Date().toISOString() };
      } else {
        try {
          const { data: own } = await supabaseAdmin
            .from('users')
            .select('username,last_seen')
            .eq('username', ownName)
            .maybeSingle();
          if (own?.username) visibleRows.unshift({ ...own, last_seen: new Date().toISOString() });
        } catch {}
      }
    }
  }

  const users = [];
  if (authUser) {
    for (const row of visibleRows) {
      users.push({ username: row.username, kind: 'user', last_seen: row.last_seen || null });
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
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Ungültiger Token' });
  }

  const seenAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ last_seen: seenAt })
    .eq('id', decoded.id)
    .select('username,last_seen')
    .maybeSingle();

  if (error) {
    console.error('Heartbeat update failed:', error.message);
    return res.status(500).json({ error: 'Online-Status konnte nicht aktualisiert werden' });
  }
  if (!data) return res.status(404).json({ error: 'Nutzerkonto nicht gefunden' });
  res.json({ ok: true, username: data.username, last_seen: data.last_seen || seenAt });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }
  res.json({ ok: true });
});

// Admin: registrierte Nutzer anzeigen (nur Benutzername + Zeit)
app.get('/api/admin/users', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  try {
    const { data, error } = await supabaseAdmin
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
        update_unlocked: up?.update_unlocked === true,
        ps_account: up?.ps_account === true
      });
    }
    res.json(users);
  } catch (error) {
    console.error('Admin Users Error:', error);
    res.setHeader('x-admin-offline', '1');
    res.status(500).json({ error: 'Registrierte Nutzer konnten nicht geladen werden' });
  }
});

// Admin: Neuen Notfall-Login-Code erstellen. Der bisherige Code wird nie ausgelesen.
app.post('/api/admin/users/:id/reset-login-code', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Ungültige Nutzer-ID' });
  }

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id,username')
      .eq('id', userId)
      .maybeSingle();
    if (userError) throw userError;
    if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    // A new code is returned once to the authorised admin; existing codes are never exposed.
    const loginCode = 'EHO-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ access_code: loginCode })
      .eq('id', user.id);
    if (updateError) throw updateError;

    console.info('Admin reset login code for user:', user.username);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, username: user.username, loginCode });
  } catch (error) {
    console.error('Admin login-code reset error:', error);
    return res.status(500).json({ error: 'Login-Code konnte nicht zurückgesetzt werden' });
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

  try {
    await supabaseAdmin
      .from('plan_requests')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', id);
  } catch {
    request.status = 'confirmed';
    request.confirmed_at = new Date().toISOString();
  }
  try {
    const requestProfile = await getProfile(request.username);
    const settings = { ...(requestProfile.settings || {}) };
    settings.planRequests = (settings.planRequests || []).map((r) => Number(r.id) === id
      ? { ...r, status: 'confirmed', confirmed_at: new Date().toISOString() }
      : r);
    await upsertProfile(request.username, { settings });
  } catch {}
  res.json({ ok: true, username: request.username, plan: request.plan });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = Boolean(req.body?.enabled);
  const days = Math.max(1, Math.min(30, Number(req.body?.days) || 2));

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Ungültige Nutzer-ID' });
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
    return res.status(500).json({ error: 'Pro-Status konnte nicht geändert werden' });
  }
});

// Admin: Premium aktivieren/deaktivieren
app.post('/api/admin/users/:id/premium', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = Boolean(req.body?.enabled);
  const days = Math.max(1, Math.min(365, Number(req.body?.days) || 30));

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Ungültige Nutzer-ID' });
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
    return res.status(500).json({ error: 'Premium-Status konnte nicht geändert werden' });
  }
});

// Admin: Update für bestimmten User freischalten/sperren
app.post('/api/admin/users/:id/unlock-update', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = req.body?.enabled !== false; // default true

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Ungültige Nutzer-ID' });
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

// Admin: PS-Account für bestimmten User setzen/entfernen
app.post('/api/admin/users/:id/ps-account', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const userId = Number(req.params.id);
  const enabled = req.body?.enabled !== false;

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Ungültige Nutzer-ID' });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Ungültige Anfrage-ID' });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Ungültige Anfrage-ID' });
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

app.post('/api/admin/chats/reset-all', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  try {
    const deleteTasks = [
      supabaseAdmin.from('chat_messages').delete().neq('id', 0),
      supabaseAdmin.from('chat_group_members').delete().neq('group_id', ''),
      supabaseAdmin.from('chat_group_admins').delete().neq('group_id', ''),
      supabaseAdmin.from('chat_group_meta').delete().neq('group_id', ''),
      supabaseAdmin.from('chat_reports').delete().neq('id', 0),
      supabaseAdmin.from('chat_groups').delete().neq('id', '')
    ];

    const results = await Promise.allSettled(deleteTasks);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) {
      console.error('Admin reset all chats failed:', rejected.reason);
      return res.status(500).json({ error: 'Alle Chats konnten nicht gelöscht werden.' });
    }

    const failed = results.find((result) => result.status === 'fulfilled' && result.value?.error);
    if (failed) {
      const err = failed.value.error;
      console.error('Admin reset all chats failed with DB error:', err);
      return res.status(500).json({ error: 'Alle Chats konnten nicht gelöscht werden: ' + (err.message || 'Datenbankfehler') });
    }

    chatGroupMetaMemory.clear();
    chatGroupAdminsMemory.clear();
    return res.json({ ok: true, deleted: true });
  } catch (error) {
    console.error('Admin reset all chats error:', error);
    return res.status(500).json({ error: 'Alle Chats konnten nicht gelöscht werden.' });
  }
});

// Admin: Chat-Meldungen abrufen
app.get('/api/admin/chat-reports', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
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
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }
  const reportId = Number(req.params.id);
  if (!Number.isInteger(reportId) || reportId <= 0) return res.status(400).json({ error: 'Ungültige Report-ID' });

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
      return res.status(400).json({ error: 'Ungültiger Aktionstyp' });
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
    res.status(500).json({ error: 'Nutzer konnte nicht gelöscht werden' });
  }
});

// App löschen
app.delete('/api/admin/apps/:id', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const appId = Number(req.params.id);
  if (!Number.isInteger(appId) || appId <= 0) {
    return res.status(400).json({ error: 'Ungültige App-ID' });
  }

  try {
    await supabase.from('installations').delete().eq('app_id', appId);
    const { error } = await supabase.from('apps').delete().eq('id', appId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Admin Delete App Error:', error);
    res.status(500).json({ error: 'App konnte nicht gelöscht werden' });
  }
});

// Neue App speichern (nur Metadaten, Dateien wurden direkt zu Supabase hochgeladen)
app.post('/api/admin/apps', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const { name, description, category, version, sourceUrl, iconUrl, downloadUrl } = req.body;

  if (!name || !description || !category || !version) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
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

// ─── Screen Share Signaling ───────────────────────────────────────────────────

// POST /api/admin/screenshare/request  { username, offer }
app.post('/api/admin/screenshare/request', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });

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

// GET /api/screenshare/pending  — Nutzer fragt ob Anfrage vorliegt
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
    return res.status(401).json({ error: 'Ungültiges Token' });
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

// GET /api/admin/screenshare/session/:sessionId  — Admin fragt Status ab
app.get('/api/admin/screenshare/session/:sessionId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });

  await ensureScreenSessionsTableExists();

  const { data } = await supabaseAdmin
    .from('screen_sessions').select('status, answer').eq('id', req.params.sessionId).single();
  if (!data) return res.status(404).json({ error: 'Session nicht gefunden' });
  res.json({ status: data.status, answer: data.answer ? JSON.parse(data.answer) : null });
});

// POST /api/admin/screenshare/end/:sessionId  — Admin beendet Session
app.post('/api/admin/screenshare/end/:sessionId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureScreenSessionsTableExists();
  await supabaseAdmin.from('screen_sessions').update({ status: 'ended' }).eq('id', req.params.sessionId);
  res.json({ ok: true });
});

// POST /api/screenshare/end  — Nutzer beendet Session
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

// ─── Chat API ────────────────────────────────────────────────────────────────

// Multer – memory storage für Supabase-Upload
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
  catch { res.status(401).json({ error: 'Ungültiger Token' }); return null; }
}

function validRtcDescription(value, type) {
  return Boolean(value && typeof value === 'object'
    && value.type === type
    && typeof value.sdp === 'string'
    && value.sdp.length > 0
    && value.sdp.length <= 100000);
}

function payloadWithinLimit(value, max = 16000) {
  try { return JSON.stringify(value).length <= max; }
  catch { return false; }
}

// Call signalling uses the already existing chat_messages table. This keeps
// calls working on deployments where no direct Postgres URL is available for
// creating extra signalling tables.
const CHAT_CALL_EVENT_SENDER = '__ehoser_call_event__';
const CHAT_CALL_EVENT_PREFIX = 'ehoser-call-v1:';
const GROUP_CALL_EVENT_SENDER = '__ehoser_group_call_event__';
const GROUP_CALL_EVENT_PREFIX = 'ehoser-group-call-v1:';
const CHAT_MEMBER_STATE_SENDER_PREFIX = 'ehoser-chat-state:';
const CHAT_RECEIPT_CONTENT_PREFIX = 'ehoser-chat-receipt-v1:';
const CHAT_TYPING_CONTENT_PREFIX = 'ehoser-chat-typing-v1:';

function chatMemberStateSender(username, kind = 'receipt') {
  return CHAT_MEMBER_STATE_SENDER_PREFIX + kind + ':' + String(username || '').slice(0, 64);
}

function parseChatMemberState(row) {
  const raw = String(row?.encrypted_content || '');
  const sender = String(row?.sender || '');
  if (!sender.startsWith(CHAT_MEMBER_STATE_SENDER_PREFIX)) return null;
  const rest = sender.slice(CHAT_MEMBER_STATE_SENDER_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator < 1) return null;
  const kind = rest.slice(0, separator);
  const username = rest.slice(separator + 1);
  try {
    if (kind === 'receipt' && raw.startsWith(CHAT_RECEIPT_CONTENT_PREFIX)) {
      const state = JSON.parse(raw.slice(CHAT_RECEIPT_CONTENT_PREFIX.length));
      return {
        kind,
        username,
        deliveredMessageId: Math.max(0, Number.parseInt(state.deliveredMessageId, 10) || 0),
        readMessageId: Math.max(0, Number.parseInt(state.readMessageId, 10) || 0)
      };
    }
    if (kind === 'typing' && raw.startsWith(CHAT_TYPING_CONTENT_PREFIX)) {
      const state = JSON.parse(raw.slice(CHAT_TYPING_CONTENT_PREFIX.length));
      return { kind, username, typingUntil: state.typingUntil ? String(state.typingUntil) : null };
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeEmailAddress(value) {
  const source = typeof value === 'object' && value
    ? (value.email || value.address || value.value || '')
    : String(value || '');
  const bracketed = String(source).match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const candidate = (bracketed?.[1] || String(source).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '')
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate.slice(0, 320) : '';
}

function normalizeEhoserMailboxLocalPart(value) {
  const local = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(local)) return null;
  return local;
}

function mailboxAddressForLocalPart(localPart) {
  return `${localPart}@${EHOSER_MAIL_DOMAIN}`;
}

function mailboxSummary(mailbox) {
  if (!mailbox) return { configured: false, address: null };
  return { configured: true, address: mailbox.address, createdAt: mailbox.created_at };
}

async function getMailboxForUsername(username) {
  const { data, error } = await supabaseAdmin
    .from('ehoser_mailboxes')
    .select('username,address,created_at')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function resendWebhookSignatureIsValid(headers, rawPayload) {
  if (!RESEND_WEBHOOK_SECRET) return false;
  const id = String(headers['svix-id'] || '').trim();
  const timestamp = String(headers['svix-timestamp'] || '').trim();
  const signature = String(headers['svix-signature'] || '').trim();
  const timestampSeconds = Number(timestamp);
  if (!id || !signature || !Number.isFinite(timestampSeconds) || Math.abs(Date.now() - timestampSeconds * 1000) > 5 * 60 * 1000) {
    return false;
  }

  let key;
  try {
    key = Buffer.from(RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  } catch {
    return false;
  }
  if (!key.length) return false;

  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawPayload}`)
    .digest('base64');
  return signature.split(/\s+/).some((entry) => {
    const match = entry.match(/^v1,(.+)$/);
    if (!match) return false;
    const actual = Buffer.from(match[1]);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  });
}

function collectEmailAddresses(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalizeEmailAddress).filter(Boolean))];
}

async function fetchReceivedResendEmail(emailId) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY ist nicht konfiguriert.');
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, Accept: 'application/json' }
  });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Resend-Abruf fehlgeschlagen (HTTP ${response.status})`);
  return payload?.data || payload;
}

async function storeResendInboundEmail(event) {
  const eventData = event?.data || {};
  const providerMessageId = String(eventData.email_id || eventData.id || '').trim();
  if (!providerMessageId) throw new Error('Resend-WebHook enthält keine E-Mail-ID.');

  // The webhook metadata is enough to route the message. This avoids fetching
  // full mail content for an address that is not an ehoser mailbox.
  const initialRecipients = collectEmailAddresses(eventData.to || eventData.received_for);
  if (!initialRecipients.length) return { ignored: true };
  const { data: recipientMailboxes, error: recipientError } = await supabaseAdmin
    .from('ehoser_mailboxes')
    .select('username,address')
    .in('address', initialRecipients);
  if (recipientError) throw recipientError;
  if (!recipientMailboxes?.length) return { ignored: true };

  const fullEmail = await fetchReceivedResendEmail(providerMessageId);
  const recipients = collectEmailAddresses(fullEmail.to || eventData.to || eventData.received_for);
  const recipient = recipientMailboxes.find((mailbox) => recipients.includes(String(mailbox.address).toLowerCase())) || recipientMailboxes[0];
  const senderAddress = normalizeEmailAddress(fullEmail.from || eventData.from) || 'unbekannt@absender.invalid';
  const { data: senderMailbox } = await supabaseAdmin
    .from('ehoser_mailboxes')
    .select('username')
    .eq('address', senderAddress)
    .maybeSingle();

  const subject = String(fullEmail.subject || eventData.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  const textBody = String(fullEmail.text || '').replace(/\u0000/g, '').slice(0, 200000);
  const { error } = await supabaseAdmin.from('ehoser_mail_messages').insert({
    provider_message_id: providerMessageId,
    direction: 'inbound',
    sender_username: senderMailbox?.username || null,
    sender_address: senderAddress,
    recipient_username: recipient.username,
    recipient_address: recipient.address,
    subject,
    text_body: textBody || 'Diese E-Mail enthält keinen lesbaren Textinhalt.',
    status: 'received'
  });
  // Resend can replay a webhook. The unique provider ID makes this idempotent.
  if (error && error.code !== '23505') throw error;
  return { ignored: false };
}

async function updateResendDeliveryStatus(event) {
  const eventData = event?.data || {};
  const providerMessageId = String(eventData.email_id || eventData.id || '').trim();
  if (!providerMessageId) return;
  const statusByEvent = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.failed': 'failed',
    'email.bounced': 'bounced'
  };
  const status = statusByEvent[event?.type];
  if (!status) return;
  const { error } = await supabaseAdmin
    .from('ehoser_mail_messages')
    .update({ status })
    .eq('provider_message_id', providerMessageId)
    .eq('direction', 'outbound');
  if (error) throw error;
}

async function getStoredChatMemberState(groupId, username, kind) {
  const sender = chatMemberStateSender(username, kind);
  const { data: rows, error: selectError } = await supabaseAdmin
    .from('chat_messages')
    .select('id,sender,encrypted_content')
    .eq('group_id', groupId)
    .eq('sender', sender)
    .order('id', { ascending: false })
    .limit(1);
  if (selectError) throw selectError;
  return { sender, row: rows?.[0] || null, state: parseChatMemberState(rows?.[0]) };
}

async function saveChatReceiptState(groupId, username, patch = {}) {
  const { sender, row, state } = await getStoredChatMemberState(groupId, username, 'receipt');
  const previous = state || {
    deliveredMessageId: 0,
    readMessageId: 0
  };
  const deliveredMessageId = Math.max(previous.deliveredMessageId, Number(patch.deliveredMessageId) || 0);
  const readMessageId = Math.max(previous.readMessageId, Number(patch.readMessageId) || 0);
  const encrypted_content = CHAT_RECEIPT_CONTENT_PREFIX + JSON.stringify({
    deliveredMessageId,
    readMessageId
  });
  const result = row
    ? await supabaseAdmin.from('chat_messages').update({ encrypted_content }).eq('id', row.id)
    : await supabaseAdmin.from('chat_messages').insert({ group_id: groupId, sender, encrypted_content });
  if (result.error) throw result.error;
  return { username, deliveredMessageId, readMessageId };
}

async function saveChatTypingState(groupId, username, typingUntil) {
  const { sender, row } = await getStoredChatMemberState(groupId, username, 'typing');
  const encrypted_content = CHAT_TYPING_CONTENT_PREFIX + JSON.stringify({ typingUntil: typingUntil || null });
  const result = row
    ? await supabaseAdmin.from('chat_messages').update({ encrypted_content }).eq('id', row.id)
    : await supabaseAdmin.from('chat_messages').insert({ group_id: groupId, sender, encrypted_content });
  if (result.error) throw result.error;
  return { username, typingUntil: typingUntil || null };
}

async function getChatGroupActivity(groupId, viewerUsername) {
  const [{ data: members, error: membersError }, { data: rows, error: stateError }] = await Promise.all([
    supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId),
    supabaseAdmin.from('chat_messages')
      .select('id,sender,encrypted_content')
      .eq('group_id', groupId)
      .like('sender', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
      .order('id', { ascending: true })
  ]);
  if (membersError) throw membersError;
  if (stateError) throw stateError;

  const receipts = new Map();
  const typings = new Map();
  for (const row of rows || []) {
    const state = parseChatMemberState(row);
    if (state?.kind === 'receipt') receipts.set(state.username, state);
    if (state?.kind === 'typing') typings.set(state.username, state);
  }
  const recipients = (members || []).map((member) => member.username).filter((name) => name !== viewerUsername);
  const deliveredUpTo = recipients.length
    ? Math.min(...recipients.map((name) => receipts.get(name)?.deliveredMessageId || 0))
    : 0;
  const readUpTo = recipients.length
    ? Math.min(...recipients.map((name) => receipts.get(name)?.readMessageId || 0))
    : 0;
  const now = Date.now();
  const typing = recipients.filter((name) => {
    const until = Date.parse(typings.get(name)?.typingUntil || '');
    return Number.isFinite(until) && until > now;
  });
  return { deliveredUpTo, readUpTo, typing };
}

function parseChatCallEvent(row) {
  const raw = String(row?.encrypted_content || '');
  if (!raw.startsWith(CHAT_CALL_EVENT_PREFIX)) return null;
  try {
    const event = JSON.parse(raw.slice(CHAT_CALL_EVENT_PREFIX.length));
    if (!event || typeof event !== 'object' || !/^[0-9a-f-]{36}$/i.test(String(event.callId || ''))) return null;
    return {
      ...event,
      event_id: Number(row.id) || 0,
      stored_at: row.created_at
    };
  } catch {
    return null;
  }
}

async function appendChatCallEvent(groupId, event) {
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      group_id: groupId,
      sender: CHAT_CALL_EVENT_SENDER,
      encrypted_content: CHAT_CALL_EVENT_PREFIX + JSON.stringify(event)
    })
    .select('id,created_at')
    .single();
  if (error) throw new Error('Anrufsignal konnte nicht gespeichert werden: ' + error.message);
  return { ...event, event_id: Number(data.id) || 0, stored_at: data.created_at };
}

async function listChatCallEvents({ groupId = null, callId = null, limit = 800 } = {}) {
  let query = supabaseAdmin
    .from('chat_messages')
    .select('id,group_id,encrypted_content,created_at')
    .eq('sender', CHAT_CALL_EVENT_SENDER);
  if (groupId) query = query.eq('group_id', groupId);
  if (callId && /^[0-9a-f-]{36}$/i.test(String(callId))) {
    query = query.like('encrypted_content', `%${callId}%`);
  }
  const { data, error } = await query
    .order('id', { ascending: false })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 800)));
  if (error) throw new Error('Anrufdaten konnten nicht geladen werden: ' + error.message);
  return (data || []).slice().reverse().map(parseChatCallEvent).filter(Boolean);
}

function rebuildChatCalls(events) {
  const calls = new Map();
  for (const event of events || []) {
    if (event.kind === 'start') {
      calls.set(event.callId, {
        id: event.callId,
        group_id: event.groupId,
        caller: event.caller,
        callee: event.callee,
        media_type: event.mediaType,
        status: 'ringing',
        offer: event.offer,
        answer: null,
        created_at: event.createdAt || event.stored_at,
        accepted_at: null,
        ended_at: null
      });
      continue;
    }
    const call = calls.get(event.callId);
    if (!call || event.kind !== 'state') continue;
    if (event.status) call.status = event.status;
    if (event.answer) call.answer = event.answer;
    if (event.status === 'accepted') call.accepted_at = event.at || event.stored_at;
    if (['rejected', 'missed', 'ended'].includes(event.status)) call.ended_at = event.at || event.stored_at;
  }
  return calls;
}

async function getMessageBackedCall(callId, username) {
  const events = await listChatCallEvents({ callId });
  const call = rebuildChatCalls(events).get(callId) || null;
  if (!call || (call.caller !== username && call.callee !== username)) return { call: null, events: [] };
  return { call, events };
}

function parseGroupCallEvent(row) {
  const raw = String(row?.encrypted_content || '');
  if (!raw.startsWith(GROUP_CALL_EVENT_PREFIX)) return null;
  try {
    const event = JSON.parse(raw.slice(GROUP_CALL_EVENT_PREFIX.length));
    if (!event || typeof event !== 'object' || !/^[0-9a-f-]{36}$/i.test(String(event.roomId || ''))) return null;
    return { ...event, event_id: Number(row.id) || 0, stored_at: row.created_at };
  } catch {
    return null;
  }
}

async function appendGroupCallEvent(groupId, event) {
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      group_id: groupId,
      sender: GROUP_CALL_EVENT_SENDER,
      encrypted_content: GROUP_CALL_EVENT_PREFIX + JSON.stringify(event)
    })
    .select('id,created_at')
    .single();
  if (error) throw new Error('Gruppenanruf konnte nicht gespeichert werden: ' + error.message);
  return { ...event, event_id: Number(data.id) || 0, stored_at: data.created_at };
}

async function listGroupCallEvents({ groupId = null, roomId = null, limit = 1000 } = {}) {
  let query = supabaseAdmin
    .from('chat_messages')
    .select('id,group_id,encrypted_content,created_at')
    .eq('sender', GROUP_CALL_EVENT_SENDER);
  if (groupId) query = query.eq('group_id', groupId);
  if (roomId && /^[0-9a-f-]{36}$/i.test(String(roomId))) query = query.like('encrypted_content', `%${roomId}%`);
  const { data, error } = await query.order('id', { ascending: false }).limit(Math.max(1, Math.min(1000, Number(limit) || 1000)));
  if (error) throw new Error('Gruppenanruf konnte nicht geladen werden: ' + error.message);
  return (data || []).slice().reverse().map(parseGroupCallEvent).filter(Boolean);
}

function rebuildGroupCallRooms(events) {
  const rooms = new Map();
  for (const event of events || []) {
    if (event.kind === 'start') {
      rooms.set(event.roomId, {
        id: event.roomId,
        group_id: event.groupId,
        host: event.host,
        participants: Array.isArray(event.participants) ? event.participants : [],
        status: 'active',
        created_at: event.createdAt || event.stored_at,
        latest_invite_at: event.createdAt || event.stored_at,
        joined: new Set([event.host]),
        left: new Set()
      });
      continue;
    }
    const room = rooms.get(event.roomId);
    if (!room) continue;
    if (event.kind === 'join') {
      room.joined.add(event.username);
      room.left.delete(event.username);
    } else if (event.kind === 'invite') {
      const username = String(event.username || '').trim();
      if (username && !room.participants.includes(username) && room.participants.length < 8) {
        room.participants.push(username);
      }
      room.latest_invite_at = event.at || event.stored_at || room.latest_invite_at;
      room.left.delete(username);
    } else if (event.kind === 'leave') {
      room.joined.delete(event.username);
      room.left.add(event.username);
    } else if (event.kind === 'end') {
      room.status = 'ended';
      room.ended_at = event.at || event.stored_at;
    }
  }
  return rooms;
}

function publicGroupCallRoom(room) {
  if (!room) return null;
  return {
    id: room.id,
    group_id: room.group_id,
    host: room.host,
    participants: room.participants,
    joined: [...room.joined],
    status: room.status,
    created_at: room.created_at,
    ended_at: room.ended_at || null
  };
}

async function getGroupCallRoom(roomId, username) {
  const events = await listGroupCallEvents({ roomId });
  const room = rebuildGroupCallRooms(events).get(roomId) || null;
  if (!room || !room.participants.includes(username)) return { room: null, events: [] };
  return { room, events };
}

function optionalAuth(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

async function insertChatGroupMembers(rows) {
  const plainRows = (rows || []).map(({ group_id, username }) => ({ group_id, username }));
  let result = await supabaseAdmin.from('chat_group_members').insert(
    plainRows.map((row) => ({ ...row, encrypted_group_key: '' }))
  );

  // Fresh schemas no longer need the legacy encryption column. PostgREST
  // rejects unknown fields before inserting anything, so retrying is safe.
  const message = String(result.error?.message || '').toLowerCase();
  const legacyColumnMissing = message.includes('encrypted_group_key')
    && (message.includes('schema cache') || message.includes('does not exist') || message.includes('could not find'));
  if (legacyColumnMissing) {
    result = await supabaseAdmin.from('chat_group_members').insert(plainRows);
  }
  return result;
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

function privateChatIdForUsers(firstUsername, secondUsername) {
  const pair = [String(firstUsername || ''), String(secondUsername || '')].sort().join(':');
  const hash = crypto.createHash('sha256').update('ehoser-private-chat-v1:' + pair).digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function findPrivateChatId(username, peerUsername) {
  const { data: memberships, error: membershipsError } = await supabaseAdmin
    .from('chat_group_members')
    .select('group_id')
    .eq('username', username);
  if (membershipsError) return { id: null, error: membershipsError };
  const ids = [...new Set((memberships || []).map((membership) => membership.group_id).filter(Boolean))];
  if (!ids.length) return { id: null, error: null };

  const [{ data: groups, error: groupsError }, { data: members, error: membersError }] = await Promise.all([
    supabaseAdmin.from('chat_groups').select('id,created_by').in('id', ids),
    supabaseAdmin.from('chat_group_members').select('group_id,username').in('group_id', ids)
  ]);
  if (groupsError || membersError) return { id: null, error: groupsError || membersError };

  const membersByGroup = new Map();
  for (const member of (members || [])) {
    if (!membersByGroup.has(member.group_id)) membersByGroup.set(member.group_id, new Set());
    membersByGroup.get(member.group_id).add(member.username);
  }
  for (const group of (groups || [])) {
    const names = membersByGroup.get(group.id) || new Set();
    if (names.size !== 2 || !names.has(username) || !names.has(peerUsername)) continue;
    const meta = await getGroupMeta(group.id, { type: 'private' });
    if ((meta.type || 'private') === 'private') return { id: group.id, error: null };
  }
  return { id: null, error: null };
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
    error: createErr?.message || mainErr?.message || 'Kein Upload-Bucket verfügbar'
  };
}

// POST /api/chat/upload — Mediendatei hochladen (Bild / Video / Audio)
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

// GET /api/chat/users/search?q= — Nutzer suchen (min. 2 Zeichen)
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

// GET /api/chat/contacts — alle registrierten Nutzer als direkte Chat-Kontakte
app.get('/api/chat/contacts', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('username,last_seen')
    .neq('username', user.username)
    .order('username', { ascending: true })
    .limit(1000);
  if (error) return res.status(500).json({ error: 'Kontakte konnten nicht geladen werden: ' + error.message });
  const sourceContacts = (data || []).filter((contact) => contact?.username);
  const usernames = sourceContacts.map((contact) => contact.username);
  const profilesByUsername = new Map();
  if (usernames.length) {
    try {
      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from('user_profiles')
        .select('username,settings')
        .in('username', usernames);
      if (!profilesError) {
        for (const profile of (profiles || [])) {
          const settings = normalizeSettings(profile?.settings || {});
          profilesByUsername.set(profile.username, {
            display_name: settings.displayName || '',
            avatar_url: settings.avatarUrl || '',
            presenceOverride: getPresenceOverride(profile.username, settings)
          });
        }
      }
    } catch {}
  }
  const contacts = sourceContacts.map((contact) => {
    const profile = profilesByUsername.get(contact.username) || { display_name: '', avatar_url: '', presenceOverride: 'automatic' };
    const { presenceOverride, ...profileDetails } = profile;
    return {
      username: contact.username,
      last_seen: applyPresenceOverride(contact.username, contact.last_seen, profile),
      ...profileDetails,
      presence_override: presenceOverride
    };
  });
  res.json({ contacts });
});

// POST /api/chat/private — vorhandenen direkten Chat öffnen oder genau einmal anlegen
app.post('/api/chat/private', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const peerUsername = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(peerUsername)) {
    return res.status(400).json({ error: 'Ungültiger Nutzername' });
  }
  if (peerUsername === user.username) return res.status(400).json({ error: 'Du kannst keinen Chat mit dir selbst öffnen' });

  const { data: peer, error: peerError } = await supabaseAdmin
    .from('users')
    .select('username')
    .eq('username', peerUsername)
    .maybeSingle();
  if (peerError) return res.status(500).json({ error: 'Kontakt konnte nicht geprüft werden: ' + peerError.message });
  if (!peer) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

  let existing = await findPrivateChatId(user.username, peer.username);
  if (existing.error) return res.status(500).json({ error: 'Privater Chat konnte nicht geprüft werden: ' + existing.error.message });
  if (existing.id) return res.json({ id: existing.id, name: peer.username, peer_username: peer.username, type: 'private', created: false });

  const id = privateChatIdForUsers(user.username, peer.username);
  const { error: groupError } = await supabaseAdmin
    .from('chat_groups')
    .insert({ id, name: peer.username, created_by: user.username });
  if (groupError && String(groupError.code || '') !== '23505') {
    return res.status(500).json({ error: 'Privater Chat konnte nicht erstellt werden: ' + groupError.message });
  }
  if (groupError) {
    existing = await findPrivateChatId(user.username, peer.username);
    if (existing.error) return res.status(500).json({ error: 'Privater Chat konnte nicht geöffnet werden: ' + existing.error.message });
    if (existing.id) return res.json({ id: existing.id, name: peer.username, peer_username: peer.username, type: 'private', created: false });
    return res.status(409).json({ error: 'Privater Chat wird gerade erstellt. Bitte erneut öffnen.' });
  }

  const { error: membersError } = await insertChatGroupMembers([
    { group_id: id, username: user.username },
    { group_id: id, username: peer.username }
  ]);
  if (membersError) {
    await supabaseAdmin.from('chat_groups').delete().eq('id', id);
    return res.status(500).json({ error: 'Mitglieder konnten nicht zum privaten Chat hinzugefügt werden: ' + membersError.message });
  }
  await ensureGroupAdmin(id, user.username);
  await setGroupMeta(id, { type: 'private', description: '', photoUrl: '' });
  res.json({ id, name: peer.username, peer_username: peer.username, type: 'private', created: true });
});

// POST /api/chat/groups — neue Gruppe erstellen
// Body: { name, members: string[], description?, photoUrl? }
app.post('/api/chat/groups', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const rawName = String(req.body?.name || '').trim();
  const incomingMembers = Array.isArray(req.body?.members) ? req.body.members : [];
  // Call rooms use the existing member + message tables for authentication and
  // WebRTC signalling. Mark them as internal so they never show up as chats.
  const callOnly = req.body?.purpose === 'group-call';

  const normalizedMembers = [...new Set(
    incomingMembers
      .map(v => String(v || '').trim())
      .filter(v => /^[a-zA-Z0-9_\-]{1,32}$/.test(v))
      .filter(v => v !== user.username)
  )];

  if (!normalizedMembers.length) {
    return res.status(400).json({ error: 'Mindestens ein weiterer Nutzer ist erforderlich' });
  }

  if (normalizedMembers.length < 2) {
    return res.status(400).json({ error: 'Eine Gruppe braucht mindestens zwei weitere Kontakte. Für einen einzelnen Kontakt nutze den direkten Chat.' });
  }

  const type = callOnly ? 'call' : 'group';
  const name = (rawName || `Gruppe (${normalizedMembers.length + 1})`).slice(0, 50);

  const id = crypto.randomUUID();
  const { error: gErr } = await supabaseAdmin.from('chat_groups').insert({ id, name, created_by: user.username });
  if (gErr) return res.status(500).json({ error: 'Fehler beim Erstellen der Gruppe: ' + gErr.message });

  const allMembers = [user.username, ...normalizedMembers];
  const rows = allMembers.map((username) => ({ group_id: id, username }));
  const { error: mErr } = await insertChatGroupMembers(rows);
  if (mErr) {
    await supabaseAdmin.from('chat_groups').delete().eq('id', id);
    return res.status(500).json({ error: 'Fehler beim Hinzufügen der Mitglieder: ' + mErr.message });
  }

  await ensureGroupAdmin(id, user.username);
  await setGroupMeta(id, {
    type,
    description: String(req.body?.description || '').slice(0, 300),
    photoUrl: String(req.body?.photoUrl || '').slice(0, 2048)
  });

  res.json({ id, name, type });
});

// GET /api/chat/groups — eigene Gruppen abrufen
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
    const type = meta.type || fallbackType;
    // A group-call room is only signalling infrastructure, not a conversation.
    // Older rooms have no metadata, but their generated title is unambiguous.
    if (type === 'call' || /^Gruppenanruf · \d{2}\.\d{2}\., \d{2}:\d{2}$/.test(String(group.name || ''))) continue;
    const peerUsername = type === 'private'
      ? groupMembers.find((username) => username !== user.username) || null
      : null;
    enriched.push({
      ...group,
      name: peerUsername || group.name,
      peer_username: peerUsername,
      type,
      description: meta.description || '',
      photo_url: meta.photoUrl || '',
      member_count: groupMembers.length,
      is_admin: admins.includes(user.username)
    });
  }

  res.json({ groups: enriched });
});

// GET /api/chat/groups/:id/members — Mitgliederliste abrufen
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

// ─── Ende-zu-Ende-Verschlüsselung ─────────────────────────────────────────────
// Private Schlüssel bleiben ausschließlich im Browser (IndexedDB). Der Server
// speichert hier nur öffentliche Schlüssel und für Mitglieder verpackte Gruppenschlüssel.
app.post('/api/chat/e2ee/public-key', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const publicKey = req.body?.publicKey;
  if (!publicKey || typeof publicKey !== 'object' || publicKey.kty !== 'RSA' || !publicKey.n || !publicKey.e) {
    return res.status(400).json({ error: 'Ungültiger öffentlicher Schlüssel' });
  }
  try {
    const profile = await getProfile(user.username);
    const settings = { ...(profile?.settings || {}), e2eePublicKey: publicKey, e2eeKeyUpdatedAt: new Date().toISOString() };
    const { error } = await supabaseAdmin.from('user_profiles').upsert({ username: user.username, settings }, { onConflict: 'username' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Öffentlicher Schlüssel konnte nicht gespeichert werden' });
  }
});

const E2EE_KEY_ENVELOPE_PREFIX = '__ehoser_e2ee_key__:';
function e2eeKeyEnvelopeSender(username) {
  return E2EE_KEY_ENVELOPE_PREFIX + String(username || '').trim();
}
// Prefer the old dedicated column whenever it is available. Existing chats may
// already have valid envelopes there; falling back to hidden system rows keeps
// E2EE working on databases where that column was removed.
async function getE2eeMemberRows(groupId) {
  const columnResult = await supabaseAdmin.from('chat_group_members')
    .select('username,encrypted_group_key').eq('group_id', groupId);
  const columnMissing = /encrypted_group_key.*(does not exist|could not find|schema cache)/i.test(String(columnResult.error?.message || ''));
  if (!columnResult.error) {
    return {
      data: (columnResult.data || []).map((member) => ({ username: member.username, wrappedKey: String(member.encrypted_group_key || '') })),
      error: null,
      storage: 'column'
    };
  }
  if (!columnMissing) return { data: [], error: columnResult.error, storage: 'messages' };
  const [{ data: members, error: membersError }, { data: envelopes, error: envelopeError }] = await Promise.all([
    supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId),
    supabaseAdmin.from('chat_messages').select('id,sender,encrypted_content').eq('group_id', groupId)
      .like('sender', E2EE_KEY_ENVELOPE_PREFIX + '%').order('id', { ascending: false })
  ]);
  if (membersError || envelopeError) return { data: [], error: membersError || envelopeError, storage: 'messages' };
  const wrappedByUsername = new Map();
  for (const row of envelopes || []) {
    const username = String(row.sender || '').slice(E2EE_KEY_ENVELOPE_PREFIX.length);
    if (username && !wrappedByUsername.has(username)) wrappedByUsername.set(username, String(row.encrypted_content || ''));
  }
  return { data: (members || []).map((member) => ({ username: member.username, wrappedKey: wrappedByUsername.get(member.username) || '' })), error: null, storage: 'messages' };
}

// Ein Mitglied kann nur seine eigene Schlüssel-Hülle laden. Öffentliche Schlüssel
// der Gruppenmitglieder dürfen zum sicheren Einpacken des Gruppenschlüssels gelesen werden.
app.get('/api/chat/groups/:id/e2ee', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).maybeSingle();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  const membersResult = await getE2eeMemberRows(id);
  if (membersResult.error) return res.status(500).json({ error: 'Schlüssel konnten nicht geladen werden' });
  const usernames = membersResult.data.map((member) => member.username).filter(Boolean);
  const { data: profiles } = usernames.length
    ? await supabaseAdmin.from('user_profiles').select('username,settings').in('username', usernames)
    : { data: [] };
  const publicKeys = new Map((profiles || []).map((profile) => [profile.username, normalizeSettings(profile.settings || {}).e2eePublicKey || null]));
  res.json({
    members: membersResult.data.map((member) => ({
      username: member.username,
      wrappedKey: member.username === user.username ? (member.wrappedKey || '') : undefined,
      publicKey: publicKeys.get(member.username) || null
    }))
  });
});

// Nur Gruppenadmins dürfen Schlüssel-Hüllen für die aktuelle Mitgliedschaft setzen.
// Der Inhalt wird nie entschlüsselt oder geprüft, sondern unverändert gespeichert.
app.put('/api/chat/groups/:id/e2ee', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  if (!keys.length || keys.length > 200) return res.status(400).json({ error: 'Keine Schlüssel angegeben' });
  const { data: group } = await supabaseAdmin.from('chat_groups').select('created_by').eq('id', id).maybeSingle();
  if (!group) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  const isAdmin = await isGroupAdmin(id, user.username, group.created_by);
  // The very first key setup may be done by any member. Afterwards only admins
  // can add a new device/member envelope, so nobody can silently replace keys.
  const currentKeys = await getE2eeMemberRows(id);
  const initialSetup = !currentKeys.error && (currentKeys.data || []).every((member) => !member.wrappedKey);
  if (!isAdmin && !initialSetup) return res.status(403).json({ error: 'Nur Gruppenadmins dürfen weitere Schlüssel setzen' });
  const validMembers = new Set((currentKeys.data || []).map((member) => member.username));
  for (const item of keys) {
    const username = String(item?.username || '').trim();
    const wrappedKey = String(item?.wrappedKey || '');
    if (!validMembers.has(username) || !wrappedKey || wrappedKey.length > 20000) return res.status(400).json({ error: 'Ungültige Schlüssel-Hülle' });
    if (currentKeys.storage === 'column') {
      const result = await supabaseAdmin.from('chat_group_members').update({ encrypted_group_key: wrappedKey }).eq('group_id', id).eq('username', username);
      if (result.error) return res.status(500).json({ error: 'Schlüssel konnte nicht gespeichert werden' });
      continue;
    }
    const sender = e2eeKeyEnvelopeSender(username);
    const { data: existing, error: lookupError } = await supabaseAdmin.from('chat_messages').select('id')
      .eq('group_id', id).eq('sender', sender).order('id', { ascending: false }).limit(1);
    if (lookupError) return res.status(500).json({ error: 'Schlüssel konnte nicht vorbereitet werden' });
    const result = existing?.[0]
      ? await supabaseAdmin.from('chat_messages').update({ encrypted_content: wrappedKey }).eq('id', existing[0].id)
      : await supabaseAdmin.from('chat_messages').insert({ group_id: id, sender, encrypted_content: wrappedKey });
    if (result.error) return res.status(500).json({ error: 'Schlüssel konnte nicht gespeichert werden' });
  }
  res.json({ ok: true });
});

// Alte Nachrichten werden im Browser verschlüsselt; dieser Endpunkt erhält und
// speichert ausschließlich bereits verschlüsselten Text.
app.post('/api/chat/groups/:id/e2ee/migrate', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 200) : [];
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).maybeSingle();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  for (const message of messages) {
    const messageId = Number(message?.id);
    const content = String(message?.content || '');
    if (!Number.isInteger(messageId) || !content || content.length > 65536) return res.status(400).json({ error: 'Ungültige Migrationsnachricht' });
    const { error } = await supabaseAdmin.from('chat_messages').update({ encrypted_content: content }).eq('id', messageId).eq('group_id', id);
    if (error) return res.status(500).json({ error: 'Alte Nachricht konnte nicht verschlüsselt gespeichert werden' });
  }
  res.json({ ok: true, migrated: messages.length });
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
    .neq('sender', CHAT_CALL_EVENT_SENDER)
    .neq('sender', GROUP_CALL_EVENT_SENDER)
    .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
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

// POST /api/chat/groups/:id/members — neues Mitglied hinzufügen
// Body: { username }
app.post('/api/chat/groups/:id/members', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username erforderlich' });

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
  const { error } = await insertChatGroupMembers([{ group_id: id, username }]);
  if (error) return res.status(500).json({ error: 'Fehler beim Hinzufügen: ' + error.message });

  const { data: afterMembers } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', id);
  const nextType = (afterMembers || []).length <= 2 ? 'private' : 'group';
  const currentMeta = await getGroupMeta(id, { type: nextType });
  await setGroupMeta(id, { type: nextType, description: currentMeta.description, photoUrl: currentMeta.photoUrl });

  res.json({ ok: true });
});

const CHAT_MESSAGE_FIELDS = 'id,group_id,sender,encrypted_content,created_at,deleted_at,deleted_by,edited_at,edited_by,hide_edit_mark,pinned_at,pinned_by,updated_at';
const LEGACY_CHAT_MESSAGE_FIELDS = 'id,group_id,sender,encrypted_content,created_at';
const DELETED_CHAT_MESSAGE_CONTENT = JSON.stringify({ t: 'deleted' });
const TICTACTOE_TEST_OWNER = 'meisterlool_707';

function publicChatMessage(row) {
  if (!row) return null;
  const { encrypted_content: content, ...message } = row;
  return { ...message, content };
}

function isMissingChatMessageMetadata(error) {
  const text = String(error?.message || error?.details || '').toLowerCase();
  const fields = ['deleted_at', 'edited_at', 'edited_by', 'hide_edit_mark', 'pinned_at', 'pinned_by', 'updated_at'];
  return fields.some((field) => text.includes('chat_messages.' + field)
    || (text.includes(field) && /does not exist|could not find|schema cache|column/.test(text)));
}

function createChatMessageQuery(groupId, fields) {
  return supabaseAdmin
    .from('chat_messages')
    .select(fields)
    .eq('group_id', groupId)
    .neq('sender', CHAT_CALL_EVENT_SENDER)
    .neq('sender', GROUP_CALL_EVENT_SENDER)
    .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
    .not('sender', 'like', E2EE_KEY_ENVELOPE_PREFIX + '%');
}

function isTicTacToeTestCommand(username, content) {
  if (String(username || '').toLowerCase() !== TICTACTOE_TEST_OWNER) return false;
  try {
    const message = JSON.parse(String(content || ''));
    return message?.t === 'txt' && String(message?.v || '').trim() === '/test';
  } catch {
    return false;
  }
}

async function readChatMessageForAction(id) {
  let hasMetadata = true;
  let result = await supabaseAdmin
    .from('chat_messages')
    .select(CHAT_MESSAGE_FIELDS)
    .eq('id', id)
    .maybeSingle();
  if (result.error && isMissingChatMessageMetadata(result.error)) {
    hasMetadata = false;
    result = await supabaseAdmin
      .from('chat_messages')
      .select(LEGACY_CHAT_MESSAGE_FIELDS)
      .eq('id', id)
      .maybeSingle();
  }
  return { data: result.data, error: result.error, hasMetadata };
}

// POST /api/chat/messages — Nachricht als JSON-Text senden
app.post('/api/chat/messages', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId, content } = req.body;
  if (!groupId || !content || typeof content !== 'string' || content.length > 65536) {
    return res.status(400).json({ error: 'Ungültige Nachricht' });
  }
  // Muss Mitglied sein
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });

  if (isTicTacToeTestCommand(user.username, content)) {
    const { data: members, error: membersError } = await supabaseAdmin
      .from('chat_group_members')
      .select('username')
      .eq('group_id', groupId);
    if (membersError) return res.status(500).json({ error: 'Spiel konnte nicht vorbereitet werden' });
    const participantNames = [...new Set((members || []).map((member) => String(member?.username || '')).filter(Boolean))];
    if (participantNames.length !== 2) {
      return res.status(400).json({ error: 'Dieser Befehl funktioniert nur in einem privaten 1-zu-1-Chat.' });
    }
    const target = participantNames.find((username) => username !== user.username);
    if (!target) return res.status(400).json({ error: 'Kein anderer Nutzer im Chat gefunden.' });

    const challengeContent = JSON.stringify({
      t: 'tic_tac_toe',
      target,
      gameId: 'ttt_' + crypto.randomBytes(12).toString('hex'),
      text: 'Wer gewinnt, ist mein bester Freund. Sonst war’s das mit der Freundschaft 😄'
    });
    const { data, error } = await supabaseAdmin
      .from('chat_messages')
      .insert({ group_id: groupId, sender: user.username, encrypted_content: challengeContent })
      .select('id,created_at')
      .single();
    if (error) return res.status(500).json({ error: 'Spiel konnte nicht gesendet werden' });
    return res.json({ id: data.id, created_at: data.created_at, command: 'tic_tac_toe' });
  }

  // The database column keeps its legacy name so existing deployments need no destructive migration.
  const { data, error } = await supabaseAdmin.from('chat_messages').insert({ group_id: groupId, sender: user.username, encrypted_content: content }).select('id,created_at').single();
  if (error) return res.status(500).json({ error: 'Fehler beim Senden' });
  res.json({ id: data.id, created_at: data.created_at });
});

// GET /api/chat/messages/:groupId/export — vollständigen Chat für ein Mitglied exportieren
app.get('/api/chat/messages/:groupId/export', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId } = req.params;
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });

  async function loadExportRows(fields) {
    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await createChatMessageQuery(groupId, fields)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) return { error };
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return { rows };
    }
  }

  let result = await loadExportRows(CHAT_MESSAGE_FIELDS);
  if (result.error && isMissingChatMessageMetadata(result.error)) {
    result = await loadExportRows(LEGACY_CHAT_MESSAGE_FIELDS);
  }
  if (result.error) return res.status(500).json({ error: 'Chat-Export konnte nicht erstellt werden' });
  res.json({ messages: (result.rows || []).map(publicChatMessage) });
});

// GET /api/chat/messages/:groupId?after=<id>&changedAfter=<ISO time> — Nachrichten abrufen (polling)
app.get('/api/chat/messages/:groupId', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId } = req.params;
  const after = parseInt(req.query.after) || 0;
  const changedAfterValue = String(req.query.changedAfter || '');
  const changedAfterMs = Date.parse(changedAfterValue);
  const changedAfter = Number.isNaN(changedAfterMs) ? null : new Date(changedAfterMs).toISOString();
  // Muss Mitglied sein
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  let hasMessageMetadata = true;
  let query = createChatMessageQuery(groupId, CHAT_MESSAGE_FIELDS);
  query = after
    ? query.gt('id', after).order('id', { ascending: true }).limit(50)
    // A fresh browser has no local cache yet. Return the same useful history
    // window that the client keeps locally, instead of only the oldest rows.
    : query.order('id', { ascending: false }).limit(180);
  let { data, error } = await query;
  if (error && isMissingChatMessageMetadata(error)) {
    // Existing installations can still load all chats while the optional message-action
    // migration has not run yet.
    hasMessageMetadata = false;
    let legacyQuery = createChatMessageQuery(groupId, LEGACY_CHAT_MESSAGE_FIELDS);
    legacyQuery = after
      ? legacyQuery.gt('id', after).order('id', { ascending: true }).limit(50)
      : legacyQuery.order('id', { ascending: false }).limit(180);
    ({ data, error } = await legacyQuery);
  }
  if (error) return res.status(500).json({ error: 'Nachrichten konnten nicht geladen werden' });

  const initialRows = after ? (data || []) : (data || []).slice().reverse();
  let changedRows = [];
  if (hasMessageMetadata && changedAfter) {
    const changedResult = await createChatMessageQuery(groupId, CHAT_MESSAGE_FIELDS)
      .gt('updated_at', changedAfter)
      .order('updated_at', { ascending: true })
      .limit(50);
    if (changedResult.error && !isMissingChatMessageMetadata(changedResult.error)) {
      return res.status(500).json({ error: 'Nachrichten konnten nicht geladen werden' });
    }
    changedRows = changedResult.data || [];
  }
  const merged = new Map();
  for (const message of [...initialRows, ...changedRows]) merged.set(String(message.id), message);
  const messages = [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id)).map(publicChatMessage);
  let pinnedRow = null;
  if (hasMessageMetadata) {
    const { data: pinned, error: pinnedError } = await supabaseAdmin
      .from('chat_messages')
      .select(CHAT_MESSAGE_FIELDS)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .not('pinned_at', 'is', null)
      .order('pinned_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pinnedError) console.warn('Angepinnte Chat-Nachricht konnte nicht geladen werden:', pinnedError.message);
    else pinnedRow = pinned;
  }
  const deliveredMessageId = messages.reduce((max, message) => Math.max(max, Number(message.id) || 0), 0);
  try {
    if (deliveredMessageId) await saveChatReceiptState(groupId, user.username, { deliveredMessageId });
    const activity = await getChatGroupActivity(groupId, user.username);
    return res.json({ messages, pinnedMessage: publicChatMessage(pinnedRow), activity, syncedAt: new Date().toISOString() });
  } catch (activityError) {
    console.error('Chat activity update failed:', activityError.message);
    return res.json({ messages, pinnedMessage: publicChatMessage(pinnedRow), activity: { deliveredUpTo: 0, readUpTo: 0, typing: [] }, syncedAt: new Date().toISOString() });
  }
});

// Read receipts: the greatest message id that is actually visible to this member.
app.post('/api/chat/groups/:groupId/read', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId } = req.params;
  const requestedId = Math.max(0, Number.parseInt(req.body?.upTo, 10) || 0);
  if (!requestedId) return res.status(400).json({ error: 'Ungültige Nachrichten-ID' });
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).maybeSingle();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  const { data: latest, error } = await supabaseAdmin
    .from('chat_messages')
    .select('id')
    .eq('group_id', groupId)
    .neq('sender', CHAT_CALL_EVENT_SENDER)
    .neq('sender', GROUP_CALL_EVENT_SENDER)
    .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
    .lte('id', requestedId)
    .order('id', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: 'Lesestatus konnte nicht gespeichert werden' });
  const readMessageId = Number(latest?.[0]?.id) || 0;
  if (!readMessageId) return res.json({ ok: true });
  try {
    await saveChatReceiptState(groupId, user.username, {
      deliveredMessageId: readMessageId,
      readMessageId
    });
    return res.json({ ok: true });
  } catch (stateError) {
    console.error('Save chat read receipt failed:', stateError.message);
    return res.status(500).json({ error: 'Lesestatus konnte nicht gespeichert werden' });
  }
});

// Typing presence expires automatically, so a closed tab never stays on "schreibt".
app.post('/api/chat/groups/:groupId/typing', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId } = req.params;
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).maybeSingle();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  const typingUntil = req.body?.active ? new Date(Date.now() + 6000).toISOString() : null;
  try {
    await saveChatTypingState(groupId, user.username, typingUntil);
    return res.json({ ok: true, typingUntil });
  } catch (stateError) {
    console.error('Save chat typing state failed:', stateError.message);
    return res.status(500).json({ error: 'Schreibstatus konnte nicht gespeichert werden' });
  }
});

// Lightweight metadata feed for browser notifications.
app.get('/api/chat/notifications', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  const { data: memberships, error: memberError } = await supabaseAdmin
    .from('chat_group_members')
    .select('group_id')
    .eq('username', user.username);
  if (memberError) return res.status(500).json({ error: 'Chats konnten nicht geladen werden' });
  const groupIds = (memberships || []).map((row) => row.group_id);
  if (!groupIds.length) return res.json({ messages: [], cursor: after });

  if (!after) {
    let latestResult = await supabaseAdmin
      .from('chat_messages')
      .select('id')
      .in('group_id', groupIds)
      .neq('sender', CHAT_CALL_EVENT_SENDER)
      .neq('sender', GROUP_CALL_EVENT_SENDER)
      .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
      .is('deleted_at', null)
      .order('id', { ascending: false })
      .limit(1);
    // Older ehoser databases can still be missing message metadata such as
    // deleted_at. A notification cursor must keep working in that case.
    if (latestResult.error && isMissingChatMessageMetadata(latestResult.error)) {
      latestResult = await supabaseAdmin
        .from('chat_messages')
        .select('id')
        .in('group_id', groupIds)
        .neq('sender', CHAT_CALL_EVENT_SENDER)
        .neq('sender', GROUP_CALL_EVENT_SENDER)
        .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
        .order('id', { ascending: false })
        .limit(1);
    }
    const { data: latest, error } = latestResult;
    if (error) return res.status(500).json({ error: 'Benachrichtigungen konnten nicht gestartet werden' });
    return res.json({ messages: [], cursor: Number(latest?.[0]?.id) || 0 });
  }

  let notificationResult = await supabaseAdmin
    .from('chat_messages')
    .select('id,group_id,sender,created_at')
    .in('group_id', groupIds)
    .neq('sender', CHAT_CALL_EVENT_SENDER)
    .neq('sender', GROUP_CALL_EVENT_SENDER)
    .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
    .is('deleted_at', null)
    .gt('id', after)
    .order('id', { ascending: true })
    .limit(50);
  if (notificationResult.error && isMissingChatMessageMetadata(notificationResult.error)) {
    notificationResult = await supabaseAdmin
      .from('chat_messages')
      .select('id,group_id,sender,created_at')
      .in('group_id', groupIds)
      .neq('sender', CHAT_CALL_EVENT_SENDER)
      .neq('sender', GROUP_CALL_EVENT_SENDER)
      .not('sender', 'like', CHAT_MEMBER_STATE_SENDER_PREFIX + '%')
      .gt('id', after)
      .order('id', { ascending: true })
      .limit(50);
  }
  const { data, error } = notificationResult;
  if (error) return res.status(500).json({ error: 'Benachrichtigungen konnten nicht geladen werden' });
  const messages = data || [];
  const cursor = messages.reduce((max, message) => Math.max(max, Number(message.id) || 0), after);
  res.json({ messages, cursor });
});

// ─── Multi-user WebRTC call signalling ──────────────────────────────────────
app.post('/api/chat/group-calls', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const groupId = String(req.body?.groupId || '');
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return res.status(400).json({ error: 'Ungültige Anrufgruppe' });
  try {
    const { data: members, error } = await supabaseAdmin
      .from('chat_group_members')
      .select('username')
      .eq('group_id', groupId);
    if (error) throw error;
    const participants = [...new Set((members || []).map((item) => item.username).filter(Boolean))];
    if (!participants.includes(user.username)) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
    if (participants.length < 2 || participants.length > 8) {
      return res.status(400).json({ error: 'Gruppenanrufe brauchen 2 bis 8 Teilnehmer' });
    }
    const roomId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await appendGroupCallEvent(groupId, {
      kind: 'start', roomId, groupId, host: user.username, participants, createdAt
    });
    const room = {
      id: roomId,
      group_id: groupId,
      host: user.username,
      participants,
      joined: [user.username],
      status: 'active',
      created_at: createdAt
    };
    return res.status(201).json({ room });
  } catch (error) {
    console.error('Create group call failed:', error.message);
    return res.status(503).json({ error: 'Gruppenanruf konnte nicht gestartet werden' });
  }
});

app.get('/api/chat/group-calls/pending', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const rooms = [...rebuildGroupCallRooms(await listGroupCallEvents()).values()]
      .filter((room) => room.status === 'active'
        && room.participants.includes(user.username)
        && !room.joined.has(user.username)
        && !room.left.has(user.username)
        && Date.now() - new Date(room.latest_invite_at || room.created_at).getTime() < 120000)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.json({ room: publicGroupCallRoom(rooms[0] || null) });
  } catch (error) {
    return res.status(503).json({ error: 'Gruppenanrufe konnten nicht geladen werden' });
  }
});

app.get('/api/chat/group-calls/:id', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const { room, events } = await getGroupCallRoom(req.params.id, user.username);
    if (!room) return res.status(404).json({ error: 'Gruppenanruf nicht gefunden' });
    const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
    const signals = events
      .filter((event) => event.kind === 'signal'
        && event.to === user.username
        && event.event_id > after)
      .slice(-150)
      .map((event) => ({
        id: event.event_id,
        sender: event.from,
        kind: event.signalKind,
        payload: event.payload,
        created_at: event.stored_at
      }));
    const cursor = events.reduce((max, event) => Math.max(max, event.event_id || 0), after);
    return res.json({ room: publicGroupCallRoom(room), signals, cursor });
  } catch (error) {
    return res.status(503).json({ error: 'Gruppenanruf konnte nicht geladen werden' });
  }
});

app.post('/api/chat/group-calls/:id/join', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const { room } = await getGroupCallRoom(req.params.id, user.username);
    if (!room) return res.status(404).json({ error: 'Gruppenanruf nicht gefunden' });
    if (room.status !== 'active') return res.status(409).json({ error: 'Gruppenanruf ist beendet' });
    if (!room.joined.has(user.username)) {
      await appendGroupCallEvent(room.group_id, {
        kind: 'join', roomId: room.id, username: user.username, at: new Date().toISOString()
      });
      room.joined.add(user.username);
    }
    return res.json({ room: publicGroupCallRoom(room) });
  } catch (error) {
    return res.status(503).json({ error: 'Beitreten fehlgeschlagen' });
  }
});

// The call host can invite further ehoser users while the room is active.
// Each invite is stored as a normal call event, so it also reaches a second
// device and never creates a visible chat conversation.
app.post('/api/chat/group-calls/:id/invite', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) return res.status(400).json({ error: 'Ungültiger Nutzername' });
  try {
    const { room } = await getGroupCallRoom(req.params.id, user.username);
    if (!room) return res.status(404).json({ error: 'Gruppenanruf nicht gefunden' });
    if (room.status !== 'active') return res.status(409).json({ error: 'Gruppenanruf ist beendet' });
    if (room.host !== user.username) return res.status(403).json({ error: 'Nur der Anrufleiter kann weitere Personen einladen' });
    if (room.participants.includes(username)) return res.status(409).json({ error: 'Diese Person ist bereits eingeladen' });
    if (room.participants.length >= 8) return res.status(400).json({ error: 'Ein Gruppenanruf kann höchstens 8 Personen haben' });

    const { data: target } = await supabase.from('users').select('username').eq('username', username).maybeSingle();
    if (!target) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

    const { data: existingMember } = await supabaseAdmin
      .from('chat_group_members')
      .select('username')
      .eq('group_id', room.group_id)
      .eq('username', username)
      .maybeSingle();
    let addedMember = false;
    if (!existingMember) {
      const { error: memberError } = await insertChatGroupMembers([{ group_id: room.group_id, username }]);
      if (memberError) return res.status(500).json({ error: 'Einladung konnte nicht vorbereitet werden' });
      addedMember = true;
    }

    try {
      await appendGroupCallEvent(room.group_id, {
        kind: 'invite', roomId: room.id, username, invitedBy: user.username, at: new Date().toISOString()
      });
    } catch (eventError) {
      if (addedMember) await supabaseAdmin.from('chat_group_members').delete().eq('group_id', room.group_id).eq('username', username);
      throw eventError;
    }

    room.participants.push(username);
    return res.status(201).json({ room: publicGroupCallRoom(room) });
  } catch (error) {
    console.error('Invite to group call failed:', error.message);
    return res.status(503).json({ error: 'Einladung konnte nicht gesendet werden' });
  }
});

app.post('/api/chat/group-calls/:id/leave', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const { room } = await getGroupCallRoom(req.params.id, user.username);
    if (!room) return res.status(404).json({ error: 'Gruppenanruf nicht gefunden' });
    if (room.status === 'active') {
      const event = room.host === user.username
        ? { kind: 'end', roomId: room.id, username: user.username, at: new Date().toISOString() }
        : { kind: 'leave', roomId: room.id, username: user.username, at: new Date().toISOString() };
      await appendGroupCallEvent(room.group_id, event);
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(503).json({ error: 'Verlassen fehlgeschlagen' });
  }
});

app.post('/api/chat/group-calls/:id/signals', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { to, kind, payload } = req.body || {};
  if (!['ice', 'offer', 'answer', 'media', 'sticker'].includes(kind) || !payloadWithinLimit(payload, 100000)) {
    return res.status(400).json({ error: 'Ungültiges Anrufsignal' });
  }
  try {
    const { room } = await getGroupCallRoom(req.params.id, user.username);
    if (!room) return res.status(404).json({ error: 'Gruppenanruf nicht gefunden' });
    if (room.status !== 'active') return res.status(409).json({ error: 'Gruppenanruf ist beendet' });
    if (!room.participants.includes(to) || to === user.username) return res.status(400).json({ error: 'Ungültiger Empfänger' });
    if (kind === 'offer' && !validRtcDescription(payload, 'offer')) return res.status(400).json({ error: 'Ungültiges Angebot' });
    if (kind === 'answer' && !validRtcDescription(payload, 'answer')) return res.status(400).json({ error: 'Ungültige Antwort' });
    if (kind === 'ice' && (!payload || typeof payload.candidate !== 'string')) return res.status(400).json({ error: 'Ungültiger ICE-Kandidat' });
    if (kind === 'media' && (!payload || typeof payload.video !== 'boolean' || typeof payload.audio !== 'boolean')) {
      return res.status(400).json({ error: 'Ungültiger Medienstatus' });
    }
    if (kind === 'sticker' && !['🔥', '😂', '❤️', '👍', '👏', '😮'].includes(String(payload?.sticker || ''))) {
      return res.status(400).json({ error: 'Ungültiger Sticker' });
    }
    const event = await appendGroupCallEvent(room.group_id, {
      kind: 'signal', roomId: room.id, from: user.username, to,
      signalKind: kind, payload, at: new Date().toISOString()
    });
    return res.status(201).json({ id: event.event_id });
  } catch (error) {
    return res.status(503).json({ error: 'Anrufsignal konnte nicht gesendet werden' });
  }
});

// ─── One-to-one WebRTC call signalling ──────────────────────────────────────
// Audio/video flows peer-to-peer. Signalling events are stored as hidden rows
// in chat_messages so calls do not depend on extra database tables.
function configuredChatCallIceServers() {
  const configuredUrls = String(process.env.CHAT_TURN_URLS || process.env.CHAT_TURN_URL || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const username = String(process.env.CHAT_TURN_USERNAME || '').trim();
  const credential = String(process.env.CHAT_TURN_CREDENTIAL || '').trim();

  // STUN is enough on many networks. A real, private TURN service can be set
  // in the deployment to relay media when mobile providers, school Wi-Fi, or
  // strict routers block a direct peer-to-peer connection.
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
  if (configuredUrls.length && username && credential) {
    servers.unshift({ urls: configuredUrls, username, credential });
  }
  return servers;
}

app.get('/api/chat/calls/config', (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ iceServers: configuredChatCallIceServers() });
});

app.post('/api/chat/calls', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId, callee, mediaType = 'audio', offer } = req.body || {};
  if (!groupId || !callee || callee === user.username) {
    return res.status(400).json({ error: 'Ungültiger Anruf' });
  }
  if (!['audio', 'video'].includes(mediaType) || !validRtcDescription(offer, 'offer')) {
    return res.status(400).json({ error: 'Ungültige Anrufdaten' });
  }

  const { data: members, error: memberError } = await supabaseAdmin
    .from('chat_group_members')
    .select('username')
    .eq('group_id', groupId);
  if (memberError) return res.status(500).json({ error: 'Mitglieder konnten nicht geprüft werden' });
  const names = (members || []).map((member) => member.username);
  if (names.length !== 2 || !names.includes(user.username) || !names.includes(callee)) {
    return res.status(403).json({ error: 'Anrufe sind nur in Chats mit genau 2 Mitgliedern möglich' });
  }

  try {
    const now = new Date().toISOString();
    const existingEvents = await listChatCallEvents({ groupId });
    const existingCalls = rebuildChatCalls(existingEvents);
    for (const existing of existingCalls.values()) {
      if (existing.caller === user.username && existing.callee === callee && existing.status === 'ringing') {
        await appendChatCallEvent(groupId, {
          kind: 'state', callId: existing.id, status: 'missed', at: now
        });
      }
    }

    const callId = crypto.randomUUID();
    await appendChatCallEvent(groupId, {
      kind: 'start',
      callId,
      groupId,
      caller: user.username,
      callee,
      mediaType,
      offer,
      createdAt: now
    });
    return res.status(201).json({
      call: {
        id: callId,
        group_id: groupId,
        caller: user.username,
        callee,
        media_type: mediaType,
        status: 'ringing',
        created_at: now
      }
    });
  } catch (error) {
    console.error('Create chat call failed:', error.message);
    return res.status(503).json({ error: 'Anruf konnte nicht gespeichert werden' });
  }
});

app.get('/api/chat/calls/pending', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const events = await listChatCallEvents();
    const calls = [...rebuildChatCalls(events).values()]
      .filter((call) => call.callee === user.username && call.status === 'ringing')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const cutoff = Date.now() - 45000;
    let pending = null;
    for (const call of calls) {
      if (new Date(call.created_at).getTime() >= cutoff && !pending) {
        pending = call;
      } else {
        await appendChatCallEvent(call.group_id, {
          kind: 'state', callId: call.id, status: 'missed', at: new Date().toISOString()
        });
      }
    }
    return res.json({ call: pending });
  } catch (error) {
    console.error('Load pending chat call failed:', error.message);
    return res.status(503).json({ error: 'Anrufe konnten nicht geladen werden' });
  }
});

app.get('/api/chat/calls/:id', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const result = await getMessageBackedCall(req.params.id, user.username);
    let call = result.call;
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });

    if (call.status === 'ringing' && Date.now() - new Date(call.created_at).getTime() > 45000) {
      const endedAt = new Date().toISOString();
      await appendChatCallEvent(call.group_id, {
        kind: 'state', callId: call.id, status: 'missed', at: endedAt
      });
      call = { ...call, status: 'missed', ended_at: endedAt };
    }

    const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
    const signals = result.events
      .filter((event) => event.kind === 'signal' && event.event_id > after)
      .slice(-100)
      .map((event) => ({
        id: event.event_id,
        sender: event.from,
        kind: event.signalKind,
        payload: event.payload,
        created_at: event.stored_at
      }));
    return res.json({ call, signals });
  } catch (error) {
    console.error('Load chat call failed:', error.message);
    return res.status(503).json({ error: 'Anruf konnte nicht geladen werden' });
  }
});

app.post('/api/chat/calls/:id/answer', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { answer } = req.body || {};
  if (!validRtcDescription(answer, 'answer')) return res.status(400).json({ error: 'Ungültige Antwort' });
  try {
    const { call } = await getMessageBackedCall(req.params.id, user.username);
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });
    if (call.callee !== user.username) return res.status(403).json({ error: 'Nur der Angerufene kann annehmen' });
    if (call.status !== 'ringing') return res.status(409).json({ error: 'Anruf ist nicht mehr verfügbar' });
    const acceptedAt = new Date().toISOString();
    await appendChatCallEvent(call.group_id, {
      kind: 'state', callId: call.id, status: 'accepted', answer, at: acceptedAt
    });
    return res.json({ call: { id: call.id, status: 'accepted', accepted_at: acceptedAt } });
  } catch (error) {
    console.error('Answer chat call failed:', error.message);
    return res.status(503).json({ error: 'Anruf konnte nicht angenommen werden' });
  }
});

app.post('/api/chat/calls/:id/reject', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const { call } = await getMessageBackedCall(req.params.id, user.username);
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });
    if (call.callee !== user.username) return res.status(403).json({ error: 'Nicht erlaubt' });
    if (call.status === 'ringing') {
      await appendChatCallEvent(call.group_id, {
        kind: 'state', callId: call.id, status: 'rejected', at: new Date().toISOString()
      });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(503).json({ error: 'Anruf konnte nicht abgelehnt werden' });
  }
});

app.post('/api/chat/calls/:id/end', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  try {
    const { call } = await getMessageBackedCall(req.params.id, user.username);
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });
    if (!['ended', 'rejected', 'missed'].includes(call.status)) {
      await appendChatCallEvent(call.group_id, {
        kind: 'state', callId: call.id, status: 'ended', at: new Date().toISOString()
      });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(503).json({ error: 'Anruf konnte nicht beendet werden' });
  }
});

app.post('/api/chat/calls/:id/signals', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { kind, payload } = req.body || {};
  if (!['ice', 'offer', 'answer', 'media'].includes(kind) || !payloadWithinLimit(payload)) {
    return res.status(400).json({ error: 'Ungültiges Anrufsignal' });
  }
  if (kind === 'offer' && !validRtcDescription(payload, 'offer')) return res.status(400).json({ error: 'Ungültiges Angebot' });
  if (kind === 'answer' && !validRtcDescription(payload, 'answer')) return res.status(400).json({ error: 'Ungültige Antwort' });
  if (kind === 'ice' && (!payload || typeof payload !== 'object' || typeof payload.candidate !== 'string')) {
    return res.status(400).json({ error: 'Ungültiger ICE-Kandidat' });
  }
  if (kind === 'media' && (!payload || typeof payload.video !== 'boolean')) {
    return res.status(400).json({ error: 'Ungültiger Medienstatus' });
  }
  try {
    const { call } = await getMessageBackedCall(req.params.id, user.username);
    if (!call) return res.status(404).json({ error: 'Anruf nicht gefunden' });
    if (!['ringing', 'accepted'].includes(call.status)) return res.status(409).json({ error: 'Anruf ist beendet' });
    const event = await appendChatCallEvent(call.group_id, {
      kind: 'signal',
      callId: call.id,
      from: user.username,
      signalKind: kind,
      payload,
      at: new Date().toISOString()
    });
    return res.status(201).json({ id: event.event_id });
  } catch (error) {
    console.error('Store chat call signal failed:', error.message);
    return res.status(503).json({ error: 'Anrufsignal konnte nicht gesendet werden' });
  }
});

// PATCH /api/chat/messages/:id — Nachricht bearbeiten
app.patch('/api/chat/messages/:id', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { content } = req.body;
  if (!id || !content || typeof content !== 'string' || content.length > 65536) return res.status(400).json({ error: 'Ungültige Anfrage' });

  let payload;
  try { payload = JSON.parse(content); } catch { return res.status(400).json({ error: 'Nur Textnachrichten können bearbeitet werden' }); }
  if (!payload || payload.t !== 'txt' || typeof payload.v !== 'string') {
    return res.status(400).json({ error: 'Nur Textnachrichten können bearbeitet werden' });
  }

  // Existierende Nachricht holen
  const { data: msgRow, error: selErr, hasMetadata } = await readChatMessageForAction(id);
  if (selErr) return res.status(500).json({ error: 'DB Fehler' });
  if (!msgRow) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
  if (msgRow.deleted_at) return res.status(409).json({ error: 'Gelöschte Nachrichten können nicht bearbeitet werden' });

  // Prüfen: Nutzer muss Mitglied der Gruppe sein
  const { data: self } = await supabaseAdmin.from('chat_group_members').select('username').eq('group_id', msgRow.group_id).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });

  // Nur der ursprüngliche Absender darf seine Nachricht bearbeiten.
  if (msgRow.sender !== user.username) {
    return res.status(403).json({ error: 'Nicht berechtigt zu bearbeiten' });
  }

  const now = new Date().toISOString();
  let updatedResult = await supabaseAdmin
    .from('chat_messages')
    .update({
      encrypted_content: content,
      edited_at: now,
      edited_by: user.username,
      updated_at: now
    })
    .eq('id', id)
    .select(CHAT_MESSAGE_FIELDS)
    .single();

  if (updatedResult.error && (!hasMetadata || isMissingChatMessageMetadata(updatedResult.error))) {
    const compatibleContent = JSON.stringify(payload);
    updatedResult = await supabaseAdmin
      .from('chat_messages')
      .update({ encrypted_content: compatibleContent })
      .eq('id', id)
      .select(LEGACY_CHAT_MESSAGE_FIELDS)
      .single();
  }
  const { data: updated, error } = updatedResult;
  if (error) return res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  res.json({ ok: true, message: publicChatMessage(updated) });
});

// DELETE /api/chat/messages/:id — Nachricht für alle als gelöschten Hinweis behalten
app.delete('/api/chat/messages/:id', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  // Older installations may not have the optional message-action columns yet.
  // In that case use the legacy fields and replace only the stored content.
  const { data: msgRow, error: selectError, hasMetadata } = await readChatMessageForAction(id);
  if (selectError) return res.status(500).json({ error: 'DB Fehler beim Laden der Nachricht' });
  if (!msgRow) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
  if (hasMetadata && msgRow.deleted_at) return res.status(409).json({ error: 'Nachricht wurde bereits gelöscht' });
  if (!hasMetadata && String(msgRow.encrypted_content || '') === DELETED_CHAT_MESSAGE_CONTENT) {
    return res.status(409).json({ error: 'Nachricht wurde bereits gelöscht' });
  }

  const { data: self } = await supabaseAdmin
    .from('chat_group_members')
    .select('username')
    .eq('group_id', msgRow.group_id)
    .eq('username', user.username)
    .maybeSingle();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  if (msgRow.sender !== user.username) return res.status(403).json({ error: 'Du kannst nur eigene Nachrichten löschen' });

  const now = new Date().toISOString();
  const deletionUpdate = hasMetadata
    ? {
        encrypted_content: DELETED_CHAT_MESSAGE_CONTENT,
        deleted_at: now,
        deleted_by: user.username,
        pinned_at: null,
        pinned_by: null,
        updated_at: now
      }
    : { encrypted_content: DELETED_CHAT_MESSAGE_CONTENT };

  const { data: updated, error } = await supabaseAdmin
    .from('chat_messages')
    .update(deletionUpdate)
    .eq('id', id)
    .select(hasMetadata ? CHAT_MESSAGE_FIELDS : LEGACY_CHAT_MESSAGE_FIELDS)
    .single();
  if (error) return res.status(500).json({ error: 'Nachricht konnte nicht gelöscht werden' });
  res.json({ ok: true, message: publicChatMessage(updated) });
});

// POST /api/chat/messages/:id/pin — für die Gruppe eine Nachricht an- oder abpinnen
app.post('/api/chat/messages/:id/pin', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const shouldPin = req.body?.pinned !== false;
  const { data: msgRow, error: selectError } = await supabaseAdmin.from('chat_messages').select(CHAT_MESSAGE_FIELDS).eq('id', id).maybeSingle();
  if (selectError) return res.status(500).json({ error: 'DB Fehler' });
  if (!msgRow) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
  if (msgRow.deleted_at) return res.status(409).json({ error: 'Gelöschte Nachrichten können nicht angepinnt werden' });

  const { data: self } = await supabaseAdmin
    .from('chat_group_members')
    .select('username')
    .eq('group_id', msgRow.group_id)
    .eq('username', user.username)
    .maybeSingle();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });

  const now = new Date().toISOString();
  const clearedMessageIds = [];
  if (shouldPin) {
    const { data: previouslyPinned, error: clearError } = await supabaseAdmin
      .from('chat_messages')
      .update({ pinned_at: null, pinned_by: null, updated_at: now })
      .eq('group_id', msgRow.group_id)
      .neq('id', id)
      .not('pinned_at', 'is', null)
      .select('id');
    if (clearError) return res.status(500).json({ error: 'Angeheftete Nachricht konnte nicht aktualisiert werden' });
    for (const row of previouslyPinned || []) clearedMessageIds.push(String(row.id));
  }

  const { data: updated, error } = await supabaseAdmin
    .from('chat_messages')
    .update(shouldPin
      ? { pinned_at: now, pinned_by: user.username, updated_at: now }
      : { pinned_at: null, pinned_by: null, updated_at: now })
    .eq('id', id)
    .select(CHAT_MESSAGE_FIELDS)
    .single();
  if (error) return res.status(500).json({ error: 'Angepinnte Nachricht konnte nicht gespeichert werden' });
  res.json({ ok: true, message: publicChatMessage(updated), clearedMessageIds });
});

// ─── VirusTotal Integration ───────────────────────────────────────────────────
const VT_API_KEY = process.env.VIRUSTOTAL_API_KEY;
const VT_BASE = 'https://www.virustotal.com/api/v3';

// POST /api/admin/vt-scan  { url: <string> }
app.post('/api/admin/vt-scan', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }

  if (!VT_API_KEY) {
    return res.status(503).json({ error: 'VIRUSTOTAL_API_KEY nicht konfiguriert' });
  }

  const { url } = req.body;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Ungültige URL' });
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
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }

  if (!VT_API_KEY) {
    return res.status(503).json({ error: 'VIRUSTOTAL_API_KEY nicht konfiguriert' });
  }

  const { analysisId } = req.params;
  if (!analysisId || !/^[A-Za-z0-9_\-=+]+$/.test(analysisId)) {
    return res.status(400).json({ error: 'Ungültige Analyse-ID' });
  }

  try {
    const response = await fetch(`${VT_BASE}/analyses/${encodeURIComponent(analysisId)}`, {
      headers: { 'x-apikey': VT_API_KEY },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Ergebnis nicht verfügbar' });
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

// ─── Games Feed Proxy ────────────────────────────────────────────────────────
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
      return res.status(502).json({ error: 'Feed-Format ungültig' });
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
    console.log(`🚀 ehoser läuft auf http://localhost:${PORT}`);
    console.log(`📨 Connected to Supabase: ${SUPABASE_URL}`);
  });
}

// ─── reCAPTCHA Enterprise Verify ──────────────────────────────────────────────
app.post('/api/verify-captcha', async (req, res) => {
  const { token, action } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token fehlt' });

  const projectId = process.env.RECAPTCHA_PROJECT_ID;
  const apiKey    = process.env.RECAPTCHA_SECRET_KEY;
  const siteKey   = '6Lf6esksAAAAAA7p5xYYHCrJze9a_ng_BUKHXyom';

  // Ohne Konfiguration: immer erlauben (Fallback für lokale Entwicklung)
  if (!projectId || !apiKey) {
    console.warn('[reCAPTCHA] RECAPTCHA_PROJECT_ID oder RECAPTCHA_SECRET_KEY fehlt – Verifikation übersprungen');
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
    // Score < 0.3 →’ wahrscheinlich Bot
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

// ─── Email-Verknüpfung ────────────────────────────────────────────────────────
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
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
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
        subject: 'Dein ehoser Bestätigungscode',
        html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#0a1828;color:#fff;border-radius:16px">
          <div style="font-size:2rem;font-weight:900;color:#4d9fff">E</div>
          <h2 style="margin:8px 0 20px;font-size:1.4rem">E-Mail Bestätigung</h2>
          <p style="color:#aaa;margin:0 0 8px">Dein Bestätigungscode für ehoser:</p>
          <div style="font-size:2.8rem;font-weight:900;letter-spacing:0.35em;color:#4d9fff;padding:20px;background:#111827;border-radius:12px;text-align:center;margin:12px 0">${code}</div>
          <p style="color:#666;font-size:12px;margin-top:20px">Gültig für 10 Minuten. Wenn du das nicht angefordert hast, ignoriere diese Mail.</p>
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

// Public route to serve the standalone chat app
app.get('/chat', (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'public', 'chat', 'index.html'));
  } catch (e) { return res.status(500).send('Fehler beim Laden der Chat-Seite'); }
});

// Tägliches Login-Belohnung: 30 Credits / Tag, 30 Tage = 1 Monat Premium
app.post('/api/me/daily-claim', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  try {
    const profile = await getProfile(auth.username);
    const settings = { ...(profile.settings || {}) };
    const daily = { ...(settings.dailyLogin || {}) };
    const today = getOasisUsageDayKey(); // yyyy-mm-dd in configured tz
    const yesterday = getOasisUsageDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (daily.lastDay === today) {
      // Already claimed today
      return res.status(409).json({ error: 'Heute bereits eingelöst', nextClaimInMs: 24 * 60 * 60 * 1000 });
    }
    let streak = Number(daily.streak || 0);
    if (daily.lastDay === yesterday) {
      streak = streak + 1;
    } else {
      streak = 1;
    }
    // give credits
    const creditsGiven = 30;
    await changeCredits(auth.username, creditsGiven);
    const patch = { settings: { ...(settings || {}), dailyLogin: { lastDay: today, streak } } };
    let premiumGranted = false;
    if (streak >= 30) {
      // grant 30 days premium
      const now = Date.now();
      const currentPremiumMs = profile.premiumUntil ? Date.parse(profile.premiumUntil) : 0;
      const startMs = Math.max(now, currentPremiumMs);
      const newPremiumUntil = new Date(startMs + 30 * 24 * 60 * 60 * 1000).toISOString();
      patch.premiumUntil = newPremiumUntil;
      patch.settings.dailyLogin.streak = 0;
      premiumGranted = true;
    }
    const updated = await upsertProfile(auth.username, patch);
    return res.json({ success: true, streak: patch.settings.dailyLogin.streak || streak, creditsGiven, premiumGranted });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Einlösen: ' + (e.message || e) });
  }
});

// ─── Update-Abstimmung ────────────────────────────────────────────────────────
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

// Öffentlich: Vote-Status abrufen (für Frontend-Polling)
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
    // unlocked = globale Schwelle erreicht ODER User hat persönliche Freischaltung
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

  // Prüfen ob bereits abgestimmt (direkt aus DB, nicht über normalizeSettings)
  const { data: existing } = await supabaseAdmin
    .from('user_profiles')
    .select('update_vote')
    .eq('username', auth.username)
    .single();

  if (existing?.update_vote === true) {
    return res.status(409).json({ error: 'Du hast bereits abgestimmt.' });
  }

  // Stimme setzen (upsert, andere Felder unberührt lassen)
  const { error: upsertError } = await supabaseAdmin
    .from('user_profiles')
    .upsert({ username: auth.username, update_vote: true }, { onConflict: 'username' });

  if (upsertError) {
    return res.status(500).json({ error: 'Datenbankfehler: ' + upsertError.message });
  }

  const status = await getVoteStatus();
  res.json({ success: true, ...status, myVote: true });
});

// Admin: Abstimmungs-Übersicht
app.get('/api/admin/votes', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }
  try {
    const status = await getVoteStatus();
    res.json({ ...status, threshold: VOTE_THRESHOLD, remaining: Math.max(0, VOTE_THRESHOLD - status.count) });
  } catch {
    res.setHeader('x-admin-offline', '1');
    res.json({ count: 0, unlocked: false, voters: [], threshold: VOTE_THRESHOLD, remaining: VOTE_THRESHOLD });
  }
});

// ─── Psychologischer Support (PS) ────────────────────────────────────────────

// PS: 4 initiale Antworten analysieren →’ 5 personalisierte Folgefragen
app.post('/api/ps/analyze', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'KI nicht verfügbar' });

  const { name, answers } = req.body;
  if (!Array.isArray(answers) || answers.length < 4) {
    return res.status(400).json({ error: 'Antworten fehlen' });
  }

  const answersText = answers.map((a, i) => `Frage ${i + 1}: ${a.question}\nAntwort: ${a.answer}`).join('\n\n');

  const systemPrompt = `Du bist ein einfühlsamer, psychologisch geschulter KI-Assistent.\nAnalysiere die Umfrageantworten von "${name || 'dem Nutzer'}" und erstelle genau 10 personalisierte Folgefragen auf Deutsch, die tiefer auf emotionale Bedürfnisse und Sorgen eingehen.\nAntworte NUR mit einem JSON-Array mit 10 Strings. Kein anderer Text.\nBeispiel: ["Frage 1?", "Frage 2?", "Frage 3?", "Frage 4?", "Frage 5?", "Frage 6?", "Frage 7?", "Frage 8?", "Frage 9?", "Frage 10?"]`;

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
      'Was beschäftigt dich gerade am meisten?',
      'Gibt es Menschen in deinem Leben, mit denen du über deine Gefühle sprechen kannst?',
      'Wie schläfst du momentan?',
      'Was würde dir helfen, dich besser zu fühlen?',
      'Hast du das Gefühl, dass du Unterstützung brauchst?',
      'Gibt es Situationen, in denen du dich besonders unwohl fühlst?',
      'Wie gehst du normalerweise mit Stress um?',
      'Gibt es etwas, das du dir selbst gegenüber wünschst?',
      'Wie wichtig sind dir enge Beziehungen zu anderen Menschen?',
      'Was macht dich glücklich, auch wenn es gerade schwer fällt?'
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
  if (!groqKey) return res.status(500).json({ error: 'KI nicht verfügbar' });

  const { name, messages, allAnswersSummary } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  const systemPrompt = `Du bist ein einfühlsamer, psychologisch geschulter KI-Assistent auf der Plattform ehoser.\nDu hilfst ${name ? `"${name}"` : 'dem Nutzer'} dabei, Gefühle, Ängste und Sorgen zu verarbeiten.\nSei immer verständnisvoll, nicht wertend und ermutigend. Rede auf Deutsch, warm und natürlich.\nWenn ernsthafte psychische Probleme beschrieben werden: empfehle professionelle Hilfe.\nKrisentelefon Deutschland: 0800 111 0 111 (kostenlos, 24/7 erreichbar).\n${allAnswersSummary ? `\nHintergrund – Umfrageantworten des Nutzers:\n${allAnswersSummary}` : ''}`;

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
        heroLine: 'ehoser stellt gerade ruhigere, hilfreichere Wege für dich nach vorne.',
        summary: 'PS-Unterstützung wurde genutzt.'
      }
    );
    res.json({ reply: data.choices?.[0]?.message?.content || '' });
  } catch {
    res.status(502).json({ error: 'KI-Verbindungsfehler' });
  }
});

// ─── Spiele-KI: Spiel generieren ─────────────────────────────────────────────
app.post('/api/game/create', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  // Pro-Check
  const profile = await getProfile(auth.username);
  if (!profile.isPro) return res.status(403).json({ error: 'Diese Funktion erfordert PRO.' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'KI nicht verfügbar' });

  const { prompt, currentCode } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Kein Prompt' });

  const systemPrompt = `Du bist ein Experte für HTML5-Spieleentwicklung.
Erstelle ein vollständiges, spielbares Browserspiel als EINE einzige HTML-Datei.
Das Spiel muss alle CSS-Styles und JavaScript INLINE enthalten (kein externes Laden).
Anforderungen:
- Vollständig spielbar im Browser, kein Laden externer Ressourcen
- Canvas oder DOM-basiert, je nach Spieltyp
- Sauberer, moderner Code
- Spiel-Loop mit requestAnimationFrame wenn nötig
- Steuerung klar beschriftet (Tastatur/Maus)
- Responsives Layout (passt in iframe)
- Deutscher Text für UI-Elemente erlaubt
- Kein alert(), confirm() oder prompt() verwenden
WICHTIG: Antworte NUR mit dem kompletten HTML-Code. Kein erklärender Text davor oder danach. Beginne mit <!DOCTYPE html>.`;

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
      // Fallback auf llama wenn Modell nicht verfügbar
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

// ─── KI Proxy (Groq) ──────────────────────────────────────────────────────────
app.post('/api/ki/premium', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const profile = await ensurePlanCredits(auth.username);
  if (!profile.isPremium) {
    return res.status(403).json({ error: 'Premium Ehoser ist nur mit Premium freigeschaltet.' });
  }

  const openAIKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.API_KEY;
  if (!openAIKey) return res.status(500).json({ error: 'OPENAI_API_KEY nicht konfiguriert' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  const creditCost = countTextCredits(messages);
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

app.post('/api/learning/chat', async (req, res) => {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert' });

  const { messages, language = 'de' } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  const defaultSystemPrompt = [
    'Du bist Ehoser Learning, ein freundlicher Lern-Assistent für Sprachen, Grammatik und Übersetzungen.',
    'Antworte kurz, klar und lernorientiert.',
    'Wenn der Nutzer ein Wort oder einen Satz übersetzen will, gib die Übersetzung, eine kurze Erklärung, eine Aussprachehilfe und 1-2 Beispiel-Sätze.',
    'Wenn passend, nenne auch Artikel, Plural, Zeiten, Konjugation oder Grammatikregeln.',
    'Wenn die gewünschte Zielsprache nicht klar ist, frage kurz nach.',
    'Antworte standardmäßig auf Deutsch, außer die Aufgabe verlangt ausdrücklich eine andere Zielsprache.'
  ].join(' ');

  const systemPrompt = messages.find((msg) => msg.role === 'system')?.content || defaultSystemPrompt;
  const chatMessages = [
    { role: 'system', content: `${String(systemPrompt)}\n\nZusatz: Die gewünschte Lernsprache des Nutzers ist ${String(language || 'de')}.` },
    ...messages.filter((msg) => msg.role !== 'system')
  ];

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: chatMessages,
        stream: false,
        max_tokens: 700
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(groqRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('Learning Groq Error:', err);
    res.status(502).json({ error: 'Lern-KI-Verbindungsfehler' });
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
        content: `🚫 Dein Zugang zur KI ist wegen mehrfacher Verstöße für noch ${days} Tag(e) gesperrt.`
      }}]});
    }
  }

  try {
    // Safeguard: letzte Nutzer-Nachricht prüfen
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
              // Verstoß zählen
              let count = 1;
              if (username) {
                const prev = kiSafeguardViolations.get(username) || { count: 0 };
                count = prev.count + 1;
                if (count >= 3) {
                  kiSafeguardViolations.set(username, { count, blockedUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 });
                  return res.status(200).json({ choices: [{ message: { role: 'assistant',
                    content: '🚫 Du wurdest wegen 3 Verstößen gegen die Nutzungsrichtlinien für 7 Tage von der KI gesperrt.'
                  }}]});
                }
                kiSafeguardViolations.set(username, { count, blockedUntil: null });
                if (count === 2) {
                  return res.status(200).json({ choices: [{ message: { role: 'assistant',
                    content: '⚠️ **Letzte Warnung:** Deine Anfrage verstößt gegen die Nutzungsrichtlinien. Bei einem weiteren Verstoß wird dein KI-Zugang für 7 Tage gesperrt.'
                  }}]});
                }
              }
              // 1. Verstoß: KI antwortet über das Hauptmodell mit Ablehnung
              const refusalMessages = [
                ...messages.slice(0, -1),
                { role: 'system', content: 'Die Anfrage des Nutzers wurde von unserem Sicherheitssystem als problematisch eingestuft. Erkläre dem Nutzer freundlich aber bestimmt, dass du bei diesem Thema nicht helfen kannst. Gib keine Informationen zu dem angeforderten Thema.' },
                lastUserMsg
              ];
              try {
                const refRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
                  body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages: refusalMessages, stream: false, max_tokens: 300 })
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
    const model = hasImage ? 'llama-3.2-11b-vision-preview' : 'openai/gpt-oss-20b';

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
  if (!profile.isPremium) {
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

// Bild-Generierung (HuggingFace SDXL primär, Pollinations als Fallback)
app.get('/api/ki/image', async (req, res) => {
  const prompt = req.query.prompt;
  if (!prompt || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Kein Prompt angegeben' });
  }
  const seed = req.query.seed || Math.floor(Math.random() * 999999);
  const hfKey = process.env.HUGGINGFACE_API_KEY;
  const pollinationsKey = process.env.POLLINATIONS_API_KEY;
  const encodedPrompt = encodeURIComponent(prompt.slice(0, 500));

  try {
    // 1. Versuch: HuggingFace Stable Diffusion XL
    if (hfKey) {
      try {
        const hfRes = await fetch('https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfKey}`,
            'Content-Type': 'application/json',
            'x-wait-for-model': 'true'
          },
          body: JSON.stringify({ inputs: prompt.slice(0, 500), parameters: { seed: Number(seed) } })
        });
        if (hfRes.ok) {
          const contentType = hfRes.headers.get('content-type') || 'image/jpeg';
          if (contentType.startsWith('image/')) {
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            const buffer = await hfRes.arrayBuffer();
            return res.send(Buffer.from(buffer));
          }
        }
        // HF Fehler loggen aber weiter zu Fallback
        console.error('[HF] Status:', hfRes.status, await hfRes.text().catch(() => ''));
      } catch (hfErr) {
        console.error('[HF] Fehler:', hfErr.message);
      }
    }

    // 2. Fallback: Pollinations
    const urls = pollinationsKey
      ? [`https://gen.pollinations.ai/image/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}&key=${encodeURIComponent(pollinationsKey)}`]
      : [
          `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`,
          `https://gen.pollinations.ai/image/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`
        ];

    let imgRes;
    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        imgRes = await fetch(url, { headers: { 'User-Agent': 'ehoser-store/1.0' }, signal: ctrl.signal });
        clearTimeout(timer);
        if (imgRes.ok) break;
      } catch {}
    }
    if (!imgRes || !imgRes.ok) {
      return res.status(502).json({ error: 'Bildgenerierung fehlgeschlagen – kein Dienst verfügbar' });
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = await imgRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: 'Bildgenerierung fehlgeschlagen' });
  }
});

// Web links that do not exist get a helpful page instead of an Express error.
// API clients still receive JSON so integrations can reliably handle 404s.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API-Endpunkt nicht gefunden' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(404).json({ error: 'Seite nicht gefunden' });
  }
  return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

module.exports = app;

