# 📋 CHECKLISTE: Von Local → Live in 15 Minuten

## 🟢 Vorbereitung (2 Min)

- [ ] Node.js v14+ installiert? (`node --version`)
- [ ] Project lokal runnen? (`npm start` → http://localhost:3000)
- [ ] Mit Code Nils2014! anmelden, Admin-Seite testen?

---

## 🔵 GitHub Setup (3 Min)

- [ ] GitHub Account? https://github.com
- [ ] Neues Repository erstellen
  - Name: `ehoser-shop`
  - Visibility: **Public**
  - README: Nicht nötig

**Repository Link kopieren!** (z.B. https://github.com/dein-name/ehoser-shop)

---

## 🟣 Code pushen (3 Min)

Im Terminal in deinem Projekt-Ordner:

```bash
# Git initialisieren
git init

# Remote hinzufügen (deine GitHub URL!)
git remote add origin https://github.com/DEIN-NAME/ehoser-shop.git

# Commit
git add .
git commit -m "🚀 Initial ehoser shop"

# Branch
git branch -M main

# Push
git push -u origin main
```

- [ ] Auf GitHub.com nachschauen: Dein Code ist dort?

---

## 🟡 Secrets generieren (1 Min)

```bash
node generate-secrets.js
```

**Output kopieren!** Sieht so aus:
```
JWT_SECRET=a1b2c3d4e5f6g7h8...
```

- [ ] JWT_SECRET notiert?

---

## 🟠 Railway Account (2 Min)

- [ ] Gehe auf https://railway.app
- [ ] Klick "Start Project"
- [ ] Mit GitHub loginnen / registrieren
- [ ] Railway akzeptiert GitHub-Zugriff

---

## 🔴 Railway Deployment (2 Min)

Auf Railway:
1. Klick "Deploy from GitHub repo"
2. Wähle `ehoser-shop` Repository
3. Railway startet Build (1-2 Minuten)
4. Sobald fertig: Grüner Haken "Running"

- [ ] Deployment erfolgreich?
- [ ] Railway gibt dir eine URL (z.B. ehoser-shop-production.railway.app)

---

## 🟢 Secrets setzen (2 Min)

Im Railway Dashboard:

1. Dein Projekt auswählen
2. Tab "Variables"
3. Folgende hinzufügen:

| Name | Wert |
|------|------|
| PORT | 3000 |
| NODE_ENV | production |
| JWT_SECRET | `<dein generierter Secret>` |
| ADMIN_UPLOAD_KEY | Nils2014! |

- [ ] Alle 4 Variables eingetragen?
- [ ] Railway deployed automatisch neu?

---

## ✅ LIVE TESTEN (1 Min)

1. Öffne deine Railway URL im Browser
2. Gib Code ein: `Nils2014!`
3. Registriere dich mit Benutzername
4. Du solltest im Admin-Panel landen
5. Test: Icon + APK hochladen
6. Prüfe: App erscheint im Store

- [ ] Website erreichbar?
- [ ] Admin-Code funktioniert?
- [ ] Upload möglich?
- [ ] App im Store sichtbar?

---

## 🎉 FERTIG!

Dein Server läuft live! Jetzt können andere:
1. URL öffnen
2. Code eingeben
3. Apps installieren

---

## 📱 Mit anderem Gerät testen

1. Auf deinem Handy/anderen PC die URL eingeben
2. Benutzername + Code eingeben
3. Apps sehen und installieren
4. Screenshot machen & stolz sein! 😎

---

## 🔒 Sicherheits-Verify

- [ ] `.env` ist auf GitHub NICHT sichtbar?
  (Railway Dashboard → Deployments → Logs checken)
- [ ] Secrets sind nur auf Railway, nicht öffentlich?
- [ ] Admin-Code funktioniert nur mit `Nils2014!`?

---

## 📊 Nach dem Launch

**Jede Woche:**
- [ ] Railway Logs checken (Errors?)
- [ ] Traffic beobachten

**Jeden Monat:**
- [ ] `npm audit` lokal ausführen
- [ ] Dependencies updaten?

**Sicherheit:**
- [ ] Admin-Code geheim gehalten?
- [ ] JWT_SECRET nicht mit anderen geteilt?

---

## 🆘 Notfall-Hilfe

**Problem: Build fehlgeschlagen**
- Schau Railway Logs
- Lokal `npm install` wiederholen
- Neu pushen: `git push`

**Problem: Website antwortet nicht**
- Railway → Redeploy
- Logs checken auf Fehler

**Problem: Falscher Admin-Code funktioniert**
- Railway → Admin-Code checken
- Stimmt es mit `Nils2014!` überein?

**Problem: Uploads gehen nicht**
- Max Dateigröße: 200MB pro Datei
- Icon nur Bilder (.png, .jpg)
- APK nur .apk Dateien

---

## 🎓 Was du gelernt hast

✅ Sichere Secrets Management (nicht im Code!)
✅ GitHub Integration
✅ Node.js Deployment
✅ Environment Variables
✅ Production vs Development
✅ Database Setup
✅ Admin-Panel mit Authentifizierung

---

## 🚀 Nächstes Level (Optional)

- Custom Domain statt railway.app
- Email-Benachrichtigungen bei Downloads
- Admin-Statistiken (User, Downloads)
- Update-Mechanismus für Apps
- Multi-Sprachen Support

---

## ✨ Glückwunsch!

Du hast einen vollständigen Production-Server mit:
- ✅ Authentifizierung
- ✅ Admin-Upload
- ✅ App-Store
- ✅ Benutzer-Management
- ✅ Datenschutz (Zugangscode)

**Das ist profesionell!** 🎉

---

## 📞 Support

- Railway Docs: https://docs.railway.app
- Node.js Guide: https://nodejs.org/docs
- Security: Siehe `SECURITY.md` in deinem Projekt
- Hoster Vergleich: Siehe `HOSTER-VERGLEICH.md`

**Du schaffst das!** 💪
