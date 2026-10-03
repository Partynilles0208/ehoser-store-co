-- Reale @ehoser.de-Postfaecher. Versand und Empfang laufen ausschliesslich
-- ueber die serverseitige Resend-Integration.

CREATE TABLE IF NOT EXISTS public.ehoser_mailboxes (
  username TEXT PRIMARY KEY REFERENCES public.users(username) ON UPDATE CASCADE ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ehoser_mail_messages (
  id BIGSERIAL PRIMARY KEY,
  provider_message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_username TEXT REFERENCES public.users(username) ON UPDATE CASCADE ON DELETE SET NULL,
  sender_address TEXT NOT NULL,
  recipient_username TEXT REFERENCES public.users(username) ON UPDATE CASCADE ON DELETE SET NULL,
  recipient_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'failed', 'bounced')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ NULL,
  CONSTRAINT ehoser_mail_messages_provider_direction_key UNIQUE (provider_message_id, direction)
);

CREATE INDEX IF NOT EXISTS ehoser_mail_messages_recipient_created_idx
  ON public.ehoser_mail_messages (recipient_username, created_at DESC);
CREATE INDEX IF NOT EXISTS ehoser_mail_messages_sender_created_idx
  ON public.ehoser_mail_messages (sender_username, created_at DESC);
CREATE INDEX IF NOT EXISTS ehoser_mail_messages_provider_message_idx
  ON public.ehoser_mail_messages (provider_message_id);

ALTER TABLE public.ehoser_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ehoser_mail_messages ENABLE ROW LEVEL SECURITY;

-- Der Browser bekommt keinen direkten Tabellenzugriff. Die API nutzt den
-- serverseitigen service_role-Client nach Prüfung des ehoser-Login-Tokens.
REVOKE ALL ON TABLE public.ehoser_mailboxes, public.ehoser_mail_messages FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.ehoser_mail_messages_id_seq FROM anon, authenticated;
