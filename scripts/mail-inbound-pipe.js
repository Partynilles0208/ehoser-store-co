#!/usr/bin/env node

const http = require('http');
const https = require('https');

const endpoint = process.env.MAIL_INBOUND_URL || 'http://127.0.0.1:3000/api/mail/inbound';
const secret = process.env.MAIL_INBOUND_SECRET || '';
const recipient = process.argv[2] || process.env.ORIGINAL_RECIPIENT || process.env.RECIPIENT || '';
const sender = process.argv[3] || process.env.SENDER || '';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const subjectMatch = raw.match(/^Subject:\s*(.+)$/im);
  const fromMatch = raw.match(/^From:\s*(.+)$/im);
  const toMatch = raw.match(/^To:\s*(.+)$/im);
  const bodyStart = raw.indexOf('\n\n');
  const payload = JSON.stringify({
    secret,
    recipient: recipient || toMatch?.[1] || '',
    sender: sender || fromMatch?.[1] || '',
    subject: subjectMatch?.[1] || '(ohne Betreff)',
    text: bodyStart >= 0 ? raw.slice(bodyStart + 2) : raw,
    raw
  });

  const url = new URL(endpoint);
  const client = url.protocol === 'https:' ? https : http;
  const req = client.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => {
    res.resume();
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 75);
  });
  req.on('error', () => process.exit(75));
  req.write(payload);
  req.end();
});
