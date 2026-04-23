const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const ADMIN_UPLOAD_KEY = process.env.ADMIN_UPLOAD_KEY || 'change-this-admin-key';

// Supabase Init
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Fehler: SUPABASE_URL oder SUPABASE_KEY nicht gesetzt!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// File Upload (temp folder) — /tmp auf Vercel, lokaler Ordner sonst
const uploadsRoot = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsRoot);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
    cb(null, fileName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 200
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'icon') {
      if (!file.mimetype.startsWith('image/')) {
        cb(new Error('Icon muss ein Bild sein.'));
        return;
      }
      cb(null, true);
      return;
    }

    if (file.fieldname === 'apk') {
      const allowed = [
        'application/vnd.android.package-archive',
        'application/octet-stream'
      ];
      const isApkName = file.originalname.toLowerCase().endsWith('.apk');
      if (!isApkName && !allowed.includes(file.mimetype)) {
        cb(new Error('Datei muss eine .apk sein.'));
        return;
      }
      cb(null, true);
      return;
    }

    cb(new Error('Ungültiger Dateityp.'));
  }
});

// API Routes

// Registrierung
app.post('/api/register', async (req, res) => {
  const { accessCode, username, email } = req.body;
  const isAdmin = accessCode === ADMIN_UPLOAD_KEY;

  if (!accessCode || accessCode.length < 6) {
    return res.status(400).json({ error: 'Ungültiger Zugangscode' });
  }

  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Benutzername muss mindestens 3 Zeichen lang sein' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          username,
          email: email || null,
          access_code: accessCode,
          verified: 1
        }
      ])
      .select();

    if (error) {
      if (error.message.includes('duplicate')) {
        return res.status(400).json({ error: 'Benutzer oder Code existiert bereits' });
      }
      throw error;
    }

    const userId = data[0].id;
    const token = jwt.sign(
      { id: userId, username, isAdmin },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Erfolgreich registriert!',
      token,
      userId,
      redirectToAdmin: isAdmin
    });
  } catch (error) {
    console.error('Register Error:', error);
    const msg = error?.message || error?.details || error?.hint || JSON.stringify(error) || 'Unbekannter Fehler';
    res.status(500).json({ error: `Registrierung fehlgeschlagen: ${msg}` });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, accessCode } = req.body;

  if (!username || !accessCode) {
    return res.status(400).json({ error: 'Benutzername und Zugangscode erforderlich' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('access_code', accessCode)
      .single();

    if (error || !data) {
      return res.status(401).json({ error: 'Benutzername oder Zugangscode falsch' });
    }

    const isAdmin = accessCode === ADMIN_UPLOAD_KEY;
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

// Token verifizieren
app.post('/api/verify-token', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Kein Token vorhanden' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch (err) {
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
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload-Fehler: ${err.message}` });
  }

  if (err) {
    return res.status(400).json({ error: err.message || 'Unbekannter Fehler' });
  }

  next();
});

// Server starten (lokal) oder als Vercel-Handler exportieren
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 ehoser shop läuft auf http://localhost:${PORT}`);
    console.log(`📊 Connected to Supabase: ${SUPABASE_URL}`);
  });
}

module.exports = app;
