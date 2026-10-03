# Ehoser Email Center

Die App hat echte Postfaecher fuer `@ehoser.de`. Versand und Empfang laufen ueber Resend; die Nachrichten landen danach im Postfach im ehoser-Chat.

## Variante A: Resend

```env
EHOSER_MAIL_DOMAIN=ehoser.de
RESEND_API_KEY=re_dein_resend_api_key
RESEND_WEBHOOK_SECRET=whsec_dein_resend_webhook_secret
```

### 1. Domain in Resend hinzufuegen

In Resend:

```txt
Domains -> Add Domain -> ehoser.de
```

Resend zeigt dir DNS-Records. Diese kopierst du bei deinem Domain-Anbieter hinein. Fuer echte Absenderadressen sind SPF und DKIM erforderlich; fuer den Empfang aktivierst du die Receiving-Domain und setzt den dort angegebenen MX-Record.

### 2. API Key erstellen

In Resend:

```txt
API Keys -> Create API Key
```

Diesen Key setzt du als:

```env
RESEND_API_KEY=re_...
```

### 3. Webhook fuer Empfang erstellen

In Resend:

```txt
Webhooks -> Add Webhook
```

URL:

```txt
https://www.ehoser.de/api/webhooks/resend
```

Event auswaehlen:

```txt
email.received
```

Resend zeigt nach dem Speichern ein Signatur-Secret an. Dieses beginnt mit `whsec_` und kommt als Server-Variable in Vercel/Railway:

```env
RESEND_WEBHOOK_SECRET=whsec_...
```

### 4. App benutzen

In der Ehoser-App:

```txt
Chat -> oben rechts auf Postfach -> Adresse erstellen, z.B. test
```

Dann kannst du von `test@ehoser.de` an echte externe Adressen senden und dort auch Antworten empfangen. Der Webhook prueft jede Anfrage mit der Resend-Signatur, bevor eine Mail gespeichert wird.

## Hinweise

- Für die Statusanzeige im Postfach kannst du zusätzlich die Events `email.sent`, `email.delivered`, `email.failed` und `email.bounced` im selben Webhook aktivieren.
- Der API-Key und das `whsec_...`-Secret gehören ausschließlich in die Server-Umgebungsvariablen, nie in den Browser oder ein Git-Commit.
- Die Postfach-Tabellen sind per RLS gesperrt; nur die API mit einem gültigen ehoser-Login kann die eigenen Nachrichten lesen.
