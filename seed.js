const sqlite3 = require('sqlite3').verbose();

// Hilfsfunktion zum Generieren von Zugangscodes
function generateAccessCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        codes.push(code);
    }
    return codes;
}

// Datenbank initialisieren
const db = new sqlite3.Database('./store.db', (err) => {
    if (err) {
        console.error('Datenbankfehler:', err);
        process.exit(1);
    }
    console.log('✅ Datenbank verbunden');
});

// Zugangscodes einfügen
async function seedAccessCodes() {
    const codes = generateAccessCodes(10);
    
    console.log('\n📋 Generierte Zugangscodes:');
    console.log('=' .repeat(40));
    
    codes.forEach((code, index) => {
        // In Zukunft könnten hier auch echte Codes in einer separaten Tabelle gespeichert werden
        console.log(`${index + 1}. ${code}`);
    });
    
    console.log('=' .repeat(40));
    console.log('\n💡 Diese Codes können zur Registrierung verwendet werden!');
    console.log('\n📝 Tipp: Kopiere diese Codes und teile sie mit deinen Mitgliedern.');
    
    db.close();
}

// Datenbankstatistiken
async function showStats() {
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        console.log(`\n👥 Registrierte Benutzer: ${row.count}`);
    });

    db.get("SELECT COUNT(*) as count FROM apps", (err, row) => {
        console.log(`📱 Verfügbare Apps: ${row.count}`);
    });

    db.get("SELECT COUNT(*) as count FROM installations", (err, row) => {
        console.log(`⬇️  Installationen: ${row.count}\n`);
    });
}

// Script ausführen
if (process.argv.includes('--stats')) {
    showStats();
    setTimeout(() => db.close(), 1000);
} else {
    seedAccessCodes();
}
