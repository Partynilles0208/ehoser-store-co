# 🚀 RAILWAY.APP - Schritt-für-Schritt Anleitung

## 5 Minuten zum Live-Server!

### Schritt 1️⃣: Vorbereitung (lokal auf deinem PC)

```bash
# 1. Ins Projekt-Verzeichnis gehen
cd "ehoser store"

# 2. Git initialisieren (wenn noch nicht gemacht)
git init
git add .
git commit -m "🎉 Initial ehoser shop deployment"

# 3. Secrets generieren
node generate-secrets.js
# → Kopiere den JWT_SECRET Output!
```

---

### Schritt 2️⃣: GitHub Repository erstellen

1. Gehe auf https://github.com → "New repository"
2. Name: `ehoser-shop`
3. Description: `Premium App Store mit Zugangscode`
4. Wähle: **Public** (damit Railway es finden kann)
5. Klicke "Create repository"

---

### Schritt 3️⃣: Code zu GitHub pushen

```bash
# Terminal in deinem Projekt-Verzeichnis öffnen

git remote add origin https://github.com/DEIN-USERNAME/ehoser-shop.git
git branch -M main
git push -u origin main

# Jetzt ist dein Code auf GitHub (aber nicht die .env!)
```

---

### Schritt 4️⃣: Railway Account + Deployment

1. Gehe auf https://railway.app
2. Klicke "Start Project"
3. Wähle "Deploy from GitHub repo"
4. GitHub autorisieren
5. Dein `ehoser-shop` Repository auswählen
6. Railway detektiert Node.js automatisch → "Deploy now"

**WARTE** - Railway konfiguriert dein Projekt...

---

### Schritt 5️⃣: Environment Variablen setzen (WICHTIG!)

⚠️ **Jetzt werden deine Secrets gesetzt, NICHT im Code!**

1. Im Railway Dashboard → Dein Projekt auswählen
2. "Variables" Tab öffnen
3. Folgende Variablen hinzufügen:

```
PORT=3000
NODE_ENV=production
JWT_SECRET=<hier den generierten Secret einfügen>
ADMIN_UPLOAD_KEY=Nils2014!
```

**SO SIEHT ES AUS:**
```
Variable Name: JWT_SECRET
Value: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

4. Klicke "Add variable" für jede
5. Railway deployed automatisch neu mit den Variablen

---

### Schritt 6️⃣: Datenbank hinzufügen (Optional, aber empfohlen)

Für Production brauchst du PostgreSQL statt SQLite.

1. Railway Dashboard → "Create" → "Database"
2. PostgreSQL auswählen
3. Railway verbindet automatisch
4. Die `DATABASE_URL` wird automatisch in deine App eingefügt

**FERTIG!** ✅

---

## 🌍 Dein Server läuft jetzt!

Railway gibt dir eine URL wie:
```
https://ehoser-shop-production.railway.app
```

**Damit können andere auf deinen Store zugreifen:**
1. Sie öffnen die URL
2. Eingabe: Zugangscode `Nils2014!`
3. Sie können Apps installieren!

---

## 🔒 Sicherheits-Check

- ✅ `.env` ist in `.gitignore` → Code wird NOT gepusht
- ✅ Secrets sind nur auf Railway Server, nicht öffentlich sichtbar
- ✅ Jeder Deployment nutzt aktuelle Secrets von Railway
- ✅ HTTPS automatisch aktiviert
- ✅ Admin-Key ist sicher geschützt

---

## 📊 Was Railway kostet

- **Free Tier:** $5/Monat automatische Credits
- Das reicht für: 100+ gleichzeitige Nutzer
- Danach: Nur $0.03 pro Stunde Nutzung

**Bei dich:** Wahrscheinlich kostenlos, weil $5 lange hält! 💰

---

## 🔧 Nachher: Code ändern?

1. Lokal ändern
2. `git add . && git commit -m "Update"`
3. `git push` → Railway deployed automatisch neu!

---

## 🆘 Probleme?

### "Build fehlgeschlagen"
→ Schau in Railway Logs (Projekt → Logs)
→ Meist: npm install Fehler → `npm install` lokal wiederholen

### "Die App lädt nicht"
→ Railway → Deployment → redeploy
→ Oder: Environment Variablen neu checken

### "Datenbank verbindet nicht"
→ PostgreSQL hinzufügen (unter "Create")
→ DATABASE_URL wird automatisch gesetzt

---

## 💡 Nächstes Level: Custom Domain

Statt `railway.app` Domain:
1. Railway → Project → Settings
2. "Custom Domain"
3. Deine Domain eingeben (z.B. apps.dein-shop.de)
4. DNS-Records einrichten (Railway zeigt dir wie)

---

## 📝 Checkliste vor Launch

- [ ] Zugangscode in `.env` (lokal) und Railway gesetzt
- [ ] JWT_SECRET generiert und in Railway
- [ ] Code auf GitHub gepusht
- [ ] Railway Deployment erfolgreich
- [ ] Envs auf Railway gesetzt
- [ ] Test: Website öffnen, Anmelden, Apps sehen
- [ ] Mit anderem Gerät/Fenster testen
- [ ] Fertig! 🎉

**Viel Erfolg!** 🚀
