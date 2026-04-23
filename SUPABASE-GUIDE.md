# 🚀 SUPABASE - Schritt-für-Schritt Anleitung

## ⭐ Warum Supabase?
- ✅ PostgreSQL kostenlos (500MB)
- ✅ Storage kostenlos (1GB) für Icon/APK
- ✅ Authentication built-in
- ✅ Real-time Updates
- ✅ Backups automatisch
- ✅ Super einfach

---

## 🎯 15-Minuten Setup

### Schritt 1️⃣: Supabase Account erstellen

1. Gehe auf https://supabase.com
2. Klick "Start Your Project"
3. Registriere dich mit GitHub (easiest)
4. Wähle dein Land/Region (EU = besser für DSGVO)

---

### Schritt 2️⃣: Neues Projekt erstellen

1. "New Project" klicken
2. Name: `ehoser-shop`
3. Password für Admin: Sicher! (min. 20 Zeichen)
4. Region: Wähle die nächste zu dir
5. "Create new project" drücken

**⏳ WARTEN** - Supabase erstellt Datenbank (2-5 Min)

---

### Schritt 3️⃣: Connection String kopieren

Sobald dein Projekt aktiv ist:

1. Klick "Project Settings" (unten links) → "Database"
2. Suche den Abschnitt "Connection Pooling"
3. Konfiguration: `Transaction mode`
4. Kopiere die `Connection String`

Sieht so aus:
```
postgresql://postgres.xxxxx:[PASSWORD]@db.xxxxx.supabase.co:6543/postgres
```

**Diese URL brauchst du später!**

---

### Schritt 4️⃣: Storage Buckets erstellen

Im Supabase Dashboard:

1. Klick "Storage" (linke Sidebar)
2. "Create a new bucket" → Name: `app-icons`
3. Nochmal → Name: `app-apks`
4. Bei beiden: **Public** auswählen (damit User downloaden können)

---

### Schritt 5️⃣: Datenbank-Tabellen erstellen

Im Supabase Dashboard:

1. Klick "SQL Editor"
2. "New Query" klicken
3. Kopiere dieses SQL:

```sql
-- Benutzer Tabelle
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  access_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  verified INTEGER DEFAULT 1
);

-- Apps Tabelle
CREATE TABLE IF NOT EXISTS apps (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  version TEXT,
  icon_url TEXT,
  download_url TEXT,
  source_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Installationen Tabelle
CREATE TABLE IF NOT EXISTS installations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  installed_at TIMESTAMP DEFAULT NOW()
);

-- Indexes für Performance
CREATE INDEX idx_users_access_code ON users(access_code);
CREATE INDEX idx_installations_user_id ON installations(user_id);
CREATE INDEX idx_apps_created_at ON apps(created_at DESC);
```

4. "Run" klicken
5. Fertig! Tabellen sind erstellt

---

### Schritt 6️⃣: Dein Projekt mit Supabase verbinden

#### Option A: Mit GitHub + Vercel (easiest)

```bash
# 1. GitHub vorbereiten
cd "ehoser store"
git init
git add .
git commit -m "🚀 Supabase Setup"
git push origin main
```

#### Option B: Mit Railway + Supabase (auch gut)

Railway ist einfacher, aber wir nutzen Supabase als DB.

---

### Schritt 7️⃣: Environment Variablen setzen

Du brauchst nur die Connection String von Supabase:

**Local (.env Datei):**
```
PORT=3000
NODE_ENV=development
JWT_SECRET=dein-secret-key
ADMIN_UPLOAD_KEY=Nils2014!
DATABASE_URL=postgresql://postgres.xxxxx:[PASSWORD]@db.xxxxx.supabase.co:6543/postgres
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Railway/Production:**
Im Dashboard → Variables → Alle oben setzen

---

### Schritt 8️⃣: npm packages installieren

```bash
npm install pg dotenv
```

---

### Schritt 9️⃣: Server für Supabase konfigurieren

(Siehe `SUPABASE-SERVER-ANPASSUNG.md`)

---

### Schritt 🔟: Deploy!

Mit Railway + Supabase:

```bash
git add .
git commit -m "Add Supabase integration"
git push

# Railway deployed automatisch
```

---

## ✅ Fertig testen

1. Öffne deine App
2. Registriere dich mit `Nils2014!`
3. Du landest im Admin
4. Lade Icon + APK hoch
5. Prüfe in Supabase Dashboard ob Daten eingefügt wurden

---

## 📱 Supabase Admin ansehen

Deine Daten live sehen:

1. Supabase Dashboard
2. "Table Editor"
3. Wähle `apps` oder `users`
4. Deine Uploads erscheinen hier live! 

---

## 💾 Storage verwenden

Supabase Storage ist wie AWS S3.

**Deine Files landen hier:**
- Icons: `https://xxxxx.supabase.co/storage/v1/object/public/app-icons/...`
- APKs: `https://xxxxx.supabase.co/storage/v1/object/public/app-apks/...`

Server speichert automatisch die richtigen URLs in der DB.

---

## 🔐 Row Level Security (Optional, aber empfohlen)

Im Supabase Dashboard → "Authentication" → "Policies"

Das sorgt dafür, dass User nur ihre eigenen Daten sehen. Für später!

---

## 📊 Supabase Limits (Free Tier)

| Feature | Limit | Genug für |
|---------|-------|-----------|
| Database | 500MB | ~10k Apps |
| Storage | 1GB | ~500 APK Files |
| Users | Unlimited | ∞ |
| API Calls | Unlimited | ✅ |
| Bandwidth | 2GB/Mo | ~1000 Downloads |

**Für dein Projekt:** Völlig ausreichend!

---

## 🚀 Nach dem Launch

**Jede Woche:**
- Supabase Dashboard ansehen (Datenbank-Grösse)
- Backups checken (automatisch täglich)

**Bei Wachstum:**
- Upgrade auf Pro Plan ($25/Mo)
- Dann 50GB Database + 100GB Storage

---

## 🆘 Häufige Probleme

### "Connection refused"
→ PostgreSQL Server startet gerade
→ 1 Minute warten oder Supabase neu laden

### "Storage Access Denied"
→ Bucket muss "Public" sein
→ Supabase → Storage → Bucket Policy checken

### "ALTER TABLE ..." Fehler
→ Tabelle existiert bereits
→ Einfach ignorieren, SQL idempotent

---

## 📚 Nächste Schritte

1. ✅ Supabase Account erstellen
2. ✅ Projekt + Datenbank + Storage setup
3. ✅ SQL ausführen
4. ✅ Connection String kopieren
5. ✅ Server anpassen (siehe nächste Datei)
6. ✅ Deploy mit Railway
7. ✅ Testen!

**Los geht's!** 🎉
