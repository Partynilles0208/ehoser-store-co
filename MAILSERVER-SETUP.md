# Ehoser Email Center

Die App hat ein Email Center fuer `@ehoser.de`. Am einfachsten laeuft es jetzt mit Resend. Postfix ist nur noch die Alternative, wenn du spaeter wirklich alles selbst hosten willst.

## Variante A: Resend

```env
MAIL_DOMAIN=ehoser.de
RESEND_API_KEY=re_dein_resend_api_key
RESEND_WEBHOOK_SECRET=dein-webhook-geheimnis
```

### 1. Domain in Resend hinzufuegen

In Resend:

```txt
Domains -> Add Domain -> ehoser.de
```

Resend zeigt dir DNS Records. Diese Records kopierst du bei deinem Domain-Anbieter rein. Wichtig sind SPF und DKIM. Fuer Empfangen/Inboud zeigt Resend auch einen MX Record.

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
https://DEINE-DOMAIN/api/mail/resend-webhook?secret=dein-webhook-geheimnis
```

Event auswaehlen:

```txt
email.received
```

Dasselbe Secret setzt du in deiner App:

```env
RESEND_WEBHOOK_SECRET=dein-webhook-geheimnis
```

### 4. App benutzen

In der Ehoser-App:

```txt
Emails -> Adresse erstellen -> z.B. test
```

Dann kannst du von `test@ehoser.de` senden. Wenn Resend Inbound fuer deine Domain aktiv ist, kommen empfangene Mails ueber den Webhook ins Postfach.

## Variante B: Postfix selbst hosten

Nur noetig, wenn du spaeter ohne Resend arbeiten willst.

Environment:

```env
MAIL_DOMAIN=ehoser.de
MAIL_INBOUND_SECRET=ein-sehr-langes-geheimes-passwort
MAIL_INBOUND_URL=http://127.0.0.1:3000/api/mail/inbound
MAIL_SENDMAIL_PATH=/usr/sbin/sendmail
```

DNS:

```txt
MX    @    mail.ehoser.de
A     mail <deine-server-ip>
TXT   @    v=spf1 mx -all
TXT   _dmarc    v=DMARC1; p=quarantine; rua=mailto:postmaster@ehoser.de
```

DKIM musst du in deinem Mailserver erzeugen und als TXT Record setzen. Ohne SPF, DKIM, DMARC und Reverse DNS landen viele Mails im Spam.

## Postfix-Idee fuer eingehende Mails

Leite Mails fuer `@ehoser.de` an das Pipe-Script weiter:

```txt
# /etc/postfix/master.cf
ehoserpipe unix - n n - - pipe
  flags=Rq user=www-data argv=/usr/bin/node /pfad/zur/app/scripts/mail-inbound-pipe.js ${recipient} ${sender}
```

```txt
# /etc/postfix/transport
ehoser.de ehoserpipe:
```

Danach:

```bash
postmap /etc/postfix/transport
postconf -e "transport_maps = hash:/etc/postfix/transport"
systemctl reload postfix
```

## Senden

Das Backend ruft `MAIL_SENDMAIL_PATH -t -i` auf. Auf einem Linux-Server mit Postfix ist das normalerweise `/usr/sbin/sendmail`.

Teste zuerst lokal auf dem Server:

```bash
echo "Subject: test

hallo" | /usr/sbin/sendmail deine-private-adresse@example.com
```

Wenn das funktioniert, kann das Email Center senden.
