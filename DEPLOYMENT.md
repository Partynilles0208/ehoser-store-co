# 🚀 Deployment Guide für ehoser shop

## Option 1: Railway.app (Empfohlen für Anfänger) ⭐

### Vorbereitung lokal
1. Git Repository erstellen:
```bash
git init
git add .
git commit -m "Initial commit"
```

2. GitHub Account + Repository erstellen (wenn noch nicht vorhanden)

### Bei Railway.app
1. https://railway.app registrieren (kostenlos)
2. Dashboard → "New Project"
3. "Deploy from GitHub repo" wählen
4. Dein ehoser-shop Repository auswählen
5. Railway erkennt Node.js automatisch

### Environment Variablen auf Railway setzen
Im Railway Dashboard:
- Project Settings → Variables
- Folgende hinzufügen:
  - `PORT=3000`
  - `JWT_SECRET=dein-sehr-sicherer-random-string` (20+ Zeichen!)
  - `ADMIN_UPLOAD_KEY=Nils2014!`
  - `NODE_ENV=production`
  - `DATABASE_URL=postgresql://...` (Railway generiert diese automatisch)

### Datenbank-Setup auf Railway
1. Im Dashboard → "Create" → "Database"
2. PostgreSQL auswählen
3. Railway verbindet automatisch und setzt DATABASE_URL

---

## Option 2: Vercel (nur Frontend + Serverless)

⚠️ **Problem:** Vercel ist gut für React/Next.js, aber dein Express-Server braucht lange Prozesse (Datei-Upload). Besser mit einer DB-Anbindung.

**Lösung:** Vercel Frontend + Neon/Supabase PostgreSQL separat

---

## Option 3: Fly.io (Für erfahrene Nutzer)

```bash
npm install -g flyctl
fly auth login
fly launch
fly secrets set ADMIN_UPLOAD_KEY=Nils2014!
fly deploy
```

---

## 🔒 Sicherheits-Checkliste

- [ ] `.env` ist in `.gitignore`
- [ ] Admin-Key NICHT in Code, nur als Environment Variable
- [ ] JWT_SECRET ist zufällig + lang (min. 32 Zeichen)
- [ ] Auf Production: `NODE_ENV=production`
- [ ] HTTPS aktiviert (alle Hoster tun das automatisch)
- [ ] Dateiuploads haben File-Size Limits (bereits im Code)
- [ ] Input-Validierung aktiv (bereits im Code)

---

## 📦 Production-Optimierungen

### 1. SQLite → PostgreSQL (für Multi-User)
Dein Code mit SQLite funktioniert auch auf Production, aber für mehrere gleichzeitige User ist PostgreSQL besser.

**Railway/Render/Fly bieten PostgreSQL kostenlos an.**

### 2. Uploads in Cloud speichern (wichtig!)
Aktuell: Dateien landen im `/uploads` Ordner des Servers
Problem: Bei Neustart/Redeploy werden Dateien gelöscht

**Lösung:** S3-ähnliche Services nutzen:
- **Cloudflare R2** (kostenlos bis 10GB)
- **AWS S3** (kostenpflichtig, aber sehr zuverlässig)
- **Supabase Storage** (kostenlos, PostgreSQL + Storage kombiniert)

---

## 💡 Schnellstart Railway

```bash
# 1. Git einrichten
git init
git add .
git commit -m "Init"

# 2. GitHub mit Railway verbinden
# → https://railway.app
# → Authorize GitHub
# → Select Repository
# → Deploy

# 3. Environment Variablen setzen im Railway Dashboard
# → dein Projekt → Variables
# → Alle Secrets hinzufügen

# 4. Fertig! 🎉
# → Dein Server läuft unter: https://ehoser-shop-production.up.railway.app
```

---

## 🎯 Kosten-Übersicht für deine App

| Hoster | Preis | Speicher | Uploads | Nutzer |
|--------|-------|----------|---------|--------|
| Railway | $5/Mo Credits (reicht lange) | Unlimited | 200MB max/Datei | Unlimited |
| Render | Kostenlos | 256MB | Begrenzt | Begrenzt |
| Fly.io | Kostenlos | 3GB | Begrenzt | Begrenzt |
| Vercel | Kostenlos | Nur Frontend | Mit Drittdienst | Unlimited |

**Für dich:** Railway ist perfekt - $5/Monat reicht für Jahre bei deinem Traffic.

---

## 🔗 Nächste Schritte

1. Railway.app Account erstellen
2. GitHub Repository erstellen
3. Code pushen (`.env` wird NICHT gepusht wegen .gitignore)
4. Railway mit GitHub verbinden
5. Environment Variablen setzen
6. Deploy fertig!

Dann geben andere Leute einfach die URL ein und können beitreten + Apps installieren.

---

## ❓ FAQ

**F: Kann ich die URL ändern?**
A: Ja, im Railway Dashboard → Custom Domain → deine Domain

**F: Was wenn ich zu viele Zugriffe bekomme?**
A: Railway skaliert automatisch in kostenpflichtige Pläne, aber erst wenn nötig

**F: Sind meine Daten sicher?**
A: Ja, Railway nutzt Enterprise-Standard Security, HTTPS überall, automatische Backups

**F: Kann ich später wechseln?**
A: Ja, deine Datenbank kannst du exportieren und zu jedem anderen Hoster migrieren
