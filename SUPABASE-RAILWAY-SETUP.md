# ⚡ SUPABASE + RAILWAY: Schritt-für-Schritt (15 Min!)

## 🎯 Das Plan

1. Supabase Account + Projekt
2. Datenbank + Storage setup
3. Code vorbereiten
4. Railway Connect
5. Deploy!

---

## ✅ Schritt 1: Supabase Account

1. Gehe auf https://supabase.com
2. Klick "Start Your Project"
3. Mit GitHub anmelden (easiest)
4. Klick "New Project"

**Projekt-Einstellungen:**
- Name: `ehoser-shop`
- Database Password: Sehr sicher! (20+ Zeichen, copy!)
- Region: EU (wegen DSGVO)
- Klick "Create new project"

⏳ **Warten Sie 5 Minuten...**

---

## ✅ Schritt 2: SQL Tabellen erstellen

Im Supabase Dashboard:

1. Klick "SQL Editor" (linke Sidebar)
2. "New Query" → Kopiere diesen Code:

```sql
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  access_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  verified INTEGER DEFAULT 1
);

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

CREATE TABLE IF NOT EXISTS installations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id BIGINT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  installed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, app_id)
);

CREATE INDEX idx_users_access_code ON users(access_code);
CREATE INDEX idx_installations_user_id ON installations(user_id);
CREATE INDEX idx_apps_created_at ON apps(created_at DESC);
```

3. "Run" klicken → ✅ Done!

---

## ✅ Schritt 3: Storage Buckets erstellen

Im Supabase Dashboard:

1. Klick "Storage" (linke Sidebar)
2. "Create a new bucket"
   - Name: `app-icons`
   - Wähle "Public"
   - Erstellen
3. Nochmal "Create"
   - Name: `app-apks`
   - Wähle "Public"
   - Erstellen

**Wichtig:** BOTH müssen "Public" sein!

---

## ✅ Schritt 4: Connection Daten kopieren

Im Supabase Dashboard:

1. Klick "Project Settings" (unten links)
2. "Database" Tab
3. Scroll zu "Connection String" → **Transaction mode**
4. Kopiere die gesamte Connection URL

Sieht so aus:
```
postgresql://postgres.abcdef:[PASSWORD]@db.abcdef.supabase.co:6543/postgres
```

**Speichern! Das brauchen wir bald.**

---

## ✅ Schritt 5: API Keys kopieren

Im Supabase Dashboard:

1. "Project Settings" → "API"
2. Kopiere:
   - `Project URL` (z.B. https://abcdef.supabase.co)
   - `anon public` Key (sehr lang)
3. Speichern!

---

## ✅ Schritt 6: Lokal vorbereiten

Im Terminal in deinem Projekt:

```bash
# Dependencies installieren
npm install

# .env Datei aktualisieren
# Öffne: ehoser store/.env
# Füge hinzu/Update:
```

Deine `.env` sollte so aussehen:

```
PORT=3000
NODE_ENV=development
JWT_SECRET=dein-super-sicherer-secret-key (min. 20 Zeichen!)
ADMIN_UPLOAD_KEY=Nils2014!

# Supabase (von oben kopiert)
DATABASE_URL=postgresql://postgres.xxxx:[PASSWORD]@db.xxxx.supabase.co:6543/postgres
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## ✅ Schritt 7: Lokal testen

```bash
npm run start:supabase
```

Öffne http://localhost:3000
- Testen Sie mit Code: `Nils2014!`
- Sie sollten im Admin-Panel landen
- Versuchen Sie einen Upload

✅ **Funktioniert lokal?** → Weiter zu Schritt 8!

---

## ✅ Schritt 8: GitHub vorbereiten

```bash
git init
git add .
git commit -m "🚀 Supabase + Ready for Railway"
git branch -M main

# Push zu GitHub
git push -u origin main
```

✅ **Code auf GitHub?** → Weiter zu Schritt 9!

---

## ✅ Schritt 9: Railway Deploy

1. Gehe auf https://railway.app
2. Klick "Start a New Project"
3. Wähle "Deploy from GitHub repo"
4. Wähle `ehoser-shop`
5. Railway startet Build (2-3 Min)

⏳ **Warten auf "Running"...**

---

## ✅ Schritt 10: Railway Environment Variablen

Im Railway Dashboard:

1. Dein Projekt auswählen
2. "Variables" Tab
3. Folgende hinzufügen:

| Variable | Wert |
|----------|------|
| `PORT` | `3000` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | `dein-sicherer-secret` |
| `ADMIN_UPLOAD_KEY` | `Nils2014!` |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |
| `DATABASE_URL` | `postgresql://...` |

⚠️ **NICHT `DATABASE_URL` posten!** Supabase Connection String bleiben privat!

4. Railway deployed automatisch neu

---

## ✅ Schritt 11: LIVE Testen

Railway gibt dir eine URL:
```
https://ehoser-shop-production.railway.app
```

1. Öffne die URL im Browser
2. Registriere dich mit `Nils2014!`
3. Du landest im Admin
4. Lade einen Test-Icon + APK hoch
5. Prüfe im Store ob es erscheint
6. ✅ **Fertig!**

---

## 🎉 LIVE GEGANGEN!

Jetzt können andere Leute:
1. Die URL öffnen
2. Mit Code `Nils2014!` anmelden
3. Apps sehen und installieren

---

## 📱 Mit anderem Gerät testen

1. Handy oder anderer PC
2. Railway URL eingeben
3. Mit Code anmelden
4. Apps sollten da sein

---

## 🔒 Sicherheits-Check

- ✅ `.env` ist auf GitHub NICHT sichtbar (in `.gitignore`)
- ✅ Secrets sind nur auf Railway, nicht öffentlich
- ✅ Supabase Connection String ist privat (nur auf Railway)
- ✅ Admin-Code `Nils2014!` funktioniert nur auf Server
- ✅ HTTPS aktiviert (automatisch)

---

## 📊 Nach Launch

**Was du regelmäßig checken solltest:**

1. **Supabase Dashboard** → Storage:
   - Wie viel GB haben deine Uploads gebraucht?
   - (Free: 1GB)

2. **Railway Dashboard** → Logs:
   - Gibt es Fehler?
   - Wie ist die CPU/Memory?

3. **Supabase Dashboard** → Database:
   - Wie viele Apps/Users?
   - (Free: 500MB)

---

## 💡 Geheimtips

### Custom Domain
Statt `railway.app`:
1. Railway → Settings
2. "Custom Domain"
3. Deine Domain eingeben (z.B. apps.mein-shop.de)
4. DNS-Records einrichten

### Automatische Backups
Supabase macht automatisch täglich Backups. Nice!

### Mehr Speicher?
Free: 500MB DB + 1GB Storage
Pro: $25/Mo → 50GB DB + 100GB Storage

---

## 🆘 Probleme?

### "PGRST116 - Not found"
→ Datenbank-Tabelle existiert nicht
→ SQL aus Schritt 2 nochmal laufen lassen

### "Upload fehlgeschlagen"
→ Supabase Storage Bucket existiert nicht
→ Bucket muss "Public" sein
→ Bucket-Namen müssen exakt passen

### "Connection refused"
→ DATABASE_URL falsch kopiert
→ Supabase Project gerade am Starten
→ 1 Minute warten

### "Variable nicht gefunden"
→ Railway hat nicht neue Variablen
→ Railway → Redeploy
→ Oder: Logs checken

---

## ✨ Zusammenfassung

| Schritt | Was | Fertig? |
|---------|-----|--------|
| 1 | Supabase Account | ☐ |
| 2 | Datenbank Tabellen | ☐ |
| 3 | Storage Buckets | ☐ |
| 4-5 | API Keys kopieren | ☐ |
| 6 | `.env` aktualisieren | ☐ |
| 7 | Lokal testen | ☐ |
| 8 | GitHub Push | ☐ |
| 9 | Railway Deploy | ☐ |
| 10 | Variables setzen | ☐ |
| 11 | LIVE testen | ☐ |

---

## 🎓 Was du gelernt hast

✅ PostgreSQL mit Supabase
✅ File Storage in der Cloud
✅ Environment Variables richtig nutzen
✅ Sicheres Deployment
✅ Admin-Panel + Authentifizierung
✅ Production-ready Code

---

## 🚀 Du bist jetzt ein Developer!

Congratulations! 🎉

Dein ehoser shop läuft live mit:
- ✅ PostgreSQL Datenbank
- ✅ Cloud File Storage (Supabase)
- ✅ Admin-Upload System
- ✅ App Store für andere Users
- ✅ Sicherer Zugang mit Admin-Code

**Nächste Level:** Mehr Features, Custom Domain, Analytics!

---

## 📚 Weitere Ressourcen

- Supabase Docs: https://supabase.com/docs
- Railway Docs: https://docs.railway.app
- Express.js Docs: https://expressjs.com
- JWT Guide: https://jwt.io

**Viel Erfolg!** 🚀
