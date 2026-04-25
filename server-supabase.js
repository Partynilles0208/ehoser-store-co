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
const ADMIN_UPLOAD_KEY = 'nils2014!';
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

function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    language: typeof src.language === 'string' ? src.language : 'de',
    design: typeof src.design === 'string' ? src.design : 'standard',
    energySaver: Boolean(src.energySaver)
  };
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
    const { data, error } = await supabase
      .from('user_profiles')
      .select('settings, pro_until')
      .eq('username', username)
      .single();
    if (!error && data) {
      settings = data.settings;
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
    isPro: Number.isFinite(ms) && ms > Date.now()
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
      await supabase.from('user_profiles').upsert({
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
    await supabase.from('user_profiles').upsert({ username, settings: newSettings, pro_until: newProUntil });
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
app.use(express.static(path.join(__dirname, 'public')));

// Öffentliche Client-Konfiguration (kein Authentifizierungs-Token nötig)
app.get('/api/config', (req, res) => {
  res.json({
    ytApiKey: process.env.YT_API_KEY || ''
  });
});

// API Routes

// Registrierung
app.post('/api/register', async (req, res) => {
  const { unlockCode, username, email, referralCode, password } = req.body;
  const clientKey = `register:${req.ip || 'unknown'}`;

  if (isRateLimited(clientKey)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte spaeter erneut probieren.' });
  }

  if (unlockCode !== UNLOCK_CODE) {
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

  if (unlockCode !== UNLOCK_CODE) {
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
  const settings = normalizeSettings(req.body || {});
  const profile = await upsertProfile(auth.username, { settings });
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
      users.push({
        ...userRow,
        pro_until: profile.proUntil,
        is_pro: profile.isPro
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

// ─── reCAPTCHA Verify ─────────────────────────────────────────────────────────
app.post('/api/verify-captcha', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token fehlt' });

  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return res.status(500).json({ success: false, error: 'RECAPTCHA_SECRET_KEY nicht konfiguriert' });
  try {
    const response = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`,
      { method: 'POST' }
    );
    const data = await response.json();
    if (data.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Captcha ungültig' });
    }
  } catch (err) {
    res.status(502).json({ success: false, error: 'Captcha-Verifikation fehlgeschlagen' });
  }
});

// ─── Email-Verknüpfung ────────────────────────────────────────────────────────
const emailCodes = new Map(); // userId → { code, email, expires, attempts }

app.post('/api/me/link-email', async (req, res) => {
  const auth = readAuthUser(req, res);
  if (!auth) return;

  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
  }

  // Rate limit: max 1 neuer Code pro 60s
  const existing = emailCodes.get(auth.id);
  if (existing && (existing.expires - 9 * 60 * 1000) > Date.now()) {
    return res.status(429).json({ error: 'Bitte warte kurz, bevor du einen neuen Code anforderst.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  emailCodes.set(auth.id, { code, email, expires: Date.now() + 10 * 60 * 1000, attempts: 0 });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log(`[DEV] Email-Code fuer ${auth.username} (${email}): ${code}`);
    return res.json({ success: true });
  }

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
  const stored = emailCodes.get(auth.id);

  if (!stored || stored.expires < Date.now()) {
    emailCodes.delete(auth.id);
    return res.status(400).json({ error: 'Code abgelaufen. Bitte neuen Code anfordern.' });
  }

  stored.attempts = (stored.attempts || 0) + 1;
  if (stored.attempts > 5) {
    emailCodes.delete(auth.id);
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte neuen Code anfordern.' });
  }

  if (stored.code !== String(code).trim()) {
    return res.status(400).json({ error: `Falscher Code. Noch ${6 - stored.attempts} Versuche.` });
  }

  emailCodes.delete(auth.id);

  const { error } = await supabase.from('users').update({ email: stored.email }).eq('id', auth.id);
  if (error) return res.status(500).json({ error: 'E-Mail konnte nicht gespeichert werden.' });

  res.json({ success: true, email: stored.email });
});

// ─── KI Proxy (Groq) ──────────────────────────────────────────────────────────
app.post('/api/ki', async (req, res) => {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages fehlt' });
  }

  try {
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
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Verbindungsfehler zur Groq API' });
  }
});

module.exports = app;
