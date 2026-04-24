const express = require('express');
const cors = require('cors');
const path = require('path');
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

// Server starten (lokal) oder als Vercel-Handler exportieren
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 ehoser läuft auf http://localhost:${PORT}`);
    console.log(`📊 Connected to Supabase: ${SUPABASE_URL}`);
  });
}

module.exports = app;
