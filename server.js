const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const ADMIN_UPLOAD_KEY = process.env.ADMIN_UPLOAD_KEY || 'change-this-admin-key';
const uploadsRoot = path.join(__dirname, 'uploads');
const iconsDir = path.join(uploadsRoot, 'icons');
const apksDir = path.join(uploadsRoot, 'apks');

fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(apksDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'icon') {
      cb(null, iconsDir);
      return;
    }
    cb(null, apksDir);
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsRoot));

// Datenbank initialisieren
const db = new sqlite3.Database('./store.db', (err) => {
  if (err) console.error('DB Error:', err);
  else console.log('Datenbank verbunden');
});

// Tabellen erstellen
db.serialize(() => {
  // Benutzertabelle
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT,
    access_code TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified INTEGER DEFAULT 0
  )`);

  // Apps Tabelle
  db.run(`CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    version TEXT,
    icon_url TEXT,
    download_url TEXT,
    source_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Installationen Tabelle
  db.run(`CREATE TABLE IF NOT EXISTS installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    app_id INTEGER,
    installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(app_id) REFERENCES apps(id)
  )`);
});

const ensureColumnExists = (table, column, definition) => {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) {
      console.error('Fehler beim Lesen des Schemas:', err.message);
      return;
    }

    const hasColumn = rows.some((row) => row.name === column);
    if (!hasColumn) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (alterErr) => {
        if (alterErr) {
          console.error(`Fehler beim Hinzufügen der Spalte ${column}:`, alterErr.message);
        }
      });
    }
  });
};

ensureColumnExists('apps', 'source_url', 'TEXT');

const removeSeededDemoApps = () => {
  db.all('PRAGMA table_info(apps)', (schemaErr, rows) => {
    if (schemaErr) {
      console.error('Fehler beim Prüfen des app-Schemas:', schemaErr.message);
      return;
    }

    const hasSourceUrl = rows.some((row) => row.name === 'source_url');
    const fallbackNames = [
      'Photo Editor Pro',
      'Code Studio',
      'Video Master',
      'Data Analyzer',
      'Security Suite',
      'Cloud Sync Pro'
    ];

    const sql = hasSourceUrl
      ? "DELETE FROM apps WHERE source_url LIKE 'https://example.com/%' OR name IN (?, ?, ?, ?, ?, ?)"
      : 'DELETE FROM apps WHERE name IN (?, ?, ?, ?, ?, ?)';

    db.run(sql, fallbackNames, function onDelete(err) {
      if (err) {
        console.error('Fehler beim Entfernen von Demo-Apps:', err.message);
        return;
      }

      if (this.changes > 0) {
        console.log(`${this.changes} Demo-Apps entfernt.`);
      }
    });
  });
};

removeSeededDemoApps();

// API Routes

// Zugangscode überprüfen und Benutzer registrieren
app.post('/api/register', (req, res) => {
  const { accessCode, username, email } = req.body;
  const isAdmin = accessCode === 'Nils2014!';

  // Hier würdest du normalerweise die Codes validieren
  // Für Demo: Alle Codes mit 6 Ziffern akzeptieren
  if (!accessCode || accessCode.length < 6) {
    return res.status(400).json({ error: 'Ungültiger Zugangscode' });
  }

  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Benutzername muss mindestens 3 Zeichen lang sein' });
  }

  db.run(
    `INSERT INTO users (username, email, access_code, verified) VALUES (?, ?, ?, 1)`,
    [username, email, accessCode],
    function(err) {
      if (err) {
        return res.status(400).json({ error: 'Benutzer existiert bereits oder Code wurde bereits verwendet' });
      }

      const token = jwt.sign(
        { id: this.lastID, username, isAdmin },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        success: true,
        message: 'Erfolgreich registriert!',
        token,
        userId: this.lastID,
        redirectToAdmin: isAdmin
      });
    }
  );
});

// Token validieren
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
app.get('/api/apps', (req, res) => {
  db.all('SELECT * FROM apps ORDER BY created_at DESC, id DESC', (err, apps) => {
    if (err) return res.status(500).json({ error: 'Datenbankfehler' });
    res.json(apps);
  });
});

// App Details
app.get('/api/apps/:id', (req, res) => {
  db.get('SELECT * FROM apps WHERE id = ?', [req.params.id], (err, app) => {
    if (err) return res.status(500).json({ error: 'Datenbankfehler' });
    if (!app) return res.status(404).json({ error: 'App nicht gefunden' });
    res.json(app);
  });
});

// Neue App (Admin Upload)
app.post('/api/admin/apps', upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'apk', maxCount: 1 }]), (req, res) => {
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

  const iconUrl = `/uploads/icons/${iconFile.filename}`;
  const downloadUrl = `/uploads/apks/${apkFile.filename}`;

  db.run(
    `INSERT INTO apps (name, description, category, version, icon_url, download_url, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, description, category, version, iconUrl, downloadUrl, sourceUrl || null],
    function insertApp(err) {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Speichern der App.' });
      }

      db.get('SELECT * FROM apps WHERE id = ?', [this.lastID], (selectErr, appRow) => {
        if (selectErr) {
          return res.status(500).json({ error: 'App wurde gespeichert, aber konnte nicht geladen werden.' });
        }

        res.status(201).json({
          success: true,
          message: 'App erfolgreich hochgeladen.',
          app: appRow
        });
      });
    }
  );
});

// App installieren
app.post('/api/install', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { appId } = req.body;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    db.run(
      `INSERT INTO installations (user_id, app_id) VALUES (?, ?)`,
      [decoded.id, appId],
      function(err) {
        if (err) {
          return res.status(400).json({ error: 'Installation fehlgeschlagen' });
        }
        res.json({ success: true, message: 'App erfolgreich installiert!' });
      }
    );
  } catch (err) {
    res.status(401).json({ error: 'Authentifizierung erforderlich' });
  }
});

// Meine installierten Apps
app.get('/api/my-apps', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    db.all(
      `SELECT apps.* FROM apps 
       JOIN installations ON apps.id = installations.app_id 
       WHERE installations.user_id = ?`,
      [decoded.id],
      (err, apps) => {
        if (err) return res.status(500).json({ error: 'Datenbankfehler' });
        res.json(apps);
      }
    );
  } catch (err) {
    res.status(401).json({ error: 'Authentifizierung erforderlich' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload-Fehler: ${err.message}` });
  }

  if (err) {
    return res.status(400).json({ error: err.message || 'Unbekannter Fehler' });
  }

  next();
});

// Server starten
app.listen(PORT, () => {
  console.log(`🚀 ehoser shop läuft auf http://localhost:${PORT}`);
});
