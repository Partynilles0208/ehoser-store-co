const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const UNLOCK_CODE = '020818';
const ADMIN_UPLOAD_KEY = '135797531lol';
const TOKEN_EXPIRES_IN = '3650d'; // 10 Jahre – Token läuft praktisch nie ab
const PRO_BONUS_MS = 2 * 24 * 60 * 60 * 1000;

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;

// Supabase Init
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Fehler: SUPABASE_URL oder SUPABASE_KEY nicht gesetzt!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Admin-Client mit service_role key – umgeht RLS für Server-seitige Operationen
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Auto-Migration: Tabellen anlegen wenn nicht vorhanden
async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('⚠️  DATABASE_URL nicht gesetzt – Auto-Migration übersprungen.');
    console.warn('   Bitte folgendes SQL in Supabase > SQL-Editor ausführen:');
    console.warn(`
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NULL;
CREATE TABLE IF NOT EXISTS user_profiles (
  username TEXT PRIMARY KEY,
  settings JSONB DEFAULT '{}'::jsonb,
  pro_until TIMESTAMP NULL
);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS update_vote BOOLEAN DEFAULT FALSE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS update_unlocked BOOLEAN DEFAULT FALSE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS chat_token TEXT NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS ps_account BOOLEAN DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS referral_invites (
  code TEXT PRIMARY KEY,
  inviter_username TEXT NOT NULL,
  used_by TEXT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  used_at TIMESTAMP NULL
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
      CREATE TABLE IF NOT EXISTS user_profiles (
        username TEXT PRIMARY KEY,
        settings JSONB DEFAULT '{}'::jsonb,
        pro_until TIMESTAMP NULL
      );
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
      CREATE TABLE IF NOT EXISTS referral_invites (
        code TEXT PRIMARY KEY,
        inviter_username TEXT NOT NULL,
        used_by TEXT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        used_at TIMESTAMP NULL
      );
    `);
    console.log('✅ Datenbank-Tabellen überprüft/erstellt.');
  } catch (err) {
    console.error('⚠️  Auto-Migration fehlgeschlagen:', err.message);
  } finally {
    await pool.end();
  }
}

initDatabase();

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

function readAuthUser(req, res) {
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

function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    language: typeof src.language === 'string' ? src.language : 'de',
    design: typeof src.design === 'string' ? src.design : 'standard',
    energySaver: Boolean(src.energySaver),
    personalizationEnabled: src.personalizationEnabled !== false,
    personalization: normalizePersonalization(src.personalization)
  };
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
  const ms = proUntil ? Date.parse(proUntil) : 0;
  return {
    username,
    settings: normalizeSettings(profile.settings || profile.user_settings),
    proUntil: proUntil || null,
    isPro: Number.isFinite(ms) && ms > Date.now()
  };
}

async function getProfile(username) {
  // Primär: users Tabelle (existiert immer), optional: user_profiles für Settings
  let proUntil = null;
  let settings = null;
  let psAccount = false;

  // Pro-Status aus users Tabelle holen (primary storage)
  try {
    const { data } = await supabase
      .from('users')
      .select('pro_until')
      .eq('username', username)
      .single();
    if (data?.pro_until) proUntil = data.pro_until;
  } catch {}

  // Settings aus user_profiles holen (optional)
  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('settings, pro_until, ps_account')
      .eq('username', username)
      .single();
    if (!error && data) {
      settings = data.settings;
      psAccount = data.ps_account === true;
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

  const ms = proUntil ? Date.parse(proUntil) : 0;
  return {
    username,
    settings: normalizeSettings(settings || mem?.settings),
    proUntil: proUntil || null,
    isPro: Number.isFinite(ms) && ms > Date.now(),
    ps_account: psAccount || false
  };
}

async function upsertProfile(username, patch) {
  const current = await getProfile(username);
  const newProUntil = Object.prototype.hasOwnProperty.call(patch, 'proUntil') ? patch.proUntil : current.proUntil;
  const newSettings = patch.settings ? normalizeSettings(patch.settings) : current.settings;

  // Pro-Status in users Tabelle schreiben (primary – existiert garantiert)
  let savedToUsers = false;
  try {
    const { error } = await supabase
      .from('users')
      .update({ pro_until: newProUntil })
      .eq('username', username);
    if (!error) savedToUsers = true;
  } catch {}

  // Wenn users.pro_until Spalte fehlt → Auto-Spalte anlegen versuchen
  if (!savedToUsers) {
    try {
      // Spalte existiert nicht → in user_profiles speichern
      await supabaseAdmin.from('user_profiles').upsert({
        username,
        settings: newSettings,
        pro_until: newProUntil
      });
    } catch {
      // Letzter Fallback: Memory
      memoryProfiles.set(username, { settings: newSettings, proUntil: newProUntil, pro_until: newProUntil });
    }
  }

  // Settings immer in user_profiles speichern (Fehler ignorieren)
  try {
    await supabaseAdmin.from('user_profiles').upsert({ username, settings: newSettings, pro_until: newProUntil });
  } catch {}

  const ms = newProUntil ? Date.parse(newProUntil) : 0;
  return {
    username,
    settings: newSettings,
    proUntil: newProUntil || null,
    isPro: Number.isFinite(ms) && ms > Date.now()
  };
}

async function extendProFor(username, ms = PRO_BONUS_MS) {
  const profile = await getProfile(username);
  const from = profile.proUntil ? Date.parse(profile.proUntil) : 0;
  const base = Number.isFinite(from) && from > Date.now() ? from : Date.now();
  const next = new Date(base + ms).toISOString();
  return upsertProfile(username, { proUntil: next });
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

    // Falls password_hash Spalte nicht existiert → nochmal ohne versuchen
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
          // loginCode stimmt → durchlassen
        }
        // passwordOk → weiter
      } else if (loginCode && data.access_code === loginCode) {
        // Altes Konto ohne Passwort, aber Login-Code stimmt → OK
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

    res.json({
      success: true,
      token,
      userId: data.id,
      profile,
      redirectToAdmin: isAdmin
    });
  } catch (error) {
    console.error('Login Error:', error);
    const msg = error?.message || JSON.stringify(error) || 'Unbekannter Fehler';
    res.status(500).json({ error: `Anmeldung fehlgeschlagen: ${msg}` });
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
    // last_seen aktualisieren (Fehler ignorieren)
    try { await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', decoded.id); } catch {}
    const refreshedToken = jwt.sign(
      { id: decoded.id, username: decoded.username, isAdmin: Boolean(decoded.isAdmin) },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );
    const profile = await getProfile(decoded.username);
    res.json({ valid: true, user: decoded, token: refreshedToken, profile });
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
  const profile = await getProfile(auth.username);
  // email aus users-Tabelle lesen
  let email = null;
  try {
    const { data } = await supabase.from('users').select('email').eq('id', auth.id).single();
    email = data?.email || null;
  } catch {}
  res.json({
    user: {
      id: auth.id,
      username: auth.username,
      isAdmin: Boolean(auth.isAdmin),
      email
    },
    profile
  });
});

// Einstellungen speichern
app.put('/api/me/settings', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;
  const current = await getProfile(auth.username);
  const settings = normalizeSettings({
    ...(req.body || {}),
    personalization: current.settings?.personalization
  });
  const profile = await upsertProfile(auth.username, { settings });
  res.json({ ok: true, profile });
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

// Online-Nutzer (letzte 5 Minuten)
app.get('/api/online-users', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Ungültiger Token' });
  }

  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('users')
    .select('username')
    .gte('last_seen', since)
    .order('last_seen', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
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
    res.status(401).json({ error: 'Ungültiger Token' });
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
        is_pro: profile.isPro,
        update_unlocked: up?.update_unlocked === true,
        ps_account: up?.ps_account === true
      });
    }
    res.json(users);
  } catch (error) {
    console.error('Admin Users Error:', error);
    res.status(500).json({ error: 'Nutzer konnten nicht geladen werden' });
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
    res.status(500).json({ error: 'Reset-Anfragen konnten nicht geladen werden' });
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
  if (adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });

  const { username, offer } = req.body;
  if (!username || !offer) return res.status(400).json({ error: 'username und offer erforderlich' });

  // End existing sessions for this user
  await supabase.from('screen_sessions')
    .update({ status: 'ended' })
    .eq('username', username)
    .in('status', ['pending', 'active']);

  const sessionId = crypto.randomUUID();
  const { error } = await supabase.from('screen_sessions').insert({
    id: sessionId, username, status: 'pending', offer: JSON.stringify(offer)
  });

  if (error) {
    console.error('Screen session error:', error);
    return res.status(500).json({ error: 'Tabelle screen_sessions fehlt. Bitte in Supabase anlegen.' });
  }
  res.json({ sessionId });
});

// GET /api/screenshare/pending  — Nutzer fragt ob Anfrage vorliegt
app.get('/api/screenshare/pending', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { data } = await supabase
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
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { sessionId, answer, accept } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId fehlt' });

    const { data: session } = await supabase
      .from('screen_sessions').select('username').eq('id', sessionId).single();
    if (!session || session.username !== decoded.username)
      return res.status(403).json({ error: 'Session nicht gefunden' });

    if (!accept) {
      await supabase.from('screen_sessions').update({ status: 'declined' }).eq('id', sessionId);
      return res.json({ ok: true });
    }
    await supabase.from('screen_sessions')
      .update({ status: 'active', answer: JSON.stringify(answer) }).eq('id', sessionId);
    res.json({ ok: true });
  } catch {
    return res.status(401).json({ error: 'Fehler' });
  }
});

// GET /api/admin/screenshare/session/:sessionId  — Admin fragt Status ab
app.get('/api/admin/screenshare/session/:sessionId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });

  const { data } = await supabase
    .from('screen_sessions').select('status, answer').eq('id', req.params.sessionId).single();
  if (!data) return res.status(404).json({ error: 'Session nicht gefunden' });
  res.json({ status: data.status, answer: data.answer ? JSON.parse(data.answer) : null });
});

// POST /api/admin/screenshare/end/:sessionId  — Admin beendet Session
app.post('/api/admin/screenshare/end/:sessionId', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_UPLOAD_KEY) return res.status(403).json({ error: 'Nicht autorisiert' });
  await supabase.from('screen_sessions').update({ status: 'ended' }).eq('id', req.params.sessionId);
  res.json({ ok: true });
});

// POST /api/screenshare/end  — Nutzer beendet Session
app.post('/api/screenshare/end', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { sessionId } = req.body;
    if (sessionId) {
      await supabase.from('screen_sessions')
        .update({ status: 'ended' }).eq('id', sessionId).eq('username', decoded.username);
    }
    res.json({ ok: true });
  } catch {
    return res.status(401).json({ error: 'Fehler' });
  }
});

// ─── Chat API (E2E verschlüsselt) ────────────────────────────────────────────

// Multer – memory storage für Supabase-Upload
const CHAT_ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/gif','image/webp',
  'video/mp4','video/webm','video/quicktime',
  'audio/webm','audio/ogg','audio/mpeg','audio/wav',
  'application/pdf'
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

// POST /api/chat/upload — Mediendatei hochladen (Bild / Video / Audio)
app.post('/api/chat/upload', chatUpload.single('file'), async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  if (!req.file) return res.status(400).json({ error: 'Keine Datei oder Typ nicht erlaubt (max 50 MB)' });

  const ext = req.file.originalname.split('.').pop().replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
  const filename = `${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from('chat-media')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });

  if (error) return res.status(500).json({ error: 'Upload fehlgeschlagen: ' + error.message });

  const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(filename);
  res.json({ url: publicUrl, mime: req.file.mimetype, size: req.file.size, name: req.file.originalname });
});

// POST /api/chat/key — eigenen ECDH Public Key hochladen/aktualisieren
app.post('/api/chat/key', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { publicKey } = req.body;
  if (!publicKey || typeof publicKey !== 'string' || publicKey.length > 4096) {
    return res.status(400).json({ error: 'Ungültiger Public Key' });
  }
  try { JSON.parse(publicKey); } catch { return res.status(400).json({ error: 'Public Key muss valides JSON sein' }); }
  const { error } = await supabase.from('chat_user_keys').upsert({ username: user.username, public_key: publicKey });
  if (error) return res.status(500).json({ error: 'Fehler beim Speichern' });
  res.json({ ok: true });
});

// GET /api/chat/key/:username — Public Key eines Nutzers abrufen
app.get('/api/chat/key/:username', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { username } = req.params;
  if (!/^[a-zA-Z0-9_\-]{1,32}$/.test(username)) return res.status(400).json({ error: 'Ungültiger Nutzername' });
  const { data } = await supabase.from('chat_user_keys').select('public_key').eq('username', username).single();
  if (!data) return res.status(404).json({ error: 'Kein Public Key gefunden – Nutzer muss Chat einmal geöffnet haben' });
  res.json({ publicKey: data.public_key });
});

// GET /api/chat/users/search?q= — Nutzer suchen (min. 2 Zeichen)
app.get('/api/chat/users/search', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ users: [] });
  const { data } = await supabase.from('users').select('username').ilike('username', `%${q}%`).limit(10);
  const users = (data || []).map(u => u.username).filter(u => u !== user.username);
  res.json({ users });
});

// POST /api/chat/groups — neue Gruppe erstellen
// Body: { name, memberKeys: { username: encryptedGroupKeyJson } }
app.post('/api/chat/groups', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { name, memberKeys } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.length > 50) {
    return res.status(400).json({ error: 'Ungültiger Gruppenname (1-50 Zeichen)' });
  }
  if (!memberKeys || typeof memberKeys !== 'object' || Array.isArray(memberKeys)) {
    return res.status(400).json({ error: 'memberKeys fehlt' });
  }
  if (!memberKeys[user.username]) {
    return res.status(400).json({ error: 'Eigener Schlüssel muss enthalten sein' });
  }
  const id = crypto.randomUUID();
  const { error: gErr } = await supabase.from('chat_groups').insert({ id, name: name.trim(), created_by: user.username });
  if (gErr) return res.status(500).json({ error: 'Fehler beim Erstellen der Gruppe' });

  const rows = Object.entries(memberKeys).map(([username, encKey]) => ({
    group_id: id, username, encrypted_group_key: String(encKey).substring(0, 8192)
  }));
  const { error: mErr } = await supabase.from('chat_group_members').insert(rows);
  if (mErr) {
    await supabase.from('chat_groups').delete().eq('id', id);
    return res.status(500).json({ error: 'Fehler beim Hinzufügen der Mitglieder' });
  }
  res.json({ id, name: name.trim() });
});

// GET /api/chat/groups — eigene Gruppen abrufen
app.get('/api/chat/groups', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { data: memberships } = await supabase.from('chat_group_members').select('group_id').eq('username', user.username);
  if (!memberships?.length) return res.json({ groups: [] });
  const ids = memberships.map(m => m.group_id);
  const { data: groups } = await supabase.from('chat_groups').select('id,name,created_by,created_at').in('id', ids).order('created_at', { ascending: false });
  res.json({ groups: groups || [] });
});

// GET /api/chat/groups/:id/key — eigenen verschlüsselten Gruppenschlüssel abrufen
app.get('/api/chat/groups/:id/key', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { data } = await supabase.from('chat_group_members').select('encrypted_group_key').eq('group_id', id).eq('username', user.username).single();
  if (!data) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  res.json({ encryptedGroupKey: data.encrypted_group_key });
});

// GET /api/chat/groups/:id/members — Mitgliederliste abrufen
app.get('/api/chat/groups/:id/members', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { data: self } = await supabase.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  const { data } = await supabase.from('chat_group_members').select('username,joined_at').eq('group_id', id);
  res.json({ members: data || [] });
});

// POST /api/chat/groups/:id/members — neues Mitglied hinzufügen
// Body: { username, encryptedGroupKey }
app.post('/api/chat/groups/:id/members', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { id } = req.params;
  const { username, encryptedGroupKey } = req.body;
  if (!username || !encryptedGroupKey) return res.status(400).json({ error: 'username und encryptedGroupKey erforderlich' });
  // Muss selbst Mitglied sein
  const { data: self } = await supabase.from('chat_group_members').select('username').eq('group_id', id).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  // Ziel-Nutzer muss existieren
  const { data: target } = await supabase.from('users').select('username').eq('username', username).single();
  if (!target) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  // Bereits Mitglied?
  const { data: existing } = await supabase.from('chat_group_members').select('username').eq('group_id', id).eq('username', username).single();
  if (existing) return res.status(409).json({ error: 'Nutzer ist bereits Mitglied' });
  const { error } = await supabase.from('chat_group_members').insert({ group_id: id, username, encrypted_group_key: String(encryptedGroupKey).substring(0, 8192) });
  if (error) return res.status(500).json({ error: 'Fehler beim Hinzufügen' });
  res.json({ ok: true });
});

// POST /api/chat/messages — Nachricht senden (verschlüsselt)
app.post('/api/chat/messages', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId, encryptedContent } = req.body;
  if (!groupId || !encryptedContent || typeof encryptedContent !== 'string' || encryptedContent.length > 65536) {
    return res.status(400).json({ error: 'Ungültige Nachricht' });
  }
  // Muss Mitglied sein
  const { data: self } = await supabase.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied dieser Gruppe' });
  const { data, error } = await supabase.from('chat_messages').insert({ group_id: groupId, sender: user.username, encrypted_content: encryptedContent }).select('id,created_at').single();
  if (error) return res.status(500).json({ error: 'Fehler beim Senden' });
  res.json({ id: data.id, created_at: data.created_at });
});

// GET /api/chat/messages/:groupId?after=<id> — Nachrichten abrufen (polling)
app.get('/api/chat/messages/:groupId', async (req, res) => {
  const user = chatAuth(req, res); if (!user) return;
  const { groupId } = req.params;
  const after = parseInt(req.query.after) || 0;
  // Muss Mitglied sein
  const { data: self } = await supabase.from('chat_group_members').select('username').eq('group_id', groupId).eq('username', user.username).single();
  if (!self) return res.status(403).json({ error: 'Nicht Mitglied' });
  let query = supabase.from('chat_messages').select('id,sender,encrypted_content,created_at').eq('group_id', groupId).order('id', { ascending: true }).limit(50);
  if (after) query = query.gt('id', after);
  const { data } = await query;
  res.json({ messages: data || [] });
});

// ─── VirusTotal Integration ───────────────────────────────────────────────────
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
  if (adminKey !== ADMIN_UPLOAD_KEY) {
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

app.get('/api/games', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `games_p${page}`;

  // Einfaches In-Memory-Cache
  if (gamesCache && gamesCache[cacheKey] && Date.now() - gamesCacheTime < GAMES_CACHE_TTL) {
    return res.json(gamesCache[cacheKey]);
  }

  try {
    const feedUrl = `https://gamemonetize.com/feed.php?format=0&page=${page}`;
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
    console.log(`📊 Connected to Supabase: ${SUPABASE_URL}`);
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
    // Score < 0.3 → wahrscheinlich Bot
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
  const status = await getVoteStatus();
  res.json({ ...status, threshold: VOTE_THRESHOLD, remaining: Math.max(0, VOTE_THRESHOLD - status.count) });
});

// ─── Psychologischer Support (PS) ────────────────────────────────────────────

// PS: 4 initiale Antworten analysieren → 5 personalisierte Folgefragen
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
    if (!groqRes.ok) return res.status(groqRes.status).json(data);

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

// ─── KI Proxy (Groq) ──────────────────────────────────────────────────────────
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

  // Gesperrt?
  if (username) {
    const v = kiSafeguardViolations.get(username);
    if (v?.blockedUntil && v.blockedUntil > Date.now()) {
      const days = Math.ceil((v.blockedUntil - Date.now()) / 86400000);
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
    res.status(502).json({ error: 'Verbindungsfehler zur Groq API' });
  }
});

  // Hugging Face Video-KI: Wan2.2 Text-to-Video
app.post('/api/ki/video/create', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Kein Prompt' });
    const apiKey = process.env.HUGGINGFACE_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'HUGGINGFACE_API_KEY nicht konfiguriert' });
  try {
      const r = await fetch('https://api-inference.huggingface.co/models/Wan-AI/Wan2.2-T2V-A14B', {
      method: 'POST',
      headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'video/mp4',
          'x-wait-for-model': 'true'
      },
        body: JSON.stringify({
          inputs: prompt.slice(0, 500),
          parameters: {
            num_frames: 81,
            num_inference_steps: 30,
            guidance_scale: 5,
            negative_prompt: [
              'blurry',
              'low quality',
              'distorted',
              'glitch',
              'text watermark'
            ]
          }
        })
    });

      if (!r.ok) {
        const contentType = r.headers.get('content-type') || '';
        let error = 'Hugging Face Video-Generierung fehlgeschlagen';
        try {
          if (contentType.includes('application/json')) {
            const data = await r.json();
            error = data.error || data.estimated_time || error;
          } else {
            const text = await r.text();
            if (text) error = text;
          }
        } catch {}
        return res.status(502).json({ error });
    }

      const contentType = r.headers.get('content-type') || 'video/mp4';
      if (!contentType.startsWith('video/')) {
        const text = await r.text().catch(() => '');
        return res.status(502).json({ error: text || 'Antwort war kein Video' });
      }

      const buffer = await r.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(buffer));
  } catch (err) {
      res.status(502).json({ error: 'Verbindungsfehler zu Hugging Face' });
  }
});

  // Alter Polling-Endpunkt wird nicht mehr verwendet, da HF das Video direkt liefert.
app.get('/api/ki/video/:id/status', async (req, res) => {
    res.status(410).json({ error: 'Status-Polling wird nicht mehr verwendet. Video wird direkt erzeugt.' });
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

module.exports = app;
