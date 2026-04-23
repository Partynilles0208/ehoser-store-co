# 🔒 Sicherheits-Leitfaden für Production

## ⚠️ NIEMALS IM CODE

- Admin-Zugangscode (Nils2014!)
- JWT Secret
- Database Connection Strings
- API Keys

**WARUM:** Wenn jemand deinen GitHub-Code sieht, hat er sofort Zugriff auf alles!

---

## ✅ IMMER: Environment Variablen

```bash
# Lokal: In .env (NICHT im Code!)
ADMIN_UPLOAD_KEY=Nils2014!
JWT_SECRET=super-lange-zufaellige-string

# Production: Auf Railway/Render/Vercel Dashboard
# Nicht im Code!
```

---

## 🔐 Best Practices

### 1. .gitignore schützt dich
```
# Deine .env wird NICHT gepusht
.env
.env.local
.env.*.local
```

### 2. JWT Secret sollte super lang sein
```
# Zu kurz (Schnell gehackt)
JWT_SECRET=my-secret ❌

# Richtig
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z ✅

# Generator:
node generate-secrets.js
```

### 3. Admin-Key Komplexität
```
# Einfach zu erraten
admin ❌
123456 ❌

# Besser
Nils2014! ✅ (Kombination aus Name + Nummer + Symbol)
```

### 4. Datenbank Sicherheit
```javascript
// BAD: Hardcoded
const db = new sqlite3.Database('./store.db');

// GOOD: Via Environment
const dbUrl = process.env.DATABASE_URL;
```

### 5. Upload-Dateivalidierung
```javascript
// ✅ Bereits im Code implementiert
- Nur .apk werden akzeptiert
- Icon nur Bilder
- Max 200MB pro Datei
- Dateinamen werden sanitized
```

---

## 🚨 Sicherheits-Checklist

### Lokal (auf deinem PC)
- [ ] `.env` existiert und ist in `.gitignore`
- [ ] Nils2014! ist NUR in lokaler `.env`, nicht im Code
- [ ] `node_modules/` ist in `.gitignore`
- [ ] Keine Secrets sind im Code sichtbar

### GitHub
- [ ] Repository ist PRIVATE oder `.env` ist nicht sichtbar
- [ ] `.gitignore` wird befolgt
- [ ] Keine `.env` Datei im Repository

### Production (Railway/Render/etc)
- [ ] Alle Secrets sind als Environment Variablen gesetzt
- [ ] HTTPS ist aktiviert (automatisch)
- [ ] Datenbank-Backups sind aktiviert
- [ ] Uploads haben File-Size Limits

---

## 📱 Input-Validierung (bereits im Code)

```javascript
✅ Zugangscode: Min 6 Zeichen
✅ Benutzername: Min 3 Zeichen
✅ Icon: Nur Bilder erlaubt
✅ APK: Nur .apk Dateien
✅ Dateigröße: Max 200MB
✅ Dateinamen: Spezialzeichen entfernt
```

---

## 🔄 Regelmäßig updaten

```bash
# Monatlich ausführen
npm update
npm audit
npm audit fix

# Abhängigkeiten auf Sicherheitsupdates prüfen
npm outdated
```

---

## 🚨 Falls kompromittiert

**Wenn Admin-Key gehackt wird:**
1. Sofort neuen Key in Railway setzen
2. Server deployed automatisch neu
3. Alter Key funktioniert nicht mehr

**Datenbank Problem:**
1. Railway hat automatische Backups
2. 30 Tage Wiederherstellung möglich
3. Exportiere regelmäßig (einmal pro Woche)

---

## 📊 Monitoring

Railway zeigt dir:
- CPU/Memory Nutzung
- Fehlgeschlagene Deployments
- Error Logs in Echtzeit
- Traffic-Statistiken

**Tipp:** Logs regelmäßig checken auf verdächtige Aktivitäten

---

## 🔗 Sicherheits-Links

- OWASP Top 10 Vulnerabilities: https://owasp.org/www-project-top-ten/
- Node.js Security Best Practices: https://nodejs.org/en/docs/guides/security/
- Railway Security: https://railway.app/security

---

## ✨ Zusammenfassung

| Was | Wo | Status |
|-----|----|----|
| Admin-Key (Nils2014!) | Railway Env Variables | 🔒 Geheim |
| JWT_SECRET | Railway Env Variables | 🔒 Geheim |
| Code | GitHub Public | 📕 Öffentlich |
| Datenbank | Railway PostgreSQL | 🔒 Encrypted |
| HTTPS | Automatisch aktiviert | ✅ Sicher |
| Backups | Railway automatisch | ✅ 30 Tage |

**Du bist sicher!** ✅
