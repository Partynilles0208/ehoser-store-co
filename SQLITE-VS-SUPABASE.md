# 🔄 SQLite ↔ Supabase Anleitung

## 🎯 Schnell-Entscheidung

| Zweck | Option | Command |
|--------|--------|---------|
| 🏠 Lokal entwickeln | SQLite | `npm start` |
| 🚀 Live gehen | Supabase + Railway | `npm run start:supabase` |

---

## 📖 Detailliert

### Option 1: SQLite (Standard)

**Warum:** Super einfach, lokal, kein Setup nötig

```bash
npm start
# oder
npm run dev
```

**Datenbank:** `store.db` im Projekt-Ordner
**Perfekt für:** Entwicklung, kleine Tests

**Problem:** 
- Multi-User: Nicht ideal
- Production: Nicht sicher
- File Upload: Lokal, nicht in Cloud

---

### Option 2: Supabase (Production)

**Warum:** PostgreSQL, Cloud Storage, Skalierbar, Sicher

```bash
# Local mit Supabase Connection
npm run start:supabase

# Oder Development Mode
npm run dev:supabase
```

**Datenbank:** PostgreSQL (Cloud)
**Storage:** Supabase Cloud
**Perfekt für:** Production, Multiple Users

**Vorteil:**
- Beliebig skalierbar
- Automatische Backups
- HTTPS
- Storage in der Cloud
- Professionell

---

## 🔧 Setup Vergleich

### SQLite Setup
```bash
# 1. npm install
npm install

# 2. Direkt starten
npm start

# Fertig!
```

### Supabase Setup
```bash
# 1. npm install
npm install

# 2. Supabase Account + Projekt
# → https://supabase.com

# 3. Datenbank Tabellen erstellen
# → SQL vom Guide kopieren

# 4. Storage Buckets erstellen
# → app-icons + app-apks

# 5. .env ausfüllen
SUPABASE_URL=...
SUPABASE_KEY=...
DATABASE_URL=...

# 6. Starten
npm run start:supabase

# Fertig!
```

---

## 📊 Feature Vergleich

| Feature | SQLite | Supabase |
|---------|--------|----------|
| **Setup Zeit** | 1 Min | 10 Min |
| **Kosten** | ✅ Kostenlos | ✅ Kostenlos (Free Tier) |
| **Skalierbarkeit** | ❌ Begrenzt | ✅ Unlimited |
| **Multi-User** | ⚠️ OK | ✅ Perfekt |
| **Backups** | ❌ Manuell | ✅ Auto Daily |
| **File Storage** | 🖥️ Lokal | ☁️ Cloud |
| **HTTPS** | ❌ | ✅ Auto |
| **Performance** | ⚠️ OK | ✅ Sehr gut |
| **Production** | ❌ | ✅ |

---

## 🚀 Migrations-Pfad

### Du startest mit SQLite → Das ist OK!

```
Week 1: Entwickeln mit SQLite
         npm start

Week 2: Supabase aufsetzen
        (Parallel, kein Druck)

Week 3: Zu Supabase migrieren
        npm run start:supabase

Week 4: Mit Railway deployen
```

---

## 🔄 Wechsel von SQLite zu Supabase

Falls du mit SQLite gestartet hast:

### Schritt 1: Supabase Setup
```bash
# Folge: SUPABASE-RAILWAY-SETUP.md → Schritt 1-5
```

### Schritt 2: Datenbank Struktur
```bash
# Copy SQL Tables (siehe Schritt 2 der Setup-Datei)
# Alle 3 Tabellen erstellen
```

### Schritt 3: Alte Daten exportieren (Optional)
```bash
# Aus SQLite.db exportieren
# In Supabase importieren
```

### Schritt 4: Code wechseln
```bash
# Von npm start
npm start

# Zu npm run start:supabase
npm run start:supabase
```

### Schritt 5: .env aktualisieren
```
SUPABASE_URL=...
SUPABASE_KEY=...
DATABASE_URL=...
```

### Schritt 6: Testen
```bash
# Testen dass alles funktioniert
# Dann deployen mit Railway
```

---

## ⚙️ Technisch: Wie funktioniert das?

### server.js (SQLite)
```javascript
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./store.db');
// Daten in lokale store.db
```

### server-supabase.js (PostgreSQL)
```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// Daten in Supabase Cloud
```

Beide haben die gleiche **API**, unterschiedliche **Backends**!

---

## 💡 Meine Empfehlungen

**Anfänger:**
1. Start mit SQLite (`npm start`)
2. Entwickle + Teste lokal
3. Wenn produktionsreif → Wechsel zu Supabase

**Production Ready:**
1. Direkt Supabase + Railway
2. Skalierbar + Sicher von Start an

**Hybrid (Empfohlen):**
1. Lokal SQLite zum Entwickeln
2. Production mit Supabase
3. `npm start` vs `npm run start:supabase`

---

## 🎯 Deine Situation

Du willst auf **Supabase**? 

Dann:
```bash
# 1. Folge: SUPABASE-RAILWAY-SETUP.md
# 2. Nutze: npm run start:supabase
# 3. Deploy mit Railway
```

**Fertig!** 🚀

---

## 📚 Checkliste für Wechsel

- [ ] Supabase Account erstellt
- [ ] Projekt + Datenbank setup
- [ ] SQL Tabellen erstellt
- [ ] Storage Buckets erstellt
- [ ] .env mit Supabase Daten aktualisiert
- [ ] `npm run start:supabase` lokal getestet
- [ ] Zu Railway deployed
- [ ] Production getestet
- [ ] Sicherung der alten SQLite.db gemacht (für Notfall)

---

## 🆘 Bei Fragen

- SQLite Probleme? → Lies `DEPLOYMENT.md`
- Supabase Probleme? → Lies `SUPABASE-RAILWAY-SETUP.md`
- Railway Probleme? → Lies `RAILWAY-GUIDE.md`
- Sicherheit? → Lies `SECURITY.md`

**Du schaffst das!** 💪
