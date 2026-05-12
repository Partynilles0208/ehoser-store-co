# Ehoser Email Center selbst hosten

Die App hat jetzt ein Email Center fuer `@ehoser.de`. Die Web-App verwaltet Adressen, zeigt Nachrichten an und sendet ueber dein eigenes `sendmail`/Postfix.

## Environment

```env
MAIL_DOMAIN=ehoser.de
MAIL_INBOUND_SECRET=ein-sehr-langes-geheimes-passwort
MAIL_INBOUND_URL=http://127.0.0.1:3000/api/mail/inbound
MAIL_SENDMAIL_PATH=/usr/sbin/sendmail
```

## DNS fuer ehoser.de

Setze beim Domain-Anbieter:

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
