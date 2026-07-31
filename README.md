# 🚀 ehoser shop - Professioneller App Store

Willkommen zu **ehoser shop** - ein moderner, professioneller App Store mit geschlossenem Zugang basierend auf Zugangscodes.

## 📖 Dokumentation

**🎯 Anfänger? Start hier:**
- **👉 [SUPABASE-RAILWAY-SETUP.md](SUPABASE-RAILWAY-SETUP.md)** - Komplettes Setup (Supabase + Railway, 15 Min!)
- **👉 [SCHNELLSTART.md](SCHNELLSTART.md)** - Schnell-Übersicht aller Optionen

**📊 Für Vergleiche:**
- **[HOSTER-VERGLEICH.md](HOSTER-VERGLEICH.md)** - Railway vs Render vs Fly.io
- **[SQLITE-VS-SUPABASE.md](SQLITE-VS-SUPABASE.md)** - SQLite oder PostgreSQL?

**📚 Tiefere Infos:**
- **[RAILWAY-GUIDE.md](RAILWAY-GUIDE.md)** - Railway.app Deployment
- **[SUPABASE-GUIDE.md](SUPABASE-GUIDE.md)** - Supabase-spezifische Einrichtung
- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Allgemeine Deployment-Optionen
- **[SECURITY.md](SECURITY.md)** - Sicherheits-Best-Practices

## 🚀 Schnellstart (5 Min)

**Lokal testen (SQLite):**
```bash
npm install
npm start
# Öffne http://localhost:3000
```

**Mit Supabase + Railway (Recommended):**
```bash
# Folge: SUPABASE-RAILWAY-SETUP.md
npm install
npm run start:supabase
```

**Admin-Code testen:** `Nils2014!`

## ✨ Features

- 🔐 **Geschlossene Community**: Nur mit Zugangscode zum Beitreten
- 📱 **App Store**: Moderne, hübsche Benutzeroberfläche
- 💾 **Datenbank**: SQLite mit persistenter Speicherung
- 🎨 **Modernes Design**: Gradient-UI mit Animations
- 🔑 **JWT Authentication**: Sichere Benutzer-Verwaltung
- 📊 **App Management**: Installieren, verwalten und anzeigen
- 📱 **Responsive**: Funktioniert auf allen Geräten

## 🛠️ Installation

### Voraussetzungen
- Node.js (v14 oder höher)
- npm oder yarn

### Schritt 1: Dependencies installieren
```bash
cd "ehoser store"
npm install
```

### Schritt 2: Server starten
```bash
npm start
```

Der Server läuft dann auf: `http://localhost:3000`

## 🔓 Zugang

### Test-Zugangscode
- **Code**: `111111` (oder beliebige 6-stellige Zahl)
- **Benutzername**: Dein gewählter Name
- **E-Mail**: Optional

## 📁 Projektstruktur

```
ehoser store/
├── server.js              # Express Backend
├── package.json          # Abhängigkeiten
├── .env                 # Umgebungsvariablen
├── store.db             # SQLite Datenbank
└── public/
    ├── index.html       # Hauptseite
    ├── styles.css       # Styling
    └── app.js          # Frontend-Logik
```

## 🎨 Design-Features

### Moderne UI-Elemente
- Gradient-Backgrounds
- Smooth Animations
- Glassmorphism-Effekte
- Responsive Grid-Layout
- Hover-Effekte
- Modal Dialoge

### Farbschema
- Primär: `#6366f1` (Indigo)
- Sekundär: `#10b981` (Grün)
- Akzent: `#f59e0b` (Orange)

## 🔐 Warum Zugangscode?

Der Zugangscode-Schutz bietet mehrere Vorteile:

1. **Datenschutz**: Geschlossene Community = kein öffentliches Impressum erforderlich (nach DSGVO Richtlinien)
2. **Community-Kontrolle**: Nur autorisierte Mitglieder
3. **Sicherheit**: Kontrollierter Zugang
4. **Qualität**: Bessere Nutzerkontrolle

## 📚 API Endpoints

### POST `/api/register`
Neuen Benutzer mit Zugangscode registrieren
```json
{
  "accessCode": "111111",
  "username": "max_mustermann",
  "email": "max@example.com"
}
```

### GET `/api/apps`
Alle verfügbaren Apps abrufen

### GET `/api/apps/:id`
Details einer spezifischen App

### POST `/api/install`
App installieren (benötigt JWT Token)
```json
{
  "appId": 1
}
```

### GET `/api/my-apps`
Meine installierten Apps abrufen (benötigt JWT Token)

### POST `/api/verify-token`
Token validieren

## 🚀 Deployment

Für Production:
1. `.env` Datei mit echtem `JWT_SECRET` erstellen
2. `NODE_ENV` auf `production` setzen
3. Database regelmäßig sichern
4. HTTPS aktivieren
5. CORS-Einstellungen anpassen

## 📱 Mobile-Optimierung

Die Website ist vollständig responsive und funktioniert perfekt auf:
- Desktop (1920px+)
- Tablet (768px - 1024px)
- Mobil (< 768px)

## 🔧 Anpassungen

### Neue Apps hinzufügen
Apps können direkt in der Datenbank hinzugefügt werden oder über ein Admin-Panel (nicht in dieser Version).

### Design ändern
Ändere die Farben in `public/styles.css`:
```css
--primary-color: #6366f1;
--secondary-color: #10b981;
--accent-color: #f59e0b;
```

### Sicherheit erhöhen
1. Echten JWT Secret setzen
2. Rate Limiting hinzufügen
3. HTTPS erzwingen
4. CORS einschränken
5. Input-Validierung verstärken

## 🐛 Troubleshooting

**Problem**: "Cannot find module 'sqlite3'"
- Lösung: `npm install sqlite3`

**Problem**: "Port 3000 ist bereits in Verwendung"
- Lösung: PORT in `.env` ändern oder anderen Process beenden

**Problem**: Frontend lädt nicht
- Lösung: Stelle sicher, dass `npm start` ausgeführt wurde

## 📄 Lizenz & Impressum

**Wichtig**: Da dies eine geschlossene Community ist, kann unter deutschen Gesetzen ein Impressum wegfallen. Für professionelle Nutzung empfehlen wir, mit einem Rechtsanwalt zu klären.

## 💡 Tipps

- Sicherungen der Datenbank regelmäßig erstellen
- Zugangscodes sicher verwalten
- Token-Ablaufzeiten anpassen
- Logging implementieren für Audit-Trail

---

**Viel Spaß mit ehoser shop!** 🎉

Bei Fragen oder Problemen - einfach die Dokumentation überprüfen oder bei der Gemeinschaft nachfragen!
