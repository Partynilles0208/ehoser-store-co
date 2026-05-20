#!/usr/bin/env node

/**
 * Generiert einen sicheren JWT Secret zum Kopieren in Railway/Production
 * Nutze diesen Command:
 * node generate-secrets.js
 */

const crypto = require('crypto');

console.log('\n🔐 Sichere Secrets generiert:\n');

const jwtSecret = crypto.randomBytes(32).toString('hex');
const newAdminKey = crypto.randomBytes(16).toString('hex');

console.log('📋 JWT_SECRET (kopiere in Railway):');
console.log(jwtSecret);

console.log('\n🔑 Alternative ADMIN_UPLOAD_KEY (falls du eine generierte willst):');
console.log(newAdminKey);

console.log('\n⚠️  ABER: Nutze "Nils2014!" als Admin-Key für deine Seite.');
console.log('💾 Speichere den JWT_SECRET sicher ab!\n');
