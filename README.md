# Ehoser Store

Professionelle, gesperrte Spieleseite fuer Ehoser mit Admin-Verwaltung und Supabase-Anbindung.

## Start

```bash
npm install
copy .env.example .env
npm start
```

Store: `http://localhost:3000` mit Code `0208`  
Admin: `http://localhost:3000/admin` mit Code `Nils2014!`

Ohne Supabase-Keys nutzt der Server lokale Dateien in `data/` und `uploads/`. Mit Supabase setzt du `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` und optional `SUPABASE_STORAGE_BUCKET`.

## Supabase

1. Neues Supabase-Projekt erstellen.
2. SQL aus `supabase/schema.sql` im Supabase SQL Editor ausfuehren.
3. `.env` mit URL und Service-Role-Key fuellen.
4. Server neu starten.

Im Adminbereich kannst du Icon, Trailer, Bilder und EXE hochladen. Wenn keine EXE hinterlegt ist oder das Veroeffentlichungsdatum in der Zukunft liegt, zeigt der Store statt Download das Erscheinungsdatum.

## Als echte Webseite deployen

Diese App braucht einen Node.js-Webservice, nicht GitHub Pages. Vercel ist vorbereitet und nutzt `server.js` als Node.js Function.

### Vercel

1. Vercel oeffnen und das GitHub-Repository `Partynilles0208/ehoser-store-co` importieren.
2. Framework Preset: `Other`.
3. Build Command leer lassen oder `npm install` nutzen.
4. Output Directory leer lassen.
5. Diese Environment Variables setzen:
   - `SITE_ACCESS_CODE=0208`
   - `ADMIN_ACCESS_CODE=Nils2014!`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`
   - `SUPABASE_STORAGE_BUCKET=games`
6. Deploy starten.

Wichtig fuer Vercel: Verwende Supabase fuer Datenbank und Storage. Vercel Functions sind serverless; lokale Upload-Ordner sind nicht fuer dauerhafte Dateien gedacht.

### Railway

1. Railway oeffnen und ein neues Projekt aus dem GitHub-Repository `Partynilles0208/ehoser-store-co` erstellen.
2. Railway erkennt `package.json` und nutzt `npm start`.
3. Diese Variablen setzen:
   - `SITE_ACCESS_CODE=0208`
   - `ADMIN_ACCESS_CODE=Nils2014!`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`
   - `SUPABASE_STORAGE_BUCKET=games`
4. Deploy starten. Danach gibt Railway eine oeffentliche HTTPS-Adresse aus.

### Render

1. New Web Service erstellen und GitHub-Repository verbinden.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Environment Variables wie oben setzen.

Der Check-Endpunkt fuer Hoster ist `/health`.
