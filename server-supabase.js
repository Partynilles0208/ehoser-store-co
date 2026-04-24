const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const UNLOCK_CODE = '020818';
const ADMIN_UPLOAD_KEY = 'nils2014!';

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// Registrierung
app.post('/api/register', async (req, res) => {
  const { unlockCode, username, email } = req.body;
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

  const loginCode = createLoginCode();

  try {
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          username,
          email: email || null,
          access_code: loginCode,
          verified: 1
        }
      ])
      .select();

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
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Erfolgreich registriert!',
      token,
      userId,
      loginCode,
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
  const { username, loginCode, unlockCode } = req.body;
  const clientKey = `login:${req.ip || 'unknown'}`;

  if (isRateLimited(clientKey)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte spaeter erneut probieren.' });
  }

  if (unlockCode !== UNLOCK_CODE) {
    registerFailedAttempt(clientKey);
    return res.status(403).json({ error: 'Entsperrcode ist falsch.' });
  }

  if (!username || !loginCode) {
    return res.status(400).json({ error: 'Benutzername und Login-Code erforderlich' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('access_code', loginCode)
      .single();

    if (error || !data) {
      registerFailedAttempt(clientKey);
      return res.status(401).json({ error: 'Benutzername oder Login-Code falsch' });
    }

    clearAttempts(clientKey);

    await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', data.id).catch(() => {});

    const isAdmin = false;
    const token = jwt.sign(
      { id: data.id, username: data.username, isAdmin },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      userId: data.id,
      redirectToAdmin: isAdmin
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
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

// Token verifizieren + last_seen aktualisieren
app.post('/api/verify-token', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Kein Token vorhanden' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // last_seen aktualisieren (Fehler ignorieren)
    await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', decoded.id).catch(() => {});
    res.json({ valid: true, user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Ungültiger Token' });
  }
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
    res.json(data || []);
  } catch (error) {
    console.error('Admin Users Error:', error);
    res.status(500).json({ error: 'Nutzer konnten nicht geladen werden' });
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

module.exports = app;
