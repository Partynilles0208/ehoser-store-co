# ehoser Developer Platform

Die Developer Platform ist unter `/developer/` erreichbar. Dort werden Projekte und API-Schlüssel verwaltet.

## Sicherheit

- Ein API-Schlüssel wird nur beim Erstellen einmal im Klartext angezeigt.
- Der Server speichert ausschließlich einen SHA-256-Hash.
- Nutze Schlüssel nur in einem Server oder einer geschützten Server-Funktion, niemals in öffentlichem Browser-JavaScript.
- Das Limit beträgt derzeit 60 Anfragen pro Minute und Schlüssel.

## API

Basis-URL: `https://ehoser.de/api/v1`

### Schlüssel testen

```bash
curl https://ehoser.de/api/v1/status \
  -H "x-api-key: EHOSER_DEIN_SCHLUESSEL"
```

### KI-Chat

```bash
curl https://ehoser.de/api/v1/ai/chat \
  -H "x-api-key: EHOSER_DEIN_SCHLUESSEL" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hallo!"}]}'
```

Die Antwort hat ein OpenAI-ähnliches `choices`-Feld. KI-Anfragen werden über den serverseitig eingerichteten Groq-Zugang verarbeitet; der Anbieter-Schlüssel wird nie an API-Nutzer ausgegeben.

## ehoser Sites

Der Baukasten liegt unter `/sites/`. Er unterstützt Titel, Texte, HTTPS-Bilder, HTTPS-Audio, Zeichnungen sowie vorbereitete KI-, Chat- und Anruf-Bausteine.

Veröffentlichte Seiten sind direkt unter folgendem Link verfügbar:

```
https://ehoser.de/sites/dein-projekt
```

Eine echte Subdomain wie `https://dein-projekt.ehoser.de` braucht zusätzlich eine Wildcard-Domain in Vercel. Die Anwendungslogik erkennt diese Adresse bereits, sobald die Wildcard eingerichtet ist.

> Die Chat- und Anruf-Bausteine sind UI-Bausteine für deine Seite. Die Verbindung zu deinem eigenen Server muss sicher über eine Server-Funktion mit deinem API-Schlüssel erfolgen.