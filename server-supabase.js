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
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
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

// Neue App hochladen (Admin)
app.post('/api/admin/apps', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'apk', maxCount: 1 }]), async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Ungültiger Admin-Key' });
  }

  const { name, description, category, version, sourceUrl } = req.body;
  const iconFile = req.files?.icon?.[0];
  const apkFile = req.files?.apk?.[0];

  if (!name || !description || !category || !version) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }

  if (!iconFile || !apkFile) {
    return res.status(400).json({ error: 'Icon und APK sind Pflicht.' });
  }

  try {
    // Upload Icon zu Supabase Storage
    const iconFileName = `${Date.now()}-${iconFile.originalname}`;
    const iconBuffer = fs.readFileSync(iconFile.path);
    const { error: iconError } = await supabase.storage
      .from('app-icons')
      .upload(iconFileName, iconBuffer, {
        cacheControl: '3600',
        upsert: false
      });

    if (iconError) {
      console.error('Icon Upload Error:', iconError);
      throw new Error('Icon Upload fehlgeschlagen');
    }

    // Upload APK zu Supabase Storage
    const apkFileName = `${Date.now()}-${apkFile.originalname}`;
    const apkBuffer = fs.readFileSync(apkFile.path);
    const { error: apkError } = await supabase.storage
      .from('app-apks')
      .upload(apkFileName, apkBuffer, {
        cacheControl: '3600',
        upsert: false
      });

    if (apkError) {
      console.error('APK Upload Error:', apkError);
      throw new Error('APK Upload fehlgeschlagen');
    }

    // Öffentliche URLs generieren
    const { data: iconData } = supabase.storage
      .from('app-icons')
      .getPublicUrl(iconFileName);
    const iconUrl = iconData.publicUrl;

    const { data: apkData } = supabase.storage
      .from('app-apks')
      .getPublicUrl(apkFileName);
    const downloadUrl = apkData.publicUrl;

    // App in Datenbank speichern
    const { data, error: insertError } = await supabase
      .from('apps')
      .insert([
        {
          name,
          description,
          category,
          version,
          icon_url: iconUrl,
          download_url: downloadUrl,
          source_url: sourceUrl || null
        }
      ])
      .select();

    if (insertError) {
      console.error('Insert Error:', insertError);
      throw insertError;
    }

    // Temp Files löschen
    try {
      fs.unlinkSync(iconFile.path);
      fs.unlinkSync(apkFile.path);
    } catch (e) {
      // Ignorieren
    }

    res.status(201).json({
      success: true,
      message: 'App erfolgreich hochgeladen.',
      app: data[0]
    });
  } catch (error) {
    console.error('Admin Upload Error:', error);
    
    // Temp Files löschen im Error-Fall
    try {
      if (iconFile) fs.unlinkSync(iconFile.path);
      if (apkFile) fs.unlinkSync(apkFile.path);
    } catch (e) {
      // Ignorieren
    }

    res.status(500).json({ error: error.message || 'Fehler beim Hochladen' });
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
