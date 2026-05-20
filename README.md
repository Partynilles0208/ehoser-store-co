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
