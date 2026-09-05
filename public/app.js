const EHOSER_DESKTOP_MODE = Boolean(window.__EHOSER_DESKTOP__) || new URLSearchParams(window.location.search).get('desktop') === '1';
const EHOSER_API_ORIGIN = EHOSER_DESKTOP_MODE
    ? (window.__EHOSER_API_ORIGIN__ || 'https://ehoser.de')
    : window.location.origin;
const API_BASE = `${EHOSER_API_ORIGIN}/api`;

function parseServerDate(value) {
    if (!value) return new Date();
    if (typeof value === 'number') return new Date(value);
    let str = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str)) {
        str = str.replace(' ', 'T');
    }
    const date = new Date(str);
    if (Number.isNaN(date.valueOf())) return new Date();
    date.setHours(date.getHours() + 2);
    return date;
}

const ENTRY_ACCESS_CODE = '020818';
const ENTRY_UNLOCK_KEY = 'ehoserEntryUnlocked';
const ENTRY_CHOICE_KEY = 'ehoserEntryChoice';
const DESKTOP_AUTH_KEY = 'ehoserDesktopActivated';
const DESKTOP_USER_CACHE_KEY = 'ehoserDesktopUserCache';
const DESKTOP_ONLINE_MODES = new Set(['games', 'ki', 'chat', 'map', 'youtube', 'news', 'images', 'weather', 'gameCreator', 'ps']);
const miniToolHelpers = {
    words: (text) => String(text || '').trim().split(/\s+/).filter(Boolean),
    lineCount: (text) => String(text || '').split(/\r?\n/).filter(Boolean).length,
    normalizeWord: (word) => String(word || '').toLowerCase().replace(/[^\p{L}0-9]+/gu, ''),
    slugify: (text) => String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-'),
    parseHexColor: (hex) => {
        const cleaned = String(hex || '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{6}$/i.test(cleaned)) {
            return [parseInt(cleaned.slice(0, 2), 16), parseInt(cleaned.slice(2, 4), 16), parseInt(cleaned.slice(4, 6), 16)];
        }
        return null;
    },
    rgbToHex: (r, g, b) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`,
    clamp: (value, min, max) => Math.min(Math.max(value, min), max),
    parseDate: (value) => {
        const date = new Date(String(value || ''));
        return Number.isNaN(date.valueOf()) ? null : date;
    },
    toTitleCase: (text) => String(text || '').replace(/\w[\p{L}0-9]*/gu, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()),
    getContrastInfo: (fg, bg) => {
        const luminance = ([r, g, b]) => {
            return [r, g, b].map((c) => {
                const v = c / 255;
                return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        };
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        const ratio = ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
        return {
            ratio: ratio.toFixed(2),
            grade: ratio >= 4.5 ? 'Gut' : ratio >= 3 ? 'Akzeptabel' : 'Schwach'
        };
    },
    weekNumber: (date) => {
        const target = new Date(date.valueOf());
        const dayNr = (date.getDay() + 6) % 7;
        target.setDate(target.getDate() - dayNr + 3);
        const firstThursday = target.valueOf();
        target.setMonth(0, 1);
        if (target.getDay() !== 4) {
            target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
        }
        return 1 + Math.round((firstThursday - target) / 604800000);
    }
};
const MINI_TOOL_DEFINITIONS = {
    lorem: {
        title: 'Lorem Ipsum',
        description: 'Erzeuge Platzhaltertext für Design-Layouts und Mockups.',
        category: 'Text-Tool',
        inputLabel: 'Wörter',
        placeholder: 'Gib die Anzahl Wörter ein, z.B. 50',
        actionText: 'Lorem erzeugen',
        run: (value) => {
            const count = Math.max(8, Math.min(200, parseInt(value, 10) || 60));
            const base = 'Lorem ipsum dolor sit amet consectetur adipiscing elit'.split(' ');
            return Array.from({ length: count }, (_, i) => base[i % base.length]).join(' ') + '.';
        }
    },
    holiday: {
        title: 'Feiertags-Countdown',
        description: 'Berechnet den nächsten Feiertag in Deutschland.',
        category: 'Planung',
        inputLabel: 'Land',
        placeholder: 'DE, AT, CH oder leer für DE',
        actionText: 'Nächsten Feiertag finden',
        run: () => {
            const holidays = [
                ['Neujahr', '01-01'], ['Karfreitag', '04-18'], ['Ostermontag', '04-21'], ['Tag der Arbeit', '05-01'], ['Christi Himmelfahrt', '05-29'], ['Pfingstmontag', '06-09'], ['Tag der Deutschen Einheit', '10-03'], ['1. Weihnachtstag', '12-25'], ['2. Weihnachtstag', '12-26']
            ];
            const today = new Date();
            const year = today.getFullYear();
            let next = null;
            for (const [name, mmdd] of holidays) {
                const [m, d] = mmdd.split('-').map(Number);
                const date = new Date(year, m - 1, d);
                if (date >= today) { next = [name, date]; break; }
            }
            if (!next) {
                const [name, mmdd] = holidays[0];
                const [m, d] = mmdd.split('-').map(Number);
                next = [name, new Date(year + 1, m - 1, d)];
            }
            const diff = Math.ceil((next[1] - today) / 86400000);
            return `Nächster Feiertag: ${next[0]} am ${next[1].toLocaleDateString('de-DE')} (${diff} Tage)`;
        }
    },
    contrast: {
        title: 'Farbkontrast',
        description: 'Prüft, wie gut zwei Farben zusammen lesbar sind.',
        category: 'Design',
        inputLabel: 'Vordergrundfarbe',
        placeholder: 'z.B. #ffffff',
        input2Label: 'Hintergrundfarbe',
        placeholder2: 'z.B. #1f2937',
        actionText: 'Kontrast prüfen',
        input2Visible: true,
        run: (value, value2) => {
            const fg = miniToolHelpers.parseHexColor(value || '#ffffff');
            const bg = miniToolHelpers.parseHexColor(value2 || '#000000');
            if (!fg || !bg) {
                return 'Bitte gültige HEX-Farben eingeben, z.B. #ffffff.';
            }
            const info = miniToolHelpers.getContrastInfo(fg, bg);
            return `Kontrastverhältnis: ${info.ratio}:1\nBewertung: ${info.grade}`;
        }
    },
    markdown: {
        title: 'Markdown Vorschau',
        description: 'Schreibe Markdown und sieh die formatierte Vorschau in Echtzeit.',
        category: 'Schreiben',
        inputLabel: 'Markdown',
        placeholder: 'Gib Markdown ein...',
        actionText: 'Vorschau aktualisieren',
        extraHtml: 'Überschriften mit #, **fett**, *kursiv* und [Link](https://example.com).',
        autoRunOnInput: true,
        run: (value) => {
            const text = String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const html = text
                .replace(/^######\s*(.*)$/gm, '<h6>$1</h6>')
                .replace(/^#####\s*(.*)$/gm, '<h5>$1</h5>')
                .replace(/^####\s*(.*)$/gm, '<h4>$1</h4>')
                .replace(/^###\s*(.*)$/gm, '<h3>$1</h3>')
                .replace(/^##\s*(.*)$/gm, '<h2>$1</h2>')
                .replace(/^#\s*(.*)$/gm, '<h1>$1</h1>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
                .replace(/^(?!<h|<ul|<ol|<blockquote|<pre)(.*)$/gm, '<p>$1</p>');
            return { html };
        }
    },
    binary: {
        title: 'Zahlen-Konverter',
        description: 'Rechnet Binär, Dezimal und Hexadezimal um.',
        category: 'Dev Tool',
        inputLabel: 'Zahl',
        placeholder: 'z.B. 42 oder 0b101010 oder 0x2A',
        actionText: 'Konvertieren',
        run: (value) => {
            const input = String(value || '').trim().toLowerCase();
            if (input.startsWith('0b')) {
                const num = parseInt(input.slice(2), 2);
                return `Dezimal: ${num}\nHex: 0x${num.toString(16).toUpperCase()}`;
            }
            if (input.startsWith('0x')) {
                const num = parseInt(input.slice(2), 16);
                return `Dezimal: ${num}\nBinär: 0b${num.toString(2)}`;
            }
            if (/^\d+$/.test(input)) {
                const num = parseInt(input, 10);
                return `Binär: 0b${num.toString(2)}\nHex: 0x${num.toString(16).toUpperCase()}`;
            }
            return 'Bitte eine Dezimalzahl, 0bBinär oder 0xHex eingeben.';
        }
    },
    fact: {
        title: 'Zufallsfakten',
        description: 'Kurze, interessante Fakten für Pausen und Gespräche.',
        category: 'Wissen',
        actionText: 'Fakt generieren',
        inputVisible: false,
        run: () => {
            const facts = [
                'Im Weltraum hört dich niemand schreien, aber dort gibt es keinen Klang.',
                'Honig kann praktisch nicht verderben und wurde in alten Gräbern gefunden.',
                'Bananen sind Beeren, Erdbeeren dagegen nicht.',
                'Der Buchstabe W ist der einzige Buchstabe mit drei Silben in Deutsch.',
                'Glühwürmchen nutzen Licht, um Artgenossen zu finden und Räuber abzuschrecken.'
            ];
            return facts[Math.floor(Math.random() * facts.length)];
        }
    },
    todo: {
        title: 'ToDo Liste',
        description: 'Schreibe Aufgaben und erhalte eine formatierte Liste.',
        category: 'Produktivität',
        inputLabel: 'Aufgaben (je Zeile)',
        placeholder: 'Erste Aufgabe\nZweite Aufgabe\n...',
        actionText: 'Liste erstellen',
        run: (value) => {
            const items = String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
            if (!items.length) return 'Bitte mindestens eine Aufgabe eingeben.';
            return items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
        }
    },
    emoji: {
        title: 'Emoji Suche',
        description: 'Finde Emojis nach Begriffen und kopiere sie schnell.',
        category: 'Spaß',
        inputLabel: 'Begriff',
        placeholder: 'z.B. lachen, liebe, wetter',
        actionText: 'Emoji finden',
        run: (value) => {
            const emojis = {
                lachen: '😄 😂 🤣',
                liebe: '❤️ 💕 😍',
                wetter: '☀️ 🌧️ ⛅',
                essen: '🍕 🍔 🍣',
                reisen: '✈️ 🌍 🧳',
                arbeit: '💼 🧑‍💻 📊'
            };
            const key = String(value || '').toLowerCase();
            return emojis[key] || 'Keine direkte Treffer. Versuch: lachen, liebe, wetter, essen, reisen, arbeit.';
        }
    },
    currency: {
        title: 'Währungsrechner',
        description: 'Rechnet Beträge einfach zwischen verschiedenen Währungen um.',
        category: 'Finanzen',
        inputLabel: 'Betrag',
        placeholder: 'z.B. 100',
        input2Label: 'Zielwährung',
        placeholder2: 'z.B. USD, CHF, GBP',
        actionText: 'Umrechnen',
        input2Visible: true,
        run: (value, value2) => {
            const amt = parseFloat(String(value || '').replace(',', '.'));
            const target = String(value2 || 'USD').trim().toUpperCase();
            const rateMap = { EUR: 1, USD: 1.08, CHF: 0.98, GBP: 0.86 };
            if (!amt || !rateMap[target]) {
                return 'Bitte Betrag und gültige Zielwährung angeben: USD, CHF, GBP.';
            }
            return `${amt.toFixed(2)} EUR ≈ ${(amt * rateMap[target]).toFixed(2)} ${target}`;
        }
    },
    sleep: {
        title: 'Schlafzyklus',
        description: 'Berechne die besten Aufwachzeiten für erholsamen Schlaf.',
        category: 'Wellness',
        inputLabel: 'Schlafenszeit',
        placeholder: 'z.B. 22:30',
        actionText: 'Beste Aufwachzeiten',
        run: (value) => {
            const match = String(value || '22:30').match(/^(\d{1,2}):(\d{2})$/);
            if (!match) return 'Bitte eine Uhrzeit im Format HH:MM eingeben.';
            const [_, h, m] = match;
            const start = new Date();
            start.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
            const options = [6.5, 8, 9.5].map((hours) => {
                const wake = new Date(start.getTime() + hours * 3600000);
                return `${hours} Std → ${wake.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
            });
            return `Beste Aufwachzeiten:\n${options.join('\n')}`;
        }
    },
    slug: {
        title: 'Slug Generator',
        description: 'Erstellt eine saubere URL aus deinem Text.',
        category: 'Web',
        inputLabel: 'Text',
        placeholder: 'z.B. Mein Blog-Beitrag Titel',
        actionText: 'Slug erzeugen',
        run: (value) => {
            const slug = miniToolHelpers.slugify(value);
            return slug || 'Bitte einen Text eingeben.';
        }
    },
    palindrome: {
        title: 'Palindrom Test',
        description: 'Prüft, ob ein Text vorwärts und rückwärts gleich ist.',
        category: 'Text',
        inputLabel: 'Text',
        placeholder: 'z.B. Anna',
        actionText: 'Prüfen',
        run: (value) => {
            const clean = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!clean) return 'Bitte einen Text eingeben.';
            return clean === clean.split('').reverse().join('') ? 'Das ist ein Palindrom.' : 'Das ist kein Palindrom.';
        }
    },
    anagram: {
        title: 'Anagramm-Generator',
        description: 'Erzeuge neue Wortkombinationen aus deinem Text.',
        category: 'Kreativ',
        inputLabel: 'Text',
        placeholder: 'z.B. Hallo Welt',
        actionText: 'Anagramme erzeugen',
        run: (value) => {
            const letters = String(value || '').replace(/[^a-zA-Z]/g, '');
            if (!letters) return 'Bitte einen Text eingeben.';
            const chars = letters.split('');
            for (let i = chars.length - 1; i > 0; i -= 1) {
                const j = Math.floor(Math.random() * (i + 1));
                [chars[i], chars[j]] = [chars[j], chars[i]];
            }
            return `Alternative Buchstabenfolge:\n${chars.join('')}`;
        }
    },
    datecalc: {
        title: 'Datumsrechner',
        description: 'Berechnet die Tage zwischen zwei Daten.',
        category: 'Planung',
        inputLabel: 'Startdatum',
        placeholder: 'z.B. 2025-01-01',
        input2Label: 'Enddatum',
        placeholder2: 'z.B. 2025-12-31',
        actionText: 'Differenz berechnen',
        input2Visible: true,
        run: (value, value2) => {
            const start = miniToolHelpers.parseDate(value);
            const end = miniToolHelpers.parseDate(value2);
            if (!start || !end) return 'Bitte zwei gültige Daten im Format YYYY-MM-DD eingeben.';
            return `Differenz: ${Math.round(Math.abs(end - start) / 86400000)} Tage`;
        }
    },
    projectidea: {
        title: 'Projektideen',
        description: 'Bekomme kreative Ideen für Websites, Apps und Hobbys.',
        category: 'Inspiration',
        inputLabel: 'Thema (optional)',
        placeholder: 'z.B. Nachhaltigkeit, Schule, Hobby',
        actionText: 'Idee finden',
        run: (value) => {
            const ideas = [
                'Eine mobile App für lokale Community-Termine.',
                'Ein persönliches Lernjournal mit Fortschrittskarten.',
                'Eine Website für einfache Haushaltsplanung.',
                'Ein Tool zur visuellen Tagesplanung mit Farben.'
            ];
            return `${value ? `Projektidee zu ${value}: ` : ''}${ideas[Math.floor(Math.random() * ideas.length)]}`;
        }
    },
    mealidea: {
        title: 'Rezeptideen',
        description: 'Finde schnelle Essensideen für Frühstück, Mittag und Abendessen.',
        category: 'Alltag',
        inputLabel: 'Bevorzugte Küche oder Zutat',
        placeholder: 'z.B. Pasta, vegan, Frühstück',
        actionText: 'Rezeptvorschlag',
        run: () => {
            const meals = ['Pasta mit Tomatensauce', 'Bowl mit Quinoa und Gemüse', 'Ofenkartoffeln mit Kräuterquark', 'Frühstücks-Porridge mit Beeren'];
            return meals[Math.floor(Math.random() * meals.length)];
        }
    },
    namegen: {
        title: 'Namens-Generator',
        description: 'Erzeuge zufällige Namen für Charaktere, Marken oder Projekte.',
        category: 'Kreativ',
        inputLabel: 'Kategorie (optional)',
        placeholder: 'z.B. Tech, Fantasy, Team',
        actionText: 'Name generieren',
        run: () => {
            const prefixes = ['Nova', 'Cloud', 'Pixel', 'Echo', 'Luna'];
            const suffixes = ['Labs', 'Studio', 'Works', 'Hub', 'Spot'];
            return `${prefixes[Math.floor(Math.random() * prefixes.length)]}${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
        }
    },
    hashtag: {
        title: 'Hashtag-Generator',
        description: 'Erstelle passende Hashtags für Social Media Beiträge.',
        category: 'Social',
        inputLabel: 'Text oder Thema',
        placeholder: 'z.B. Reisen, Fitness, Coding',
        actionText: 'Hashtags erzeugen',
        run: (value) => {
            const base = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (!base) return 'Bitte einen Begriff eingeben.';
            const tag = base.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
            return `#${tag} #${tag}Tipps #${tag}Life`;
        }
    },
    domain: {
        title: 'Domain-Ideen',
        description: 'Finde einprägsame Domain-Namen für neue Projekte.',
        category: 'Startup',
        inputLabel: 'Ein Wort oder Thema',
        placeholder: 'z.B. shop, tech, musik',
        actionText: 'Domain-Ideen',
        run: (value) => {
            const prefix = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!prefix) return 'Bitte ein Thema oder Wort eingeben.';
            return `${prefix}hub.de\n${prefix}works.com\n${prefix}zone.net`;
        }
    },
    phonefmt: {
        title: 'Telefonformatierer',
        description: 'Formatiert Telefonnummern sauber und einheitlich.',
        category: 'Office',
        inputLabel: 'Nummer',
        placeholder: 'z.B. 491771234567',
        actionText: 'Formatieren',
        run: (value) => {
            const digits = String(value || '').replace(/\D/g, '');
            if (!digits) return 'Bitte eine Telefonnummer eingeben.';
            if (digits.length === 11) {
                return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
            }
            return digits;
        }
    },
    wordfreq: {
        title: 'Wortfrequenz',
        description: 'Finde die häufigsten Wörter in deinem Text.',
        category: 'Analyse',
        inputLabel: 'Text',
        placeholder: 'Gib hier deinen Text ein...',
        actionText: 'Analysieren',
        run: (value) => {
            const words = miniToolHelpers.words(value);
            const counts = words.reduce((acc, word) => {
                const key = miniToolHelpers.normalizeWord(word);
                if (!key) return acc;
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {});
            const entries = Object.entries(counts);
            if (!entries.length) return 'Bitte Text eingeben.';
            return entries.sort((a, b) => b[1] - a[1]).map(([w, c]) => `${w}: ${c}`).join('\n');
        }
    },
    textclean: {
        title: 'Text bereinigen',
        description: 'Entfernt überflüssige Leerzeichen und bereinigt Text.',
        category: 'Produktivität',
        inputLabel: 'Text',
        placeholder: 'Gib hier deinen Text ein...',
        actionText: 'Bereinigen',
        run: (value) => {
            const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
            return cleaned || 'Bitte Text eingeben.';
        }
    },
    timer2: {
        title: 'Kurzzeit-Timer',
        description: 'Starte einen einfachen Timer für Pausen oder Übungen.',
        category: 'Zeit',
        inputLabel: 'Sekunden',
        placeholder: 'z.B. 90',
        actionText: 'Timer starten',
        run: (value) => {
            const seconds = miniToolHelpers.clamp(parseInt(String(value || ''), 10) || 0, 1, 3600);
            if (!seconds) return 'Bitte eine Dauer in Sekunden eingeben.';
            return `timer:${seconds}`;
        }
    },
    timezone: {
        title: 'Zeitzonen',
        description: 'Berechnet Uhrzeiten zwischen zwei Zeitzonen.',
        category: 'Reise',
        inputLabel: 'Uhrzeit',
        placeholder: 'z.B. 14:00',
        input2Label: 'Zeitzone (z.B. UTC+1)',
        placeholder2: 'z.B. UTC+2 oder UTC-5',
        actionText: 'Umrechnen',
        input2Visible: true,
        run: (value, value2) => {
            const timeMatch = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
            const zoneMatch = String(value2 || '').match(/^UTC([+-]\d{1,2})$/i);
            if (!timeMatch || !zoneMatch) return 'Bitte Zeit HH:MM und Zeitzone z.B. UTC+2 eingeben.';
            const hours = parseInt(timeMatch[1], 10);
            const mins = parseInt(timeMatch[2], 10);
            const offset = parseInt(zoneMatch[1], 10);
            const date = new Date();
            date.setHours(hours - offset, mins, 0, 0);
            return `UTC Zeit: ${date.toISOString().substr(11, 5)}\n${value2.toUpperCase()} entspricht UTC`;
        }
    },
    randomcolor: {
        title: 'Zufallsfarbe',
        description: 'Erzeugt zufällige Farbwerte als HEX und RGB.',
        category: 'Design',
        actionText: 'Farbe generieren',
        inputVisible: false,
        run: () => {
            const rand = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
            const rgb = miniToolHelpers.parseHexColor(rand);
            return `${rand}\nRGB: ${rgb.join(', ')}`;
        }
    },
    rgb: {
        title: 'Farbcode-Konverter',
        description: 'Wandelt Hex-Farben in RGB um und umgekehrt.',
        category: 'Design',
        inputLabel: 'Hex oder RGB',
        placeholder: 'z.B. #ff6600 oder 255,102,0',
        actionText: 'Konvertieren',
        run: (value) => {
            const hexMatch = String(value || '').match(/^#?([0-9a-f]{6})$/i);
            if (hexMatch) {
                const rgb = miniToolHelpers.parseHexColor(hexMatch[1]);
                return `RGB: ${rgb.join(', ')}`;
            }
            const rgbMatch = String(value || '').match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
            if (rgbMatch) {
                const [r, g, b] = rgbMatch.slice(1).map((num) => miniToolHelpers.clamp(parseInt(num, 10), 0, 255));
                return miniToolHelpers.rgbToHex(r, g, b);
            }
            return 'Bitte Hex (#rrggbb) oder RGB (r,g,b) eingeben.';
        }
    },
    weeknumber: {
        title: 'Wochennummer',
        description: 'Finde die Kalenderwoche für ein bestimmtes Datum.',
        category: 'Planung',
        inputLabel: 'Datum',
        placeholder: 'z.B. 2025-05-27',
        actionText: 'Woche berechnen',
        run: (value) => {
            const date = miniToolHelpers.parseDate(value);
            if (!date) return 'Bitte ein gültiges Datum im Format YYYY-MM-DD eingeben.';
            return `KW ${miniToolHelpers.weekNumber(date)}`;
        }
    },
    speedcalc: {
        title: 'Speed Rechner',
        description: 'Berechnet Tipp- oder Lesegeschwindigkeit.',
        category: 'Analyse',
        inputLabel: 'Anzahl Wörter',
        placeholder: 'z.B. 250',
        input2Label: 'Sekunden',
        placeholder2: 'z.B. 60',
        actionText: 'Speed berechnen',
        input2Visible: true,
        run: (value, value2) => {
            const wordsCount = Math.max(1, parseInt(String(value || ''), 10) || 0);
            const seconds = Math.max(1, parseInt(String(value2 || ''), 10) || 60);
            if (!wordsCount || !seconds) return 'Bitte Wortanzahl und Sekunden eingeben.';
            return `Geschwindigkeit: ${Math.round(wordsCount / seconds * 60)} WPM`;
        }
    },
    password2: {
        title: 'Passwort-Generator 2.0',
        description: 'Erzeugt sichere Passwörter mit optionalen Symbolen.',
        category: 'Security',
        inputLabel: 'Länge',
        placeholder: 'z.B. 16',
        input2Label: 'Symbole verwenden? (ja/nein)',
        placeholder2: 'z.B. ja',
        actionText: 'Passwort erstellen',
        input2Visible: true,
        run: (value, value2) => {
            const length = miniToolHelpers.clamp(parseInt(String(value || ''), 10) || 16, 8, 64);
            const useSymbols = String(value2 || '').toLowerCase().startsWith('j');
            const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + (useSymbols ? '!@#$%^&*()_+-=[]{}|;:,.<>?' : '');
            let result = '';
            for (let i = 0; i < length; i += 1) {
                result += charset[Math.floor(Math.random() * charset.length)];
            }
            return result;
        }
    },
    motivation: {
        title: 'Motivations-Boost',
        description: 'Liefert inspirierende Sätze für mehr Fokus.',
        category: 'Mindset',
        actionText: 'Motivation holen',
        inputVisible: false,
        run: () => {
            const quotes = ['Du kannst mehr als du denkst.', 'Kleiner Fortschritt ist immer noch Fortschritt.', 'Starte jetzt, nicht später.', 'Deine beste Zeit ist jetzt.'];
            return quotes[Math.floor(Math.random() * quotes.length)];
        }
    },
    wordcount: {
        title: 'Wortanzahl',
        description: 'Zählt Wörter, Zeichen und häufigste Wörter im Text.',
        category: 'Text',
        inputLabel: 'Text',
        placeholder: 'Gib hier deinen Text ein...',
        actionText: 'Zählen',
        run: (value) => {
            const text = String(value || '');
            if (!text.trim()) return 'Bitte gib einen Text ein.';
            const words = miniToolHelpers.words(text);
            const lines = miniToolHelpers.lineCount(text);
            const chars = text.length;
            const unique = [...new Set(words.map((word) => miniToolHelpers.normalizeWord(word)))].filter(Boolean).length;
            const freq = words.reduce((acc, word) => {
                const key = miniToolHelpers.normalizeWord(word);
                if (!key) return acc;
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {});
            const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, c]) => `${w}: ${c}`).join('\n');
            return `Zeichen: ${chars}\nWörter: ${words.length}\nZeilen: ${lines}\nEinzigartige Wörter: ${unique}\n\nTop Wörter:\n${top}`;
        }
    },
    caseconv: {
        title: 'Text-Konverter',
        description: 'Konvertiere Text in Groß-, Klein- oder Titel-Schreibweise.',
        category: 'Text',
        inputLabel: 'Text',
        placeholder: 'Gib deinen Text ein...',
        input2Label: 'Modus',
        placeholder2: 'upper, lower oder title',
        actionText: 'Konvertieren',
        input2Visible: true,
        run: (value, value2) => {
            const mode = String(value2 || '').toLowerCase();
            if (!value.trim()) return 'Bitte gib einen Text ein.';
            if (mode === 'upper' || mode === 'groß') return String(value).toUpperCase();
            if (mode === 'lower' || mode === 'klein') return String(value).toLowerCase();
            if (mode === 'title' || mode === 'titel') return miniToolHelpers.toTitleCase(value);
            return 'Bitte wähle einen Modus: upper, lower oder title.';
        }
    }
};
const parseMiniNumber = (value) => {
    const num = parseFloat(String(value ?? '').replace(',', '.').trim());
    return Number.isFinite(num) ? num : null;
};

const formatMiniNumber = (value, digits = 6) => {
    if (!Number.isFinite(value)) return '0';
    return Number(value.toFixed(digits)).toString();
};

function createExtraMiniToolDefinitions() {
    const defs = {};

    const conversionSpecs = [
        { key: 'km_mi', title: 'Kilometer -> Meilen', from: 'km', to: 'mi', factor: 0.621371 },
        { key: 'm_ft', title: 'Meter -> Fuß', from: 'm', to: 'ft', factor: 3.28084 },
        { key: 'cm_in', title: 'Zentimeter -> Inch', from: 'cm', to: 'in', factor: 0.393701 },
        { key: 'kg_lb', title: 'Kilogramm -> Pfund', from: 'kg', to: 'lb', factor: 2.20462 },
        { key: 'g_oz', title: 'Gramm -> Unzen', from: 'g', to: 'oz', factor: 0.035274 },
        { key: 'l_gal', title: 'Liter -> Gallonen', from: 'l', to: 'gal', factor: 0.264172 },
        { key: 'ml_floz', title: 'Milliliter -> Fluid Ounce', from: 'ml', to: 'fl oz', factor: 0.033814 },
        { key: 'ha_ac', title: 'Hektar -> Acre', from: 'ha', to: 'ac', factor: 2.47105 },
        { key: 'km2_mi2', title: 'Quadratkilometer -> Quadratmeilen', from: 'km²', to: 'mi²', factor: 0.386102 },
        { key: 'm2_ft2', title: 'Quadratmeter -> Quadratfuß', from: 'm²', to: 'ft²', factor: 10.7639 },
        { key: 'nm_km', title: 'Seemeilen -> Kilometer', from: 'nm', to: 'km', factor: 1.852 },
        { key: 'bar_psi', title: 'Bar -> PSI', from: 'bar', to: 'psi', factor: 14.5038 },
        { key: 'kpa_psi', title: 'kPa -> PSI', from: 'kPa', to: 'psi', factor: 0.145038 },
        { key: 'mps_kmh', title: 'm/s -> km/h', from: 'm/s', to: 'km/h', factor: 3.6 },
        { key: 'w_hp', title: 'Watt -> PS', from: 'W', to: 'PS', factor: 0.00135962 },
        { key: 'kw_hp', title: 'Kilowatt -> PS', from: 'kW', to: 'PS', factor: 1.35962 },
        { key: 'n_lbf', title: 'Newton -> lbf', from: 'N', to: 'lbf', factor: 0.224809 },
        { key: 'j_cal', title: 'Joule -> Kalorien', from: 'J', to: 'cal', factor: 0.239006 },
        { key: 'wh_j', title: 'Wattstunden -> Joule', from: 'Wh', to: 'J', factor: 3600 },
        { key: 'byte_kb', title: 'Byte -> KB', from: 'B', to: 'KB', factor: 1 / 1024 },
        { key: 'kb_mb', title: 'KB -> MB', from: 'KB', to: 'MB', factor: 1 / 1024 },
        { key: 'mb_gb', title: 'MB -> GB', from: 'MB', to: 'GB', factor: 1 / 1024 },
        { key: 'gb_tb', title: 'GB -> TB', from: 'GB', to: 'TB', factor: 1 / 1024 },
        { key: 'min_h', title: 'Minuten -> Stunden', from: 'min', to: 'h', factor: 1 / 60 }
    ];

    conversionSpecs.forEach((spec) => {
        const mode = `x100_${spec.key}`;
        defs[mode] = {
            title: spec.title,
            description: `Konvertiert ${spec.from} nach ${spec.to}.`,
            category: 'Konverter',
            inputLabel: `Wert in ${spec.from}`,
            placeholder: `z.B. 10 ${spec.from}`,
            actionText: 'Umrechnen',
            cardIcon: '🔁',
            cardBadge: 'Konverter',
            generatedBatch: 'x100',
            run: (value) => {
                const n = parseMiniNumber(value);
                if (n === null) return `Bitte einen gültigen Wert in ${spec.from} eingeben.`;
                return `${formatMiniNumber(n)} ${spec.from} = ${formatMiniNumber(n * spec.factor)} ${spec.to}`;
            }
        };

        const inverseMode = `x100_${spec.key}_rev`;
        defs[inverseMode] = {
            title: `${spec.to} -> ${spec.from}`,
            description: `Konvertiert ${spec.to} nach ${spec.from}.`,
            category: 'Konverter',
            inputLabel: `Wert in ${spec.to}`,
            placeholder: `z.B. 10 ${spec.to}`,
            actionText: 'Umrechnen',
            cardIcon: '🔁',
            cardBadge: 'Konverter',
            generatedBatch: 'x100',
            run: (value) => {
                const n = parseMiniNumber(value);
                if (n === null) return `Bitte einen gültigen Wert in ${spec.to} eingeben.`;
                return `${formatMiniNumber(n)} ${spec.to} = ${formatMiniNumber(n / spec.factor)} ${spec.from}`;
            }
        };
    });

    defs.x100_c_f = {
        title: 'Celsius -> Fahrenheit',
        description: 'Temperatur von Celsius in Fahrenheit umrechnen.',
        category: 'Konverter',
        inputLabel: 'Temperatur in °C',
        placeholder: 'z.B. 22',
        actionText: 'Umrechnen',
        cardIcon: '🌡️',
        cardBadge: 'Konverter',
        generatedBatch: 'x100',
        run: (value) => {
            const n = parseMiniNumber(value);
            if (n === null) return 'Bitte eine gültige Temperatur eingeben.';
            return `${formatMiniNumber(n)} °C = ${formatMiniNumber((n * 9) / 5 + 32)} °F`;
        }
    };

    defs.x100_f_c = {
        title: 'Fahrenheit -> Celsius',
        description: 'Temperatur von Fahrenheit in Celsius umrechnen.',
        category: 'Konverter',
        inputLabel: 'Temperatur in °F',
        placeholder: 'z.B. 72',
        actionText: 'Umrechnen',
        cardIcon: '🌡️',
        cardBadge: 'Konverter',
        generatedBatch: 'x100',
        run: (value) => {
            const n = parseMiniNumber(value);
            if (n === null) return 'Bitte eine gültige Temperatur eingeben.';
            return `${formatMiniNumber(n)} °F = ${formatMiniNumber(((n - 32) * 5) / 9)} °C`;
        }
    };

    const calcTools = [
        {
            key: 'x100_add',
            title: 'Addierer',
            description: 'Zwei Zahlen addieren.',
            icon: '➕',
            category: 'Rechner',
            run: (a, b) => `${formatMiniNumber(a)} + ${formatMiniNumber(b)} = ${formatMiniNumber(a + b)}`
        },
        {
            key: 'x100_subtract',
            title: 'Subtrahierer',
            description: 'Zwei Zahlen subtrahieren.',
            icon: '➖',
            category: 'Rechner',
            run: (a, b) => `${formatMiniNumber(a)} - ${formatMiniNumber(b)} = ${formatMiniNumber(a - b)}`
        },
        {
            key: 'x100_multiply',
            title: 'Multiplikator',
            description: 'Zwei Zahlen multiplizieren.',
            icon: '✖️',
            category: 'Rechner',
            run: (a, b) => `${formatMiniNumber(a)} × ${formatMiniNumber(b)} = ${formatMiniNumber(a * b)}`
        },
        {
            key: 'x100_divide',
            title: 'Dividierer',
            description: 'Zwei Zahlen dividieren.',
            icon: '➗',
            category: 'Rechner',
            run: (a, b) => (b === 0 ? 'Division durch 0 ist nicht erlaubt.' : `${formatMiniNumber(a)} / ${formatMiniNumber(b)} = ${formatMiniNumber(a / b)}`)
        },
        {
            key: 'x100_power',
            title: 'Potenz-Rechner',
            description: 'Basis hoch Exponent berechnen.',
            icon: '🧮',
            category: 'Rechner',
            run: (a, b) => `${formatMiniNumber(a)} ^ ${formatMiniNumber(b)} = ${formatMiniNumber(Math.pow(a, b))}`
        },
        {
            key: 'x100_percent_of',
            title: 'Prozent von Zahl',
            description: 'Berechnet x Prozent von y.',
            icon: '💯',
            category: 'Rechner',
            run: (a, b) => `${formatMiniNumber(a)}% von ${formatMiniNumber(b)} = ${formatMiniNumber((a / 100) * b)}`
        },
        {
            key: 'x100_percent_change',
            title: 'Prozentänderung',
            description: 'Relative Veränderung zwischen zwei Werten.',
            icon: '📈',
            category: 'Rechner',
            run: (a, b) => (a === 0 ? 'Startwert darf nicht 0 sein.' : `Änderung: ${formatMiniNumber(((b - a) / a) * 100)}%`)
        },
        {
            key: 'x100_avg2',
            title: 'Mittelwert aus 2',
            description: 'Durchschnitt aus zwei Werten.',
            icon: '📊',
            category: 'Rechner',
            run: (a, b) => `Mittelwert: ${formatMiniNumber((a + b) / 2)}`
        },
        {
            key: 'x100_min2',
            title: 'Kleinere Zahl',
            description: 'Ermittelt den kleineren von zwei Werten.',
            icon: '📉',
            category: 'Rechner',
            run: (a, b) => `Minimum: ${formatMiniNumber(Math.min(a, b))}`
        },
        {
            key: 'x100_max2',
            title: 'Größere Zahl',
            description: 'Ermittelt den größeren von zwei Werten.',
            icon: '🏁',
            category: 'Rechner',
            run: (a, b) => `Maximum: ${formatMiniNumber(Math.max(a, b))}`
        }
    ];

    calcTools.forEach((tool) => {
        defs[tool.key] = {
            title: tool.title,
            description: tool.description,
            category: tool.category,
            inputLabel: 'Wert A',
            placeholder: 'z.B. 12.5',
            input2Label: 'Wert B',
            placeholder2: 'z.B. 3.4',
            input2Visible: true,
            actionText: 'Berechnen',
            cardIcon: tool.icon,
            cardBadge: 'Rechner',
            generatedBatch: 'x100',
            run: (value, value2) => {
                const a = parseMiniNumber(value);
                const b = parseMiniNumber(value2);
                if (a === null || b === null) return 'Bitte zwei gültige Zahlen eingeben.';
                return tool.run(a, b);
            }
        };
    });

    const randomTools = [
        {
            key: 'x100_rand_int',
            title: 'Zufallszahl (Bereich)',
            description: 'Zieht eine Zufallszahl zwischen Min und Max.',
            icon: '🎯',
            run: (a, b) => {
                const min = Math.ceil(Math.min(a, b));
                const max = Math.floor(Math.max(a, b));
                return `Zahl: ${Math.floor(Math.random() * (max - min + 1)) + min}`;
            }
        },
        {
            key: 'x100_rand_even',
            title: 'Zufällige gerade Zahl',
            description: 'Liefert eine zufällige gerade Zahl im Bereich.',
            icon: '2️⃣',
            run: (a, b) => {
                const min = Math.ceil(Math.min(a, b));
                const max = Math.floor(Math.max(a, b));
                const first = min % 2 === 0 ? min : min + 1;
                if (first > max) return 'In diesem Bereich gibt es keine gerade Zahl.';
                const count = Math.floor((max - first) / 2) + 1;
                return `Gerade Zahl: ${first + Math.floor(Math.random() * count) * 2}`;
            }
        },
        {
            key: 'x100_rand_odd',
            title: 'Zufällige ungerade Zahl',
            description: 'Liefert eine zufällige ungerade Zahl im Bereich.',
            icon: '1️⃣',
            run: (a, b) => {
                const min = Math.ceil(Math.min(a, b));
                const max = Math.floor(Math.max(a, b));
                const first = min % 2 !== 0 ? min : min + 1;
                if (first > max) return 'In diesem Bereich gibt es keine ungerade Zahl.';
                const count = Math.floor((max - first) / 2) + 1;
                return `Ungerade Zahl: ${first + Math.floor(Math.random() * count) * 2}`;
            }
        },
        {
            key: 'x100_coin_flip',
            title: 'Münzwurf',
            description: 'Werfe eine digitale Münze.',
            icon: '🪙',
            single: true,
            run: () => (Math.random() < 0.5 ? 'Kopf' : 'Zahl')
        },
        {
            key: 'x100_dice6',
            title: 'W6 Würfel',
            description: 'Würfelt eine Zahl von 1 bis 6.',
            icon: '🎲',
            single: true,
            run: () => `Wurf: ${1 + Math.floor(Math.random() * 6)}`
        },
        {
            key: 'x100_dice20',
            title: 'W20 Würfel',
            description: 'Würfelt eine Zahl von 1 bis 20.',
            icon: '🎲',
            single: true,
            run: () => `Wurf: ${1 + Math.floor(Math.random() * 20)}`
        },
        {
            key: 'x100_pick_item',
            title: 'Zufallsauswahl',
            description: 'Wählt einen zufälligen Eintrag aus deiner Liste.',
            icon: '🎰',
            textList: true,
            run: (value) => {
                const items = String(value || '').split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
                if (!items.length) return 'Bitte mindestens zwei Einträge angeben.';
                return `Gewählt: ${items[Math.floor(Math.random() * items.length)]}`;
            }
        },
        {
            key: 'x100_random_color',
            title: 'Random HEX Farbe',
            description: 'Erzeugt eine zufällige Hex-Farbe.',
            icon: '🎨',
            single: true,
            run: () => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`
        },
        {
            key: 'x100_random_password',
            title: 'Quick Passwort',
            description: 'Erstellt ein zufälliges Passwort mit gewünschter Länge.',
            icon: '🔐',
            singleInput: true,
            run: (value) => {
                const len = miniToolHelpers.clamp(parseInt(String(value || ''), 10) || 16, 8, 64);
                const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*+-_?';
                let out = '';
                for (let i = 0; i < len; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
                return out;
            }
        },
        {
            key: 'x100_random_uuidlite',
            title: 'Kurz-ID Generator',
            description: 'Erstellt eine kurze zufällige ID.',
            icon: '🆔',
            single: true,
            run: () => Math.random().toString(36).slice(2, 10).toUpperCase()
        }
    ];

    randomTools.forEach((tool) => {
        if (tool.single) {
            defs[tool.key] = {
                title: tool.title,
                description: tool.description,
                category: 'Zufall',
                inputVisible: false,
                actionText: 'Starten',
                cardIcon: tool.icon,
                cardBadge: 'Zufall',
                generatedBatch: 'x100',
                run: () => tool.run()
            };
            return;
        }

        if (tool.textList) {
            defs[tool.key] = {
                title: tool.title,
                description: tool.description,
                category: 'Zufall',
                inputLabel: 'Einträge (mit Komma oder Zeilen)',
                placeholder: 'Pizza, Pasta, Sushi',
                actionText: 'Auswählen',
                cardIcon: tool.icon,
                cardBadge: 'Zufall',
                generatedBatch: 'x100',
                run: (value) => tool.run(value)
            };
            return;
        }

        if (tool.singleInput) {
            defs[tool.key] = {
                title: tool.title,
                description: tool.description,
                category: 'Zufall',
                inputLabel: 'Länge',
                placeholder: 'z.B. 16',
                actionText: 'Generieren',
                cardIcon: tool.icon,
                cardBadge: 'Zufall',
                generatedBatch: 'x100',
                run: (value) => tool.run(value)
            };
            return;
        }

        defs[tool.key] = {
            title: tool.title,
            description: tool.description,
            category: 'Zufall',
            inputLabel: 'Min',
            placeholder: 'z.B. 1',
            input2Label: 'Max',
            placeholder2: 'z.B. 100',
            input2Visible: true,
            actionText: 'Generieren',
            cardIcon: tool.icon,
            cardBadge: 'Zufall',
            generatedBatch: 'x100',
            run: (value, value2) => {
                const a = parseMiniNumber(value);
                const b = parseMiniNumber(value2);
                if (a === null || b === null) return 'Bitte Min und Max als Zahlen eingeben.';
                return tool.run(a, b);
            }
        };
    });

    const textTools = [
        { key: 'x100_text_upper', title: 'Text -> GROSS', description: 'Wandelt Text in Großbuchstaben.', icon: '🔠', run: (v) => String(v || '').toUpperCase() },
        { key: 'x100_text_lower', title: 'Text -> klein', description: 'Wandelt Text in Kleinbuchstaben.', icon: '🔡', run: (v) => String(v || '').toLowerCase() },
        { key: 'x100_text_title', title: 'Text -> Titel', description: 'Wandelt Text in Titelschreibweise.', icon: '🅰️', run: (v) => miniToolHelpers.toTitleCase(v || '') },
        { key: 'x100_text_reverse', title: 'Text umkehren', description: 'Dreht den Text rückwärts.', icon: '↩️', run: (v) => String(v || '').split('').reverse().join('') },
        { key: 'x100_text_novowels', title: 'Vokale entfernen', description: 'Entfernt alle Vokale aus dem Text.', icon: '🚫', run: (v) => String(v || '').replace(/[aeiouäöüAEIOUÄÖÜ]/g, '') },
        { key: 'x100_text_keep_letters', title: 'Nur Buchstaben', description: 'Filtert nur Buchstaben aus Text.', icon: '🔤', run: (v) => String(v || '').replace(/[^\p{L}\s]/gu, '') },
        { key: 'x100_text_keep_numbers', title: 'Nur Zahlen', description: 'Filtert nur Ziffern aus Text.', icon: '🔢', run: (v) => String(v || '').replace(/\D/g, '') },
        { key: 'x100_text_trim', title: 'Leerzeichen glätten', description: 'Reduziert Leerzeichen auf ein Zeichen.', icon: '🧹', run: (v) => String(v || '').replace(/\s+/g, ' ').trim() },
        { key: 'x100_text_sort_lines', title: 'Zeilen sortieren', description: 'Sortiert Zeilen alphabetisch.', icon: '📚', run: (v) => String(v || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de')).join('\n') },
        { key: 'x100_text_unique_lines', title: 'Duplikate (Zeilen) entfernen', description: 'Behält jede Zeile nur einmal.', icon: '🧾', run: (v) => [...new Set(String(v || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))].join('\n') },
        { key: 'x100_text_reverse_words', title: 'Wort-Reihenfolge umdrehen', description: 'Dreht die Wortreihenfolge um.', icon: '🔄', run: (v) => miniToolHelpers.words(v).reverse().join(' ') },
        { key: 'x100_text_char_count', title: 'Zeichen zählen', description: 'Zählt alle Zeichen inklusive Leerzeichen.', icon: '📏', run: (v) => `Zeichen: ${String(v || '').length}` },
        { key: 'x100_text_word_count', title: 'Wörter zählen', description: 'Zählt die Wörter im Text.', icon: '🧮', run: (v) => `Wörter: ${miniToolHelpers.words(v).length}` },
        { key: 'x100_text_remove_spaces', title: 'Alle Leerzeichen entfernen', description: 'Entfernt alle Whitespaces.', icon: '✂️', run: (v) => String(v || '').replace(/\s+/g, '') },
        { key: 'x100_text_url_encode', title: 'URL Encode', description: 'Kodiert Text für URL-Parameter.', icon: '🔗', run: (v) => encodeURIComponent(String(v || '')) },
        { key: 'x100_text_url_decode', title: 'URL Decode', description: 'Dekodiert URL-kodierten Text.', icon: '🧩', run: (v) => {
            try { return decodeURIComponent(String(v || '')); } catch { return 'Ungültige URL-Kodierung.'; }
        } },
        { key: 'x100_text_b64_encode', title: 'Base64 Encode', description: 'Kodiert Text in Base64.', icon: '📦', run: (v) => {
            try { return btoa(unescape(encodeURIComponent(String(v || '')))); } catch { return 'Konnte nicht kodieren.'; }
        } },
        { key: 'x100_text_b64_decode', title: 'Base64 Decode', description: 'Dekodiert Base64 zu Text.', icon: '📭', run: (v) => {
            try { return decodeURIComponent(escape(atob(String(v || '').trim()))); } catch { return 'Ungültiger Base64-Text.'; }
        } },
        { key: 'x100_text_rot13', title: 'ROT13', description: 'ROT13-Codierung für Text.', icon: '🔐', run: (v) => String(v || '').replace(/[a-zA-Z]/g, (c) => {
            const base = c <= 'Z' ? 65 : 97;
            return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
        }) },
        { key: 'x100_text_slug', title: 'Slugify', description: 'Erstellt URL-Slug aus Text.', icon: '🧷', run: (v) => miniToolHelpers.slugify(v || '') }
    ];

    textTools.forEach((tool) => {
        defs[tool.key] = {
            title: tool.title,
            description: tool.description,
            category: 'Text',
            inputLabel: 'Text',
            placeholder: 'Text hier eingeben...',
            actionText: 'Ausführen',
            cardIcon: tool.icon,
            cardBadge: 'Text',
            generatedBatch: 'x100',
            run: (value) => {
                const out = tool.run(value);
                return String(out || '').trim() || 'Kein Ergebnis.';
            }
        };
    });

    const dateTools = [
        {
            key: 'x100_date_days_until',
            title: 'Tage bis Datum',
            description: 'Berechnet Tage von heute bis Ziel-Datum.',
            icon: '📅',
            run: (v) => {
                const d = miniToolHelpers.parseDate(v);
                if (!d) return 'Bitte ein gültiges Datum eingeben (YYYY-MM-DD).';
                const today = new Date();
                const ms = d.setHours(0, 0, 0, 0) - new Date(today.getFullYear(), today.getMonth(), today.getDate()).valueOf();
                return `Differenz: ${Math.round(ms / 86400000)} Tage`;
            }
        },
        {
            key: 'x100_date_days_between',
            title: 'Tage zwischen 2 Daten',
            description: 'Berechnet Tage zwischen Start und Ende.',
            icon: '🗓️',
            twoInputs: true,
            run: (a, b) => {
                const start = miniToolHelpers.parseDate(a);
                const end = miniToolHelpers.parseDate(b);
                if (!start || !end) return 'Bitte zwei gültige Daten eingeben.';
                return `Differenz: ${Math.round((end - start) / 86400000)} Tage`;
            }
        },
        {
            key: 'x100_date_add_days',
            title: 'Datum + Tage',
            description: 'Addiert Tage zu einem Datum.',
            icon: '➕',
            twoInputs: true,
            run: (a, b) => {
                const date = miniToolHelpers.parseDate(a);
                const days = parseMiniNumber(b);
                if (!date || days === null) return 'Bitte Datum und Tage eingeben.';
                const out = new Date(date);
                out.setDate(out.getDate() + Math.trunc(days));
                return out.toLocaleDateString('de-DE');
            }
        },
        {
            key: 'x100_date_add_weeks',
            title: 'Datum + Wochen',
            description: 'Addiert Wochen zu einem Datum.',
            icon: '📆',
            twoInputs: true,
            run: (a, b) => {
                const date = miniToolHelpers.parseDate(a);
                const weeks = parseMiniNumber(b);
                if (!date || weeks === null) return 'Bitte Datum und Wochen eingeben.';
                const out = new Date(date);
                out.setDate(out.getDate() + Math.trunc(weeks) * 7);
                return out.toLocaleDateString('de-DE');
            }
        },
        {
            key: 'x100_date_add_months',
            title: 'Datum + Monate',
            description: 'Addiert Monate zu einem Datum.',
            icon: '🗃️',
            twoInputs: true,
            run: (a, b) => {
                const date = miniToolHelpers.parseDate(a);
                const months = parseMiniNumber(b);
                if (!date || months === null) return 'Bitte Datum und Monate eingeben.';
                const out = new Date(date);
                out.setMonth(out.getMonth() + Math.trunc(months));
                return out.toLocaleDateString('de-DE');
            }
        },
        {
            key: 'x100_date_weekday',
            title: 'Wochentag Finder',
            description: 'Zeigt den Wochentag für ein Datum.',
            icon: '📍',
            run: (v) => {
                const d = miniToolHelpers.parseDate(v);
                if (!d) return 'Bitte ein gültiges Datum eingeben.';
                return d.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            }
        },
        {
            key: 'x100_date_isoweek',
            title: 'ISO Kalenderwoche',
            description: 'Berechnet die ISO-Wochennummer.',
            icon: '🔢',
            run: (v) => {
                const d = miniToolHelpers.parseDate(v);
                if (!d) return 'Bitte ein gültiges Datum eingeben.';
                return `KW ${miniToolHelpers.weekNumber(d)}`;
            }
        },
        {
            key: 'x100_date_leapyear',
            title: 'Schaltjahr Check',
            description: 'Prüft, ob ein Jahr ein Schaltjahr ist.',
            icon: '🛰️',
            run: (v) => {
                const y = parseInt(String(v || '').trim(), 10);
                if (!Number.isInteger(y) || y < 1) return 'Bitte ein gültiges Jahr eingeben.';
                const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
                return leap ? `${y} ist ein Schaltjahr.` : `${y} ist kein Schaltjahr.`;
            }
        },
        {
            key: 'x100_date_timestamp_now',
            title: 'Jetzt als Timestamp',
            description: 'Zeigt aktuellen Unix-Timestamp in Sekunden und Millisekunden.',
            icon: '⏱️',
            noInput: true,
            run: () => {
                const now = Date.now();
                return `Millisekunden: ${now}\nSekunden: ${Math.floor(now / 1000)}`;
            }
        },
        {
            key: 'x100_date_unix_to_date',
            title: 'Unix -> Datum',
            description: 'Wandelt Unix-Sekunden in Datum/Uhrzeit um.',
            icon: '🕰️',
            run: (v) => {
                const ts = parseMiniNumber(v);
                if (ts === null) return 'Bitte Unix-Sekunden eingeben.';
                const d = new Date(ts * 1000);
                if (Number.isNaN(d.valueOf())) return 'Ungültiger Timestamp.';
                return d.toLocaleString('de-DE');
            }
        }
    ];

    dateTools.forEach((tool) => {
        if (tool.noInput) {
            defs[tool.key] = {
                title: tool.title,
                description: tool.description,
                category: 'Datum/Zeit',
                inputVisible: false,
                actionText: 'Anzeigen',
                cardIcon: tool.icon,
                cardBadge: 'Datum/Zeit',
                generatedBatch: 'x100',
                run: () => tool.run()
            };
            return;
        }

        if (tool.twoInputs) {
            defs[tool.key] = {
                title: tool.title,
                description: tool.description,
                category: 'Datum/Zeit',
                inputLabel: 'Startdatum',
                placeholder: 'YYYY-MM-DD',
                input2Label: 'Wert / Enddatum',
                placeholder2: 'z.B. 7 oder 2026-12-31',
                input2Visible: true,
                actionText: 'Berechnen',
                cardIcon: tool.icon,
                cardBadge: 'Datum/Zeit',
                generatedBatch: 'x100',
                run: (a, b) => tool.run(a, b)
            };
            return;
        }

        defs[tool.key] = {
            title: tool.title,
            description: tool.description,
            category: 'Datum/Zeit',
            inputLabel: tool.key === 'x100_date_leapyear' ? 'Jahr' : 'Datum / Timestamp',
            placeholder: tool.key === 'x100_date_leapyear' ? 'z.B. 2028' : (tool.key === 'x100_date_unix_to_date' ? 'z.B. 1735689600' : 'YYYY-MM-DD'),
            actionText: 'Berechnen',
            cardIcon: tool.icon,
            cardBadge: 'Datum/Zeit',
            generatedBatch: 'x100',
            run: (value) => tool.run(value)
        };
    });

    return defs;
}

function createPremiumMiniToolDefinitions() {
    const defs = {};
    const safe = (value) => String(value || '').replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] || ch));
    const words = (value) => String(value || '').trim().split(/\s+/).filter(Boolean);

    defs.prolab_cyber_terminal = {
        title: 'Cyber Terminal Simulator',
        description: 'Simuliert Befehle wie nmap, whois, ping und traceroute in einer sicheren Lernumgebung.',
        category: 'Cyber Lab',
        inputLabel: 'Befehl',
        placeholder: 'z.B. nmap school.local oder ping api.example.com',
        actionText: 'Simulieren',
        cardIcon: '💻',
        cardBadge: 'Cyber Lab',
        generatedBatch: 'prolab',
        run: (value) => {
            const command = String(value || '').trim();
            if (!command) return 'Beispiel: nmap school.local';
            const cmd = command.toLowerCase();
            if (cmd.startsWith('nmap')) {
                return { html: `<pre style="margin:0;white-space:pre-wrap;">Nmap Scan Report (Simulation)
Target: ${safe(command.split(/\s+/).slice(1).join(' ') || 'unknown.local')}
22/tcp   open   ssh
80/tcp   open   http
443/tcp  open   https
3306/tcp filtered mysql
Hinweis: Nur Trainingsdaten, kein echter Netzwerkscan.</pre>` };
            }
            if (cmd.startsWith('whois')) {
                return { html: `<pre style="margin:0;white-space:pre-wrap;">WHOIS (Simulation)
Domain: ${safe(command.split(/\s+/).slice(1).join(' ') || 'example.com')}
Registrar: Demo Registrar GmbH
Created: 2022-04-17
Nameserver: ns1.demo.net, ns2.demo.net
Status: clientTransferProhibited</pre>` };
            }
            if (cmd.startsWith('ping')) {
                return { html: `<pre style="margin:0;white-space:pre-wrap;">PING (Simulation)
reply #1 time=21ms
reply #2 time=19ms
reply #3 time=23ms
reply #4 time=20ms
packet loss: 0%</pre>` };
            }
            if (cmd.startsWith('traceroute') || cmd.startsWith('tracert')) {
                return { html: `<pre style="margin:0;white-space:pre-wrap;">Traceroute (Simulation)
1  192.168.0.1   1ms
2  10.0.0.1      7ms
3  80.157.x.x   14ms
4  edge-${Math.floor(Math.random() * 8) + 1}.ix  19ms
5  target         23ms</pre>` };
            }
            return 'Unterstützte Demo-Befehle: nmap, whois, ping, traceroute.';
        }
    };

    defs.prolab_log_forensics = {
        title: 'Log Forensics Analyzer',
        description: 'Analysiert Server-Logs auf verdächtige Muster wie Brute-Force, SQLi und 5xx-Spitzen.',
        category: 'Cyber Lab',
        inputLabel: 'Log-Text',
        placeholder: 'Logzeilen hier einfügen...',
        actionText: 'Analysieren',
        cardIcon: '🕵️',
        cardBadge: 'Forensics',
        generatedBatch: 'prolab',
        run: (value) => {
            const lines = String(value || '').split(/\r?\n/).filter(Boolean);
            if (!lines.length) return 'Füge Logzeilen ein, um verdächtige Muster zu erkennen.';
            let errors5xx = 0;
            let loginFails = 0;
            let sqlInjectionHints = 0;
            let xssHints = 0;
            lines.forEach((line) => {
                if (/\s5\d\d\s/.test(line)) errors5xx += 1;
                if (/login failed|unauthorized|invalid password|401/i.test(line)) loginFails += 1;
                if (/(union\s+select|or\s+1=1|sleep\(|information_schema)/i.test(line)) sqlInjectionHints += 1;
                if (/(<script>|onerror=|javascript:)/i.test(line)) xssHints += 1;
            });
            const risk = (errors5xx * 1.2) + (loginFails * 1.5) + (sqlInjectionHints * 3) + (xssHints * 2.5);
            const level = risk >= 12 ? 'Hoch' : risk >= 6 ? 'Mittel' : 'Niedrig';
            return { html: `<div style="display:grid;gap:8px;">
<div><strong>Risiko-Level:</strong> ${level}</div>
<div>5xx-Fehler: ${errors5xx}</div>
<div>Login-Fehler: ${loginFails}</div>
<div>SQLi-Indikatoren: ${sqlInjectionHints}</div>
<div>XSS-Indikatoren: ${xssHints}</div>
<small style="opacity:.8;">Hinweis: Heuristik für Training, keine produktive SIEM-Engine.</small>
</div>` };
        }
    };

    defs.prolab_password_audit = {
        title: 'Password Audit Pro',
        description: 'Bewertet Passwortstärke mit Entropie-Schätzung und Crack-Time-Modell.',
        category: 'Cyber Lab',
        inputLabel: 'Passwort',
        placeholder: 'Passwort hier eingeben...',
        actionText: 'Prüfen',
        cardIcon: '🛡️',
        cardBadge: 'Security',
        generatedBatch: 'prolab',
        run: (value) => {
            const pw = String(value || '');
            if (!pw) return 'Bitte ein Passwort eingeben.';
            const hasLower = /[a-z]/.test(pw);
            const hasUpper = /[A-Z]/.test(pw);
            const hasNumber = /\d/.test(pw);
            const hasSpecial = /[^A-Za-z0-9]/.test(pw);
            let charset = 0;
            if (hasLower) charset += 26;
            if (hasUpper) charset += 26;
            if (hasNumber) charset += 10;
            if (hasSpecial) charset += 33;
            charset = Math.max(charset, 1);
            const entropy = pw.length * Math.log2(charset);
            const guesses = Math.pow(2, entropy);
            const gps = 5e9;
            const seconds = guesses / gps;
            const toHuman = (s) => {
                if (s < 60) return `${Math.round(s)} Sek`;
                if (s < 3600) return `${Math.round(s / 60)} Min`;
                if (s < 86400) return `${Math.round(s / 3600)} Std`;
                if (s < 31536000) return `${Math.round(s / 86400)} Tage`;
                return `${Math.round(s / 31536000)} Jahre`;
            };
            const score = entropy >= 80 ? 'Sehr stark' : entropy >= 60 ? 'Stark' : entropy >= 45 ? 'Mittel' : 'Schwach';
            return `Entropie: ${entropy.toFixed(1)} bit\nBewertung: ${score}\nBrute-Force Modell: ${toHuman(seconds)}`;
        }
    };

    defs.prolab_zero_trust_check = {
        title: 'Zero Trust Check',
        description: 'Prüft Architektur-Text auf Zero-Trust-Prinzipien.',
        category: 'Cyber Lab',
        inputLabel: 'Architektur-Beschreibung',
        placeholder: 'Beschreibe kurz dein System...',
        actionText: 'Check ausführen',
        cardIcon: '🧱',
        cardBadge: 'Architektur',
        generatedBatch: 'prolab',
        run: (value) => {
            const txt = String(value || '').toLowerCase();
            if (!txt.trim()) return 'Bitte eine kurze Systembeschreibung eingeben.';
            const checks = [
                ['mfa', /mfa|2fa|multi.?factor/],
                ['least_privilege', /least privilege|minimalrechte|rollenmodell|rbac/],
                ['device_posture', /device posture|geräteprüfung|compliance check/],
                ['microsegmentation', /microsegmentation|segmentierung|netzsegment/],
                ['continuous_verification', /continuous|laufend|verifizieren|telemetrie/],
                ['encrypted_transport', /tls|https|verschlüsselt|encryption/]
            ];
            const found = checks.filter(([, pattern]) => pattern.test(txt)).map(([name]) => name);
            return `Erkannte Prinzipien: ${found.length}/6\n${found.join(', ') || 'Keine'}\nEmpfehlung: Fehlende Prinzipien ergänzen und Zugriff kontextabhängig prüfen.`;
        }
    };

    defs.prolab_study_formula_coach = {
        title: 'Formel-Coach Schule',
        description: 'Erzeugt verständliche Formel-Erklärungen inklusive Variablen-Legende.',
        category: 'Schule Pro',
        inputLabel: 'Thema/Formel',
        placeholder: 'z.B. pythagoras, v=s/t, flaeche kreis',
        actionText: 'Erklären',
        cardIcon: '📐',
        cardBadge: 'Schule Pro',
        generatedBatch: 'prolab',
        run: (value) => {
            const q = String(value || '').toLowerCase();
            if (!q) return 'Gib ein Thema ein, z.B. pythagoras.';
            if (q.includes('pyth')) return 'Pythagoras: a² + b² = c²\na,b = Katheten, c = Hypotenuse\nNutzen: rechtwinklige Dreiecke.';
            if (q.includes('v=') || q.includes('geschwindigkeit')) return 'Geschwindigkeit: v = s / t\nv = Geschwindigkeit, s = Strecke, t = Zeit\nUmstellen: s = v·t, t = s/v.';
            if (q.includes('kreis')) return 'Kreis: A = πr² und U = 2πr\nA = Fläche, U = Umfang, r = Radius.';
            return 'Lernhilfe: Definiere Variablen, notiere Einheit, stelle Formel um, setze Zahlen ein, Einheit prüfen.';
        }
    };

    defs.prolab_exam_trainer = {
        title: 'Prüfungs-Trainer',
        description: 'Erstellt einen Lernplan statt Cheats: Fokusblöcke, Wiederholung und Recall.',
        category: 'Schule Pro',
        inputLabel: 'Prüfung in Tagen',
        placeholder: 'z.B. 14',
        input2Label: 'Themen (Komma-getrennt)',
        placeholder2: 'z.B. Algebra, Geometrie, Physik',
        input2Visible: true,
        actionText: 'Plan bauen',
        cardIcon: '🎓',
        cardBadge: 'Lernplan',
        generatedBatch: 'prolab',
        run: (value, value2) => {
            const days = miniToolHelpers.clamp(parseInt(String(value || ''), 10) || 7, 1, 120);
            const topics = String(value2 || '').split(',').map((t) => t.trim()).filter(Boolean);
            if (!topics.length) return 'Bitte mindestens ein Thema eingeben.';
            const rows = [];
            for (let d = 1; d <= Math.min(days, 12); d += 1) {
                const topic = topics[(d - 1) % topics.length];
                rows.push(`Tag ${d}: ${topic} (45m Fokus + 15m aktive Wiederholung)`);
            }
            return `Lernplan (${days} Tage, Vorschau):\n${rows.join('\n')}\n\nTipp: Alle 3 Tage Mini-Test ohne Unterlagen.`;
        }
    };

    defs.prolab_flashcard_generator = {
        title: 'Flashcard Generator',
        description: 'Wandelt Stichwörter in Lernkarten-Format Frage/Antwort um.',
        category: 'Schule Pro',
        inputLabel: 'Stichwörter',
        placeholder: 'z.B. Mitose, DNA, Osmose',
        actionText: 'Karten erzeugen',
        cardIcon: '🗂️',
        cardBadge: 'Lernen',
        generatedBatch: 'prolab',
        run: (value) => {
            const items = String(value || '').split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
            if (!items.length) return 'Bitte Stichwörter eingeben.';
            const out = items.slice(0, 20).map((item, i) => `${i + 1}. Frage: Was ist ${item}?\n   Antwort: Definiere ${item} in 2 Sätzen + 1 Beispiel.`);
            return out.join('\n');
        }
    };

    defs.prolab_essay_structure = {
        title: 'Essay Struktur Pro',
        description: 'Baut aus einem Thema eine klare Struktur mit Einleitung, Argumenten und Fazit.',
        category: 'Schule Pro',
        inputLabel: 'Thema',
        placeholder: 'z.B. Sollte KI Hausaufgaben korrigieren?',
        actionText: 'Struktur erstellen',
        cardIcon: '🧠',
        cardBadge: 'Writing',
        generatedBatch: 'prolab',
        run: (value) => {
            const topic = String(value || '').trim();
            if (!topic) return 'Bitte ein Thema eingeben.';
            return { html: `<div style="display:grid;gap:8px;">
<div><strong>Einleitung:</strong> Kontext + These zu "${safe(topic)}"</div>
<div><strong>Hauptteil 1:</strong> Pro-Argument mit Beispiel</div>
<div><strong>Hauptteil 2:</strong> Gegenargument + Entkräftung</div>
<div><strong>Hauptteil 3:</strong> Auswirkungen auf Schule/Gesellschaft</div>
<div><strong>Fazit:</strong> Bewertung + Ausblick</div>
</div>` };
        }
    };

    defs.prolab_grade_target = {
        title: 'Notenziel Rechner',
        description: 'Berechnet welche Note du brauchst, um dein Ziel im Schnitt zu erreichen.',
        category: 'Schule Pro',
        inputLabel: 'Aktueller Schnitt',
        placeholder: 'z.B. 2.7',
        input2Label: 'Zielschnitt',
        placeholder2: 'z.B. 2.3',
        input2Visible: true,
        actionText: 'Berechnen',
        cardIcon: '📘',
        cardBadge: 'Schule Pro',
        generatedBatch: 'prolab',
        run: (value, value2) => {
            const now = parseMiniNumber(value);
            const goal = parseMiniNumber(value2);
            if (now === null || goal === null) return 'Bitte zwei gültige Notenwerte eingeben.';
            const needed = goal * 2 - now;
            return `Wenn die nächste Leistung gleich gewichtet ist, brauchst du etwa: ${formatMiniNumber(needed, 2)}.`;
        }
    };

    defs.prolab_palette_lab = {
        title: 'Design Palette Lab',
        description: 'Erzeugt 5er-Paletten mit klarer Rolle: Primary, Secondary, Accent, Surface, Text.',
        category: 'Design Pro',
        inputLabel: 'Basisfarbe (#HEX)',
        placeholder: 'z.B. #0e8a9b',
        actionText: 'Palette generieren',
        cardIcon: '🎨',
        cardBadge: 'Design Pro',
        generatedBatch: 'prolab',
        run: (value) => {
            const rgb = miniToolHelpers.parseHexColor(value || '#0e8a9b');
            if (!rgb) return 'Bitte eine gültige HEX-Farbe eingeben.';
            const shift = (f) => rgb.map((n) => miniToolHelpers.clamp(Math.round(n * f), 0, 255));
            const p = miniToolHelpers.rgbToHex(...rgb);
            const s = miniToolHelpers.rgbToHex(...shift(0.75));
            const a = miniToolHelpers.rgbToHex(...shift(1.25));
            const surf = '#0F172A';
            const text = '#E2E8F0';
            return { html: `<div style="display:grid;gap:8px;">
<div>Primary: <strong>${p}</strong></div>
<div>Secondary: <strong>${s}</strong></div>
<div>Accent: <strong>${a}</strong></div>
<div>Surface: <strong>${surf}</strong></div>
<div>Text: <strong>${text}</strong></div>
</div>` };
        }
    };

    defs.prolab_typography_pairing = {
        title: 'Typography Pairing Pro',
        description: 'Schlägt starke Font-Kombinationen für Headline + Body vor.',
        category: 'Design Pro',
        inputLabel: 'Mood',
        placeholder: 'z.B. modern, editorial, tech, playful',
        actionText: 'Pairing finden',
        cardIcon: '🅰️',
        cardBadge: 'Typography',
        generatedBatch: 'prolab',
        run: (value) => {
            const mood = String(value || '').toLowerCase();
            if (mood.includes('editorial')) return 'Headline: Fraunces\nBody: Source Sans 3\nCharakter: elegant + gut lesbar';
            if (mood.includes('tech')) return 'Headline: Space Grotesk\nBody: IBM Plex Sans\nCharakter: futuristisch + präzise';
            if (mood.includes('play')) return 'Headline: Baloo 2\nBody: Nunito\nCharakter: freundlich + locker';
            return 'Headline: Sora\nBody: Inter Tight\nCharakter: modern + klar';
        }
    };

    defs.prolab_ui_copy_polish = {
        title: 'UI Copy Polish',
        description: 'Verbessert kurze Button-/Hint-Texte auf klar, präzise, handlungsorientiert.',
        category: 'Design Pro',
        inputLabel: 'UI-Text',
        placeholder: 'z.B. klicken sie hier um fortzufahren',
        actionText: 'Verbessern',
        cardIcon: '✍️',
        cardBadge: 'UX Writing',
        generatedBatch: 'prolab',
        run: (value) => {
            const text = String(value || '').trim();
            if (!text) return 'Bitte einen UI-Text eingeben.';
            const cleaned = text.replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase());
            return `Klar: ${cleaned}\nCTA-Variante: Jetzt fortfahren\nKurz-Variante: Weiter`;
        }
    };

    defs.prolab_grid_system_builder = {
        title: 'Grid System Builder',
        description: 'Berechnet responsive Spaltenbreiten für Desktop/Tablet/Mobile.',
        category: 'Design Pro',
        inputLabel: 'Desktop-Breite (px)',
        placeholder: 'z.B. 1200',
        input2Label: 'Spalten',
        placeholder2: 'z.B. 12',
        input2Visible: true,
        actionText: 'Grid berechnen',
        cardIcon: '📐',
        cardBadge: 'Layout',
        generatedBatch: 'prolab',
        run: (value, value2) => {
            const width = parseMiniNumber(value);
            const cols = parseInt(String(value2 || ''), 10);
            if (width === null || !cols || cols < 2 || cols > 24) return 'Bitte Breite und Spaltenzahl (2-24) angeben.';
            const gutter = 24;
            const totalGutter = gutter * (cols - 1);
            const col = (width - totalGutter) / cols;
            return `Desktop: ${cols} Spalten, ${col.toFixed(2)}px pro Spalte, Gutter ${gutter}px\nTablet: 8 Spalten\nMobile: 4 Spalten`;
        }
    };

    defs.prolab_css_component_generator = {
        title: 'CSS Component Generator',
        description: 'Erstellt moderne CSS-Snippets für Card, Button und Panel.',
        category: 'Design Pro',
        inputLabel: 'Typ',
        placeholder: 'card, button oder panel',
        actionText: 'Snippet erzeugen',
        cardIcon: '🧩',
        cardBadge: 'CSS',
        generatedBatch: 'prolab',
        run: (value) => {
            const type = String(value || '').toLowerCase().trim();
            if (type === 'button') {
                return `.btn-pro {\n  padding: 12px 18px;\n  border-radius: 12px;\n  border: 1px solid rgba(255,255,255,0.2);\n  background: linear-gradient(135deg, #0e8a9b, #1d4ed8);\n  color: #fff;\n  font-weight: 700;\n}`;
            }
            if (type === 'panel') {
                return `.panel-pro {\n  border-radius: 18px;\n  background: rgba(15,23,42,0.75);\n  backdrop-filter: blur(12px);\n  border: 1px solid rgba(148,163,184,0.25);\n  box-shadow: 0 24px 48px rgba(2,6,23,0.35);\n}`;
            }
            return `.card-pro {\n  border-radius: 16px;\n  padding: 18px;\n  background: linear-gradient(160deg, #0f172a, #111827);\n  border: 1px solid rgba(56,189,248,0.3);\n}`;
        }
    };

    defs.prolab_json_schema_maker = {
        title: 'JSON Schema Maker',
        description: 'Leitet aus einem JSON-Beispiel ein Schema-Grundgerüst ab.',
        category: 'Tech Pro',
        inputLabel: 'JSON Beispiel',
        placeholder: '{"name":"Max","age":16}',
        actionText: 'Schema bauen',
        cardIcon: '🧬',
        cardBadge: 'Tech Pro',
        generatedBatch: 'prolab',
        run: (value) => {
            try {
                const obj = JSON.parse(String(value || '{}'));
                if (obj === null || Array.isArray(obj) || typeof obj !== 'object') return 'Bitte ein JSON-Objekt eingeben.';
                const props = Object.entries(obj).map(([k, v]) => {
                    const t = Array.isArray(v) ? 'array' : typeof v;
                    return `    "${k}": { "type": "${t}" }`;
                });
                return `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
${props.join(',\n')}
  },
  "required": [${Object.keys(obj).map((k) => `"${k}"`).join(', ')}]
}`;
            } catch {
                return 'Ungültiges JSON. Bitte zuerst validen JSON-Text eingeben.';
            }
        }
    };

    defs.prolab_api_blueprint = {
        title: 'API Endpoint Blueprint',
        description: 'Generiert Endpoint-Struktur mit Methode, Auth und Beispielantwort.',
        category: 'Tech Pro',
        inputLabel: 'Ressource',
        placeholder: 'z.B. users, orders, tasks',
        actionText: 'Blueprint erzeugen',
        cardIcon: '🛰️',
        cardBadge: 'Backend',
        generatedBatch: 'prolab',
        run: (value) => {
            const res = miniToolHelpers.slugify(value || 'resource') || 'resource';
            return `GET /api/${res}\nPOST /api/${res}\nGET /api/${res}/{id}\nPATCH /api/${res}/{id}\nDELETE /api/${res}/{id}\n\nAuth: Bearer JWT\nResponse: { \"ok\": true, \"data\": [...] }`;
        }
    };

    defs.prolab_sql_query_designer = {
        title: 'SQL Query Designer',
        description: 'Erstellt sichere SQL-Templates mit Parametern (Prepared Statements).',
        category: 'Tech Pro',
        inputLabel: 'Tabelle',
        placeholder: 'z.B. users',
        input2Label: 'Filter-Feld',
        placeholder2: 'z.B. email',
        input2Visible: true,
        actionText: 'SQL erzeugen',
        cardIcon: '🗄️',
        cardBadge: 'SQL',
        generatedBatch: 'prolab',
        run: (value, value2) => {
            const table = miniToolHelpers.slugify(value || '').replace(/-/g, '_');
            const field = miniToolHelpers.slugify(value2 || '').replace(/-/g, '_');
            if (!table || !field) return 'Bitte Tabelle und Feld angeben.';
            return `-- Sicheres Template\nSELECT * FROM ${table} WHERE ${field} = ?;\nUPDATE ${table} SET updated_at = NOW() WHERE ${field} = ?;\n-- Immer Parameter binden, nie String-Konkatenation.`;
        }
    };

    defs.prolab_latency_simulator = {
        title: 'Latency Simulator',
        description: 'Schätzt User-Impact bei unterschiedlicher API-Latenz.',
        category: 'Tech Pro',
        inputLabel: 'Requests pro View',
        placeholder: 'z.B. 12',
        input2Label: 'Ø Latenz pro Request (ms)',
        placeholder2: 'z.B. 180',
        input2Visible: true,
        actionText: 'Impact berechnen',
        cardIcon: '📡',
        cardBadge: 'Performance',
        generatedBatch: 'prolab',
        run: (value, value2) => {
            const req = parseMiniNumber(value);
            const lat = parseMiniNumber(value2);
            if (req === null || lat === null) return 'Bitte Requests und Latenz angeben.';
            const serial = req * lat;
            const parallelApprox = Math.ceil(req / 4) * lat;
            return `Seriell: ~${Math.round(serial)}ms\nParallel (4er): ~${Math.round(parallelApprox)}ms\nEmpfehlung: Bündeln, Caching, kritische Pfade priorisieren.`;
        }
    };

    defs.prolab_compression_estimator = {
        title: 'Compression Estimator',
        description: 'Schätzt Dateigröße nach gzip/brotli für typische Web-Assets.',
        category: 'Tech Pro',
        inputLabel: 'Dateigröße (KB)',
        placeholder: 'z.B. 420',
        actionText: 'Schätzen',
        cardIcon: '🗜️',
        cardBadge: 'Web Perf',
        generatedBatch: 'prolab',
        run: (value) => {
            const kb = parseMiniNumber(value);
            if (kb === null || kb <= 0) return 'Bitte eine positive Dateigröße in KB eingeben.';
            const gzip = kb * 0.33;
            const brotli = kb * 0.26;
            return `Original: ${kb.toFixed(1)} KB\ngzip: ~${gzip.toFixed(1)} KB\nbrotli: ~${brotli.toFixed(1)} KB`;
        }
    };

    defs.prolab_regex_architect = {
        title: 'Regex Architect',
        description: 'Schlägt robuste Regex-Muster für typische Validierungen vor.',
        category: 'Tech Pro',
        inputLabel: 'Use Case',
        placeholder: 'z.B. email, ipv4, url, date',
        actionText: 'Pattern zeigen',
        cardIcon: '🔬',
        cardBadge: 'Regex',
        generatedBatch: 'prolab',
        run: (value) => {
            const q = String(value || '').toLowerCase();
            if (q.includes('email')) return '/^[^\s@]+@[^\s@]+\.[^\s@]+$/';
            if (q.includes('ipv4')) return '/^(25[0-5]|2[0-4]\\d|[01]?\\d\\d?)(\\.(25[0-5]|2[0-4]\\d|[01]?\\d\\d?)){3}$/';
            if (q.includes('url')) return '/^https?:\/\/[^\s$.?#].[^\s]*$/i';
            if (q.includes('date')) return '/^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$/';
            return 'Use Cases: email, ipv4, url, date';
        }
    };

    defs.prolab_ascii_circuit = {
        title: 'ASCII Circuit Designer',
        description: 'Erzeugt technische ASCII-Skizzen für Stromfluss und Module.',
        category: 'Tech Pro',
        inputLabel: 'Setup',
        placeholder: 'z.B. sensor-controller-led',
        actionText: 'Skizze bauen',
        cardIcon: '🔌',
        cardBadge: 'Engineering',
        generatedBatch: 'prolab',
        run: (value) => {
            const parts = String(value || 'sensor-controller-led').split(/[-,>]/).map((s) => s.trim()).filter(Boolean);
            if (parts.length < 2) return 'Bitte mindestens zwei Module angeben, z.B. sensor-controller-led';
            const line = parts.map((p) => `[${p.toUpperCase()}]`).join(' -> ');
            return `${line}\nPower: +5V -----> ${parts[0].toUpperCase()} ... GND`; 
        }
    };

    defs.prolab_hacker_story_mode = {
        title: 'Hacker Simulator Story',
        description: 'Erzeugt missionsartige Cyber-Trainingsszenarien ohne echte Angriffsanleitung.',
        category: 'Cyber Lab',
        inputLabel: 'Mission-Typ',
        placeholder: 'z.B. phishing-detect, incident-response, blue-team',
        actionText: 'Mission starten',
        cardIcon: '🧠',
        cardBadge: 'Simulator',
        generatedBatch: 'prolab',
        run: (value) => {
            const mission = String(value || 'blue-team').toLowerCase();
            const scenarios = {
                'phishing-detect': 'Mission: Erkenne 5 Anzeichen einer Phishing-Mail und markiere Risiko-Level pro Mail.',
                'incident-response': 'Mission: Priorisiere Alerts, isoliere betroffene Systeme, dokumentiere Timeline + Lessons Learned.',
                'blue-team': 'Mission: Hardening-Check für 3 Server, MFA-Quote erhöhen, Logs auf Anomalien prüfen.'
            };
            return `${scenarios[mission] || scenarios['blue-team']}\n\nZiel: defensive Security-Kompetenz aufbauen.`;
        }
    };

    defs.prolab_design_brief_generator = {
        title: 'Design Brief Generator',
        description: 'Generiert ein professionelles Design-Briefing für App/Website-Projekte.',
        category: 'Design Pro',
        inputLabel: 'Projektname',
        placeholder: 'z.B. Nova Learning App',
        actionText: 'Brief erstellen',
        cardIcon: '📋',
        cardBadge: 'Creative',
        generatedBatch: 'prolab',
        run: (value) => {
            const name = String(value || 'Projekt').trim();
            return `Projekt: ${name}\nZielgruppe: 16-35\nTonality: klar, mutig, hochwertig\nVisuelle Richtung: starke Typografie + dynamische Flächen\nDeliverables: Moodboard, UI-Kit, Click-Prototype, QA.`;
        }
    };

    defs.prolab_prompt_engineer = {
        title: 'Prompt Engineer Assistant',
        description: 'Baut präzise Prompt-Strukturen für Coding, Design und Analyse.',
        category: 'Tech Pro',
        inputLabel: 'Task',
        placeholder: 'z.B. landing page redesign',
        actionText: 'Prompt bauen',
        cardIcon: '🧩',
        cardBadge: 'AI Tech',
        generatedBatch: 'prolab',
        run: (value) => {
            const task = String(value || '').trim();
            if (!task) return 'Bitte einen Task eingeben.';
            return `Rolle: Senior Specialist\nAufgabe: ${task}\nConstraints: klare Kriterien, keine Annahmen\nOutput-Format: nummerierte Schritte + Checkliste + Edge Cases.`;
        }
    };

    defs.prolab_brainstorm_engine = {
        title: 'Innovation Brainstorm Engine',
        description: 'Erzeugt 12 technisch ambitionierte Feature-Ideen rund um dein Thema.',
        category: 'Tech Pro',
        inputLabel: 'Thema',
        placeholder: 'z.B. education app, cyber dashboard',
        actionText: 'Ideen generieren',
        cardIcon: '🚀',
        cardBadge: 'Innovation',
        generatedBatch: 'prolab',
        run: (value) => {
            const topic = String(value || 'digitales produkt').trim();
            const items = [
                'Realtime-Event-Feed mit Prioritätsstufen',
                'Adaptive UI je nach Nutzungsmuster',
                'Auto-Tagging via Semantik',
                'Offline-first Sync mit Konfliktauflösung',
                'Security Scorecard mit Trendlinien',
                'Voice Shortcuts für Power-User',
                'Role-based Quick Actions',
                'Scenario-Simulator für Risikoentscheidungen',
                'Learning Replay aus User Sessions',
                'Contextual AI Copilot pro Ansicht',
                'Heatmap-basierte UX-Optimierung',
                'Plugin-SDK für Drittanbieter'
            ];
            return `Innovation-Ideen für ${topic}:\n- ${items.join('\n- ')}`;
        }
    };

    const extraCyber = [
        { key: 'prolab_threat_model_canvas', title: 'Threat Model Canvas', desc: 'Bedrohungsmodell für App/Service in STRIDE-ähnlichen Blöcken.', icon: '🧭' },
        { key: 'prolab_soc_alert_triage', title: 'SOC Alert Triage', desc: 'Priorisiert Alarme nach Impact, Confidence und Exploitability.', icon: '🚨' },
        { key: 'prolab_incident_timeline', title: 'Incident Timeline Builder', desc: 'Strukturiert Security-Vorfälle in saubere Zeitachsen.', icon: '🕒' },
        { key: 'prolab_phishing_mail_checker', title: 'Phishing Mail Checker', desc: 'Checkt Mailtext auf typische Social-Engineering-Merkmale.', icon: '📩' },
        { key: 'prolab_network_segmentation_guide', title: 'Network Segmentation Guide', desc: 'Erzeugt Segmentierungs-Vorschläge für sichere Netzwerke.', icon: '🧱' },
        { key: 'prolab_blue_team_checklist', title: 'Blue Team Checklist', desc: 'Defensive Security-Checkliste für tägliche Operation.', icon: '🛡️' }
    ];

    extraCyber.forEach((tool) => {
        defs[tool.key] = {
            title: tool.title,
            description: tool.desc,
            category: 'Cyber Lab',
            inputLabel: 'Kontext',
            placeholder: 'z.B. webshop api / school portal / mobile app',
            actionText: 'Analysieren',
            cardIcon: tool.icon,
            cardBadge: 'Cyber Lab',
            generatedBatch: 'prolab',
            run: (value) => {
                const ctx = String(value || 'System').trim();
                return `${tool.title} für: ${ctx}\n1) Assets definieren\n2) Angriffsfläche kartieren\n3) Risiko priorisieren\n4) Gegenmaßnahmen planen\n5) Review-Termin festlegen`;
            }
        };
    });

    const extraSchool = [
        { key: 'prolab_oral_exam_trainer', title: 'Mündlich-Prüfung Trainer', desc: 'Trainiert Antworten mit klarer Struktur.', icon: '🗣️' },
        { key: 'prolab_summary_compressor', title: 'Zusammenfassung Kompressor', desc: 'Macht aus langen Texten lernbare Kurzfassungen.', icon: '🧾' },
        { key: 'prolab_topic_quiz_builder', title: 'Themen-Quiz Builder', desc: 'Erstellt Schnellquiz zu einem Thema.', icon: '❓' },
        { key: 'prolab_revision_scheduler', title: 'Wiederholungs-Scheduler', desc: 'Plant Wiederholungen nach Spaced-Repetition-Logik.', icon: '📅' },
        { key: 'prolab_concept_map_helper', title: 'Concept Map Helper', desc: 'Baut Begriffsnetze für bessere Lernverknüpfung.', icon: '🕸️' },
        { key: 'prolab_math_drill_generator', title: 'Mathe-Drill Generator', desc: 'Erzeugt Übungsblöcke in steigender Schwierigkeit.', icon: '➗' }
    ];

    extraSchool.forEach((tool) => {
        defs[tool.key] = {
            title: tool.title,
            description: tool.desc,
            category: 'Schule Pro',
            inputLabel: 'Thema',
            placeholder: 'z.B. lineare Funktionen, Weimarer Republik, DNA',
            actionText: 'Lernhilfe bauen',
            cardIcon: tool.icon,
            cardBadge: 'Schule Pro',
            generatedBatch: 'prolab',
            run: (value) => {
                const topic = String(value || 'Thema').trim();
                const n = Math.max(3, Math.min(8, words(topic).length + 3));
                const bullets = Array.from({ length: n }, (_, i) => `${i + 1}. Kernpunkt ${i + 1} zu ${topic}`);
                return `${tool.title}: ${topic}\n${bullets.join('\n')}\n\nHinweis: Lernhilfe, kein Prüfungsbetrug.`;
            }
        };
    });

    const extraDesign = [
        { key: 'prolab_brand_voice_studio', title: 'Brand Voice Studio', desc: 'Definiert Tonalität, Do/Don\'t und Sprachbeispiele.', icon: '🎙️' },
        { key: 'prolab_landing_wireframe_plan', title: 'Landing Wireframe Plan', desc: 'Erstellt Struktur für Hero, Proof, CTA und Footer.', icon: '🧱' },
        { key: 'prolab_component_state_matrix', title: 'Component State Matrix', desc: 'Plant Zustände wie default, hover, focus, disabled.', icon: '🧩' },
        { key: 'prolab_motion_concept_lab', title: 'Motion Concept Lab', desc: 'Definiert sinnvolle Animationen mit Dauer und Zweck.', icon: '🎞️' },
        { key: 'prolab_accessibility_pass', title: 'Accessibility Pass', desc: 'Checkliste für Kontrast, Fokus, Semantik und Labels.', icon: '♿' },
        { key: 'prolab_icon_system_builder', title: 'Icon System Builder', desc: 'Legt Stil, Strichstärke und Raster für Icons fest.', icon: '🧿' }
    ];

    extraDesign.forEach((tool) => {
        defs[tool.key] = {
            title: tool.title,
            description: tool.desc,
            category: 'Design Pro',
            inputLabel: 'Projektkontext',
            placeholder: 'z.B. fintech app, gaming dashboard, school portal',
            actionText: 'Framework bauen',
            cardIcon: tool.icon,
            cardBadge: 'Design Pro',
            generatedBatch: 'prolab',
            run: (value) => {
                const ctx = String(value || 'Projekt').trim();
                return `${tool.title} für ${ctx}\n- Zielgruppe\n- Visuelle Leitplanken\n- Komponenten-Regeln\n- Qualitätskriterien\n- QA-Check`;
            }
        };
    });

    const extraTech = [
        { key: 'prolab_system_design_canvas', title: 'System Design Canvas', desc: 'Skizziert Services, Datenflüsse und Engpässe.', icon: '🏗️' },
        { key: 'prolab_cache_strategy_advisor', title: 'Cache Strategy Advisor', desc: 'Empfiehlt Cache-Layer und Invalidation-Ansatz.', icon: '🧠' },
        { key: 'prolab_queue_pipeline_planner', title: 'Queue Pipeline Planner', desc: 'Plant Worker/Retry/Dead-Letter-Strukturen.', icon: '📬' },
        { key: 'prolab_monitoring_kpi_builder', title: 'Monitoring KPI Builder', desc: 'Definiert SLO, SLI und Alert-Grenzwerte.', icon: '📈' },
        { key: 'prolab_release_risk_checker', title: 'Release Risk Checker', desc: 'Bewertet Risiko vor Deploy mit klaren Gates.', icon: '🚦' },
        { key: 'prolab_data_model_studio', title: 'Data Model Studio', desc: 'Leitet Entitäten, Relationen und Constraints ab.', icon: '🗃️' }
    ];

    extraTech.forEach((tool) => {
        defs[tool.key] = {
            title: tool.title,
            description: tool.desc,
            category: 'Tech Pro',
            inputLabel: 'Use Case',
            placeholder: 'z.B. chat app with realtime updates',
            actionText: 'Blueprint erstellen',
            cardIcon: tool.icon,
            cardBadge: 'Tech Pro',
            generatedBatch: 'prolab',
            run: (value) => {
                const useCase = String(value || 'Use Case').trim();
                return `${tool.title}: ${useCase}\nA) Kernmodule\nB) Datenfluss\nC) Failure-Mode\nD) Skalierungshebel\nE) Observability-Punkte`;
            }
        };
    });

    return defs;
}

const extraMiniToolDefinitions = createExtraMiniToolDefinitions();
Object.keys(extraMiniToolDefinitions).forEach((mode) => {
    if (!MINI_TOOL_DEFINITIONS[mode]) {
        MINI_TOOL_DEFINITIONS[mode] = extraMiniToolDefinitions[mode];
    }
});

const premiumMiniToolDefinitions = createPremiumMiniToolDefinitions();
Object.keys(premiumMiniToolDefinitions).forEach((mode) => {
    if (!MINI_TOOL_DEFINITIONS[mode]) {
        MINI_TOOL_DEFINITIONS[mode] = premiumMiniToolDefinitions[mode];
    }
});

function renderGeneratedMiniToolCards() {
    const grid = document.getElementById('modeCardsGrid');
    if (!grid) return;

    const existingModes = new Set();
    grid.querySelectorAll('.mode-card').forEach((card) => {
        const onclick = card.getAttribute('onclick') || '';
        const match = onclick.match(/selectMode\('([^']+)'\)/);
        if (match) existingModes.add(match[1]);
    });

    const generatedModes = Object.entries(MINI_TOOL_DEFINITIONS)
        .filter(([, def]) => def?.generatedBatch === 'x100' || def?.generatedBatch === 'prolab')
        .sort((a, b) => (a[1].title || '').localeCompare(b[1].title || '', 'de'));

    const frag = document.createDocumentFragment();

    generatedModes.forEach(([mode, def]) => {
        if (existingModes.has(mode)) return;

        const btn = document.createElement('button');
        btn.className = `mode-card mode-card-${mode}`;
        btn.setAttribute('onclick', `selectMode('${mode}')`);

        const icon = document.createElement('div');
        icon.className = 'mode-card-icon';
        icon.textContent = def.cardIcon || '🛠️';

        const body = document.createElement('div');
        body.className = 'mode-card-body';

        const h3 = document.createElement('h3');
        h3.textContent = def.title || mode;

        const p = document.createElement('p');
        p.textContent = def.description || 'Neues Mini-Tool';

        const badge = document.createElement('span');
        badge.className = 'mode-badge';
        badge.textContent = def.cardBadge || def.category || 'Tool';

        body.appendChild(h3);
        body.appendChild(p);
        body.appendChild(badge);
        btn.appendChild(icon);
        btn.appendChild(body);
        frag.appendChild(btn);
    });

    if (frag.childNodes.length) {
        grid.appendChild(frag);
    }
}

const MINI_TOOL_MODES = new Set(Object.keys(MINI_TOOL_DEFINITIONS));
let currentUser = null;
let currentProfile = null;
let allApps = [];
let currentCategory = 'all';
let resetRequestId = null;
let resetLookupToken = null;
let resetToken = null;
let resetPollInterval = null;
let pendingReferral = null;
let imageSearchLastQuery = '';
let _lastPersonalizationSearchMiss = '';
let _chatNotifyInitialized = false;
let _moderationLockActive = false;
let _moderationCountdownTimer = null;
let _desktopUpdateInfo = null;
let _desktopUpdateStarted = false;
let _desktopUpdateUnsubscribe = null;
let _desktopWebLoginSessionId = null;
let _desktopWebLoginPollInterval = null;
let _desktopNativeAuthLoaded = false;
let deferredInstallPrompt = null;

function setupInstallPrompt() {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        const bar = document.getElementById('mobileInstallBar');
        if (bar) bar.classList.add('is-ready');
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        const bar = document.getElementById('mobileInstallBar');
        if (bar) bar.classList.remove('is-ready');
    });
}

async function triggerInstallPrompt() {
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (outcome === 'accepted') {
            showAlert('App wurde installiert.', 'success');
        } else {
            showAlert('Installation abgebrochen.', 'info');
        }
        return;
    }
    showAlert('Die Installation ist in diesem Browser gerade nicht verfügbar. Öffne das Menü und wähle „Zum Startbildschirm hinzufügen“.', 'info');
}

setupInstallPrompt();

function isEntryUnlocked() {
    return sessionStorage.getItem(ENTRY_UNLOCK_KEY) === '1';
}

function showEntryGate(choiceVisible = false, message = '') {
    const gate = document.getElementById('entryGate');
    const choiceCard = document.getElementById('entryChoiceCard');
    const help = document.getElementById('entryGateHelp');
    if (!gate) return;
    gate.style.display = 'flex';
    document.body.classList.add('entry-locked');
    if (choiceCard) choiceCard.style.display = choiceVisible ? 'block' : 'none';
    if (help && message) help.textContent = message;
    if (!choiceVisible) {
        setTimeout(() => document.getElementById('entryGateCode')?.focus(), 50);
    }
}

function hideEntryGate() {
    const gate = document.getElementById('entryGate');
    if (gate) gate.style.display = 'none';
    document.body.classList.remove('entry-locked');
}

function submitEntryCode() {
    const input = document.getElementById('entryGateCode');
    const help = document.getElementById('entryGateHelp');
    const code = String(input?.value || '').replace(/\s+/g, '');
    if (code !== ENTRY_ACCESS_CODE) {
        if (help) help.textContent = 'Der Code ist nicht korrekt. Bitte noch einmal prüfen.';
        input?.focus();
        input?.select?.();
        return;
    }

    sessionStorage.setItem(ENTRY_UNLOCK_KEY, '1');
    if (help) help.textContent = 'Code akzeptiert. Bitte wähle jetzt deinen Bereich.';
    showEntryGate(true);
}

function enterControlCenter() {
    sessionStorage.setItem(ENTRY_CHOICE_KEY, 'control-center');
    hideEntryGate();
    showSection('auth');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function enterLearningSpace() {
    sessionStorage.setItem(ENTRY_CHOICE_KEY, 'learning');
    hideEntryGate();
    window.location.href = '/learning/';
}

function initEntryGate() {
    const input = document.getElementById('entryGateCode');
    if (!input) return;

    if (isEntryUnlocked()) {
        hideEntryGate();
        return;
    }

    showEntryGate(false, 'Gib den Zugangscode ein, um die Auswahl freizuschalten.');
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitEntryCode();
        }
    });
}

function decodeMojibakeText(value) {
    const text = String(value ?? '');
    if (!/[\u00C3\u00C2\u00E2\u00F0\u00EF]/.test(text)) return text;
    try {
        const chars = Array.from(text);
        if (!chars.every(ch => ch.charCodeAt(0) <= 255)) return text;
        const bytes = Uint8Array.from(chars.map(ch => ch.charCodeAt(0)));
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return decoded.includes('\uFFFD') ? text : decoded;
    } catch {
        return text;
    }
}

function fixVisibleMojibake(root = document.body) {
    if (!root) return;
    const skipTags = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT']);
    const visitText = (node) => {
        if (!node?.nodeValue || !/[\u00C3\u00C2\u00E2\u00F0\u00EF]/.test(node.nodeValue)) return;
        node.nodeValue = decodeMojibakeText(node.nodeValue);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            return /[\u00C3\u00C2\u00E2\u00F0\u00EF]/.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    while (walker.nextNode()) visitText(walker.currentNode);
}

function startMojibakeFixer() {
    fixVisibleMojibake();
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    if (node.parentElement?.tagName !== 'SCRIPT') {
                        node.nodeValue = decodeMojibakeText(node.nodeValue);
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    fixVisibleMojibake(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function isAdminGuestPreview() {
    return sessionStorage.getItem('adminGuestPreview') === '1';
}

function isDesktopMode() {
    return EHOSER_DESKTOP_MODE;
}

function isDesktopActivated() {
    return isDesktopMode() && localStorage.getItem(DESKTOP_AUTH_KEY) === '1';
}

function markDesktopActivated() {
    if (isDesktopMode()) localStorage.setItem(DESKTOP_AUTH_KEY, '1');
}

function clearDesktopActivated() {
    if (isDesktopMode()) {
        localStorage.removeItem(DESKTOP_AUTH_KEY);
        localStorage.removeItem(DESKTOP_USER_CACHE_KEY);
    }
}

function saveDesktopUserCache(user, profile) {
    if (!isDesktopMode() || !user) return;
    try {
        localStorage.setItem(DESKTOP_USER_CACHE_KEY, JSON.stringify({ user, profile: profile || null }));
    } catch {}
}

function readDesktopUserCache() {
    if (!isDesktopMode()) return null;
    try {
        return JSON.parse(localStorage.getItem(DESKTOP_USER_CACHE_KEY) || 'null');
    } catch {
        return null;
    }
}

async function saveDesktopAuthToken(token) {
    if (!isDesktopMode() || !token || !window.ehoserDesktopAuth?.set) return false;
    try {
        const result = await window.ehoserDesktopAuth.set(token);
        return result?.ok !== false;
    } catch {
        return false;
    }
}

async function clearDesktopAuthToken() {
    if (!isDesktopMode() || !window.ehoserDesktopAuth?.clear) return;
    try {
        await window.ehoserDesktopAuth.clear();
    } catch {}
}

async function loadDesktopAuthToken() {
    if (!isDesktopMode() || _desktopNativeAuthLoaded) return;
    _desktopNativeAuthLoaded = true;
    const existing = localStorage.getItem('token');
    if (existing) {
        await saveDesktopAuthToken(existing);
        return;
    }
    try {
        const stored = await window.ehoserDesktopAuth?.get?.();
        if (stored?.token) {
            localStorage.setItem('token', stored.token);
            await saveDesktopAuthToken(stored.token);
            markDesktopActivated();
        }
    } catch {}
}

function showDesktopAuthGate() {
    currentUser = null;
    currentProfile = null;
    allApps = [];
    localStorage.removeItem('proStatus');
    showLoggedOutUI();
    showSection('auth');
    showAlert('Bitte einmal anmelden, bevor du die Desktop-App nutzen kannst.', 'error');
}

function startDesktopCachedSession() {
    const cached = readDesktopUserCache();
    currentUser = cached?.user || { id: 'desktop-cache', username: 'Desktop', isGuest: false, isAdmin: false };
    currentProfile = cached?.profile || { isPro: true, isPremium: false, ps_account: false, settings: { displayName: currentUser.username || 'Desktop' } };
    allApps = [];
    localStorage.setItem('proStatus', '1');
    if (cached?.user) {
        syncPlanStatus();
        applyProfileSettings();
        showLoggedInUI();
    } else {
        showDesktopUI();
    }
    showSection('mode-select');
    decorateDesktopModeCards();
}

function desktopRequiresInternet(featureName = 'Diese Funktion') {
    showAlert(`${featureName}: Internetverbindung erforderlich. Diese EXE verbindet sich online mit ehoser.de, damit die Vercel Environment Variables genutzt werden.`, 'error');
    showSection('mode-select');
}

function desktopNetworkUnavailable(featureName) {
    if (!isDesktopMode()) return false;
    if (navigator.onLine !== false) return false;
    desktopRequiresInternet(featureName);
    return true;
}

function decorateDesktopModeCards() {
    if (!isDesktopMode()) return;
    document.body.classList.add('desktop-mode');
    document.querySelectorAll('.mode-card').forEach((card) => {
        const onclick = card.getAttribute('onclick') || '';
        const match = onclick.match(/selectMode\('([^']+)'\)/);
        const mode = match ? match[1] : '';
        if (!DESKTOP_ONLINE_MODES.has(mode)) return;
        card.classList.add('mode-card-online-only');
        if (!card.querySelector('.desktop-online-badge')) {
            const badge = document.createElement('span');
            badge.className = 'desktop-online-badge';
            badge.textContent = 'Internet erforderlich';
            card.appendChild(badge);
        }
    });
}

function formatUpdateBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
}

function ensureDesktopUpdateUI() {
    if (!isDesktopMode() || !window.ehoserDesktopUpdates) return null;
    if (document.getElementById('desktopUpdateButton')) {
        return document.getElementById('desktopUpdateModal');
    }

    const button = document.createElement('button');
    button.id = 'desktopUpdateButton';
    button.className = 'desktop-update-button';
    button.type = 'button';
    button.textContent = 'Update herunterladen';
    button.style.display = 'none';
    button.addEventListener('click', openDesktopUpdateModal);
    document.body.appendChild(button);

    const modal = document.createElement('div');
    modal.id = 'desktopUpdateModal';
    modal.className = 'desktop-update-modal';
    modal.innerHTML = `
        <div class="desktop-update-panel">
            <button class="desktop-update-close" type="button" aria-label="Schliessen">&times;</button>
            <div class="desktop-update-kicker">Neue Desktop-Version</div>
            <h2>Update wird heruntergeladen</h2>
            <div class="desktop-update-grid">
                <span>Version</span><strong id="desktopUpdateVersion">-</strong>
                <span>Datei</span><strong id="desktopUpdateFile">-</strong>
                <span>Groesse</span><strong id="desktopUpdateSize">-</strong>
                <span>Tempo</span><strong id="desktopUpdateSpeed">0 MB/s</strong>
            </div>
            <div class="desktop-update-progress">
                <div id="desktopUpdateProgressBar"></div>
            </div>
            <div class="desktop-update-meta">
                <span id="desktopUpdatePercent">0%</span>
                <span id="desktopUpdateDownloaded">0 MB / 0 MB</span>
            </div>
            <p id="desktopUpdateStatus">Download wird vorbereitet...</p>
        </div>
    `;
    modal.querySelector('.desktop-update-close').addEventListener('click', () => {
        modal.classList.remove('show');
    });
    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('show');
    });
    document.body.appendChild(modal);
    return modal;
}

function updateDesktopUpdateModal(info) {
    if (!info) return;
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    setText('desktopUpdateVersion', `${info.currentVersion || '?'} -> ${info.latestVersion || '?'}`);
    setText('desktopUpdateFile', info.fileName || 'Installer');
    setText('desktopUpdateSize', formatUpdateBytes(info.fileSize));
    setText('desktopUpdateDownloaded', `0 MB / ${formatUpdateBytes(info.fileSize)}`);
}

function handleDesktopUpdateProgress(payload) {
    const percent = Math.max(0, Math.min(100, payload?.percent || 0));
    const total = payload?.totalBytes || _desktopUpdateInfo?.fileSize || 0;
    const received = payload?.receivedBytes || 0;
    const speed = payload?.bytesPerSecond || 0;
    const bar = document.getElementById('desktopUpdateProgressBar');
    const button = document.getElementById('desktopUpdateButton');
    const status = document.getElementById('desktopUpdateStatus');

    if (bar) bar.style.width = `${percent}%`;
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    setText('desktopUpdatePercent', `${percent.toFixed(0)}%`);
    setText('desktopUpdateDownloaded', `${formatUpdateBytes(received)} / ${formatUpdateBytes(total)}`);
    setText('desktopUpdateSpeed', speed > 0 ? `${formatUpdateBytes(speed)}/s` : '0 MB/s');

    if (payload?.state === 'completed') {
        if (status) status.textContent = `Download fertig: ${payload.savePath || payload.fileName || 'Installer'}`;
        if (button) button.textContent = 'Update heruntergeladen';
    } else if (payload?.state === 'cancelled' || payload?.state === 'interrupted') {
        if (status) status.textContent = 'Download wurde unterbrochen. Bitte erneut versuchen.';
        _desktopUpdateStarted = false;
    } else if (status) {
        status.textContent = 'Download laeuft...';
    }
}

async function openDesktopUpdateModal() {
    const modal = ensureDesktopUpdateUI();
    if (!modal || !_desktopUpdateInfo?.downloadUrl) return;
    updateDesktopUpdateModal(_desktopUpdateInfo);
    modal.classList.add('show');

    if (_desktopUpdateStarted) return;
    _desktopUpdateStarted = true;
    const status = document.getElementById('desktopUpdateStatus');
    if (status) status.textContent = 'Download wird gestartet...';
    const result = await window.ehoserDesktopUpdates.download(_desktopUpdateInfo.downloadUrl);
    if (!result?.ok) {
        _desktopUpdateStarted = false;
        if (status) status.textContent = result?.error || 'Download konnte nicht gestartet werden.';
    }
}

async function initDesktopUpdates() {
    if (!isDesktopMode() || !window.ehoserDesktopUpdates) return;
    ensureDesktopUpdateUI();
    if (!_desktopUpdateUnsubscribe) {
        _desktopUpdateUnsubscribe = window.ehoserDesktopUpdates.onProgress(handleDesktopUpdateProgress);
    }
    try {
        const info = await window.ehoserDesktopUpdates.check();
        if (!info?.available || !info.downloadUrl) return;
        _desktopUpdateInfo = info;
        const button = document.getElementById('desktopUpdateButton');
        if (button) {
            button.textContent = 'Update herunterladen';
            button.style.display = '';
        }
        updateDesktopUpdateModal(info);
    } catch {
        // Der Hinweis bleibt still, wenn die Update-Pruefung offline fehlschlaegt.
    }
}

// Client-Konfiguration (API Keys sicher vom Backend laden)
window.__ENV__ = { __loaded: false };
fetch(`${API_BASE}/config`).then(r => r.json()).then(cfg => {
    window.__ENV__ = { ...cfg, __loaded: true };
    updateGoogleAuthVisibility();
}).catch(() => {
    window.__ENV__ = { __loaded: true };
    updateGoogleAuthVisibility();
});

let _googleAuthInitialized = false;
let _pendingReloadSnapshot = null;

try {
    const rawReloadSnapshot = sessionStorage.getItem('pendingReloadSnapshot');
    _pendingReloadSnapshot = rawReloadSnapshot ? JSON.parse(rawReloadSnapshot) : null;
} catch {
    _pendingReloadSnapshot = null;
}

function normalizeUnlockCodeValue(value) {
    return String(value || '').replace(/\s+/g, '');
}

function getActiveAuthUnlockCode() {
    const registerForm = document.getElementById('registerForm');
    const registerVisible = registerForm && registerForm.style.display !== 'none';
    const input = registerVisible
        ? document.getElementById('unlockCode')
        : document.getElementById('loginUnlockCode');
    return normalizeUnlockCodeValue(input?.value || '');
}

function moderationSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

async function showModerationLock(moderation) {
    if (!moderation || _moderationLockActive) return;

    if (moderation.type === 'warn') {
        showAlert(`Admin-Warnung: ${moderation.reason || 'Bitte halte dich an die Regeln.'}`, 'error');
        try {
            const token = localStorage.getItem('token');
            if (token) {
                await fetch(`${API_BASE}/me/moderation/ack`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });
            }
        } catch {}
        return;
    }

    _moderationLockActive = true;

    const lock = document.getElementById('moderationLock');
    const title = document.getElementById('moderationTitle');
    const reason = document.getElementById('moderationReason');
    const phase = document.getElementById('moderationPhase');
    const countdown = document.getElementById('moderationCountdown');
    if (!lock || !title || !reason || !phase || !countdown) return;

    lock.style.display = 'flex';
    reason.textContent = moderation.reason ? `Grund: ${moderation.reason}` : '';
    countdown.textContent = '';

    title.textContent = moderation.type === 'delete' ? 'Account wird gelöscht' : 'Account wird gesperrt';
    const sequence = Array.isArray(moderation.sequence) ? moderation.sequence : [];
    for (const step of sequence) {
        const seconds = Math.max(1, Number(step.seconds) || 1);
        phase.textContent = `${step.text} (${seconds}s)`;
        await moderationSleep(seconds * 1000);
    }

    if (moderation.type === 'delete') {
        phase.textContent = 'Account wird jetzt entfernt...';
        try {
            const token = localStorage.getItem('token');
            if (token) {
                await fetch(`${API_BASE}/me/moderation/finalize-delete`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });
            }
        } catch {}
        logout();
        return;
    }

    if (moderation.banUntil) {
        const until = Date.parse(moderation.banUntil);
        if (Number.isFinite(until)) {
            const tick = () => {
                const left = until - Date.now();
                if (left <= 0) {
                    countdown.textContent = 'Bann ist abgelaufen. Bitte neu anmelden.';
                    clearInterval(_moderationCountdownTimer);
                    _moderationCountdownTimer = null;
                    return;
                }
                countdown.textContent = `Verbleibende Bannzeit: ${formatDuration(left)}`;
            };
            tick();
            clearInterval(_moderationCountdownTimer);
            _moderationCountdownTimer = setInterval(tick, 1000);
        }
    }
}

function captureReloadSnapshot() {
    const activeSection = document.querySelector('.section.active')?.id || 'mode-select';
    sessionStorage.setItem('pendingReloadSnapshot', JSON.stringify({
        sectionId: activeSection,
        scrollY: window.scrollY || 0
    }));
}

function restoreReloadSnapshot() {
    if (!_pendingReloadSnapshot) return;
    const { sectionId, scrollY } = _pendingReloadSnapshot;
    const targetSection = document.getElementById(sectionId);
    if (targetSection && sectionId !== 'voteScreen') {
        showSection(sectionId);
    }
    requestAnimationFrame(() => {
        window.scrollTo({ top: Number(scrollY) || 0, behavior: 'auto' });
    });
    sessionStorage.removeItem('pendingReloadSnapshot');
    _pendingReloadSnapshot = null;
}

function showRepoUpdateOverlay() {
    return;
}

function dismissRepoUpdate() {
    return;
}

function loadRepoUpdate() {
    captureReloadSnapshot();
    window.location.reload();
}

async function checkRepoVersion() {
    return;
}

function startRepoUpdatePolling() {
    return;
}

async function handleGoogleCredentialResponse(response) {
    const unlockCode = getActiveAuthUnlockCode();
    if (unlockCode !== '020818') {
        showAlert('Google-Anmeldung wird erst mit dem richtigen Zugangscode freigeschaltet.', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idToken: response?.credential,
                unlockCode
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Google-Anmeldung fehlgeschlagen');

        localStorage.setItem('token', data.token);
        await saveDesktopAuthToken(data.token);
        markDesktopActivated();
        currentUser = { id: data.userId, username: data.username, isAdmin: false };
        currentProfile = data.profile || null;
        saveDesktopUserCache(currentUser, currentProfile);
        syncPlanStatus();
        applyProfileSettings();
        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        showAlert(`Erfolgreich mit Google angemeldet: ${data.username}`, 'success');
    } catch (error) {
        showAlert(error.message || 'Google-Anmeldung fehlgeschlagen', 'error');
    }
}

function initGoogleAuth() {
    if (isDesktopMode()) return;
    if (_googleAuthInitialized) return;
    const clientId = window.__ENV__?.googleClientId;
    const buttonHost = document.getElementById('googleSignInButton');
    if (!clientId || !buttonHost) return;
    if (!window.google?.accounts?.id) {
        // GSI script noch nicht geladen (async), nach kurzer Verzögerung erneut versuchen
        setTimeout(() => { _googleAuthInitialized = false; initGoogleAuth(); }, 500);
        return;
    }

    window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true
    });
    buttonHost.innerHTML = '';
    window.google.accounts.id.renderButton(buttonHost, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
        width: 320
    });
    _googleAuthInitialized = true;
    updateGoogleAuthVisibility();
}

function updateGoogleAuthVisibility() {
    const gate = document.getElementById('googleAuthGate');
    if (!gate) return;
    if (isDesktopMode()) {
        const codeOk = getActiveAuthUnlockCode() === '020818';
        gate.style.display = codeOk ? 'block' : 'none';
        gate.classList.add('desktop-auth-gate');
        const title = gate.querySelector('.google-auth-gate-title');
        const buttonHost = document.getElementById('googleSignInButton');
        const notConfiguredMsg = document.getElementById('googleNotConfiguredMsg');
        if (title) title.textContent = 'Weitere Anmeldeoptionen';
        if (buttonHost) {
            buttonHost.innerHTML = '<p class="desktop-auth-gate-copy">Du kannst dich mit Benutzername/Passwort anmelden oder unten einen Code fuer die Web-App erzeugen.</p>';
        }
        if (notConfiguredMsg) notConfiguredMsg.style.display = 'none';
        return;
    }
    gate.classList.remove('desktop-auth-gate');
    const codeOk = getActiveAuthUnlockCode() === '020818';
    gate.style.display = codeOk ? 'block' : 'none';
    if (!codeOk) return;

    // Config noch nicht geladen – kurz warten und neu prüfen
    if (!window.__ENV__?.__loaded) {
        setTimeout(updateGoogleAuthVisibility, 300);
        return;
    }

    const clientId = window.__ENV__?.googleClientId;
    const notConfiguredMsg = document.getElementById('googleNotConfiguredMsg');
    if (!clientId) {
        if (notConfiguredMsg) notConfiguredMsg.style.display = 'block';
        return;
    }
    if (notConfiguredMsg) notConfiguredMsg.style.display = 'none';
    initGoogleAuth();
}

function getPersonalization() {
    return null;
}

function hasPremiumAccess() {
    const until = currentProfile?.premiumUntil || currentProfile?.settings?.premiumUntil || null;
    const untilMs = until ? Date.parse(until) : 0;
    return currentProfile?.isPremium === true || (Number.isFinite(untilMs) && untilMs > Date.now());
}

function hasProAccess() {
    return hasPremiumAccess() || currentProfile?.isPro === true;
}

function getCreditBalance() {
    return Number(currentProfile?.credits ?? currentProfile?.settings?.credits?.balance ?? 0);
}

function getCurrentPlanKey() {
    if (hasPremiumAccess()) return 'premium';
    if (hasProAccess()) return 'pro';
    return 'free';
}

function syncPlanStatus() {
    if (!currentProfile) return;
    currentProfile.isPremium = hasPremiumAccess();
    currentProfile.isPro = hasProAccess();
    currentProfile.credits = getCreditBalance();
    localStorage.setItem('proStatus', currentProfile.isPro ? '1' : '0');
    localStorage.setItem('premiumStatus', currentProfile.isPremium ? '1' : '0');
}

async function refreshCurrentProfile() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok || !data?.profile) return;
        currentProfile = data.profile;
        syncPlanStatus();
        applyProfileSettings();
        showLoggedInUI();
        updateKIModelAccessUI();
    } catch {}
}

let _lastProfileFocusRefresh = 0;
window.addEventListener('focus', () => {
    if (!localStorage.getItem('token') || isAdminGuestPreview()) return;
    const now = Date.now();
    if (now - _lastProfileFocusRefresh < 5000) return;
    _lastProfileFocusRefresh = now;
    refreshCurrentProfile();
});

async function trackPersonalizationEvent(type, payload) {
    return;
}

function applyPersonalizationUI() {
    const titleEl = document.getElementById('modeTitle');
    const subtitleEl = document.getElementById('modeSubtitle');
    const bannerEl = document.getElementById('personalizationBanner');
    const searchInput = document.getElementById('searchInput');
    const cardsWrap = document.querySelector('.mode-cards');
    const defaultTitle = 'Ehoser Control Center';
    const defaultSubtitle = 'Ein neu sortierter Workspace für Spiele, KI, Karten, Medien und schnelle Tools. Alles startet direkt im Browser.';

    document.body.dataset.personalizationTone = 'neutral';
    document.body.dataset.personalizationLayout = 'standard';
    document.body.dataset.personalizationPrimaryMode = 'default';
    document.body.classList.remove('personalized-ui');

    if (titleEl) {
        titleEl.textContent = currentUser ? `Ehoser für ${currentUser.username}` : defaultTitle;
    }
    if (subtitleEl) {
        subtitleEl.textContent = defaultSubtitle;
    }
    if (bannerEl) {
        bannerEl.style.display = 'none';
        bannerEl.textContent = '';
    }

    if (searchInput) {
        if (!searchInput.dataset.defaultPlaceholder) {
            searchInput.dataset.defaultPlaceholder = searchInput.getAttribute('placeholder') || '';
        }
        searchInput.setAttribute(
            'placeholder',
            personalization?.simplifySearch
                ? 'Beschreibe kurz, was du starten willst'
                : searchInput.dataset.defaultPlaceholder
        );
    }

    if (cardsWrap) {
        const getModeFromCard = (card) => {
            if (card.id === 'psModeCard') return 'ps';
            if (card.id === 'gameCreatorCard') return 'gameCreator';
            const onclick = card.getAttribute('onclick') || '';
            const match = onclick.match(/selectMode\('([^']+)'\)/);
            return match ? match[1] : '';
        };
        const priority = new Map();
        (personalization?.highlightModes || []).forEach((mode, index) => priority.set(mode, index));
        if (personalization?.prioritizePs) priority.set('ps', -1);
        const cards = Array.from(cardsWrap.querySelectorAll('.mode-card'));
        cards.forEach(card => card.classList.remove('mode-card-personalized'));
        cards.sort((a, b) => {
            const pa = priority.has(getModeFromCard(a)) ? priority.get(getModeFromCard(a)) : 999;
            const pb = priority.has(getModeFromCard(b)) ? priority.get(getModeFromCard(b)) : 999;
            if (pa !== pb) return pa - pb;
            return 0;
        });
        cards.forEach(card => {
            const mode = getModeFromCard(card);
            if (priority.has(mode)) card.classList.add('mode-card-personalized');
            cardsWrap.appendChild(card);
        });
    }
}

function switchAuthTab(tab, btn) {
    document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('loginForm').style.display = tab === 'login' ? '' : 'none';
    if (tab !== 'login') {
        document.getElementById('helpRequestForm').style.display = 'none';
        document.getElementById('resetCompleteForm').style.display = 'none';
    }
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateGoogleAuthVisibility();
    updateMoreLoginOptionsVisibility();
}

function updateMoreLoginOptionsVisibility() {
    const desktopBox = document.getElementById('desktopWebLoginBox');
    if (desktopBox) desktopBox.style.display = isDesktopMode() ? 'block' : 'none';
}

function toggleMoreLoginOptions() {
    const box = document.getElementById('moreLoginOptions');
    if (!box) return;
    box.style.display = box.style.display === 'none' ? '' : 'none';
    updateMoreLoginOptionsVisibility();
}

function toggleResetHelp() {
    const form = document.getElementById('helpRequestForm');
    form.style.display = form.style.display === 'none' ? '' : 'none';
}

function stopDesktopWebLoginPolling() {
    clearInterval(_desktopWebLoginPollInterval);
    _desktopWebLoginPollInterval = null;
}

async function finishDesktopWebLogin(data) {
    localStorage.setItem('token', data.token);
    await saveDesktopAuthToken(data.token);
    markDesktopActivated();
    currentUser = { id: data.userId, username: data.username, isAdmin: false };
    currentProfile = data.profile || null;
    saveDesktopUserCache(currentUser, currentProfile);
    syncPlanStatus();
    applyProfileSettings();
    showLoggedInUI();
    await loadApps();
    showSection('mode-select');
    startOnlinePolling();
    showAlert('Desktop-App wurde mit deinem Web-Account angemeldet.', 'success');
}

async function pollDesktopWebLoginStatus() {
    if (!_desktopWebLoginSessionId) return;
    const statusEl = document.getElementById('desktopWebLoginStatus');
    try {
        const res = await fetch(`${API_BASE}/desktop-login/status/${encodeURIComponent(_desktopWebLoginSessionId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Status konnte nicht geladen werden');
        if (data.status === 'approved' && data.token) {
            stopDesktopWebLoginPolling();
            if (statusEl) statusEl.textContent = 'Bestaetigt. Anmeldung wird abgeschlossen...';
            await finishDesktopWebLogin(data);
        } else if (data.status === 'expired') {
            stopDesktopWebLoginPolling();
            if (statusEl) statusEl.textContent = 'Code ist abgelaufen. Bitte neuen Code erstellen.';
        } else if (statusEl) {
            statusEl.textContent = 'Warte auf Bestaetigung in der Web-App...';
        }
    } catch {
        if (statusEl) statusEl.textContent = 'Verbindung wird erneut versucht...';
    }
}

async function startDesktopWebLogin() {
    if (!isDesktopMode()) return;
    const codeWrap = document.getElementById('desktopWebLoginCodeWrap');
    const codeEl = document.getElementById('desktopWebLoginCode');
    const statusEl = document.getElementById('desktopWebLoginStatus');
    try {
        stopDesktopWebLoginPolling();
        if (statusEl) statusEl.textContent = 'Code wird erstellt...';
        const res = await fetch(`${API_BASE}/desktop-login/start`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Code konnte nicht erstellt werden');
        _desktopWebLoginSessionId = data.sessionId;
        if (codeEl) codeEl.textContent = data.code || '------';
        if (codeWrap) codeWrap.style.display = 'grid';
        if (statusEl) statusEl.textContent = 'Code in der Web-App unter Account Einstellungen eingeben.';
        _desktopWebLoginPollInterval = setInterval(pollDesktopWebLoginStatus, 2000);
        pollDesktopWebLoginStatus();
    } catch (error) {
        if (statusEl) statusEl.textContent = error.message || 'Code konnte nicht erstellt werden.';
        showAlert(error.message || 'Desktop-Code konnte nicht erstellt werden.', 'error');
    }
}

async function applyDesktopLoginCode() {
    const token = localStorage.getItem('token');
    const input = document.getElementById('desktopLoginCodeInput');
    const status = document.getElementById('desktopLoginSettingsStatus');
    const code = String(input?.value || '').replace(/\D/g, '');
    if (!token) { showAlert('Bitte zuerst anmelden.', 'error'); return; }
    if (code.length !== 6) {
        if (status) status.textContent = 'Bitte den 6-stelligen Code eingeben.';
        return;
    }
    try {
        if (status) status.textContent = 'Code wird angewendet...';
        const res = await fetch(`${API_BASE}/desktop-login/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) {
            if (status) status.textContent = data.error || 'Code konnte nicht angewendet werden.';
            showAlert(data.error || 'Code konnte nicht angewendet werden.', 'error');
            return;
        }
        if (input) input.value = '';
        if (status) status.textContent = 'Desktop-App wurde angemeldet.';
        showAlert('Desktop-App erfolgreich angemeldet.', 'success');
    } catch {
        if (status) status.textContent = 'Netzwerkfehler.';
        showAlert('Netzwerkfehler beim Anwenden des Codes.', 'error');
    }
}

function stopResetStatusPolling() {
    clearInterval(resetPollInterval);
    resetPollInterval = null;
}

function startResetStatusPolling() {
    stopResetStatusPolling();
    pollResetStatus();
    resetPollInterval = setInterval(pollResetStatus, 5000);
}

async function handleHelpRequest(event) {
    event.preventDefault();
    const username = document.getElementById('helpUsername').value.trim();

    try {
        const response = await fetch(`${API_BASE}/request-code-reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });

        const data = await response.json();
        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Anfrage fehlgeschlagen'}`, 'error');
            return;
        }

        resetRequestId = data.requestId;
        resetLookupToken = data.lookupToken;
        showAlert('Anfrage gesendet. Admin wurde benachrichtigt.', 'success');
        startResetStatusPolling();
    } catch (err) {
        showAlert('Verbindungsfehler beim Senden der Anfrage.', 'error');
    }
}

async function showModerationLock(moderation) {
    if (!moderation || _moderationLockActive) return;

    if (moderation.type === 'warn') {
        showAlert(`Admin-Warnung: ${moderation.reason || 'Bitte halte dich an die Regeln.'}`, 'error');
        try {
            const token = localStorage.getItem('token');
            if (token) {
                await fetch(`${API_BASE}/me/moderation/ack`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });
            }
        } catch {}
        return;
    }

    _moderationLockActive = true;

    const overlay = document.getElementById('moderationLock');
    const termBody = document.getElementById('banTermBody');
    if (!overlay || !termBody) return;

    overlay.style.display = 'flex';
    termBody.innerHTML = '';

    const username = currentUser?.username || 'Nutzer';
    const banUntil = moderation.banUntil || null;
    const seqKey = `banSeq_${username}_${banUntil || moderation.type}`;
    const seqAlreadyShown = localStorage.getItem(seqKey) === '1';

    if (!seqAlreadyShown && moderation.type === 'ban') {
        // Prompt-Zeile mit blinkendem Cursor
        const promptLine = _banTermLine(termBody, '$ ');
        const cursor = document.createElement('span');
        cursor.className = 'ban-term-cursor';
        termBody.appendChild(cursor);

        // 3 Sekunden Verbindungsaufbau
        await moderationSleep(3000);
        cursor.remove();

        // /ban username langsam eintippen
        const cmd = `/ban ${username}`;
        for (const ch of cmd) {
            promptLine.textContent += ch;
            await moderationSleep(75);
        }
        await moderationSleep(500);
        _banTermLine(termBody, '');

        // KI wird gelöscht (10s, kein Timer angezeigt)
        const kiLine = _banTermLine(termBody, 'KI wird gelöscht');
        const d1 = _banTermDots(kiLine, 'KI wird gelöscht');
        await moderationSleep(10000);
        clearInterval(d1);
        kiLine.textContent = `KI erfolgreich für ${username} deaktiviert`;
        await moderationSleep(700);

        // Laden
        const l1 = _banTermLine(termBody, 'Laden');
        const d2 = _banTermDots(l1, 'Laden');
        await moderationSleep(2200);
        clearInterval(d2);
        l1.textContent = 'Laden... abgeschlossen';
        await moderationSleep(400);

        // Alle Apps deaktivieren
        _banTermLine(termBody, `Alle Apps deaktivieren für ${username}`);
        const l2 = _banTermLine(termBody, 'Laden');
        const d3 = _banTermDots(l2, 'Laden');
        await moderationSleep(2200);
        clearInterval(d3);
        l2.textContent = 'Laden... abgeschlossen';
        await moderationSleep(400);

        _banTermLine(termBody, 'Ban erfolgreich');
        await moderationSleep(600);
        _banTermLine(termBody, '');

        if (banUntil) localStorage.setItem(seqKey, '1');
    }

    if (moderation.type === 'delete') {
        _banTermLine(termBody, 'Account-Löschung wird durchgeführt...');
        await moderationSleep(2000);
        try {
            const token = localStorage.getItem('token');
            if (token) {
                await fetch(`${API_BASE}/me/moderation/finalize-delete`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });
            }
        } catch {}
        logout();
        return;
    }

    if (banUntil) {
        const until = Date.parse(banUntil);
        if (Number.isFinite(until)) {
            const cdLine = _banTermLine(termBody, '');
            cdLine.style.color = '#ff5555';
            const tick = () => {
                const left = until - Date.now();
                if (left <= 0) {
                    cdLine.textContent = 'Bann abgelaufen. Bitte neu anmelden.';
                    clearInterval(_moderationCountdownTimer);
                    _moderationCountdownTimer = null;
                    return;
                }
                cdLine.textContent = `Verbleibende Bannzeit: ${formatDuration(left)}`;
            };
            tick();
            clearInterval(_moderationCountdownTimer);
            _moderationCountdownTimer = setInterval(tick, 1000);
        }
    }
}

function _banTermLine(container, text) {
    const span = document.createElement('span');
    span.className = 'ban-term-line';
    span.textContent = text !== undefined ? text : '';
    container.appendChild(span);
    return span;
}

function _banTermDots(el, base) {
    let n = 0;
    return setInterval(() => {
        n = (n % 3) + 1;
        el.textContent = base + '.'.repeat(n);
    }, 400);
}

async function handleLogin(event) {
    event.preventDefault();
    const unlockCode = document.getElementById('loginUnlockCode').value.trim();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword')?.value.trim() || '';
    const loginCode = document.getElementById('loginCode')?.value.trim() || '';

    if (!password && !loginCode) {
        showAlert('Bitte Passwort oder Login-Code eingeben.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                unlockCode,
                password: password || undefined,
                loginCode: loginCode || undefined
            })
        });

        const data = await response.json();

        if (response.status === 423) {
            await showModerationLock(data.moderation || null);
            return;
        }

        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Anmeldung fehlgeschlagen'}`, 'error');
            return;
        }

        localStorage.setItem('token', data.token);
        await saveDesktopAuthToken(data.token);
        markDesktopActivated();
        currentUser = { id: data.userId, username, isAdmin: !!data.redirectToAdmin };
        currentProfile = data.profile || null;
        saveDesktopUserCache(currentUser, currentProfile);
        syncPlanStatus();
        applyProfileSettings();
        showAlert('Erfolgreich angemeldet!', 'success');

        if (data.redirectToAdmin) {
            window.location.href = 'admin.html';
            return;
        }

        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        if (data.moderationWarning?.type === 'warn') {
            showAlert(`Admin-Warnung: ${data.moderationWarning.reason || 'Bitte halte dich an die Regeln.'}`, 'error');
            fetch(`${API_BASE}/me/moderation/ack`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${data.token}` }
            }).catch(() => {});
        }
        document.getElementById('loginForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
    }
}

// ── reCAPTCHA entfernt – Vote-Screen oder direkt starten ─────────────────────
function showCaptcha() {
    applyUpdateFeatures(true);
    startApp();
    startRepoUpdatePolling();
}

// ── Update-Abstimmung ─────────────────────────────────────────────────────────
let _votePollingInterval = null;

function applyUpdateFeatures(unlocked) {
    const cards = document.querySelectorAll('[data-update-feature]');
    cards.forEach(c => { c.style.display = unlocked ? '' : 'none'; });
}

async function loadVoteStatus() {
    try {
        const token = localStorage.getItem('token');
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/vote/status`, { headers });
        const data = await res.json();
        const count = data.count || 0;
        const unlocked = data.unlocked || false;
        const myVote = data.myVote || false;

        const countEl = document.getElementById('voteCountDisplay');
        const bar = document.getElementById('voteProgressBar');
        if (countEl) countEl.textContent = `${count} / 10`;
        if (bar) bar.style.width = `${Math.min(100, count * 10)}%`;

        // Abstimmen-Button je nach Status
        const voteBtn = document.getElementById('voteBtn');
        const voteMsg = document.getElementById('voteMsg');
        if (voteBtn) {
            if (!token) {
                voteBtn.disabled = true;
                voteBtn.style.opacity = '0.5';
                if (voteMsg) voteMsg.textContent = 'Bitte anmelden um abstimmen zu können.';
            } else if (myVote) {
                voteBtn.disabled = true;
                voteBtn.style.opacity = '0.5';
                voteBtn.textContent = '✓ Bereits abgestimmt';
                if (voteMsg) voteMsg.textContent = 'Du hast bereits abgestimmt.';
            } else {
                voteBtn.disabled = false;
                voteBtn.style.opacity = '';
            }
        }

        applyUpdateFeatures(unlocked);
        return { count, unlocked, myVote };
    } catch {
        return { count: 0, unlocked: false, myVote: false };
    }
}

function showVoteScreen() {
    const screen = document.getElementById('voteScreen');
    if (screen) screen.style.display = 'block';
    loadVoteStatus();

    // Polling alle 5s – wenn 10 erreicht: alle Seiten refreshen
    clearInterval(_votePollingInterval);
    _votePollingInterval = setInterval(async () => {
        const status = await loadVoteStatus();
        if (status.unlocked) {
            clearInterval(_votePollingInterval);
        }
    }, 5000);
}

async function castVote() {
    const token = localStorage.getItem('token');
    if (!token) { showAlert('Bitte zuerst anmelden.', 'error'); return; }

    const btn = document.getElementById('voteBtn');
    const msg = document.getElementById('voteMsg');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Abstimmen…'; }

    try {
        const res = await fetch(`${API_BASE}/vote`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) {
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '✓ Bereits abgestimmt'; }
            if (msg) msg.textContent = data.error || 'Fehler.';
            return;
        }
        if (btn) { btn.textContent = '✅ Stimme gezählt!'; btn.style.background = 'linear-gradient(135deg,#1a7a3a,#2dbe6c)'; }
        if (msg) msg.textContent = `${data.count} von 10 Stimmen – danke!`;
        loadVoteStatus();

        if (data.unlocked) {
            if (msg) msg.textContent = '🎉 Update freigeschaltet! Du kannst es jetzt laden.';
        }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = '🗳️ Für Update abstimmen'; }
        if (msg) msg.textContent = 'Netzwerkfehler. Bitte erneut versuchen.';
    }
}

function skipVote() {
    clearInterval(_votePollingInterval);
    const screen = document.getElementById('voteScreen');
    if (screen) screen.style.display = 'none';
    startApp();
}

async function startApp() {
    await loadDesktopAuthToken();
    const token = localStorage.getItem('token');
    stopOnlinePolling();
    stopResetStatusPolling();

    if (isDesktopMode()) {
        if (token) {
            startDesktopCachedSession();
            verifyToken(token);
            return;
        }
        showDesktopAuthGate();
        return;
    }

    if (token) {
        verifyToken(token);
        return;
    }

    if (isAdminGuestPreview()) {
        currentUser = { id: null, username: 'Gast-Test', isGuest: true, isAdmin: false };
        currentProfile = { isPro: false, ps_account: false, settings: { displayName: 'Gast-Test' } };
        allApps = [];
        localStorage.removeItem('proStatus');
        showAdminGuestPreviewUI();
        showSection('mode-select');
        startOnlinePolling();
        return;
    }

    currentUser = null;
    currentProfile = null;
    allApps = [];
    localStorage.removeItem('proStatus');
    showLoggedOutUI();
    showSection('auth');
}

document.addEventListener('DOMContentLoaded', () => {
    renderGeneratedMiniToolCards();
    initSecurityExperience();
    if (isDesktopMode()) {
        decorateDesktopModeCards();
        initDesktopUpdates();
    }
    updateMoreLoginOptionsVisibility();

    // Referral-Code aus URL lesen
    const ref = new URLSearchParams(window.location.search).get('ref');
    pendingReferral = ref || localStorage.getItem('pendingReferralCode') || null;
    if (pendingReferral) {
        localStorage.setItem('pendingReferralCode', pendingReferral);
        const referralInput = document.getElementById('referralCode');
        if (referralInput) referralInput.value = pendingReferral;
    }

    ['unlockCode', 'loginUnlockCode'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('input', updateGoogleAuthVisibility);
    });
    updateGoogleAuthVisibility();

    // Splash: standardmäßig nur einmal (persistiert auch über Neustarts)
    const splash = document.getElementById('introSplash');
    if (splash) {
        const forceIntro = new URLSearchParams(window.location.search).get('intro') === '1';
        const alreadyShown = !forceIntro && (
            sessionStorage.getItem('intro_shown') === '1'
        );
        if (alreadyShown) {
            splash.remove();
            document.body.classList.remove('splash-active');
            document.body.style.overflow = '';
            showCaptcha();
        } else {
            // Neues Intro: kompaktes Reveal statt langer Splash-Sequenz
            const compactIntro = window.matchMedia?.('(max-width: 640px)').matches;
            const bigLogoDelay = compactIntro ? 1200 : 3000;
            const splashEndDelay = compactIntro ? 2800 : 5200;
            const bigLogo = document.getElementById('introBigLogo');
            if (bigLogo) {
                setTimeout(() => {
                    bigLogo.style.opacity = '1';
                    bigLogo.style.transition = 'opacity 0.18s ease, transform 0.65s cubic-bezier(.2,1.3,.3,1)';
                    bigLogo.style.transform = 'translateY(0) scale(1)';
                    setTimeout(() => {
                        bigLogo.style.transition = 'transform 0.28s ease-out';
                        bigLogo.style.transform = 'translateY(0) scale(0.98)';
                    }, 650);
                }, bigLogoDelay);
            }

            // Finaler Übergang auf die neue Oberfläche, auf Mobile schneller
            setTimeout(() => {
                splash.remove();
                document.body.classList.remove('splash-active');
                document.body.style.overflow = '';
                sessionStorage.setItem('intro_shown', '1');
                // Weißes Body-Overlay für den Blitz-Übergang (mit Fallback, damit es nie hängen bleibt)
                const bodyFlash = document.createElement('div');
                bodyFlash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99998;pointer-events:none;opacity:1;transition:opacity 0.3s ease;';
                document.body.appendChild(bodyFlash);
                setTimeout(() => {
                    bodyFlash.style.opacity = '0';
                }, 30);
                setTimeout(() => {
                    if (bodyFlash.parentNode) bodyFlash.remove();
                }, 500);
                showCaptcha();
            }, splashEndDelay);
        }
    } else {
        document.body.classList.remove('splash-active');
        document.body.style.overflow = '';
        showCaptcha();
    }
});

async function verifyToken(token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // Vercel cold start kann ~10s dauern
    try {
        const response = await fetch(`${API_BASE}/verify-token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('proStatus');
            clearDesktopActivated();
            await clearDesktopAuthToken();
            showSection('auth');
            return;
        }

        if (response.status === 423) {
            const payload = await response.json().catch(() => ({}));
            await showModerationLock(payload.moderation || null);
            return;
        }

        if (!response.ok) {
            if (isDesktopActivated()) {
                startDesktopCachedSession();
                showAlert('Offline gestartet. Online-Funktionen brauchen Internet.', 'error');
                return;
            }
            showSection('auth');
            return;
        }

        const data = await response.json();
        if (data.token) {
            localStorage.setItem('token', data.token);
            await saveDesktopAuthToken(data.token);
        }
        markDesktopActivated();
        currentUser = data.user;
        currentProfile = data.profile || null;
        saveDesktopUserCache(currentUser, currentProfile);
        // 🔧 Pro-Status in localStorage speichern für FaceWarp/Chat
        syncPlanStatus();
        applyProfileSettings();
        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        if (data.moderationWarning?.type === 'warn') {
            showAlert(`Admin-Warnung: ${data.moderationWarning.reason || 'Bitte halte dich an die Regeln.'}`, 'error');
            fetch(`${API_BASE}/me/moderation/ack`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${data.token || token}` }
            }).catch(() => {});
        }
    } catch (err) {
        if (isDesktopActivated() && localStorage.getItem('token')) {
            startDesktopCachedSession();
            showAlert('Offline gestartet. Online-Funktionen brauchen Internet.', 'error');
            return;
        }
        showSection('auth');
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const unlockCode = document.getElementById('unlockCode').value.trim();
    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('registerPassword').value.trim();
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value.trim();

    if (!password || password.length < 6) {
        showAlert('Passwort muss mindestens 6 Zeichen lang sein.', 'error');
        return;
    }
    if (password !== passwordConfirm) {
        showAlert('Passwörter stimmen nicht überein.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unlockCode, username, email, password, referralCode: pendingReferral })
        });

        const data = await response.json();

        if (!response.ok) {
            showAlert(`Fehler: ${data.error || 'Registrierung fehlgeschlagen'}`, 'error');
            return;
        }

        localStorage.setItem('token', data.token);
        await saveDesktopAuthToken(data.token);
        markDesktopActivated();
        currentUser = { id: data.userId, username, isAdmin: !!data.redirectToAdmin };
        currentProfile = data.profile || null;
        saveDesktopUserCache(currentUser, currentProfile);
        syncPlanStatus();
        applyProfileSettings();
        window.alert(`Dein Login-Code: ${data.loginCode}\nDiesen Code sicher speichern. Du kannst ihn als Backup zum Anmelden nutzen.`);
        if (data.referralApplied) {
            showAlert('Referral erfolgreich: Ihr habt beide 2 Tage Pro erhalten.', 'success');
            localStorage.removeItem('pendingReferralCode');
            pendingReferral = null;
        }
        showAlert('Willkommen bei ehoser.', 'success');

        if (data.redirectToAdmin) {
            window.location.href = 'admin.html';
            return;
        }

        showLoggedInUI();
        await loadApps();
        showSection('mode-select');
        restoreReloadSnapshot();
        startOnlinePolling();
        document.getElementById('registerForm').reset();
    } catch (err) {
        showAlert('Verbindungsfehler. Prüfe ob der Server läuft.', 'error');
    }
}

function openStandaloneChat() {
    const isLocalDev = /localhost|127\.0\.0\.1/.test(window.location.hostname);
    const url = isLocalDev ? `${window.location.origin}/chat` : 'https://ehoser.de/chat';
    window.location.href = url;
}

function showLoggedInUI() {
    const navLinks = document.getElementById('navLinks');
    syncPlanStatus();
    const plan = hasPremiumAccess() ? 'Premium' : (hasProAccess() ? 'PRO' : 'Gratis');
    const credits = getCreditBalance();
    const psBadge = currentProfile?.ps_account ? '<span style="background:rgba(77,159,255,0.2);color:#4d9fff;border:1px solid rgba(77,159,255,0.4);border-radius:6px;font-size:0.75em;font-weight:700;padding:2px 7px;letter-spacing:.04em;">PS</span>' : '';
    const personalization = getPersonalization();
    const displayName = currentProfile?.settings?.displayName || currentUser.username;
    const avatarUrl = currentProfile?.settings?.avatarUrl || '';
    const avatarNode = avatarUrl
        ? `<img src="${escapeAttribute(avatarUrl)}" alt="Profilbild" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid rgba(14,240,208,0.35);">`
        : `<span style="width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:rgba(14,240,208,0.15);color:#0ef0d0;font-weight:700;">${escapeHtml((displayName || '?').charAt(0).toUpperCase())}</span>`;
    const helloText = personalization?.heroLine
        ? `Hallo, ${escapeHtml(displayName)}. ${escapeHtml(personalization.heroLine.slice(0, 72))}`
        : `Hallo, ${escapeHtml(displayName)}.`;
    navLinks.innerHTML = `
        <a href="#" onclick="showSection('mode-select')" class="nav-link">Start</a>
        <button type="button" class="nav-chat-button" onclick="openStandaloneChat()" aria-label="Chat öffnen"><img src="/chat.png" alt="Chat" /></button>
        <button type="button" class="nav-pill" onclick="showSection('mode-select')">Hinzufügen</button>
        <button type="button" class="nav-pill" onclick="showSection('updates')">Updates</button>
        <button onclick="openSettingsModal()" class="btn-small" style="width:auto;padding:8px 12px;">Einstellungen</button>
        <button onclick="openPricingModal()" class="plan-badge ${hasPremiumAccess() ? 'premium' : (hasProAccess() ? 'pro' : '')}" style="border:0;cursor:pointer;">${plan}</button>
        <span class="plan-badge" title="KI Credits">${credits} Credits</span>
        ${!hasPremiumAccess() ? '<button onclick="openPricingModal()" class="btn-small" style="width:auto;padding:8px 12px;">Pro Mitglied werden</button>' : ''}
        <span style="display:flex;align-items:center;gap:8px;">${avatarNode}</span>
        <span class="hello-user">${psBadge} ${helloText}</span>
        <button onclick="logout()" class="logout-btn">Abmelden</button>
    `;

    // PS-Hilfe-Karte zeigen/verstecken
    const psCard = document.getElementById('psModeCard');
    if (psCard) psCard.style.display = currentProfile?.ps_account ? '' : 'none';

    // Spiel-erstellen-Karte zeigen/verstecken (nur Pro)
    const gameCard = document.getElementById('gameCreatorCard');
    if (gameCard) gameCard.style.display = hasProAccess() ? '' : 'none';

    applyPersonalizationUI();
    // initialize daily claim button in nav
    try { initDailyClaimButton(); } catch (e) {}
}

// --- Daily login claim UI and actions --------------------------------------
function initDailyClaimButton() {
    const nav = document.getElementById('navLinks');
    if (!nav) return;
    if (document.getElementById('dailyClaimBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'dailyClaimBtn';
    btn.className = 'nav-pill';
    btn.textContent = 'Tägliches Geschenk';
    btn.onclick = claimDaily;
    nav.insertBefore(btn, nav.querySelector('.nav-pill') || null);
    updateDailyBtn();
}

async function updateDailyBtn() {
    const btn = document.getElementById('dailyClaimBtn');
    if (!btn) return;
    const token = localStorage.getItem('token');
    if (!token) { btn.style.display = 'none'; return; }
    try {
        const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { btn.style.display = ''; btn.textContent = 'Tägliches Geschenk'; return; }
        const data = await res.json();
        const dl = data.settings?.dailyLogin || {};
        const streak = Number(dl.streak || 0);
        btn.textContent = `Tagesbonus (${streak}d)`;
    } catch {
        btn.textContent = 'Tägliches Geschenk';
    }
}

async function claimDaily() {
    const token = localStorage.getItem('token');
    if (!token) { alert('Bitte anmelden'); return; }
    try {
        const res = await fetch(`${API_BASE}/me/daily-claim`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        const d = await res.json();
        if (!res.ok) return alert(d.error || 'Fehler');
        alert(`Erhalten: ${d.creditsGiven} Credits. Streak: ${d.streak} Tage.` + (d.premiumGranted ? '\nMonat PRO geschenkt!' : ''));
        updateDailyBtn();
    } catch (e) { alert('Fehler: ' + e.message); }
}

function showLoggedOutUI() {
    const navLinks = document.getElementById('navLinks');
    if (!navLinks) return;
    navLinks.innerHTML = '<a href="#" onclick="showSection(\'auth\')" class="nav-link">Anmelden</a><button type="button" class="nav-chat-button" onclick="openStandaloneChat()" aria-label="Chat öffnen"><img src="/chat.png" alt="Chat" /></button><button type="button" class="nav-pill" onclick="showSection(\'auth\')">Hinzufügen</button><button type="button" class="nav-pill" onclick="showSection(\'updates\')">Updates</button>';
}

function showAdminGuestPreviewUI() {
    const navLinks = document.getElementById('navLinks');
    if (!navLinks) return;
    navLinks.innerHTML = `
        <a href="#" onclick="showSection('mode-select')" class="nav-link">Start</a>
        <button type="button" class="nav-chat-button" onclick="openStandaloneChat()" aria-label="Chat öffnen"><img src="/chat.png" alt="Chat" /></button>
        <button type="button" class="nav-pill" onclick="showSection('mode-select')">Hinzufügen</button>
        <button type="button" class="nav-pill" onclick="showSection('updates')">Updates</button>
        <span class="plan-badge">Gast-Test</span>
        <button onclick="exitAdminGuestPreview()" class="logout-btn">Test verlassen</button>
    `;
}

function exitAdminGuestPreview() {
    sessionStorage.removeItem('adminGuestPreview');
    currentUser = null;
    currentProfile = null;
    allApps = [];
    showLoggedOutUI();
    showSection('auth');
}

async function loadApps() {
    try {
        const token = localStorage.getItem('token');
        if (!token && !isAdminGuestPreview()) {
            showLoggedOutUI();
            showSection('auth');
            return;
        }

        const response = await fetch(`${API_BASE}/apps`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const apps = await response.json();
        if (!response.ok) {
            if (!isAdminGuestPreview()) {
                showLoggedOutUI();
                showSection('auth');
            } else {
                displayApps([], { searchText: '', category: 'all', adminGuestPreview: true });
            }
            return;
        }
        allApps = Array.isArray(apps) ? apps : [];
        displayApps(allApps, { searchText: '', category: 'all' });
    } catch (err) {
        // Silent fallback: do not show a false startup error when apps are available.
    }
}

function displayApps(apps, meta) {
    const appsList = document.getElementById('appsList');
    const searchText = meta?.searchText || '';
    const personalization = getPersonalization();

    if (!apps.length) {
        appsList.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <h3>${meta?.adminGuestPreview ? 'Gast-Test aktiv' : 'Keine Apps gefunden'}</h3>
                <p>${meta?.adminGuestPreview ? 'Du bist aus dem Admin-Bereich ohne Account in der App. So kannst du die Oberflaeche vor GitHub testen.' : (personalization?.simplifySearch ? 'Ich habe die Suche bereits vereinfacht. Versuche einen kuerzeren Begriff oder lass dir von ehoser KI etwas Passendes vorschlagen.' : 'Versuche eine andere Suche oder Kategorie.')}</p>
                ${searchText ? `<button class="btn-small" onclick="selectMode('ki')" style="margin-top:12px;">KI nach ${escapeHtml(searchText)} fragen</button>` : ''}
            </div>
        `;
        return;
    }

    appsList.innerHTML = apps.map((app) => `
        <article class="app-card">
            <div class="app-icon-wrap">${renderIcon(app.icon_url, app.name)}</div>
            <h3 class="app-name">${escapeHtml(app.name)}</h3>
            <div class="app-category">${escapeHtml(app.category || 'Allgemein')}</div>
            <p class="app-version">Version ${escapeHtml(app.version || '1.0.0')}</p>
            <div class="app-actions">
                <button class="btn-small btn-install" onclick="installApp(${app.id}, this)">Installieren</button>
                <button class="btn-small btn-info" onclick="showAppDetails(${app.id})">Details</button>
            </div>
        </article>
    `).join('');
}

function renderIcon(iconUrl, appName) {
    if (!iconUrl) {
        return '<span class="emoji-icon">📱</span>';
    }

    const looksLikeImage = iconUrl.startsWith('/uploads/') || /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(iconUrl) || iconUrl.startsWith('http');
    if (looksLikeImage) {
        const safeUrl = escapeAttribute(iconUrl);
        const alt = escapeAttribute(appName || 'App Icon');
        return `<img class="app-icon-img" src="${safeUrl}" alt="${alt}">`;
    }

    return `<span class="emoji-icon">${escapeHtml(iconUrl)}</span>`;
}

function filterApps() {
    const searchText = document.getElementById('searchInput').value.trim().toLowerCase();
    applyFilters(searchText, currentCategory);
}

function filterByCategory(category, evt) {
    currentCategory = category;
    document.querySelectorAll('.filter-btn').forEach((btn) => btn.classList.remove('active'));

    const clickedButton = evt?.currentTarget || event?.currentTarget;
    if (clickedButton) {
        clickedButton.classList.add('active');
    }

    const searchText = document.getElementById('searchInput').value.trim().toLowerCase();
    applyFilters(searchText, category);
}

function applyFilters(searchText, category) {
    let filtered = [...allApps];

    if (searchText) {
        filtered = filtered.filter((app) =>
            (app.name || '').toLowerCase().includes(searchText) ||
            (app.description || '').toLowerCase().includes(searchText)
        );
    }

    if (category !== 'all') {
        filtered = filtered.filter((app) => app.category === category);
    }

    if (!filtered.length && searchText && currentUser) {
        const missKey = `${category}:${searchText}`;
        if (_lastPersonalizationSearchMiss !== missKey) {
            _lastPersonalizationSearchMiss = missKey;
            trackPersonalizationEvent('search-empty', { query: searchText, category });
        }
    } else if (filtered.length) {
        _lastPersonalizationSearchMiss = '';
    }

    displayApps(filtered, { searchText, category });
}

async function installApp(appId, button) {
    if (!currentUser || currentUser.isGuest || !localStorage.getItem('token')) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }

    const app = allApps.find((item) => item.id === appId);
    const isPro = hasProAccess();
    const token = localStorage.getItem('token');

    try {
        const response = await fetch(`${API_BASE}/install`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ appId })
        });

        const data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Installation fehlgeschlagen.', 'error');
            return;
        }

        if (button) {
            button.textContent = 'Installiert';
            button.classList.add('btn-installed');
            button.disabled = true;
        }

        if (!isPro) {
            showAlert('Gratis-Modus: Download startet in 5 Sekunden. Mit PRO sofort.', 'success');
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        // APK direkt herunterladen
        if (app && app.download_url) {
            const a = document.createElement('a');
            a.href = app.download_url;
            a.download = `${app.name || 'app'}.apk`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        showAlert('Download gestartet!', 'success');
    } catch (err) {
        showAlert('Installationsfehler.', 'error');
    }
}

function showAppDetails(appId) {
    const app = allApps.find((item) => item.id === appId);
    if (!app) {
        return;
    }

    const modal = document.getElementById('appModal');
    const modalBody = document.getElementById('modalBody');

    modalBody.innerHTML = `
        <div class="modal-body">
            <div class="app-icon app-icon-large">${renderIcon(app.icon_url, app.name)}</div>
            <h3>${escapeHtml(app.name)}</h3>
            <div class="app-category">${escapeHtml(app.category || 'Allgemein')}</div>
            <p>${escapeHtml(app.description || 'Keine Beschreibung')}</p>
            <p><strong>Version:</strong> ${escapeHtml(app.version || '1.0.0')}</p>
            ${app.source_url ? `<p><strong>Quelle:</strong> <a href="${escapeAttribute(app.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(app.source_url)}</a></p>` : ''}
            ${app.download_url ? `<p><strong>Datei:</strong> <a href="${escapeAttribute(app.download_url)}" target="_blank" rel="noopener noreferrer">APK herunterladen</a></p>` : ''}
            <button class="btn-primary" onclick="installApp(${app.id}); closeModal();">Jetzt installieren</button>
        </div>
    `;

    modal.classList.add('show');
}

function closeModal() {
    document.getElementById('appModal').classList.remove('show');
}

async function loadMyApps() {
    const token = localStorage.getItem('token');

    if (!token) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/my-apps`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!response.ok) {
            showAlert('Meine Apps konnten nicht geladen werden.', 'error');
            return;
        }

        const apps = await response.json();
        const myAppsList = document.getElementById('myAppsList');

        if (!apps.length) {
            myAppsList.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1;">
                    <h3>Noch keine Apps installiert</h3>
                    <p>Hier erscheinen deine freigegebenen Inhalte.</p>
                </div>
            `;
            return;
        }

        myAppsList.innerHTML = apps.map((app) => `
            <article class="app-card">
                <div class="app-icon-wrap">${renderIcon(app.icon_url, app.name)}</div>
                <h3 class="app-name">${escapeHtml(app.name)}</h3>
                <div class="app-category">${escapeHtml(app.category || 'Allgemein')}</div>
                <p class="app-version">Version ${escapeHtml(app.version || '1.0.0')}</p>
                <div class="app-actions">
                    <button class="btn-small btn-installed" disabled>Installiert</button>
                    <button class="btn-small btn-info" onclick="showAppDetails(${app.id})">Details</button>
                </div>
            </article>
        `).join('');
    } catch (err) {
        showAlert('Meine Apps konnten nicht geladen werden.', 'error');
    }
}

function runSecurityCheck() {
    const input = document.getElementById('securityCheckInput');
    const meterFill = document.getElementById('securityMeterFill');
    const hints = document.getElementById('securityHints');
    if (!input || !meterFill || !hints) return;

    const value = String(input.value || '').trim();
    let score = 0;
    const checks = [];

    if (value.length >= 12) { score += 1; checks.push('Länge >= 12'); }
    if (/[A-Z]/.test(value)) { score += 1; checks.push('Großbuchstaben'); }
    if (/[0-9]/.test(value)) { score += 1; checks.push('Zahl'); }
    if (/[^A-Za-z0-9]/.test(value)) { score += 1; checks.push('Sonderzeichen'); }
    if (value.length >= 16) { score += 1; checks.push('Sehr lang'); }

    const width = Math.min(100, score * 20);
    const label = score >= 4 ? 'strong' : score >= 3 ? 'good' : score >= 2 ? 'medium' : 'weak';
    meterFill.style.width = `${width}%`;
    meterFill.className = label;

    const headline = score >= 4 ? 'Stark' : score >= 3 ? 'Gut' : score >= 2 ? 'Mittel' : 'Schwach';
    hints.innerHTML = `<strong>${headline}</strong><br>${checks.length ? checks.join(' • ') : 'Füge mehr Länge oder Sonderzeichen hinzu.'}`;
}

function toggleGhostMode() {
    const button = document.getElementById('ghostModeToggle');
    const isActive = document.body.classList.toggle('ghost-mode');
    if (button) {
        button.textContent = isActive ? '🌫️ Fokusmodus aktiv' : '🌫️ Fokusmodus aktivieren';
    }
}

function initSecurityExperience() {
    const input = document.getElementById('securityCheckInput');
    if (input) {
        input.addEventListener('input', runSecurityCheck);
    }
    runSecurityCheck();
}

function showSection(sectionId) {
    const token = localStorage.getItem('token');
    if (sectionId === 'auth' && token && !isAdminGuestPreview()) {
        sectionId = 'mode-select';
    }
    if (sectionId !== 'auth' && !token && !isAdminGuestPreview()) {
        sectionId = 'auth';
    }

    if (sectionId === 'earth3d' && !document.getElementById('earth3dCanvas')) {
        sectionId = 'mode-select';
    }

    document.querySelectorAll('.section').forEach((section) => {
        section.classList.remove('active');
    });

    const section = document.getElementById(sectionId);
    if (!section) {
        return;
    }

    section.classList.add('active');
    document.body.dataset.section = sectionId;

    // Games: enable immersive/fullscreen mode to hide top UI (online widget, navbar)
    if (sectionId === 'games') {
        document.body.classList.add('games-fullscreen');
        try { document.getElementById('onlineWidget') && document.getElementById('onlineWidget').classList.add('hidden-by-games'); } catch {}
    } else {
        document.body.classList.remove('games-fullscreen');
        try { document.getElementById('onlineWidget') && document.getElementById('onlineWidget').classList.remove('hidden-by-games'); } catch {}
    }

    // Chat hat eigenes internes Scroll-Layout; Seiten-Scroll dafür sperren.
    document.body.classList.toggle('chat-scroll-lock', sectionId === 'chat');

    if (sectionId === 'auth') {
        loadUnlockCode();
    }
    if (sectionId === 'my-apps') {
        loadMyApps();
    }
    if (sectionId === 'games') {
        if (!gamesAllLoaded.length) loadGames();
    }
}

let _miniToolMode = '';
let _miniToolTimer = null;

function getMiniToolDefinition(mode) {
    return MINI_TOOL_DEFINITIONS[mode] || null;
}

function initMiniTool(mode) {
    _miniToolMode = mode;
    if (_miniToolTimer) {
        clearInterval(_miniToolTimer);
        _miniToolTimer = null;
    }
    renderMiniTool();
    setTimeout(() => document.getElementById('miniToolInput')?.focus(), 50);
}

function setMiniToolOutput(content, useHtml = false) {
    const output = document.getElementById('miniToolOutput');
    if (!output) return;
    if (useHtml) {
        output.innerHTML = content;
    } else {
        output.textContent = content;
    }
}

function renderMiniTool() {
    const title = document.getElementById('miniToolTitle');
    const description = document.getElementById('miniToolDescription');
    const category = document.getElementById('miniToolCategory');
    const inputLabel = document.getElementById('miniToolInputLabel');
    const input = document.getElementById('miniToolInput');
    const input2 = document.getElementById('miniToolInput2');
    const input2Label = document.getElementById('miniToolInput2Label');
    const actionBtn = document.getElementById('miniToolActionBtn');
    const extra = document.getElementById('miniToolExtra');

    if (!title || !description || !category || !inputLabel || !input || !input2 || !input2Label || !actionBtn || !extra) {
        return;
    }

    const def = getMiniToolDefinition(_miniToolMode);
    title.textContent = def?.title || 'Mini-Tool';
    description.textContent = def?.description || 'Nutz eines der neuen Mini-Tools für schnellen Browser-Support.';
    category.textContent = def?.category || 'Werkzeug';
    input.value = '';
    input2.value = '';
    input.placeholder = def?.placeholder || 'Eingabe hier...';
    input2.placeholder = def?.placeholder2 || '';
    inputLabel.textContent = def?.inputLabel || 'Eingabe';
    inputLabel.style.display = def?.inputVisible === false ? 'none' : 'block';
    input.style.display = def?.inputVisible === false ? 'none' : 'block';
    input2Label.textContent = def?.input2Label || 'Zusatz';
    input2Label.style.display = def?.input2Visible ? 'block' : 'none';
    input2.style.display = def?.input2Visible ? 'block' : 'none';
    actionBtn.textContent = def?.actionText || 'Ausführen';
    extra.innerHTML = def?.extraHtml || '';

    setMiniToolOutput('Bereit. Starte das Tool über die Schaltfläche rechts.');
}

function runMiniTool() {
    const value = document.getElementById('miniToolInput')?.value || '';
    const value2 = document.getElementById('miniToolInput2')?.value || '';
    const def = getMiniToolDefinition(_miniToolMode);
    if (!def) {
        setMiniToolOutput('Dieses Tool ist noch nicht verfügbar.');
        return;
    }

    if (_miniToolTimer) {
        clearInterval(_miniToolTimer);
        _miniToolTimer = null;
    }

    const result = def.run(value, value2);
    if (result && typeof result === 'object' && result.html) {
        setMiniToolOutput(result.html, true);
        return;
    }

    const text = String(result ?? '');
    if (text.startsWith('timer:')) {
        const seconds = parseInt(text.slice(6), 10) || 0;
        if (!seconds) {
            setMiniToolOutput('Bitte eine Dauer in Sekunden eingeben.');
            return;
        }
        let remaining = seconds;
        setMiniToolOutput(`Timer läuft: ${remaining} Sekunden`);
        _miniToolTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                clearInterval(_miniToolTimer);
                _miniToolTimer = null;
                setMiniToolOutput('⏰ Zeit abgelaufen!');
                return;
            }
            setMiniToolOutput(`Timer läuft: ${remaining} Sekunden`);
        }, 1000);
        return;
    }

    setMiniToolOutput(text);
}

function miniToolReset() {
    if (_miniToolTimer) {
        clearInterval(_miniToolTimer);
        _miniToolTimer = null;
    }
    renderMiniTool();
}

function miniToolInputChanged() {
    const def = getMiniToolDefinition(_miniToolMode);
    if (def?.autoRunOnInput) {
        runMiniTool();
    }
}

function showDesktopUI() {
    const navLinks = document.getElementById('navLinks');
    if (!navLinks) return;
    navLinks.innerHTML = `
        <span class="hello-user">Desktop-App - ehoser.de</span>
        <a href="#" onclick="showSection('mode-select')" class="nav-link">Tools</a>
        <button type="button" class="nav-chat-button" onclick="openStandaloneChat()" aria-label="Chat öffnen"><img src="/chat.png" alt="Chat" /></button>
        <button type="button" class="nav-pill" onclick="showSection('mode-select')">Hinzufügen</button>
        <button type="button" class="nav-pill" onclick="showSection('updates')">Updates</button>
        <a href="#" onclick="showSection('auth')" class="nav-link desktop-online-link">Online-Konto</a>
    `;
}

let _unlockCode = null;

async function loadUnlockCode() {
    const display = document.getElementById('unlockCodeDisplay');
    if (_unlockCode) {
        if (display) display.textContent = _unlockCode;
        updateGoogleAuthVisibility();
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/unlock-code`);
        const data = await res.json();
        _unlockCode = data.code;
        if (display) display.textContent = _unlockCode;
        updateGoogleAuthVisibility();
    } catch {
        if (display) display.textContent = '–';
    }
}

async function copyUnlockCode() {
    if (!_unlockCode) return;
    try {
        await navigator.clipboard.writeText(_unlockCode);
    } catch {
        // Fallback
        const el = document.getElementById('unlockCodeDisplay');
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    const btn = document.querySelector('.unlock-code-copy');
    if (btn) {
        btn.textContent = '✓ Kopiert!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = '📋 Kopieren';
            btn.classList.remove('copied');
        }, 2000);
    }
}

function selectMode(mode) {
    if (isDesktopMode() && DESKTOP_ONLINE_MODES.has(mode)) {
        const names = {
            games: 'Online Spiele',
            ki: 'KI',
            chat: 'Chat',
            map: 'Karte',
            earth3d: '3D Earth Flight',
            youtube: 'YouTube',
            news: 'Nachrichten',
            images: 'Bildersuche',
            weather: 'Wetter',
            gameCreator: 'Game Creator',
            ps: 'PS'
        };
        if (desktopNetworkUnavailable(names[mode] || 'Diese Funktion')) return;
    }

    if (mode === 'store') {
        showSection('mode-select');
    } else if (mode === 'games') {
        showSection('games');
    } else if (mode === 'images') {
        showSection('images');
        if (!imageSearchLastQuery) {
            document.getElementById('imageSearchStatus').textContent = 'Gib ein Suchwort ein und starte die Suche.';
        }
    } else if (mode === 'weather') {
        showSection('weather');
        document.getElementById('weatherStatus').textContent = '';
        document.getElementById('weatherResult').innerHTML = '';
        setTimeout(() => document.getElementById('weatherCityInput')?.focus(), 50);
    } else if (mode === 'map') {
        showSection('map');
        setTimeout(initMap, 50); // kurz warten bis section sichtbar ist
    } else if (mode === 'earth3d') {
        showSection('earth3d');
        setTimeout(() => {
            loadEarth3DMapTexture();
            initEarth3DScene();
        }, 60);
    } else if (mode === 'youtube') {
        showSection('youtube');
        setTimeout(() => document.getElementById('ytSearchInput')?.focus(), 50);
    } else if (mode === 'news') {
        showSection('news');
        newsLoad('top');
    } else if (mode === 'ki') {
        // Registrierung nötig
        const token = localStorage.getItem('token');
        if (!token && !isAdminGuestPreview()) {
            showAlert('Bitte zuerst anmelden, um ehoser KI zu nutzen.', 'error');
            showSection('auth');
            return;
        }
        showSection('ki');
        // Name bereits bekannt → direkt Chat öffnen, sonst Modal zeigen
        if (sessionStorage.getItem('kiUserName')) {
            showKIChat();
        } else {
            document.getElementById('kiNameModal').style.display = 'flex';
            document.getElementById('kiChatWrapper').style.display = 'none';
            setTimeout(() => document.getElementById('kiNameInput')?.focus(), 50);
        }
    } else if (mode === 'facewarp') {
        openFacewarpModeModal();
    } else if (mode === 'chat') {
        openStandaloneChat();
        showAlert('Chat öffnet sich jetzt in der eigenen Chat-Seite.', 'success');
    } else if (mode === 'qr') {
        showSection('qr');
        setTimeout(() => document.getElementById('qrInput')?.focus(), 50);
    } else if (mode === 'calc') {
        showSection('calc');
        _calcExpr = '';
        _calcRender();
    } else if (mode === 'notes') {
        showSection('notes');
        _notesLoad();
        _notesRender();
    } else if (mode === 'pwd') {
        showSection('pwd');
        pwdGenerate();
    } else if (mode === 'palette') {
        showSection('palette');
        paletteGenerate();
    } else if (mode === 'json') {
        showSection('json');
    } else if (mode === 'stopwatch') {
        showSection('stopwatch');
    } else if (mode === 'encode') {
        showSection('encode');
    } else if (mode === 'units') {
        showSection('units');
        unitsUpdateCat();
    } else if (mode === 'rng') {
        showSection('rng');
    } else if (mode === 'tone') {
        showSection('tone');
    } else if (mode === 'draw') {
        showSection('draw');
        drawInit();
    } else if (mode === 'habits') {
        showSection('habits');
        habitsRender();
    } else if (mode === 'texttools') {
        showSection('texttools');
    } else if (mode === 'gradient') {
        showSection('gradient');
        gradUpdate();
    } else if (mode === 'sandbox') {
        showSection('sandbox');
    } else if (mode === 'regex') {
        showSection('regex');
    } else if (mode === 'wheel') {
        showSection('wheel');
        wheelDraw();
    } else if (mode === 'hash') {
        showSection('hash');
    } else if (mode === 'typing') {
        showSection('typing');
        typingReset();
    } else if (mode === 'camera') {
        showSection('camera');
        cameraStart();
    } else if (mode === 'countdown') {
        showSection('countdown');
    } else if (mode === 'metronome') {
        showSection('metronome');
        metroInit();
    } else if (mode === 'snake') {
        showSection('snake'); initSnake();
    } else if (mode === 'tictactoe') {
        showSection('tictactoe'); initTictactoe();
    } else if (mode === 'memory2') {
        showSection('memory2'); initMemory2();
    } else if (mode === 'bmi') {
        showSection('bmi'); initBmi();
    } else if (mode === 'tip') {
        showSection('tip'); initTip();
    } else if (mode === 'morse') {
        showSection('morse'); initMorse();
    } else if (mode === 'caesar') {
        showSection('caesar'); initCaesar();
    } else if (mode === 'uuid') {
        showSection('uuid'); initUuid();
    } else if (mode === 'boxshadow') {
        showSection('boxshadow'); initBoxshadow();
    } else if (mode === 'httpstatus') {
        showSection('httpstatus'); initHttpstatus();
    } else if (mode === 'pomodoro') {
        showSection('pomodoro'); initPomodoro();
    } else if (mode === 'kanban') {
        showSection('kanban'); initKanban();
    } else if (mode === 'eightball') {
        showSection('eightball'); initEightball();
    } else if (mode === 'jokegen') {
        showSection('jokegen'); initJokegen();
    } else if (mode === 'breathe') {
        showSection('breathe'); initBreathe();
    } else if (mode === 'sudoku') {
        showSection('sudoku'); initSudoku();
    } else if (mode === 'hangman') {
        showSection('hangman'); initHangman();
    } else if (mode === '2048') {
        showSection('2048'); init2048();
    } else if (mode === 'reaction') {
        showSection('reaction'); initReaction();
    } else if (mode === 'interest') {
        showSection('interest'); initInterest();
    } else if (mode === 'quote') {
        showSection('quote'); initQuote();
    } else if (mode === 'dice') {
        showSection('dice'); initDice();
    } else if (mode === 'mood') {
        showSection('mood'); initMood();
    } else if (mode === 'grades') {
        showSection('grades'); initGrades();
    } else if (mode === 'worldclock') {
        showSection('worldclock'); initWorldclock();
    } else if (mode === 'pong') {
        showSection('pong'); initPong();
    } else if (mode === 'pwdcheck') {
        showSection('pwdcheck'); initPwdcheck();
    } else if (mode === 'agecalc') {
        showSection('agecalc'); initAgecalc();
    } else if (mode === 'calendar') {
        showSection('calendar'); initCalendar();
    } else if (mode === 'wordle') {
        showSection('wordle'); initWordle();
    } else if (mode === 'breakout') {
        showSection('breakout'); initBreakout();
    } else if (mode === 'colorquiz') {
        showSection('colorquiz'); initColorquiz();
    } else if (mode === 'numguess') {
        showSection('numguess'); initNumguess();
    } else if (mode === 'birthday') {
        showSection('birthday'); initBirthday();
    } else if (mode === 'minesweeper') {
        showSection('minesweeper'); initMinesweeper();
    } else if (MINI_TOOL_MODES.has(mode)) {
        showSection('mini-tools');
        initMiniTool(mode);
    } else {
        showSection('mode-select');
    }
}



// WMO weather code -> icon + description (Open-Meteo)
function weatherCodeInfo(code) {
    const map = {
        0:  ['&#9728;&#65039;', 'Klarer Himmel'],
        1:  ['&#127780;&#65039;', '\u00dcberwiegend klar'],
        2:  ['&#9925;', 'Teilweise bew\u00f6lkt'],
        3:  ['&#9729;&#65039;', 'Bedeckt'],
        45: ['&#127787;&#65039;', 'Nebel'],
        48: ['&#127787;&#65039;', 'Gefrierender Nebel'],
        51: ['&#127782;&#65039;', 'Leichter Nieselregen'],
        53: ['&#127782;&#65039;', 'Nieselregen'],
        55: ['&#127783;&#65039;', 'Starker Nieselregen'],
        61: ['&#127783;&#65039;', 'Leichter Regen'],
        63: ['&#127783;&#65039;', 'Regen'],
        65: ['&#127783;&#65039;', 'Starker Regen'],
        71: ['&#127784;&#65039;', 'Leichter Schneefall'],
        73: ['&#127784;&#65039;', 'Schneefall'],
        75: ['&#10052;&#65039;', 'Starker Schneefall'],
        77: ['&#127784;&#65039;', 'Schneek\u00f6rner'],
        80: ['&#127782;&#65039;', 'Leichte Schauer'],
        81: ['&#127783;&#65039;', 'Schauer'],
        82: ['&#9928;&#65039;', 'Starke Schauer'],
        85: ['&#127784;&#65039;', 'Schneeschauer'],
        86: ['&#10052;&#65039;', 'Starke Schneeschauer'],
        95: ['&#9928;&#65039;', 'Gewitter'],
        96: ['&#9928;&#65039;', 'Gewitter mit Hagel'],
        99: ['&#9928;&#65039;', 'Gewitter mit starkem Hagel'],
    };
    return map[code] || ['&#127777;&#65039;', `Wetter-Code ${code}`];
}

async function runWeatherSearch() {
    const input = document.getElementById('weatherCityInput');
    const status = document.getElementById('weatherStatus');
    const result = document.getElementById('weatherResult');
    const city = (input?.value || '').trim();

    if (!city) {
        status.textContent = 'Bitte einen Ort eingeben.';
        return;
    }

    status.textContent = 'Suche Ort...';
    result.innerHTML = '';

    try {
        // 1. Geocoding (kein API key needed)
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de&format=json`);
        const geoData = await geoRes.json();

        if (!geoData.results?.length) {
            status.textContent = `Ort "${city}" nicht gefunden.`;
            return;
        }

        const { latitude, longitude, name, country, admin1 } = geoData.results[0];
        status.textContent = 'Lade Wetterdaten...';

        // 2. Weather data (no API key needed)
        const weatherRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
            `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,visibility` +
            `&wind_speed_unit=kmh&timezone=auto`
        );
        const weatherData = await weatherRes.json();
        const cur = weatherData.current;

        status.textContent = '';

        const temp      = Math.round(cur.temperature_2m);
        const feels     = Math.round(cur.apparent_temperature);
        const humidity  = cur.relative_humidity_2m;
        const wind      = Math.round(cur.wind_speed_10m);
        const visKm     = cur.visibility != null ? `${Math.round(cur.visibility / 1000)} km` : '-';
        const [icon, desc] = weatherCodeInfo(cur.weather_code);
        const location  = [name, admin1, country].filter(Boolean).join(', ');

        result.innerHTML = `
            <div class="weather-card">
                <div class="weather-card-city">${escapeHtml(name)}</div>
                <div class="weather-card-country">${escapeHtml([admin1, country].filter(Boolean).join(', '))}</div>
                <div class="weather-card-icon" style="font-size:5rem;line-height:1">${icon}</div>
                <div class="weather-card-desc">${escapeHtml(desc)}</div>
                <div class="weather-card-temp">${temp}&deg;C</div>
                <div class="weather-card-feels">Gef&uuml;hlt wie ${feels}&deg;C</div>
                <div class="weather-card-stats">
                    <div class="weather-stat">
                        <span class="weather-stat-label">Luftfeucht.</span>
                        <span class="weather-stat-value">${humidity}%</span>
                    </div>
                    <div class="weather-stat">
                        <span class="weather-stat-label">Wind</span>
                        <span class="weather-stat-value">${wind} km/h</span>
                    </div>
                    <div class="weather-stat">
                        <span class="weather-stat-label">Sichtweite</span>
                        <span class="weather-stat-value">${visKm}</span>
                    </div>
                </div>
            </div>`;
    } catch (err) {
        status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.';
    }
}

// ─── 3D Earth Flight ──────────────────────────
let earth3dState = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    phase: 0,
    drift: 0,
    rotationY: 0,
    wallpaper: null,
    ready: false,
    rafId: null
};

function getEarth3DMapKey() {
    return localStorage.getItem('ehoserEarth3DMapKey') || window.__ENV__?.googleMapsApiKey || '';
}

function updateEarth3DMapKeyState() {
    const keyState = document.getElementById('earth3dMapKeyState');
    const input = document.getElementById('earth3dMapKeyInput');
    const key = getEarth3DMapKey();
    if (keyState) keyState.textContent = key ? 'aktiv' : 'nicht konfiguriert';
    if (input && !input.value) input.value = key;
}

function saveEarth3DMapKey() {
    const input = document.getElementById('earth3dMapKeyInput');
    const key = String(input?.value || '').trim();
    if (key) {
        localStorage.setItem('ehoserEarth3DMapKey', key);
    } else {
        localStorage.removeItem('ehoserEarth3DMapKey');
    }
    updateEarth3DMapKeyState();
    loadEarth3DMapTexture();
    if (document.getElementById('earth3dCanvas')) initEarth3DScene();
}

function loadEarth3DMapTexture() {
    const key = getEarth3DMapKey();
    if (!key) {
        earth3dState.wallpaper = null;
        earth3dState.ready = false;
        return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        earth3dState.wallpaper = img;
        earth3dState.ready = true;
    };
    img.onerror = () => {
        earth3dState.wallpaper = null;
        earth3dState.ready = false;
    };
    img.src = `https://maps.googleapis.com/maps/api/staticmap?center=0,0&zoom=2&size=1200x700&maptype=satellite&scale=2&key=${encodeURIComponent(key)}`;
}

function resizeEarth3DCanvas() {
    const canvas = document.getElementById('earth3dCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(900, Math.round(rect.width * ratio));
    canvas.height = Math.max(500, Math.round(rect.height * ratio));
    earth3dState.width = canvas.width;
    earth3dState.height = canvas.height;
}

function drawEarth3DScene() {
    const { ctx, width, height } = earth3dState;
    if (!ctx) return;

    const cx = width * 0.52;
    const cy = height * 0.54;
    const radius = Math.min(width, height) * 0.32;

    ctx.clearRect(0, 0, width, height);

    const bg = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, Math.max(width, height) * 0.7);
    bg.addColorStop(0, '#0b2334');
    bg.addColorStop(0.35, '#0d1d2b');
    bg.addColorStop(1, '#020b14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 90; i++) {
        const x = (i * 173.1) % width;
        const y = (i * 91.4 + (earth3dState.phase * 18)) % height;
        const alpha = 0.15 + ((i % 7) / 12);
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.fillRect(x, y, 2, 2);
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(earth3dState.rotationY);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();

    const globeGrad = ctx.createRadialGradient(-radius * 0.35, -radius * 0.45, radius * 0.2, 0, 0, radius);
    globeGrad.addColorStop(0, '#66e0ff');
    globeGrad.addColorStop(0.25, '#1d7fe8');
    globeGrad.addColorStop(0.6, '#0b4f7d');
    globeGrad.addColorStop(1, '#071a2b');
    ctx.fillStyle = globeGrad;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);

    if (earth3dState.wallpaper) {
        ctx.globalAlpha = 0.9;
        ctx.drawImage(earth3dState.wallpaper, -radius, -radius, radius * 2, radius * 2);
    } else {
        ctx.fillStyle = 'rgba(27, 141, 118, 0.7)';
        ctx.beginPath();
        ctx.moveTo(-radius * 0.9, -radius * 0.2);
        ctx.bezierCurveTo(-radius * 0.5, -radius * 0.7, -radius * 0.1, -radius * 0.4, radius * 0.15, -radius * 0.5);
        ctx.bezierCurveTo(radius * 0.6, -radius * 0.6, radius * 0.9, -radius * 0.1, radius * 0.7, radius * 0.15);
        ctx.bezierCurveTo(radius * 0.45, radius * 0.55, radius * 0.05, radius * 0.7, -radius * 0.15, radius * 0.5);
        ctx.bezierCurveTo(-radius * 0.5, radius * 0.45, -radius * 0.95, radius * 0.1, -radius * 0.9, -radius * 0.2);
        ctx.fill();
    }

    ctx.strokeStyle = 'rgba(135, 240, 255, 0.45)';
    ctx.lineWidth = 1.1;
    for (let lat = -4; lat <= 4; lat++) {
        ctx.beginPath();
        for (let lon = -180; lon <= 180; lon += 8) {
            const x = Math.sin((lon * Math.PI) / 180) * radius * (0.75 + (lat / 12));
            const y = Math.cos((lon * Math.PI) / 180) * radius * (0.75 + (lat / 12));
            if (lon === -180) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    for (let lon = -7; lon <= 7; lon++) {
        ctx.beginPath();
        for (let lat = -90; lat <= 90; lat += 10) {
            const x = Math.sin((lon * Math.PI) / 180) * radius * Math.cos((lat * Math.PI) / 180);
            const y = Math.cos((lon * Math.PI) / 180) * radius * Math.cos((lat * Math.PI) / 180);
            if (lat === -90) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius + 18, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(130, 214, 255, 0.72)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-earth3dState.rotationY * 1.15);
    ctx.beginPath();
    for (let i = 0; i <= 90; i++) {
        const t = (i / 90) * Math.PI * 2;
        const x = Math.cos(t) * (radius + 40 + Math.sin(earth3dState.phase + t * 3) * 12);
        const y = Math.sin(t) * (radius + 40 + Math.sin(earth3dState.phase + t * 3) * 12);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(14, 240, 208, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '600 14px Outfit, sans-serif';
    ctx.fillText('3D Earth Flight', 28, 34);
    ctx.fillStyle = 'rgba(162, 210, 232, 0.82)';
    ctx.font = '500 12px Outfit, sans-serif';
    ctx.fillText(getEarth3DMapKey() ? 'Live Map Texture aktiv' : 'Canvas-Erdansicht aktiv', 28, 56);
}

function animateEarth3D() {
    const canvas = document.getElementById('earth3dCanvas');
    if (!canvas) return;

    earth3dState.phase += 0.008;
    earth3dState.rotationY += 0.005;
    earth3dState.drift = Math.sin(earth3dState.phase * 1.8) * 22;
    drawEarth3DScene();
    earth3dState.rafId = requestAnimationFrame(animateEarth3D);
}

function initEarth3DScene() {
    const canvas = document.getElementById('earth3dCanvas');
    if (!canvas) return;
    earth3dState.canvas = canvas;
    earth3dState.ctx = canvas.getContext('2d');
    resizeEarth3DCanvas();
    updateEarth3DMapKeyState();
    loadEarth3DMapTexture();
    if (earth3dState.rafId) cancelAnimationFrame(earth3dState.rafId);
    animateEarth3D();
}

function resetEarth3DView() {
    earth3dState.phase = 0;
    earth3dState.rotationY = 0;
    earth3dState.drift = 0;
    drawEarth3DScene();
}

async function toggleEarth3DFullscreen() {
    const viewport = document.getElementById('earth3dViewport');
    if (!viewport) return;

    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
            return;
        }
        await viewport.requestFullscreen();
    } catch {
        showAlert('Vollbild konnte nicht gestartet werden. Probiere es erneut.', 'info');
    }
}

// ─── Karte (Leaflet + OpenStreetMap + Nominatim) ──────────────────────────────
let _map = null;
let _mapNormalLayer = null;
let _mapSatLayer = null;
let _mapCurrentLayer = 'normal';
let _mapSearchTimer = null;

function initMap() {
    if (_map) {
        _map.invalidateSize();
        return;
    }
    _map = window.L?.map('mapContainer', { zoomControl: true, attributionControl: true })
        .setView([51.1657, 10.4515], 6);
    if (!_map) return;

    _mapNormalLayer = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    });
    _mapSatLayer = window.L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri',
        maxZoom: 19
    });
    _mapNormalLayer.addTo(_map);

    // Dropdown schließen bei Klick auf Karte
    _map.on('click', closeMapDropdown);
}

function setMapLayer(type) {
    if (!_map) return;
    if (type === 'satellite' && _mapCurrentLayer !== 'satellite') {
        _map.removeLayer(_mapNormalLayer);
        _mapSatLayer.addTo(_map);
        _mapCurrentLayer = 'satellite';
        document.getElementById('mapLayerNormalBtn')?.classList.remove('active');
        document.getElementById('mapLayerSatBtn')?.classList.add('active');
    } else if (type === 'normal' && _mapCurrentLayer !== 'normal') {
        _map.removeLayer(_mapSatLayer);
        _mapNormalLayer.addTo(_map);
        _mapCurrentLayer = 'normal';
        document.getElementById('mapLayerSatBtn')?.classList.remove('active');
        document.getElementById('mapLayerNormalBtn')?.classList.add('active');
    }
}

function onMapSearchInput() {
    const val = document.getElementById('mapSearchInput')?.value.trim() || '';
    const dropdown = document.getElementById('mapSearchDropdown');
    clearTimeout(_mapSearchTimer);

    if (val.length < 2) {
        closeMapDropdown();
        return;
    }

    _mapSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=7&addressdetails=1&accept-language=de`,
                { headers: { 'Accept': 'application/json' } }
            );
            const results = await res.json();
            if (!dropdown) return;

            if (!results.length) {
                dropdown.innerHTML = '<div class="map-search-item map-search-empty">Kein Ergebnis gefunden</div>';
                dropdown.style.display = 'block';
                return;
            }

            dropdown.innerHTML = '';
            results.forEach(r => {
                const item = document.createElement('div');
                item.className = 'map-search-item';
                item.textContent = r.display_name;
                item.dataset.lat = r.lat;
                item.dataset.lon = r.lon;
                item.dataset.name = r.display_name;
                item.addEventListener('click', () => goToMapResult(item.dataset.lat, item.dataset.lon, item.dataset.name));
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'block';
        } catch {
            closeMapDropdown();
        }
    }, 280);
}

function closeMapDropdown() {
    const d = document.getElementById('mapSearchDropdown');
    if (d) { d.innerHTML = ''; d.style.display = 'none'; }
}

function goToMapResult(lat, lon, name) {
    if (!_map) return;
    _map.setView([parseFloat(lat), parseFloat(lon)], 14);
    closeMapDropdown();
    const input = document.getElementById('mapSearchInput');
    if (input) input.value = name.split(',')[0].trim();
}

// Dropdown schließen bei Klick außerhalb
document.addEventListener('click', (e) => {
    const wrap = document.getElementById('mapSearchInput')?.closest('.map-search-wrap');
    if (wrap && !wrap.contains(e.target)) closeMapDropdown();
});

// --- Nachrichten (NewsAPI via Backend-Proxy) ---
let _newsCat = 'top';

async function newsLoad(cat) {
    _newsCat = cat || _newsCat;
    const tabMap = { top:'Top', technology:'Tech', science:'Sci', business:'Biz', sports:'Sport', entertainment:'Ent', health:'Health' };
    Object.keys(tabMap).forEach(c => {
        document.getElementById('newsTab' + tabMap[c])?.classList.toggle('active', c === _newsCat);
    });
    const status = document.getElementById('newsStatus');
    const grid   = document.getElementById('newsGrid');
    if (status) status.textContent = 'Nachrichten werden geladen...';
    if (grid)   grid.innerHTML = '';
    try {
        const res  = await fetch(`${API_BASE}/news?cat=${encodeURIComponent(_newsCat)}`);
        if (!res.ok) { const err = await res.json().catch(()=>({})); if (status) status.textContent = 'Fehler: ' + (err.error || res.statusText); return; }
        const data = await res.json();
        if (!data.articles?.length) { if (status) status.textContent = 'Keine Artikel gefunden.'; return; }
        if (status) status.textContent = '';
        if (grid)   grid.innerHTML = data.articles.map(newsCard).join('');
    } catch (e) { if (status) status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.'; }
}

async function newsSearch() {
    const q = document.getElementById('newsSearchInput')?.value.trim();
    if (!q) return newsLoad(_newsCat);
    const tabMap = { top:'Top', technology:'Tech', science:'Sci', business:'Biz', sports:'Sport', entertainment:'Ent', health:'Health' };
    Object.keys(tabMap).forEach(c => document.getElementById('newsTab' + tabMap[c])?.classList.remove('active'));
    const status = document.getElementById('newsStatus');
    const grid   = document.getElementById('newsGrid');
    if (status) status.textContent = 'Suche laeuft...';
    if (grid)   grid.innerHTML = '';
    try {
        const res  = await fetch(`${API_BASE}/news?q=${encodeURIComponent(q)}`);
        if (!res.ok) { const err = await res.json().catch(()=>({})); if (status) status.textContent = 'Fehler: ' + (err.error || res.statusText); return; }
        const data = await res.json();
        if (!data.articles?.length) { if (status) status.textContent = 'Keine Artikel gefunden.'; return; }
        if (status) status.textContent = '';
        if (grid)   grid.innerHTML = data.articles.map(newsCard).join('');
    } catch (e) { if (status) status.textContent = 'Verbindungsfehler.'; }
}

function newsSetCat(cat) {
    const inp = document.getElementById('newsSearchInput');
    if (inp) inp.value = '';
    newsLoad(cat);
}

function newsCard(a) {
    const title = escapeHtml(a.title || 'Kein Titel');
    const desc  = escapeHtml((a.description || '').slice(0, 130)) + (a.description && a.description.length > 130 ? '...' : '');
    const src   = escapeHtml(a.source?.name || '');
    const img   = a.urlToImage || '';
    const url   = a.url || '#';
    const date  = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString('de-DE', { day:'2-digit', month:'short', year:'numeric' }) : '';
    return `
        <a class="news-card" href="${url}" target="_blank" rel="noopener noreferrer">
            ${img ? `<div class="news-thumb" style="background-image:url('${img}')"></div>` : '<div class="news-thumb news-thumb-empty">newspaper</div>'}
            <div class="news-card-body">
                <div class="news-card-meta"><span class="news-source">${src}</span>${date ? `<span class="news-date">${date}</span>` : ''}</div>
                <div class="news-card-title">${title}</div>
                <div class="news-card-desc">${desc}</div>
            </div>
        </a>`;
}

// ─── YouTube (YouTube Data API v3) ────────────────────────────────────────────
let _ytType = 'video';
let _ytNextPageToken = null;
let _ytPrevPageToken = null;
let _ytLastQuery = '';

function setYTType(type) {
    _ytType = type;
    ['video', 'playlist', 'channel'].forEach(t => {
        const btn = document.getElementById('ytTab' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.classList.toggle('active', t === type);
    });
    if (_ytLastQuery) runYTSearch();
}

async function runYTSearch(pageToken) {
    const query = document.getElementById('ytSearchInput')?.value.trim();
    if (!query) return;
    _ytLastQuery = query;

    const status = document.getElementById('ytStatus');
    const results = document.getElementById('ytResults');
    const pagination = document.getElementById('ytPagination');
    if (status) status.textContent = 'Suche läuft…';
    if (results) results.innerHTML = '';
    if (pagination) pagination.innerHTML = '';
    closeYTPlayer();

    try {
        let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=${_ytType}&maxResults=12&key=${window.__ENV__?.ytApiKey || ''}&safeSearch=moderate`;
        if (pageToken) url += `&pageToken=${pageToken}`;

        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            status.textContent = 'Fehler: ' + (err?.error?.message || res.statusText);
            return;
        }
        const data = await res.json();
        _ytNextPageToken = data.nextPageToken || null;
        _ytPrevPageToken = data.prevPageToken || null;

        if (!data.items?.length) {
            status.textContent = 'Keine Ergebnisse gefunden.';
            return;
        }

        status.textContent = '';
        if (results) results.innerHTML = data.items.map(item => buildYTCard(item)).join('');

        // Pagination
        if (pagination && (_ytPrevPageToken || _ytNextPageToken)) {
            pagination.innerHTML = `
                ${_ytPrevPageToken ? `<button class="yt-page-btn" onclick="runYTSearch('${_ytPrevPageToken}')">← Zurück</button>` : ''}
                ${_ytNextPageToken ? `<button class="yt-page-btn" onclick="runYTSearch('${_ytNextPageToken}')">Weiter →</button>` : ''}
            `;
        }

        // Scroll to results
        document.getElementById('ytResults')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        if (status) status.textContent = 'Verbindungsfehler. Bitte versuche es erneut.';
    }
}

function buildYTCard(item) {
    const kind = item.id.kind; // youtube#video, youtube#playlist, youtube#channel
    const thumb = item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '';
    const title = escapeHtml(item.snippet.title);
    const sub = escapeHtml(item.snippet.channelTitle || item.snippet.description || '');

    let id, onclickAttr, badge, playOverlay;

    if (kind === 'youtube#video') {
        id = item.id.videoId;
        onclickAttr = `openYTPlayer('${id}', this.querySelector('.yt-card-title').textContent, 'video')`;
        badge = '▶ Video';
        playOverlay = `<div class="yt-play-overlay"><div class="yt-play-icon">▶</div></div>`;
    } else if (kind === 'youtube#playlist') {
        id = item.id.playlistId;
        onclickAttr = `openYTPlayer('${id}', this.querySelector('.yt-card-title').textContent, 'playlist')`;
        badge = '📋 Playlist';
        playOverlay = `<div class="yt-play-overlay"><div class="yt-play-icon">▶</div></div>`;
    } else {
        id = item.id.channelId;
        onclickAttr = `window.open('https://www.youtube.com/channel/${id}','_blank')`;
        badge = '📺 Kanal';
        playOverlay = '';
    }

    return `
        <div class="yt-card" onclick="${onclickAttr}">
            <div class="yt-thumb-wrap">
                ${thumb ? `<img class="yt-thumb" src="${thumb}" alt="" loading="lazy">` : ''}
                ${playOverlay}
            </div>
            <div class="yt-card-body">
                <div class="yt-card-title">${title}</div>
                <div class="yt-card-sub">${sub}</div>
                <span class="yt-card-type-badge">${badge}</span>
            </div>
        </div>`;
}

function openYTPlayer(id, title, type) {
    const wrap = document.getElementById('ytPlayerWrap');
    const iframe = document.getElementById('ytIframe');
    const titleEl = document.getElementById('ytPlayerTitle');
    if (!wrap || !iframe) return;

    let src;
    if (type === 'playlist') {
        src = `https://www.youtube-nocookie.com/embed/videoseries?list=${id}&autoplay=1`;
    } else {
        src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    }

    iframe.src = src;
    if (titleEl) titleEl.textContent = title;
    wrap.style.display = 'block';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeYTPlayer() {
    const wrap = document.getElementById('ytPlayerWrap');
    const iframe = document.getElementById('ytIframe');
    if (iframe) iframe.src = '';
    if (wrap) wrap.style.display = 'none';
}

// ─── KI Chat (Groq – Llama 3.3 70B) ──────────────────────────────────────────
// API Key liegt serverseitig in GROQ_API_KEY (Vercel Environment Variable)
let _kiHistory = []; // { role: 'user'|'assistant'|'system', content: string }
let _kiAttachment = null; // { type: 'image'|'text', data: string, name: string }
let _kiModel = 'ehoser1';
let _pendingVideoRequest = null;

function updateKIModelAccessUI() {
    const premiumBtn = document.getElementById('kiModelPremium');
    if (!premiumBtn) return;
    const unlocked = hasPremiumAccess();
    premiumBtn.classList.toggle('locked', !unlocked);
    premiumBtn.setAttribute('aria-disabled', unlocked ? 'false' : 'true');
    premiumBtn.title = unlocked ? 'Premium Ehoser ist freigeschaltet.' : 'Nur mit Premium. PRO und Gratis sehen hier ein Schloss.';
    premiumBtn.textContent = unlocked ? 'Premium Ehoser' : 'Premium Ehoser 🔒';
}

const KI_SYSTEM_PROMPT = `Du bist ehoser KI, ein freundlicher und sympathischer KI-Assistent, der exklusiv auf den Servern von ehoser läuft. ehoser ist eine private Plattform mit Spielen, Chat und weiteren Features.
Deine Persönlichkeit ist locker, nett und ein kleines bisschen charmant – aber nicht übertrieben. Keine Kosenamen wie "Schatz" oder "Süße". Sprich den Nutzer normal aber herzlich an.
Wenn du den Nutzer persönlich ansprechen möchtest, schreibe ausschließlich [name] anstelle des echten Namens (zum Beispiel: "Hey [name], wie kann ich helfen?"). Verwende niemals den echten Namen direkt.
Antworte IMMER ausschließlich auf Deutsch, egal in welcher Sprache der Nutzer schreibt. Keine Ausnahmen.
Halte deine Antworten kurz und knapp – maximal 3-4 Sätze.
Du kannst Bilder generieren! Wenn der Nutzer ein Bild möchte, antworte mit: BILD_GENERIEREN: [englischer Bildprompt]. Dieser Befehl wird automatisch erkannt und ein Bild erstellt.
Du kannst auch Videos generieren! Wenn der Nutzer ein Video möchte, antworte mit: VIDEO_GENERIEREN: [englischer Videoprompt]. Dieser Befehl wird automatisch erkannt und ein Video erstellt.`;

function startKIWithName() {
    const input = document.getElementById('kiNameInput');
    const name = (input?.value || '').trim();
    if (!name) {
        input?.focus();
        return;
    }
    sessionStorage.setItem('kiUserName', name);
    showKIChat();
}

function showKIChat() {
    const name = sessionStorage.getItem('kiUserName') || 'Nutzer';
    document.getElementById('kiNameModal').style.display = 'none';
    document.getElementById('kiChatWrapper').style.display = 'flex';

    // Anhang-Button nur für PRO sichtbar
    const attachBtn = document.getElementById('kiAttachBtn');
    if (attachBtn) attachBtn.style.display = localStorage.getItem('proStatus') === '1' ? 'flex' : 'none';

    // Nur beim ersten Mal initialisieren
    if (_kiHistory.length === 0) {
        _kiHistory = [{ role: 'system', content: KI_SYSTEM_PROMPT }];
        const greeting = kiReplaceNamePlaceholder(`Hallo, [name]! 👋 Ich bin ehoser KI, dein persönlicher Assistent auf dem ehoser Server. Wie kann ich dir heute helfen?`);
        appendKIBubble('ai', greeting);
    }
    updateKIModelAccessUI();
    setKIModel(_kiModel);
    setTimeout(() => document.getElementById('kiInput')?.focus(), 50);
}

function kiHandleFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        showAlert('Datei zu groß (max. 4 MB).', 'error');
        event.target.value = '';
        return;
    }
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onload = (e) => {
        _kiAttachment = { type: isImage ? 'image' : 'text', data: e.target.result, name: file.name };
        document.getElementById('kiAttachPreview').style.display = 'flex';
        document.getElementById('kiAttachName').textContent = '📁 ' + file.name;
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
    event.target.value = '';
}

function kiClearAttachment() {
    _kiAttachment = null;
    const preview = document.getElementById('kiAttachPreview');
    if (preview) preview.style.display = 'none';
    const name = document.getElementById('kiAttachName');
    if (name) name.textContent = '';
}

function kiReplaceNamePlaceholder(text) {
    const name = sessionStorage.getItem('kiUserName') || '';
    return name ? text.replace(/\[name\]/gi, name) : text;
}

function setKIModel(model) {
    updateKIModelAccessUI();
    if (model === 'premium' && !hasPremiumAccess()) {
        _kiModel = 'ehoser1';
        showAlert('Premium Ehoser ist nur mit Premium freigeschaltet. PRO enthält diese neue KI nicht.', 'error');
        model = 'ehoser1';
    }
    _kiModel = ['ehoser1', 'premium'].includes(model) ? model : 'ehoser1';
    const config = {
        ehoser1: {
            title: 'GPT-OSS 20B',
            placeholder: 'Stell eine Frage...',
            label: 'Offenes Sprachmodell'
        },
        premium: {
            title: 'Premium Ehoser',
            placeholder: 'Frag Premium Ehoser alles, was du wissen, planen oder erstellen willst...',
            label: 'GPT-5.4 Mini'
        }
    }[_kiModel];

    document.querySelectorAll('.ki-model-btn').forEach(btn => btn.classList.remove('active'));
    const activeId = _kiModel === 'ehoser1' ? 'kiModelEhoser1' : 'kiModelPremium';
    document.getElementById(activeId)?.classList.add('active');
    const title = document.getElementById('kiModelTitle');
    if (title) title.textContent = config.title;
    const input = document.getElementById('kiInput');
    if (input) input.placeholder = config.placeholder;
    const messages = document.getElementById('kiMessages');
    if (messages) messages.style.display = 'flex';
}

function appendKIBubble(type, text) {
    const messages = document.getElementById('kiMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = `ki-bubble ki-bubble-${type}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
}

function appendKIImageBubble(prompt, imageUrl) {
    const messages = document.getElementById('kiMessages');
    if (!messages) return;
    const div = document.createElement('div');
    div.className = 'ki-bubble ki-bubble-ai';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.8rem;color:#8ab4c9;margin-bottom:8px;';
    label.textContent = '\uD83C\uDFA8 Generiertes Bild: ' + prompt;
    div.appendChild(label);
    const loading = document.createElement('div');
    loading.style.cssText = 'color:#8ab4c9;font-size:0.9rem;padding:4px 0;';
    loading.textContent = '\u23F3 Bild wird generiert\u2026 (kann bis zu 30 Sekunden dauern)';
    div.appendChild(loading);
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = prompt;
    img.style.cssText = 'max-width:100%;border-radius:10px;display:none;cursor:pointer;margin-top:6px;';
    img.title = 'Klicken zum \u00D6ffnen in neuem Tab';
    img.onclick = () => window.open(imageUrl, '_blank', 'noopener');
    img.onload = () => {
        loading.remove();
        img.style.display = 'block';
        messages.scrollTop = messages.scrollHeight;
    };
    img.onerror = () => {
        loading.innerHTML = '\u274C Bild konnte nicht geladen werden. '
            + '<a href="' + imageUrl + '" target="_blank" rel="noopener" style="color:#8ab4c9;text-decoration:underline;">Direkt \u00F6ffnen</a>'
            + ' &nbsp;<button onclick="this.closest(\'.ki-bubble\').querySelector(\'img\').src=\'' + imageUrl + '?r=\'+Date.now()" '
            + 'style="background:#1e3a4a;color:#8ab4c9;border:1px solid #8ab4c9;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:0.8rem;">'
            + '\uD83D\uDD04 Erneut versuchen</button>';
    };
    div.appendChild(img);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function kiHandleImageGenCommand(reply) {
    const match = reply.match(/BILD_GENERIEREN:\s*(.+)/i);
    if (!match) return false;
    const prompt = match[1].trim().replace(/["']/g, '').slice(0, 500);
    const seed = Math.floor(Math.random() * 999999);
    // Direkt von Pollinations laden – kein Backend-Proxy, kein Vercel-Timeout
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
    const textBefore = reply.replace(/BILD_GENERIEREN:\s*.+/i, '').trim();
    if (textBefore) appendKIBubble('ai', kiReplaceNamePlaceholder(textBefore));
    appendKIImageBubble(prompt, url);
    return true;
}

function appendKIVideoBubble(prompt) {
    const messages = document.getElementById('kiMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = 'ki-bubble ki-bubble-ai';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.8rem;color:#8ab4c9;margin-bottom:8px;';
    label.textContent = '\uD83C\uDFAC Generiertes Video: ' + prompt;
    div.appendChild(label);
    const status = document.createElement('div');
    status.className = 'ki-video-status';
    status.style.cssText = 'color:#8ab4c9;font-size:0.9rem;padding:4px 0;';
    status.textContent = '\u23F3 Video wird generiert\u2026 (kann 1-3 Minuten dauern)';
    div.appendChild(status);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return { div, status };
}

function videoQualityLabel(quality) {
    return ({ low: 'niedrig', medium: 'mittel', high: 'hoch' })[quality] || 'mittel';
}

function videoCreditCost(seconds, quality) {
    const q = ({ low: 1, medium: 2, high: 3 })[quality] || 2;
    return Number(seconds) * 10 * q;
}

function parseVideoOptions(text) {
    const lower = String(text || '').toLowerCase();
    const quality = lower.includes('hoch') || lower.includes('beste') || lower.includes('high')
        ? 'high'
        : lower.includes('niedrig') || lower.includes('klein') || lower.includes('low')
            ? 'low'
            : lower.includes('mittel') || lower.includes('normal') || lower.includes('medium')
                ? 'medium'
                : null;
    const secMatch = lower.match(/(\d{1,2})\s*(sek|sec|s\b)/);
    const seconds = secMatch ? Math.min(12, Math.max(4, Number(secMatch[1]))) : null;
    return { quality, seconds: seconds ? (seconds <= 4 ? 4 : seconds <= 8 ? 8 : 12) : null };
}

function maybeStartVideoFlow(text) {
    if (!/(video|film|clip|sora)/i.test(text || '')) return false;
    if (!hasPremiumAccess()) {
        appendKIBubble('ai', 'Es tut mir leid, Video KI ist ab 20 Euro im Shop erhaeltlich. Oeffne oben deinen Tarif und waehle Premium.');
        return true;
    }
    _pendingVideoRequest = { prompt: text, step: 'details' };
    appendKIBubble('ai', 'Welche Qualitaet soll das Video haben: niedrig, mittel oder hoch? Und wie viele Sekunden: 4, 8 oder 12? Je hoeher die Qualitaet, desto mehr Credits kostet es.');
    return true;
}

function handlePendingVideoFlow(text) {
    if (!_pendingVideoRequest) return false;
    if (/abbrechen|stop|nein|cancel/i.test(text || '')) {
        _pendingVideoRequest = null;
        appendKIBubble('ai', 'Videovorgang abgelehnt.');
        return true;
    }
    if (_pendingVideoRequest.step === 'details') {
        const opts = parseVideoOptions(text);
        if (!opts.quality || !opts.seconds) {
            appendKIBubble('ai', 'Bitte schreibe Qualitaet und Sekunden dazu, zum Beispiel: "hoch 8 Sekunden".');
            return true;
        }
        const cost = videoCreditCost(opts.seconds, opts.quality);
        _pendingVideoRequest = { ..._pendingVideoRequest, ...opts, cost, step: 'confirm' };
        appendKIBubble('ai', `Das kostet ${cost} Credits (${videoQualityLabel(opts.quality)}, ${opts.seconds} Sekunden). Druecke Fortfahren zum Generieren oder Abbrechen.`);
        appendKIVideoConfirmButtons();
        return true;
    }
    return true;
}

function appendKIVideoConfirmButtons() {
    const messages = document.getElementById('kiMessages');
    if (!messages) return;
    const wrap = document.createElement('div');
    wrap.className = 'ki-bubble ki-bubble-ai';
    wrap.style.display = 'flex';
    wrap.style.gap = '8px';
    wrap.style.flexWrap = 'wrap';
    wrap.innerHTML = `
        <button class="btn-primary" onclick="confirmPendingVideoGeneration()">Fortfahren</button>
        <button class="btn-secondary" onclick="cancelPendingVideoGeneration()">Abbrechen</button>
    `;
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
}

function cancelPendingVideoGeneration() {
    _pendingVideoRequest = null;
    appendKIBubble('ai', 'Videovorgang abgelehnt.');
}

async function confirmPendingVideoGeneration() {
    if (!_pendingVideoRequest || _pendingVideoRequest.step !== 'confirm') return;
    const req = _pendingVideoRequest;
    _pendingVideoRequest = null;
    await kiStartVideoGeneration(req.prompt, req);
}

async function kiStartVideoGeneration(prompt, options = {}) {
    const bubble = appendKIVideoBubble(prompt);
    if (!bubble) return;
    const { div, status } = bubble;
    const messages = document.getElementById('kiMessages');
    try {
        const res = await fetch(`${API_BASE}/ki/video/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
            body: JSON.stringify({ prompt, quality: options.quality || 'medium', seconds: options.seconds || 4 })
        });

        if (!res.ok) {
            let error = 'Video-Generierung fehlgeschlagen';
            try {
                const data = await res.json();
                if (data?.error) error = data.error;
            } catch {
                try {
                    const text = await res.text();
                    if (text) error = text;
                } catch {}
            }
            status.textContent = '\u274C ' + error;
            await refreshCurrentProfile();
            return;
        }

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        status.remove();

        const video = document.createElement('video');
        video.src = objectUrl;
        video.controls = true;
        video.playsInline = true;
        video.style.cssText = 'max-width:100%;border-radius:10px;margin-top:6px;';

        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = 'ehoser-ki-video.mp4';
        link.style.cssText = 'display:block;font-size:0.8rem;color:#8ab4c9;margin-top:6px;text-decoration:underline;';
        link.textContent = '\u2B07\uFE0F Video herunterladen';

        div.appendChild(video);
        div.appendChild(link);
        if (messages) messages.scrollTop = messages.scrollHeight;
        await refreshCurrentProfile();
    } catch (err) {
        status.textContent = '\u274C Verbindungsfehler';
        await refreshCurrentProfile();
    }
}

function kiHandleVideoGenCommand(reply) {
    const match = reply.match(/VIDEO_GENERIEREN:\s*(.+)/i);
    if (!match) return false;
    const prompt = match[1].trim().replace(/["']/g, '').slice(0, 500);
    const textBefore = reply.replace(/VIDEO_GENERIEREN:\s*.+/i, '').trim();
    if (textBefore) appendKIBubble('ai', kiReplaceNamePlaceholder(textBefore));
    maybeStartVideoFlow(prompt);
    return true;
}

function showKITyping() {
    const messages = document.getElementById('kiMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = 'ki-bubble ki-bubble-ai ki-typing';
    div.id = 'kiTypingIndicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
}

async function sendKIMessage() {
    const input = document.getElementById('kiInput');
    const sendBtn = document.querySelector('.ki-send-btn');
    const text = input?.value.trim();
    const token = localStorage.getItem('token');
    if (!text && !_kiAttachment) return;
    if (_kiModel === 'premium' && !hasPremiumAccess()) {
        setKIModel('ehoser1');
        return;
    }
    if (!_kiAttachment && _pendingVideoRequest) {
        appendKIBubble('user', text);
        handlePendingVideoFlow(text);
        input.value = '';
        input?.focus();
        return;
    }
    if (!_kiAttachment && /(video|film|clip|sora)/i.test(text || '')) {
        appendKIBubble('user', text);
        maybeStartVideoFlow(text);
        input.value = '';
        input?.focus();
        return;
    }

    input.value = '';
    if (sendBtn) sendBtn.disabled = true;

    // ── Nachricht aufbauen ──────────────────────────────────────
    let apiMessage; // was an Groq geht (ggf. mit base64 Bild)
    let historyMsg; // was im Verlauf gespeichert wird (kein base64)

    if (_kiAttachment?.type === 'image') {
        // Bild-Bubble im Chat anzeigen
        const msgEl = document.getElementById('kiMessages');
        if (msgEl) {
            const bubble = document.createElement('div');
            bubble.className = 'ki-bubble ki-bubble-user';
            const img = document.createElement('img');
            img.src = _kiAttachment.data;
            img.className = 'ki-bubble-img';
            img.alt = _kiAttachment.name;
            bubble.appendChild(img);
            if (text) { const t = document.createElement('div'); t.style.marginTop='6px'; t.textContent = text; bubble.appendChild(t); }
            msgEl.appendChild(bubble);
            msgEl.scrollTop = msgEl.scrollHeight;
        }
        // Groq Vision Format
        apiMessage = { role: 'user', content: [
            { type: 'text', text: text || 'Was siehst du auf diesem Bild?' },
            { type: 'image_url', image_url: { url: _kiAttachment.data } }
        ]};
        historyMsg = { role: 'user', content: `[Bild: ${_kiAttachment.name}]${text ? ' – ' + text : ''}` };
    } else if (_kiAttachment?.type === 'text') {
        const combined = `Dateiinhalt (${_kiAttachment.name}):\n\`\`\`\n${_kiAttachment.data.slice(0, 8000)}\n\`\`\`${text ? '\n\n' + text : ''}`;
        // Zeige Datei-Badge + Text im Chat
        const msgEl = document.getElementById('kiMessages');
        if (msgEl) {
            const bubble = document.createElement('div');
            bubble.className = 'ki-bubble ki-bubble-user';
            const badge = document.createElement('div');
            badge.className = 'ki-bubble-file-badge';
            badge.textContent = '📄 ' + _kiAttachment.name;
            bubble.appendChild(badge);
            if (text) { const t = document.createElement('div'); t.style.marginTop='4px'; t.textContent = text; bubble.appendChild(t); }
            msgEl.appendChild(bubble);
            msgEl.scrollTop = msgEl.scrollHeight;
        }
        apiMessage = { role: 'user', content: combined };
        historyMsg = { role: 'user', content: combined };
    } else {
        appendKIBubble('user', text);
        apiMessage = { role: 'user', content: text };
        historyMsg = apiMessage;
    }

    kiClearAttachment();

    // Verlauf + API-Nachrichten aufbauen
    const historyForRequest = [..._kiHistory, apiMessage];
    _kiHistory.push(historyMsg);

    const typing = showKITyping();

    try {
        const res = await fetch(_kiModel === 'premium' ? `${API_BASE}/ki/premium` : `${API_BASE}/ki`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ messages: historyForRequest })
        });

        typing?.remove();

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err?.error?.message || err?.error || `Fehler ${res.status}`;
            appendKIBubble('error', '⚠️ ' + msg);
            _kiHistory.pop();
            await refreshCurrentProfile();
            return;
        }

        const data = await res.json();
        const rawReply = data?.choices?.[0]?.message?.content || '(Keine Antwort)';
        _kiHistory.push({ role: 'assistant', content: rawReply });
        if (!kiHandleVideoGenCommand(rawReply) && !kiHandleImageGenCommand(rawReply)) {
            const reply = kiReplaceNamePlaceholder(rawReply);
            appendKIBubble('ai', reply);
        }
        await refreshCurrentProfile();
    } catch (err) {
        typing?.remove();
        appendKIBubble('error', '⚠️ Verbindungsfehler. Bitte versuche es erneut.');
        _kiHistory.pop();
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        input?.focus();
    }
}

function clearKIChat() {
    kiClearAttachment();
    _kiHistory = [{ role: 'system', content: KI_SYSTEM_PROMPT }];
    const messages = document.getElementById('kiMessages');
    if (messages) messages.innerHTML = '';
    appendKIBubble('ai', kiReplaceNamePlaceholder('Verlauf geleert. 👋 Womit kann ich dir helfen, [name]?'));
    setKIModel(_kiModel);
}
function renderImageSearchResults(hits) {
    const grid = document.getElementById('imageSearchResults');
    if (!grid) return;

    if (!Array.isArray(hits) || !hits.length) {
        grid.innerHTML = '<div class="games-loading">Keine Bilder gefunden.</div>';
        return;
    }

    grid.innerHTML = hits.map((hit) => {
        const preview = escapeAttribute(hit.webformatURL || hit.previewURL || '');
        const pageUrl = escapeAttribute(hit.pageURL || '');
        const tags = escapeHtml(hit.tags || 'Bild');
        const author = escapeHtml(hit.user || 'Unbekannt');
        return `
            <article class="image-result-card">
                <a href="${pageUrl}" target="_blank" rel="noopener noreferrer" class="image-result-link">
                    <img src="${preview}" alt="${tags}" loading="lazy" class="image-result-thumb">
                </a>
                <div class="image-result-meta">
                    <div class="image-result-tags">${tags}</div>
                    <div class="image-result-user">von ${author}</div>
                </div>
            </article>
        `;
    }).join('');
}

async function runImageSearch() {
    const input = document.getElementById('imageSearchInput');
    const status = document.getElementById('imageSearchStatus');
    const grid = document.getElementById('imageSearchResults');
    const token = localStorage.getItem('token');

    if (!token && !isAdminGuestPreview()) {
        showAlert('Bitte zuerst anmelden, um die Bildersuche zu nutzen.', 'error');
        showSection('auth');
        return;
    }

    const q = (input?.value || '').trim();
    if (!q) {
        status.textContent = 'Bitte Suchwort eingeben.';
        return;
    }

    imageSearchLastQuery = q;
    status.textContent = 'Suche läuft...';
    if (grid) grid.innerHTML = '<div class="games-loading">Bilder werden geladen…</div>';

    try {
        const params = new URLSearchParams({ q });
        const response = await fetch(`${API_BASE}/pixabay?${params.toString()}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const data = await response.json();

        if (!response.ok) {
            status.textContent = `Fehler: ${data.error || 'Suche fehlgeschlagen.'}`;
            if (grid) grid.innerHTML = '';
            return;
        }

        const hits = Array.isArray(data.hits) ? data.hits : [];
        status.textContent = `${hits.length} Treffer für "${q}"`;
        renderImageSearchResults(hits);
    } catch {
        status.textContent = 'Verbindungsfehler bei der Bildersuche.';
        if (grid) grid.innerHTML = '';
    }
}

async function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('proStatus');
    clearDesktopActivated();
    await clearDesktopAuthToken();
    sessionStorage.removeItem('adminGuestPreview');
    sessionStorage.removeItem('intro_shown');
    currentUser = null;
    currentProfile = null;
    allApps = [];
    stopOnlinePolling();
    stopResetStatusPolling();
    showLoggedOutUI();
    showSection('auth');
}

let onlineInterval = null;
let heartbeatInterval = null;
const guestId = localStorage.getItem('guestId') || `guest-${cryptoRandom()}`;
localStorage.setItem('guestId', guestId);

function cryptoRandom() {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function startOnlinePolling() {
    clearInterval(onlineInterval);
    clearInterval(heartbeatInterval);
    fetchOnlineUsers();
    onlineInterval = setInterval(fetchOnlineUsers, 30000);
    heartbeatInterval = setInterval(sendHeartbeat, 60000);
    if (localStorage.getItem('token')) startScreenSharePolling();
}

function stopOnlinePolling() {
    clearInterval(onlineInterval);
    clearInterval(heartbeatInterval);
    stopScreenSharePolling();
}

async function sendHeartbeat() {
    const token = localStorage.getItem('token');
    if (token) {
        fetch(`${API_BASE}/heartbeat`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        }).catch(() => {});
        return;
    }
    fetch(`${API_BASE}/guest-heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId })
    }).catch(() => {});
}

async function fetchOnlineUsers() {
    const token = localStorage.getItem('token');
    try {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/online-users`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        const users = Array.isArray(data) ? data : (data.users || []);
        const widget = document.getElementById('onlineWidget');
        const list = document.getElementById('onlineList');
        widget.style.display = '';
        // Double-click to hide/show the online widget (persisted)
        try {
            if (widget && !widget._dblInit) {
                widget.ondblclick = () => {
                    const hidden = localStorage.getItem('onlineWidgetHidden') === '1';
                    if (hidden) {
                        widget.classList.remove('hidden-by-dbl');
                        localStorage.removeItem('onlineWidgetHidden');
                    } else {
                        widget.classList.add('hidden-by-dbl');
                        localStorage.setItem('onlineWidgetHidden','1');
                    }
                };
                widget._dblInit = true;
            }
            if (localStorage.getItem('onlineWidgetHidden') === '1') widget.classList.add('hidden-by-dbl');
        } catch (e) {}
        if (users.length === 0) {
            list.innerHTML = '<li style="color:var(--muted)">Niemand online</li>';
        } else {
            list.innerHTML = users.map(u => `<li>${escapeHtml(u.username || 'Gast')}</li>`).join('');
        }
    } catch {}
}

function applyProfileSettings() {
    const settings = currentProfile?.settings;
    if (!settings) {
        applyPersonalizationUI();
        return;
    }

    document.documentElement.dataset.design = settings.design || 'standard';
    if (settings.energySaver) {
        document.body.classList.add('energy-saver');
    } else {
        document.body.classList.remove('energy-saver');
    }

    applyPersonalizationUI();
}

function updatePlanBadge() {
    const el = document.getElementById('planBadge');
    if (!el) return;

    if (hasPremiumAccess()) {
        const premiumUntil = currentProfile?.premiumUntil || currentProfile?.settings?.premiumUntil || '';
        const until = premiumUntil ? new Date(premiumUntil).toLocaleDateString('de-DE') : '';
        el.textContent = `${until ? `Plan: Premium bis ${until}` : 'Plan: Premium'} | ${getCreditBalance()} Credits`;
        el.classList.add('pro', 'premium');
    } else if (hasProAccess()) {
        const until = currentProfile.proUntil ? new Date(currentProfile.proUntil).toLocaleDateString('de-DE') : '';
        el.textContent = `${until ? `Plan: PRO bis ${until}` : 'Plan: PRO'} | ${getCreditBalance()} Credits`;
        el.classList.add('pro');
        el.classList.remove('premium');
    } else {
        el.textContent = `Plan: Gratis | ${getCreditBalance()} Credits`;
        el.classList.remove('pro', 'premium');
    }
}

function openSettingsModal() {
    if (!currentUser) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }

    const modal = document.getElementById('settingsModal');
    const p = currentProfile || { settings: { language: 'de', design: 'standard', energySaver: false }, isPro: false };
    document.getElementById('settingLanguage').value = p.settings?.language || 'de';
    document.getElementById('settingDesign').value = p.settings?.design || 'standard';
    document.getElementById('settingEnergySaver').checked = Boolean(p.settings?.energySaver);
    const personalizationToggle = document.getElementById('settingPersonalizationEnabled');
    if (personalizationToggle) {
        personalizationToggle.checked = false;
        personalizationToggle.disabled = true;
        personalizationToggle.closest('.form-group')?.style.setProperty('display', 'none');
    }
    const displayNameInput = document.getElementById('accountDisplayName');
    if (displayNameInput) displayNameInput.value = p.settings?.displayName || currentUser?.username || '';
    const usernameInput = document.getElementById('accountUsername');
    if (usernameInput) usernameInput.value = currentUser?.username || '';
    const usernameLabel = document.getElementById('accountProfileUsernameLabel');
    if (usernameLabel) usernameLabel.textContent = currentUser?.username || 'Gast';
    const avatarInput = document.getElementById('accountAvatarUrl');
    if (avatarInput) avatarInput.value = p.settings?.avatarUrl || '';
    refreshAccountAvatarPreview();
    document.getElementById('inviteLinkWrap').style.display = 'none';
    // Login-Code laden und anzeigen
    const codeDisplay = document.getElementById('myLoginCodeDisplay');
    if (codeDisplay) {
        codeDisplay.textContent = '••••••';
        codeDisplay.dataset.revealed = 'false';
    }
    const toggleBtn = document.getElementById('toggleCodeBtn');
    if (toggleBtn) toggleBtn.textContent = '👁 Anzeigen';
    fetchLoginCode();
    updatePlanBadge();
    // Aktuelle E-Mail laden
    const emailDisplay = document.getElementById('emailCurrentDisplay');
    if (emailDisplay) {
        fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
            .then(r => r.json())
            .then(d => {
                const mail = d.user?.email || null;
                emailDisplay.textContent = mail ? `Verknüpft: ${mail}` : 'Noch keine E-Mail verknüpft.';
                const unlinkRow = document.getElementById('emailUnlinkRow');
                if (unlinkRow) unlinkRow.style.display = mail ? 'block' : 'none';
            }).catch(() => {});
    }
    document.getElementById('emailCodeRow').style.display = 'none';
    // Chat Token laden
    loadChatToken();
    modal.classList.add('show');
}

let _cachedLoginCode = null;
async function fetchLoginCode() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/login-code`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        _cachedLoginCode = data.loginCode || null;
        const codeDisplay = document.getElementById('myLoginCodeDisplay');
        if (codeDisplay && codeDisplay.dataset.revealed === 'true') {
            codeDisplay.textContent = _cachedLoginCode || '–';
        }
    } catch {}
}

function toggleShowLoginCode() {
    const codeDisplay = document.getElementById('myLoginCodeDisplay');
    const btn = document.getElementById('toggleCodeBtn');
    if (!codeDisplay) return;
    if (codeDisplay.dataset.revealed === 'true') {
        codeDisplay.textContent = '••••••';
        codeDisplay.dataset.revealed = 'false';
        if (btn) btn.textContent = '👁 Anzeigen';
    } else {
        if (_cachedLoginCode) {
            codeDisplay.textContent = _cachedLoginCode;
            codeDisplay.dataset.revealed = 'true';
            if (btn) btn.textContent = '🙈 Verbergen';
        } else {
            fetchLoginCode().then(() => {
                if (_cachedLoginCode) {
                    codeDisplay.textContent = _cachedLoginCode;
                    codeDisplay.dataset.revealed = 'true';
                    if (btn) btn.textContent = '🙈 Verbergen';
                }
            });
        }
    }
}

async function copyLoginCode() {
    if (!_cachedLoginCode) await fetchLoginCode();
    if (!_cachedLoginCode) { showAlert('Code konnte nicht geladen werden.', 'error'); return; }
    try {
        await navigator.clipboard.writeText(_cachedLoginCode);
        showAlert('Login-Code kopiert!', 'success');
    } catch {
        showAlert('Kopieren fehlgeschlagen. Bitte manuell kopieren.', 'error');
    }
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.remove('show');
    // E-Mail-Eingaben beim Schließen zurücksetzen
    const emailInput = document.getElementById('emailInput');
    const emailCodeInput = document.getElementById('emailCodeInput');
    const emailCodeRow = document.getElementById('emailCodeRow');
    if (emailInput) emailInput.value = '';
    if (emailCodeInput) emailCodeInput.value = '';
    if (emailCodeRow) emailCodeRow.style.display = 'none';
}

let _selectedPlanRequest = null;

function openPricingModal() {
    if (!currentUser) {
        showAlert('Bitte zuerst anmelden.', 'error');
        return;
    }
    const modal = document.getElementById('pricingModal');
    const box = document.getElementById('planRequestBox');
    const status = document.getElementById('planRequestStatus');
    if (box) box.style.display = 'none';
    if (status) status.textContent = '';
    _selectedPlanRequest = null;
    if (modal) modal.classList.add('show');
}

function closePricingModal() {
    document.getElementById('pricingModal')?.classList.remove('show');
}

function selectPlanRequest(plan) {
    _selectedPlanRequest = plan === 'premium' ? 'premium' : 'pro';
    const box = document.getElementById('planRequestBox');
    const status = document.getElementById('planRequestStatus');
    if (box) box.style.display = 'block';
    if (status) status.textContent = `${_selectedPlanRequest === 'premium' ? 'Premium 20 Euro' : 'Pro 10 Euro'}: Bar bezahlen, echten Namen eintragen und Anfrage senden.`;
}

async function sendPlanRequest() {
    if (!_selectedPlanRequest) return;
    const token = localStorage.getItem('token');
    const input = document.getElementById('planRealName');
    const status = document.getElementById('planRequestStatus');
    const realName = (input?.value || '').trim();
    if (!token) {
        if (status) status.textContent = 'Bitte erst anmelden.';
        return;
    }
    if (realName.length < 3) {
        if (status) status.textContent = 'Bitte echten Namen eingeben.';
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/me/plan-request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ plan: _selectedPlanRequest, realName })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen');
        if (status) status.textContent = 'Tarif Anfrage wurde gesendet. Bezahle bar beim Admin, danach wird freigeschaltet.';
        if (input) input.value = '';
    } catch (err) {
        if (status) status.textContent = err.message || 'Anfrage fehlgeschlagen.';
    }
}

function refreshAccountAvatarPreview() {
    const preview = document.getElementById('accountAvatarPreview');
    const fallback = document.getElementById('accountAvatarFallback');
    const usernameLabel = document.getElementById('accountProfileUsernameLabel');
    const usernameInput = document.getElementById('accountUsername');
    if (usernameInput) usernameInput.value = currentUser?.username || usernameInput.value || '';
    if (usernameLabel) usernameLabel.textContent = currentUser?.username || 'Gast';
    const avatarUrl = document.getElementById('accountAvatarUrl')?.value?.trim() || (currentProfile?.settings?.avatarUrl || '');
    if (avatarUrl) {
        preview.src = avatarUrl;
        preview.style.display = 'block';
        if (fallback) fallback.style.display = 'none';
    } else {
        preview.removeAttribute('src');
        preview.style.display = 'none';
        if (fallback) {
            fallback.textContent = (currentUser?.username || 'U').charAt(0).toUpperCase();
            fallback.style.display = 'grid';
        }
    }
}

async function uploadAccountAvatar() {
    const token = localStorage.getItem('token');
    if (!token) { showAlert('Bitte zuerst anmelden.', 'error'); return; }
    const input = document.getElementById('accountAvatarFile');
    const file = input?.files?.[0];
    if (!file) { showAlert('Bitte zuerst ein Bild auswählen.', 'error'); return; }
    if (!file.type.startsWith('image/')) { showAlert('Nur Bilder sind erlaubt.', 'error'); return; }

    const fd = new FormData();
    fd.append('file', file);
    try {
        const res = await fetch(`${API_BASE}/chat/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd
        });
        const data = await res.json();
        if (!res.ok) {
            showAlert(data.error || 'Upload fehlgeschlagen.', 'error');
            return;
        }
        const avatarInput = document.getElementById('accountAvatarUrl');
        if (avatarInput) avatarInput.value = data.url || '';
        refreshAccountAvatarPreview();

        // Direkt speichern, damit das Profilbild sofort aktiv ist.
        const saveRes = await fetch(`${API_BASE}/me/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ avatarUrl: data.url || '' })
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) {
            showAlert(saveData.error || 'Profilbild hochgeladen, aber Speichern fehlgeschlagen.', 'error');
            return;
        }
        currentProfile = saveData.profile || currentProfile;
        if (currentProfile) {
            syncPlanStatus();
            applyProfileSettings();
            showLoggedInUI();
        }
        showAlert('Profilbild gespeichert!', 'success');
    } catch {
        showAlert('Netzwerkfehler beim Upload.', 'error');
    }
}

function _chatPickImageFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = () => {
            const file = input.files?.[0] || null;
            input.remove();
            resolve(file);
        };
        input.click();
    });
}

async function loadChatToken() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/chat-token`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        const display = document.getElementById('chatTokenDisplay');
        const val = document.getElementById('chatTokenValue');
        if (data.token && display && val) {
            val.textContent = data.token;
            display.style.display = 'block';
        }
    } catch {}
}

async function createChatToken() {
    const token = localStorage.getItem('token');
    if (!token) { showAlert('Bitte zuerst anmelden.', 'error'); return; }
    const msg = document.getElementById('chatTokenMsg');
    if (msg) msg.textContent = 'Token wird erstellt...';
    try {
        const res = await fetch(`${API_BASE}/me/chat-token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { if (msg) msg.textContent = data.error || 'Fehler.'; return; }
        const display = document.getElementById('chatTokenDisplay');
        const val = document.getElementById('chatTokenValue');
        if (display && val) { val.textContent = data.token; display.style.display = 'block'; }
        if (msg) msg.textContent = 'Token wurde erstellt!';
    } catch { if (msg) msg.textContent = 'Netzwerkfehler.'; }
}

function copyChatToken() {
    const val = document.getElementById('chatTokenValue');
    if (!val?.textContent) return;
    navigator.clipboard.writeText(val.textContent).then(() => {
        const msg = document.getElementById('chatTokenMsg');
        if (msg) msg.textContent = 'Token kopiert!';
    });
}

// ─── Inline Chat ──────────────────────────────────────────────────────────────
let _chatCurrentGroupId = null;
let _chatCurrentGroupName = null;
let _chatPollInterval = null;
let _chatLastMsgId = 0;
let _chatGroups = [];
const CHAT_LOCAL_STORAGE_KEY = 'ehoser_chat_cache_v1';

function chatGetLocalCache() {
    try {
        const raw = localStorage.getItem(CHAT_LOCAL_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function chatSetLocalCache(cache) {
    try {
        localStorage.setItem(CHAT_LOCAL_STORAGE_KEY, JSON.stringify(cache));
    } catch {}
}

function chatGetCachedMessages(groupId) {
    const cache = chatGetLocalCache();
    const list = Array.isArray(cache[groupId]) ? cache[groupId] : [];
    return list.slice().sort((a, b) => {
        const aId = Number(a?.id) || 0;
        const bId = Number(b?.id) || 0;
        if (aId && bId) return aId - bId;
        return new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime();
    });
}

function chatPersistCachedMessages(groupId, messages) {
    const cache = chatGetLocalCache();
    const unique = [];
    const seen = new Set();
    for (const msg of Array.isArray(messages) ? messages : []) {
        const key = String(msg?.id || msg?.created_at || JSON.stringify(msg));
        if (!seen.has(key)) { seen.add(key); unique.push(msg); }
    }
    cache[groupId] = unique.sort((a, b) => {
        const aId = Number(a?.id) || 0;
        const bId = Number(b?.id) || 0;
        if (aId && bId) return aId - bId;
        return new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime();
    });
    chatSetLocalCache(cache);
}

function chatRenderCachedMessages(groupId) {
    const container = document.getElementById('chatMessages');
    if (!container || !_chatCurrentGroupId || _chatCurrentGroupId !== groupId) return;
    const msgs = chatGetCachedMessages(groupId);
    if (!msgs.length) return;
    container.innerHTML = '';
    msgs.forEach(m => {
        const isMe = m.sender === currentUser?.username;
        const div = document.createElement('div');
        div.className = `chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}`;
        const time = parseServerDate(m.created_at || Date.now()).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const initial = (m.sender || '?')[0].toUpperCase();
        const payload = chatParsePayload(m.encrypted_content);
        const bodyHtml = chatRenderPayload(payload);
        div.innerHTML = `
            <div class="chat-msg-avatar">${escapeHtml(initial)}</div>
            <div class="chat-msg-body">
                <div class="chat-msg-sender">
                    ${escapeHtml(m.sender)}
                    <span class="chat-msg-time-inline">${time}</span>
                </div>
                <div class="chat-msg-bubble">${bodyHtml}</div>
            </div>
        `;
        container.appendChild(div);
        if (m.id) _chatLastMsgId = Math.max(_chatLastMsgId, Number(m.id) || 0);
    });
    chatScrollToBottom(false);
}
let _chatUserSearchTimer = null;
let _chatSelectedUsers = new Set();
let _chatLastUserDirectory = [];

function chatCanNotify() {
    return 'Notification' in window && Notification.permission === 'granted';
}

function chatAskNotificationPermission() {
    if (!('Notification' in window)) return;
    if (_chatNotifyInitialized) return;
    _chatNotifyInitialized = true;
    if (Notification.permission !== 'default') return;
    const accepted = window.confirm('Moechtest du Chat-Benachrichtigungen aktivieren?');
    if (!accepted) return;
    Notification.requestPermission().catch(() => {});
}

function requestChatNotificationsManually() {
    if (!('Notification' in window)) {
        showAlert('Dieser Browser unterstützt keine Benachrichtigungen.', 'error');
        return;
    }
    Notification.requestPermission().then((permission) => {
        if (permission === 'granted') showAlert('Benachrichtigungen aktiviert.', 'success');
        else showAlert('Benachrichtigungen wurden nicht erlaubt.', 'error');
    }).catch(() => {
        showAlert('Benachrichtigungen konnten nicht aktiviert werden.', 'error');
    });
}

function chatParsePayload(rawContent) {
    try {
        const parsed = JSON.parse(rawContent);
        if (parsed && typeof parsed === 'object' && parsed.t) return parsed;
    } catch {}
    return { t: 'txt', v: String(rawContent || '') };
}

function chatPayloadPreview(payload) {
    if (!payload || typeof payload !== 'object') return 'Neue Nachricht';
    if (payload.t === 'txt') return String(payload.v || '').slice(0, 140) || 'Textnachricht';
    if (payload.t === 'img') return 'Bild gesendet';
    if (payload.t === 'file') return `Datei gesendet: ${payload.name || 'Datei'}`;
    if (payload.t === 'vid') return 'Video gesendet';
    if (payload.t === 'aud') return 'Audio gesendet';
    return 'Neue Nachricht';
}

function chatRenderPayload(payload) {
    const p = payload || { t: 'txt', v: '' };
    if (p.t === 'img') {
        return `
            <div class="chat-media-wrap">
                <a href="${escapeAttribute(p.url || '')}" target="_blank" rel="noopener">
                    <img class="chat-inline-image" src="${escapeAttribute(p.url || '')}" alt="${escapeAttribute(p.name || 'Bild')}" loading="lazy">
                </a>
                <div><a class="chat-file-link" href="${escapeAttribute(p.url || '')}" target="_blank" rel="noopener" download="${escapeAttribute(p.name || 'bild')}">Herunterladen</a></div>
            </div>
        `;
    }
    if (p.t === 'file' || p.t === 'vid' || p.t === 'aud') {
        const label = p.name || (p.t === 'vid' ? 'Video' : p.t === 'aud' ? 'Audio' : 'Datei');
        return `<a class="chat-file-link" href="${escapeAttribute(p.url || '')}" target="_blank" rel="noopener" download="${escapeAttribute(label)}">${escapeHtml(label)}</a>`;
    }
    return escapeHtml(String(p.v || '')).replace(/\n/g, '<br>');
}

function appendOptimisticChatMessage(tempId, text) {
    const container = document.getElementById('chatMessages');
    if (!container || !_chatCurrentGroupId) return;

    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-me pending';
    div.dataset.tempid = String(tempId);
    const initial = (currentUser?.username || '?')[0].toUpperCase();
    div.innerHTML = `
        <div class="chat-msg-avatar">${escapeHtml(initial)}</div>
        <div class="chat-msg-body">
            <div class="chat-msg-sender">
                ${escapeHtml(currentUser?.username || 'Du')}
                <span class="chat-msg-time-inline">jetzt</span>
            </div>
            <div class="chat-msg-bubble">${escapeHtml(String(text || '')).replace(/\n/g, '<br>')}</div>
        </div>
    `;
    container.appendChild(div);
    chatScrollToBottom(false);
}

function finalizeOptimisticChatMessage(tempId, serverMsg) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const selector = `[data-tempid="${CSS.escape(String(tempId))}"]`;
    const el = container.querySelector(selector);
    if (!el || !serverMsg) return;
    el.removeAttribute('data-tempid');
    el.classList.remove('pending');
    const time = parseServerDate(serverMsg.created_at || Date.now()).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const timeEl = el.querySelector('.chat-msg-time-inline');
    if (timeEl) timeEl.textContent = time;
    if (serverMsg.id) el.dataset.msgid = String(serverMsg.id);
}

async function chatUploadAndSendFile(inputEl) {
    if (!_chatCurrentGroupId) { showAlert('Bitte erst ein Gespraech waehlen.', 'error'); return; }
    const file = inputEl?.files?.[0];
    if (!file) return;
    inputEl.value = '';

    const token = localStorage.getItem('token');
    if (!token) return;

    const fd = new FormData();
    fd.append('file', file);
    try {
        const uploadRes = await fetch(`${API_BASE}/chat/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) {
            showAlert(uploadData.error || 'Upload fehlgeschlagen.', 'error');
            return;
        }

        const mime = String(uploadData.mime || file.type || '');
        let payload;
        if (mime.startsWith('image/')) payload = { t: 'img', url: uploadData.url, name: uploadData.name, size: uploadData.size };
        else if (mime.startsWith('video/')) payload = { t: 'vid', url: uploadData.url, name: uploadData.name, size: uploadData.size };
        else if (mime.startsWith('audio/')) payload = { t: 'aud', url: uploadData.url, name: uploadData.name, size: uploadData.size };
        else payload = { t: 'file', url: uploadData.url, name: uploadData.name, size: uploadData.size };

        const sendRes = await fetch(`${API_BASE}/chat/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ groupId: _chatCurrentGroupId, encryptedContent: JSON.stringify(payload) })
        });
        const sendData = await sendRes.json().catch(() => ({}));
        if (!sendRes.ok) {
            showAlert(sendData.error || 'Datei konnte nicht gesendet werden.', 'error');
            return;
        }
        await chatFetchMessages();
    } catch {
        showAlert('Netzwerkfehler beim Senden der Datei.', 'error');
    }
}

function triggerChatFilePicker() {
    const input = document.getElementById('chatFileInput');
    if (!input) return;
    input.click();
}

async function initChatSection() {
    _chatCurrentGroupId = null;
    clearInterval(_chatPollInterval);
    document.getElementById('chatEmptyState').style.display = 'flex';
    document.getElementById('chatConv').style.display = 'none';
    chatAskNotificationPermission();
    _chatSelectedUsers.clear();
    await chatLoadGroups();
    await chatSearchUsers('');
}

async function chatLoadGroups() {
    const token = localStorage.getItem('token');
    if (!token) return;
    const list = document.getElementById('chatGroupList');
    try {
        const res = await fetch(`${API_BASE}/chat/groups`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        _chatGroups = data.groups || [];
        if (!_chatGroups.length) {
            list.innerHTML = '<div class="chat-loading" style="color:#6a9bb8;font-size:0.9rem;padding:16px;">Noch keine Gespräche.<br>Wähle Nutzer und klicke auf Anwenden.</div>';
            return;
        }
        list.innerHTML = _chatGroups.map(g => `
            <button class="chat-group-item" onclick="openChatGroup('${escapeAttribute(g.id)}','${escapeAttribute(g.name)}')">
                <div class="chat-group-avatar">${g.photo_url ? `<img src="${escapeAttribute(g.photo_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">` : escapeHtml(g.name.charAt(0).toUpperCase())}</div>
                <div class="chat-group-info">
                    <div class="chat-group-name">${escapeHtml(g.name)}</div>
                    <div class="chat-group-sub">${g.type === 'private' ? 'Privater Chat' : `Gruppe · ${g.member_count || 0} Mitglieder`}</div>
                </div>
            </button>
        `).join('');
    } catch {
        list.innerHTML = '<div class="chat-loading" style="color:#e57373;">Fehler beim Laden.</div>';
    }
}

function chatSearchUsers(query) {
    const dropdown = document.getElementById('chatUserDropdown');
    clearTimeout(_chatUserSearchTimer);
    _chatUserSearchTimer = setTimeout(async () => {
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            const q = String(query || '').trim();
            const url = q
                ? `${API_BASE}/chat/users/search?q=${encodeURIComponent(q)}&limit=200`
                : `${API_BASE}/chat/users/search?limit=200`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();
            const users = data.users || [];
            _chatLastUserDirectory = users;
            if (!users.length) {
                dropdown.innerHTML = '<div class="chat-dd-item chat-dd-empty">Kein Nutzer gefunden</div>';
                dropdown.style.display = 'block';
                return;
            }
            const selectedText = _chatSelectedUsers.size
                ? `<div class="chat-dd-item chat-dd-empty">Ausgewählt: ${escapeHtml([..._chatSelectedUsers].join(', '))}</div>`
                : '';
            dropdown.innerHTML = selectedText + users.map(u => {
                const selectedClass = _chatSelectedUsers.has(u) ? ' selected' : '';
                return `<div class="chat-dd-item${selectedClass}" onclick="chatToggleUserSelection('${escapeAttribute(u)}')">${escapeHtml(u)}</div>`;
            }).join('');
            dropdown.style.display = 'block';
        } catch {
            dropdown.style.display = 'none';
        }
    }, 300);
}

function chatToggleUserSelection(username) {
    if (_chatSelectedUsers.has(username)) _chatSelectedUsers.delete(username);
    else _chatSelectedUsers.add(username);
    chatSearchUsers(document.getElementById('chatDmInput')?.value || '');
}

async function chatApplySelectedUsers() {
    const users = [..._chatSelectedUsers];
    if (!users.length) {
        showAlert('Bitte mindestens einen Nutzer auswählen.', 'error');
        return;
    }
    await chatCreateConversation(users);
}

async function chatCreateConversation(targetUsers) {
    const token = localStorage.getItem('token');
    if (!token) return;

    const uniqueUsers = [...new Set((targetUsers || []).map(u => String(u || '').trim()).filter(Boolean))];
    if (!uniqueUsers.length) return;

    const myUsername = currentUser?.username;
    if (!myUsername) return;

    const privateChat = uniqueUsers.length === 1;
    const groupName = privateChat
        ? uniqueUsers[0]
        : (window.prompt('Gruppenname eingeben:', `Gruppe ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`) || '').trim();

    if (!groupName) {
        showAlert('Gruppenname fehlt.', 'error');
        return;
    }

    const memberKeys = { [myUsername]: 'plain' };
    uniqueUsers.forEach(u => { memberKeys[u] = 'plain'; });

    try {
        const res = await fetch(`${API_BASE}/chat/groups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                name: groupName,
                members: uniqueUsers,
                memberKeys
            })
        });
        const data = await res.json();
        if (!res.ok) {
            showAlert(data.error || 'Gespräch konnte nicht erstellt werden.', 'error');
            return;
        }
        _chatSelectedUsers.clear();
        document.getElementById('chatDmInput').value = '';
        document.getElementById('chatUserDropdown').style.display = 'none';
        await chatLoadGroups();
        openChatGroup(data.id, data.name);
    } catch {
        showAlert('Netzwerkfehler beim Erstellen des Gesprächs.', 'error');
    }
}

async function chatStartDM(targetUsername) {
    await chatCreateConversation([targetUsername]);
}

function chatIsNearBottom(container) {
    if (!container) return true;
    return container.scrollHeight - container.scrollTop <= container.clientHeight + 40;
}

function chatUpdateScrollButton() {
    const container = document.getElementById('chatMessages');
    const btn = document.getElementById('chatScrollBottomBtn');
    if (!container || !btn) return;
    btn.style.display = chatIsNearBottom(container) ? 'none' : 'inline-flex';
}

function chatScrollToBottom(smooth = false) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    chatUpdateScrollButton();
}

function chatScrollBy(delta) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.scrollBy({ top: delta, behavior: 'smooth' });
    setTimeout(chatUpdateScrollButton, 120);
}

function openChatGroup(groupId, groupName) {
    _chatCurrentGroupId = groupId;
    _chatCurrentGroupName = groupName;
    _chatLastMsgId = 0;
    const group = _chatGroups.find(g => g.id === groupId) || {};
    document.getElementById('chatEmptyState').style.display = 'none';
    document.getElementById('chatConv').style.display = 'flex';
    document.getElementById('chatConvName').textContent = groupName;
    document.getElementById('chatConvStatus').textContent = group.type === 'private' ? 'Privater Chat' : `Gruppe · ${group.member_count || 0} Mitglieder`;
    const manageBtn = document.getElementById('chatManageBtn');
    if (manageBtn) manageBtn.style.display = (group.type === 'group' && group.is_admin) ? '' : 'none';
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = '';
    chatMessages.onscroll = chatUpdateScrollButton;
    const cached = chatGetCachedMessages(groupId);
    if (cached.length) {
        cached.forEach(m => {
            const isMe = m.sender === currentUser?.username;
            const div = document.createElement('div');
            div.className = `chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}`;
            const time = parseServerDate(m.created_at || Date.now()).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            const initial = (m.sender || '?')[0].toUpperCase();
            const payload = chatParsePayload(m.encrypted_content);
            const bodyHtml = chatRenderPayload(payload);
            div.innerHTML = `
                <div class="chat-msg-avatar">${escapeHtml(initial)}</div>
                <div class="chat-msg-body">
                    <div class="chat-msg-sender">
                        ${escapeHtml(m.sender)}
                        <span class="chat-msg-time-inline">${time}</span>
                    </div>
                    <div class="chat-msg-bubble">${bodyHtml}</div>
                </div>
            `;
            if (m.id) _chatLastMsgId = Math.max(_chatLastMsgId, Number(m.id) || 0);
            chatMessages.appendChild(div);
        });
    }
    clearInterval(_chatPollInterval);
    chatFetchMessages();
    _chatPollInterval = setInterval(chatFetchMessages, 3000);
    chatUpdateScrollButton();
    setTimeout(() => {
        chatScrollToBottom(false);
        document.getElementById('chatMsgInput')?.focus();
    }, 40);
    // Highlight aktive Gruppe
    document.querySelectorAll('.chat-group-item').forEach(el => el.classList.remove('active'));
    const btn = document.querySelector(`.chat-group-item[onclick*="${groupId}"]`);
    if (btn) btn.classList.add('active');
}

function closeChatConv() {
    clearInterval(_chatPollInterval);
    _chatCurrentGroupId = null;
    document.getElementById('chatConv').style.display = 'none';
    document.getElementById('chatEmptyState').style.display = 'flex';
    const btn = document.getElementById('chatScrollBottomBtn');
    if (btn) btn.style.display = 'none';
}

async function chatFetchMessages() {
    if (!_chatCurrentGroupId) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        let url = `${API_BASE}/chat/messages/${_chatCurrentGroupId}`;
        if (_chatLastMsgId) url += `?after=${_chatLastMsgId}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const data = await res.json();
        const msgs = data.messages || [];
        if (!msgs.length) return;

        const container = document.getElementById('chatMessages');
        const wasAtBottom = chatIsNearBottom(container);
        const beforeLastMsgId = _chatLastMsgId;
        const cache = chatGetCachedMessages(_chatCurrentGroupId);
        const cachedIds = new Set(cache.map(m => String(m.id || '')));
        const newMessages = msgs.filter(m => !cachedIds.has(String(m.id || '')));

        if (newMessages.length) {
            const merged = [...cache, ...newMessages].sort((a, b) => {
                const aId = Number(a.id) || 0;
                const bId = Number(b.id) || 0;
                if (aId && bId) return aId - bId;
                return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
            });
            chatPersistCachedMessages(_chatCurrentGroupId, merged);
        }

        newMessages.forEach(m => {
            _chatLastMsgId = Math.max(_chatLastMsgId, Number(m.id) || 0);
            const isMe = m.sender === currentUser?.username;
            const div = document.createElement('div');
            div.className = `chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}`;
            const time = parseServerDate(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            const initial = (m.sender || '?')[0].toUpperCase();
            const payload = chatParsePayload(m.encrypted_content);
            const bodyHtml = chatRenderPayload(payload);
            div.innerHTML = `
                <div class="chat-msg-avatar">${initial}</div>
                <div class="chat-msg-body">
                    <div class="chat-msg-sender">
                        ${escapeHtml(m.sender)}
                        <span class="chat-msg-time-inline">${time}</span>
                    </div>
                    <div class="chat-msg-bubble">${bodyHtml}</div>
                </div>
            `;
            container.appendChild(div);

            if (!isMe && Number(m.id) > beforeLastMsgId && beforeLastMsgId > 0 && chatCanNotify()) {
                const preview = chatPayloadPreview(payload);
                try {
                    new Notification(`Neue Nachricht von ${m.sender}`, {
                        body: preview,
                        tag: `chat-${_chatCurrentGroupId}`
                    });
                } catch {}
            }
        });
        if (wasAtBottom) chatScrollToBottom(false);
        else chatUpdateScrollButton();
    } catch {}
}

async function sendChatMsg() {
    if (!_chatCurrentGroupId) return;
    const input = document.getElementById('chatMsgInput');
    const text = input?.value.trim();
    if (!text) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const payload = JSON.stringify({ t: 'txt', v: text });
    const tempMessage = {
        id: tempId,
        sender: currentUser?.username || 'Du',
        encrypted_content: payload,
        created_at: new Date().toISOString()
    };
    const cache = chatGetLocalCache();
    const groupList = Array.isArray(cache[_chatCurrentGroupId]) ? cache[_chatCurrentGroupId] : [];
    cache[_chatCurrentGroupId] = [...groupList, tempMessage].sort((a, b) => {
        const aId = Number(a?.id) || 0;
        const bId = Number(b?.id) || 0;
        if (aId && bId) return aId - bId;
        return new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime();
    });
    chatSetLocalCache(cache);
    appendOptimisticChatMessage(tempId, text);
    input.value = '';
    input.style.height = 'auto';
    try {
        const res = await fetch(`${API_BASE}/chat/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ groupId: _chatCurrentGroupId, encryptedContent: payload })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || 'Nachricht senden fehlgeschlagen');
        }
        const finalMessage = { id: data.id, sender: currentUser?.username || 'Du', encrypted_content: payload, created_at: data.created_at || new Date().toISOString() };
        const nextCache = chatGetLocalCache();
        nextCache[_chatCurrentGroupId] = (nextCache[_chatCurrentGroupId] || []).map(msg => String(msg.id || '') === String(tempId) ? finalMessage : msg);
        chatSetLocalCache(nextCache);
        finalizeOptimisticChatMessage(tempId, finalMessage);
        await chatFetchMessages();
    } catch (err) {
        const container = document.getElementById('chatMessages');
        const el = container?.querySelector(`[data-tempid="${CSS.escape(String(tempId))}"]`);
        if (el) {
            el.classList.add('send-failed');
            const timeEl = el.querySelector('.chat-msg-time-inline');
            if (timeEl) timeEl.textContent = 'Fehler';
        }
        showAlert('Nachricht konnte nicht gesendet werden.', 'error');
    }
}

document.addEventListener('click', e => {
    const dropdown = document.getElementById('chatUserDropdown');
    const input = document.getElementById('chatDmInput');
    if (dropdown && input && !input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

// ─── Psychologischer Support (PS) ────────────────────────────────────────────

let _psName = '';
let _psAnswers = []; // { question, answer }
let _psChatHistory = []; // { role, content }
let _psAllSummary = '';

const PS_FIXED_QUESTIONS = [
    'Wie geht es dir heute?',
    'Wie ging es dir in den letzten Wochen?',
    'Was ist deine größte Angst?',
    'Was ist dein größter Wunsch?',
    'Hast du einen Zwang, etwas nicht zu können?'
];

function _psSaveState() {
    try {
        localStorage.setItem('ps_chat', JSON.stringify({
            name: _psName,
            history: _psChatHistory,
            summary: _psAllSummary
        }));
    } catch {}
}

function _psLoadState() {
    try {
        const raw = localStorage.getItem('ps_chat');
        if (!raw) return false;
        const saved = JSON.parse(raw);
        if (!saved?.history?.length) return false;
        _psName = saved.name || '';
        _psChatHistory = saved.history;
        _psAllSummary = saved.summary || '';
        return true;
    } catch { return false; }
}

function openPsHelp() {
    const overlay = document.getElementById('psOverlay');
    if (!overlay) return;

    // Wenn gespeicherter Chat vorhanden → direkt Chat zeigen
    if (_psLoadState()) {
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        showPsScreen('psScreenChat');
        const chatMessages = document.getElementById('psChatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
            _psChatHistory.forEach(m => appendPsChatMessage(m.role, m.content));
        }
        return;
    }

    // Kein gespeicherter Chat → Neu starten
    _psName = '';
    _psAnswers = [];
    _psChatHistory = [];
    _psAllSummary = '';
    showPsScreen('psScreenName');
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closePsOverlay() {
    const overlay = document.getElementById('psOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
}

function resetPsChat() {
    if (!confirm('Chat wirklich loeschen und neu starten?')) return;
    localStorage.removeItem('ps_chat');
    _psName = '';
    _psAnswers = [];
    _psChatHistory = [];
    _psAllSummary = '';
    closePsOverlay();
}

function showPsScreen(id) {
    ['psScreenName', 'psScreenSurvey', 'psScreenAnalyzing', 'psScreenResult', 'psScreenChat']
        .forEach(s => {
            const el = document.getElementById(s);
            if (el) el.style.display = s === id ? 'flex' : 'none';
        });
}

function startPsSurvey() {
    const nameInput = document.getElementById('psFirstNameInput');
    const name = nameInput?.value.trim();
    if (!name) { showAlert('Bitte gib deinen Vornamen ein.', 'error'); return; }
    _psName = name;
    _psAnswers = [];
    showPsSurveyQuestion(0, PS_FIXED_QUESTIONS);
}

function showPsSurveyQuestion(index, questions) {
    const numEl = document.getElementById('psSurveyNum');
    const totalEl = document.getElementById('psSurveyTotal');
    const questionEl = document.getElementById('psSurveyQuestion');
    const answerEl = document.getElementById('psSurveyAnswer');
    const nextBtn = document.getElementById('psNextBtn');
    const bar = document.getElementById('psSurveyBar');

    if (numEl) numEl.textContent = index + 1;
    if (totalEl) totalEl.textContent = questions.length;
    if (questionEl) questionEl.textContent = questions[index];
    if (answerEl) answerEl.value = '';
    if (bar) bar.style.width = `${Math.round((index / questions.length) * 100)}%`;
    if (nextBtn) nextBtn.onclick = () => submitPsSurveyAnswer(index, questions);
    showPsScreen('psScreenSurvey');
}

async function submitPsSurveyAnswer(index, questions) {
    const answerEl = document.getElementById('psSurveyAnswer');
    const answer = answerEl?.value.trim();
    if (!answer) { showAlert('Bitte schreib eine Antwort.', 'error'); return; }

    _psAnswers.push({ question: questions[index], answer });

    if (index + 1 < questions.length) {
        // More questions in this phase
        showPsSurveyQuestion(index + 1, questions);
    } else if (questions === PS_FIXED_QUESTIONS) {
        // Fixed questions done → AI generates follow-up questions
        await fetchPsFollowUpQuestions();
    } else {
        // All personalized questions done → show result
        await showPsResult();
    }
}

async function fetchPsFollowUpQuestions() {
    showPsScreen('psScreenAnalyzing');
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
        const res = await fetch(`${API_BASE}/ps/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: _psName, answers: _psAnswers.slice(0, 4) })
        });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.questions)) {
            showAlert('KI-Analyse fehlgeschlagen. Weiter mit Standard-Fragen.', 'error');
            await showPsResult();
            return;
        }
        showPsSurveyQuestion(0, data.questions);
    } catch {
        await showPsResult();
    }
}

async function showPsResult() {
    showPsScreen('psScreenResult');
    // Build summary for AI chat context
    _psAllSummary = _psAnswers.map((a, i) => `Frage ${i + 1}: ${a.question}\nAntwort: ${a.answer}`).join('\n\n');

    // Small delay for effect
    await new Promise(r => setTimeout(r, 2000));

    // Open chat and get initial AI analysis
    await initPsChat();
}

async function initPsChat() {
    showPsScreen('psScreenChat');
    const chatMessages = document.getElementById('psChatMessages');
    if (chatMessages) chatMessages.innerHTML = '';
    _psChatHistory = [];

    // AI sends opening message
    const openingMessage = `Hallo ${_psName}, ich habe deine Antworten gelesen. Danke, dass du dich mir anvertraust. Ich bin hier, um dir zuzuhören und dir zu helfen. Lass uns gemeinsam schauen, wie es dir geht.`;
    appendPsChatMessage('assistant', openingMessage);
    _psChatHistory.push({ role: 'assistant', content: openingMessage });
    _psSaveState();

    // AI analyzes and responds
    await sendPsChatToAI(null);
}

function appendPsChatMessage(role, text) {
    const chatMessages = document.getElementById('psChatMessages');
    if (!chatMessages) return;
    const div = document.createElement('div');
    div.style.cssText = `margin:8px 0;padding:12px 16px;border-radius:14px;max-width:85%;word-wrap:break-word;line-height:1.5;font-size:0.95rem;color:#fff;${role === 'user' ? 'background:rgba(77,159,255,0.2);border:1px solid rgba(77,159,255,0.35);margin-left:auto;text-align:right;' : 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);'}`;
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendPsChatToAI(userMessage) {
    const token = localStorage.getItem('token');
    if (!token) return;

    if (userMessage) {
        _psChatHistory.push({ role: 'user', content: userMessage });
        appendPsChatMessage('user', userMessage);
        _psSaveState();
    }

    // Typing indicator
    const chatMessages = document.getElementById('psChatMessages');
    const typing = document.createElement('div');
    typing.id = 'psTyping';
    typing.style.cssText = 'padding:10px 16px;color:#8ab4c9;font-style:italic;font-size:0.9rem;';
    typing.textContent = '...';
    if (chatMessages) chatMessages.appendChild(typing);

    try {
        const res = await fetch(`${API_BASE}/ps/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                name: _psName,
                messages: _psChatHistory.filter(m => m.role === 'user' || m.role === 'assistant'),
                allAnswersSummary: _psAllSummary
            })
        });
        const data = await res.json();
        typing?.remove();
        if (!res.ok) { appendPsChatMessage('assistant', 'Entschuldigung, ich konnte gerade nicht antworten. Versuch es nochmal.'); return; }
        const reply = data.reply || '';
        _psChatHistory.push({ role: 'assistant', content: reply });
        appendPsChatMessage('assistant', reply);
        _psSaveState();
        await refreshCurrentProfile();
    } catch {
        typing?.remove();
        appendPsChatMessage('assistant', 'Verbindungsfehler. Bitte versuche es erneut.');
    }
}

async function sendPsChat() {
    const input = document.getElementById('psChatInput');
    const message = input?.value.trim();
    if (!message) return;
    if (input) input.value = '';
    await sendPsChatToAI(message);
}

function psChatKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendPsChat();
    }
}

async function unlinkEmail() {
    if (!confirm('E-Mail-Adresse wirklich entfernen?')) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/unlink-email`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { showAlert(data.error || 'Fehler beim Entfernen.', 'error'); return; }
        document.getElementById('emailCurrentDisplay').textContent = 'Noch keine E-Mail verknüpft.';
        document.getElementById('emailUnlinkRow').style.display = 'none';
        showAlert('E-Mail wurde entfernt.', 'success');
    } catch { showAlert('Netzwerkfehler.', 'error'); }
}

// ── E-Mail Verknüpfung ────────────────────────────────────────────────────────
async function sendEmailCode() {
    const email = document.getElementById('emailInput')?.value?.trim();
    if (!email) { showAlert('Bitte eine E-Mail-Adresse eingeben.', 'error'); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/link-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) { showAlert(data.error || 'Fehler beim Senden.', 'error'); return; }
        document.getElementById('emailCodeRow').style.display = 'block';
        showAlert('Code wurde gesendet!', 'success');
    } catch { showAlert('Netzwerkfehler.', 'error'); }
}

async function verifyEmailCode() {
    const code = document.getElementById('emailCodeInput')?.value?.trim();
    if (!code || code.length !== 6) { showAlert('Bitte den 6-stelligen Code eingeben.', 'error'); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const res = await fetch(`${API_BASE}/me/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) { showAlert(data.error || 'Falscher Code.', 'error'); return; }
        document.getElementById('emailCurrentDisplay').textContent = `Verknüpft: ${data.email}`;
        document.getElementById('emailCodeRow').style.display = 'none';
        document.getElementById('emailInput').value = '';
        document.getElementById('emailCodeInput').value = '';
        showAlert('E-Mail erfolgreich verknüpft!', 'success');
    } catch { showAlert('Netzwerkfehler.', 'error'); }
}

async function saveAccountSettings() {
    const token = localStorage.getItem('token');
    if (!token) return;

    const payload = {
        language: document.getElementById('settingLanguage').value,
        design: document.getElementById('settingDesign').value,
        energySaver: document.getElementById('settingEnergySaver').checked,
        personalizationEnabled: document.getElementById('settingPersonalizationEnabled').checked,
        displayName: (document.getElementById('accountDisplayName')?.value || '').trim(),
        avatarUrl: (document.getElementById('accountAvatarUrl')?.value || '').trim()
    };

    if (payload.displayName.length > 40) {
        showAlert('Anzeigename darf maximal 40 Zeichen haben.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/me/settings`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Einstellungen konnten nicht gespeichert werden.', 'error');
            return;
        }
        currentProfile = data.profile;
        syncPlanStatus();
        applyProfileSettings();
        showLoggedInUI();
        closeSettingsModal();
        showAlert('Einstellungen gespeichert.', 'success');
    } catch {
        showAlert('Netzwerkfehler beim Speichern.', 'error');
    }
}

async function createReferralInvite() {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const response = await fetch(`${API_BASE}/referral/create`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Referral-Link konnte nicht erstellt werden.', 'error');
            return;
        }
        document.getElementById('inviteLinkWrap').style.display = 'grid';
        document.getElementById('inviteLinkInput').value = data.inviteUrl;
        showAlert('Link erstellt. Wenn 1 Person registriert, bekommt ihr beide 2 Tage PRO.', 'success');
    } catch {
        showAlert('Referral-Link konnte nicht erstellt werden.', 'error');
    }
}

async function copyInviteLink() {
    const input = document.getElementById('inviteLinkInput');
    if (!input?.value) return;
    try {
        await navigator.clipboard.writeText(input.value);
        showAlert('Einladungslink kopiert.', 'success');
    } catch {
        input.select();
        document.execCommand('copy');
    }
}

function openFacewarpModeModal() {
    document.getElementById('facewarpModeModal').classList.add('show');
}

function closeFacewarpModeModal() {
    document.getElementById('facewarpModeModal').classList.remove('show');
}

function openFacewarpWithTier(tier) {
    const safeTier = tier === 'pro' ? 'pro' : 'basic';
    window.location.href = isDesktopMode()
        ? `facewarp/index.html?tier=${safeTier}&desktop=1&return=mode-select`
        : `/facewarp/?tier=${safeTier}&return=mode-select`;
}

function showAlert(message, type) {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;

    const mainContent = document.querySelector('.main-content');
    mainContent.insertBefore(alertDiv, mainContent.firstChild);

    setTimeout(() => alertDiv.remove(), 3500);
}

window.onclick = function onWindowClick(evt) {
    const modal = document.getElementById('appModal');
    if (evt.target === modal) {
        modal.classList.remove('show');
    }
    const settingsModal = document.getElementById('settingsModal');
    if (evt.target === settingsModal) {
        closeSettingsModal();
    }
    const facewarpModeModal = document.getElementById('facewarpModeModal');
    if (evt.target === facewarpModeModal) {
        closeFacewarpModeModal();
    }
    const gameModal = document.getElementById('gameModal');
    if (evt.target === gameModal) {
        closeGameModal();
    }
};

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

// ─── Online Spiele ────────────────────────────────────────────────────────────
let gamesAllLoaded = [];
let gamesFiltered = [];
let gamesCurrentPage = 1;
let gamesCurrentCategory = 'all';
let gamesSearchText = '';

// ─── Game Timer Variablen (15min Limit für Gratis) ─────────────────────────
let _gameTimerInterval = null;
let _gameSecondsLeft = 0;
let _gameStartTime = null;
let _gameLimitSeconds = 900; // 15 Min = 900 Sekunden für Gratis

async function loadGames() {
    const grid = document.getElementById('gamesGrid');
    grid.innerHTML = '<div class="games-loading">Spiele werden geladen…</div>';

    try {
        const res = await fetch(`${API_BASE}/games?page=${gamesCurrentPage}`);
        if (!res.ok) throw new Error('Feed nicht verfügbar');
        const data = await res.json();

        if (!Array.isArray(data) || !data.length) {
            grid.innerHTML = '<div class="games-loading">Keine Spiele gefunden.</div>';
            document.getElementById('gamesNextBtn').disabled = true;
            return;
        }

        gamesAllLoaded = data;
        buildGameCategoryFilter(data);
        gamesFiltered = data;
        applyGamesFilter();

        document.getElementById('gamesPageInfo').textContent = `Seite ${gamesCurrentPage}`;
        document.getElementById('gamesPrevBtn').disabled = gamesCurrentPage <= 1;
        document.getElementById('gamesNextBtn').disabled = data.length < 10;
    } catch (err) {
        grid.innerHTML = `<div class="games-loading" style="color:#b63f2d">Fehler: ${escapeHtml(err.message)}</div>`;
    }
}

function buildGameCategoryFilter(games) {
    const categories = ['all', ...new Set(games.map(g => g.category).filter(Boolean).sort())];
    const container = document.getElementById('gamesCategoryFilter');
    container.innerHTML = categories.map(c =>
        `<button class="filter-btn${c === gamesCurrentCategory ? ' active' : ''}" 
            onclick="filterGamesByCategory('${escapeAttribute(c)}', this)">${escapeHtml(c === 'all' ? 'Alle' : c)}</button>`
    ).join('');
}

function filterGamesByCategory(category, btn) {
    gamesCurrentCategory = category;
    document.querySelectorAll('#gamesCategoryFilter .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    applyGamesFilter();
}

function filterGames() {
    gamesSearchText = document.getElementById('gamesSearch').value.trim().toLowerCase();
    applyGamesFilter();
}

function applyGamesFilter() {
    let result = [...gamesAllLoaded];

    if (gamesSearchText) {
        result = result.filter(g =>
            (g.title || '').toLowerCase().includes(gamesSearchText) ||
            (g.description || '').toLowerCase().includes(gamesSearchText) ||
            (g.tags || '').toLowerCase().includes(gamesSearchText) ||
            (g.category || '').toLowerCase().includes(gamesSearchText)
        );
    }

    if (gamesCurrentCategory !== 'all') {
        result = result.filter(g => g.category === gamesCurrentCategory);
    }

    gamesFiltered = result;
    displayGames(gamesFiltered);
}

function displayGames(games) {
    const grid = document.getElementById('gamesGrid');

    if (!games.length) {
        grid.innerHTML = '<div class="games-loading">Keine Spiele gefunden.</div>';
        return;
    }

    grid.innerHTML = games.map(g => {
        const title = escapeHtml(g.title || 'Unbekannt');
        const category = escapeHtml(g.category || '');
        const tags = (g.tags || '').split(',').map(t => t.trim()).filter(Boolean)
            .slice(0, 4).map(t => `<span class="game-tag">${escapeHtml(t)}</span>`).join('');
        const desc = escapeHtml((g.description || '').replace(/&[a-z]+;/gi, ' ').substring(0, 120));
        const thumb = escapeAttribute(g.thumb || '');
        const gameUrl = escapeAttribute(g.url || '');
        const gTitle = escapeAttribute(g.title || '');

        return `
        <article class="game-card" onclick="openGame('${gameUrl}', '${gTitle}')">
            <div class="game-thumb-wrap">
                <img class="game-thumb" src="${thumb}" alt="${title}" loading="lazy" onerror="this.style.display='none'">
                <div class="game-play-overlay">▶</div>
            </div>
            <div class="game-info">
                <h3 class="game-title">${title}</h3>
                ${category ? `<span class="game-category">${category}</span>` : ''}
                <p class="game-desc">${desc}${(g.description || '').length > 120 ? '…' : ''}</p>
                <div class="game-tags">${tags}</div>
            </div>
        </article>`;
    }).join('');
}

function _formatGameTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `⏱️ ${mins}:${secs.toString().padStart(2, '0')}`;
}

function _updateGameTimer() {
    if (!_gameStartTime) return;
    
    const elapsed = Math.floor((Date.now() - _gameStartTime) / 1000);
    _gameSecondsLeft = Math.max(0, _gameLimitSeconds - elapsed);
    
    const badge = document.getElementById('gameTimerBadge');
    if (badge) {
        badge.textContent = _formatGameTime(_gameSecondsLeft);
        badge.classList.toggle('warning', _gameSecondsLeft <= 60);
    }
    
    if (_gameSecondsLeft <= 0) {
        _stopGameTimer();
        alert('⚠️ Deine 15 Minuten sind vorbei! Jetzt Vollzugang freischalten für unbegrenzte Spielzeit.');
        closeGameModal();
    }
}

function _startGameTimer() {
    if (_gameTimerInterval) clearInterval(_gameTimerInterval);
    _gameStartTime = Date.now();
    _gameSecondsLeft = _gameLimitSeconds;
    
    const badge = document.getElementById('gameTimerBadge');
    if (badge) {
        badge.style.display = 'block';
        badge.classList.remove('warning');
    }
    
    _gameTimerInterval = setInterval(_updateGameTimer, 500);
}

function _stopGameTimer() {
    if (_gameTimerInterval) {
        clearInterval(_gameTimerInterval);
        _gameTimerInterval = null;
    }
    const badge = document.getElementById('gameTimerBadge');
    if (badge) {
        badge.style.display = 'none';
    }
}

function openGame(url, title) {
    if (!url) return;
    
    // Wenn kein Pro → Timer starten (15 Min)
    if (currentProfile && !hasProAccess()) {
        _startGameTimer();
    } else {
        _stopGameTimer();
        const badge = document.getElementById('gameTimerBadge');
        if (badge) badge.style.display = 'none';
    }
    
    document.getElementById('gameFrame').src = url;
    document.getElementById('gameModal').classList.add('show');
}

function closeGameModal() {
    _stopGameTimer();
    document.getElementById('gameFrame').src = '';
    document.getElementById('gameModal').classList.remove('show');
    // Zurück zu Spieleauswahl
    showSection('games');
}

function changeGamesPage(delta) {
    gamesCurrentPage = Math.max(1, gamesCurrentPage + delta);
    gamesAllLoaded = [];
    gamesFiltered = [];
    gamesCurrentCategory = 'all';
    gamesSearchText = '';
    document.getElementById('gamesSearch').value = '';
    loadGames();
}

// ─── Bildschirmübertragung (Nutzer = Sharer / WebRTC Answerer) ─────────────────────
let _srSession = null;
let _srOffer = null;
let _srPc = null;
let _srStream = null;
let _srPollInterval = null;
let _srDisconnectTimer = null;

function startScreenSharePolling() {
    if (_srPollInterval) return;
    _srPollInterval = setInterval(_pollShareRequest, 2500);
}

function stopScreenSharePolling() {
    clearInterval(_srPollInterval);
    _srPollInterval = null;
}

async function _pollShareRequest() {
    const token = localStorage.getItem('token');
    if (!token || _srPc) return;
    try {
        const res = await fetch(`${API_BASE}/screenshare/pending`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.pending && data.sessionId && data.offer) {
            stopScreenSharePolling();
            _srSession = data.sessionId;
            _srOffer = data.offer;
            document.getElementById('shareRequestPopup').style.display = 'flex';
        }
    } catch {}
}

async function acceptShareRequest() {
    document.getElementById('shareRequestPopup').style.display = 'none';
    const token = localStorage.getItem('token');
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'browser',
                frameRate: { ideal: 30 },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false,
            preferCurrentTab: true,
            selfBrowserSurface: 'include'
        });
        _srStream = stream;

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
        _srPc = pc;

        // Video-Track hinzufügen
        stream.getTracks().forEach(track => {
            pc.addTrack(track, stream);
            track.onended = () => endShareSession();
        });

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            if (state === 'connected') {
                if (_srDisconnectTimer) { clearTimeout(_srDisconnectTimer); _srDisconnectTimer = null; }
                return;
            }
            if (state === 'disconnected') {
                if (!_srDisconnectTimer) {
                    try { pc.restartIce && pc.restartIce(); } catch {}
                    _srDisconnectTimer = setTimeout(() => {
                        endShareSession();
                    }, 10000);
                }
                return;
            }
            if (state === 'failed' || state === 'closed') endShareSession();
        };

        pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState;
            if (s === 'connected' || s === 'completed') {
                if (_srDisconnectTimer) { clearTimeout(_srDisconnectTimer); _srDisconnectTimer = null; }
            }
        };

        // Offer setzen, Answer erstellen
        await pc.setRemoteDescription(new RTCSessionDescription(_srOffer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Warten bis ICE-Gathering abgeschlossen
        const finalAnswer = await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve(pc.localDescription);
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') resolve(pc.localDescription);
            };
            setTimeout(() => resolve(pc.localDescription), 5000);
        });

        const res = await fetch(`${API_BASE}/screenshare/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ sessionId: _srSession, answer: finalAnswer, accept: true })
        });
        if (!res.ok) { endShareSession(); return; }

        document.getElementById('shareIndicator').style.display = 'flex';
    } catch (err) {
        endShareSession();
        startScreenSharePolling();
    }
}

async function declineShareRequest() {
    document.getElementById('shareRequestPopup').style.display = 'none';
    const token = localStorage.getItem('token');
    if (_srSession && token) {
        await fetch(`${API_BASE}/screenshare/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ sessionId: _srSession, accept: false })
        }).catch(() => {});
    }
    _srSession = null;
    _srOffer = null;
    startScreenSharePolling();
}

async function endShareSession() {
    if (_srDisconnectTimer) {
        clearTimeout(_srDisconnectTimer);
        _srDisconnectTimer = null;
    }
    if (_srStream) { _srStream.getTracks().forEach(t => t.stop()); _srStream = null; }
    if (_srPc) { _srPc.close(); _srPc = null; }
    const token = localStorage.getItem('token');
    if (_srSession && token) {
        await fetch(`${API_BASE}/screenshare/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ sessionId: _srSession })
        }).catch(() => {});
        _srSession = null;
    }
    document.getElementById('shareIndicator').style.display = 'none';
    startScreenSharePolling();
}


// ─── Game Creator ─────────────────────────────────────────────────────────────
let _gameCurrentCode = '';

function openGameCreator() {
    if (!hasProAccess()) {
        showAlert('Spiele erstellen ist nur für PRO-Nutzer verfügbar.', 'error');
        return;
    }
    const overlay = document.getElementById('gameCreatorOverlay');
    if (overlay) { overlay.style.display = 'flex'; }
}

function closeGameCreator() {
    const overlay = document.getElementById('gameCreatorOverlay');
    if (overlay) overlay.style.display = 'none';
}

function _gameSetStatus(msg) {
    const el = document.getElementById('gameStatus');
    if (el) el.textContent = msg;
}

function _gameShowLoading(show) {
    const empty = document.getElementById('gamePreviewEmpty');
    const loading = document.getElementById('gamePreviewLoading');
    const frame = document.getElementById('gamePreviewFrame');
    if (show) {
        if (empty) empty.style.display = 'none';
        if (loading) { loading.style.display = 'flex'; }
        if (frame) frame.style.display = 'none';
    } else {
        if (loading) loading.style.display = 'none';
    }
}

function _gameShowFrame(code) {
    const frame = document.getElementById('gamePreviewFrame');
    const empty = document.getElementById('gamePreviewEmpty');
    const dlBtn = document.getElementById('gameDownloadBtn');
    if (!frame) return;
    const blob = new Blob([code], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    frame.src = url;
    frame.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (dlBtn) dlBtn.style.display = '';
}

function _gameAddHistoryBubble(role, text) {
    const history = document.getElementById('gamePromptHistory');
    if (!history) return;
    const div = document.createElement('div');
    div.className = 'game-history-bubble ' + role;
    div.textContent = (role === 'user' ? '👤 ' : '🤖 ') + text;
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
}

async function sendGamePrompt() {
    const input = document.getElementById('gamePromptInput');
    const sendBtn = document.getElementById('gameSendBtn');
    const prompt = input?.value?.trim();
    if (!prompt) return;

    input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Generiere...';

    const isImprovement = !!_gameCurrentCode;
    _gameAddHistoryBubble('user', isImprovement ? '🔧 Verbessern: ' + prompt : prompt);
    _gameSetStatus(isImprovement ? 'KI verbessert dein Spiel...' : 'KI programmiert dein Spiel...');
    _gameShowLoading(true);

    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_BASE}/game/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ prompt, currentCode: _gameCurrentCode || undefined })
        });
        const data = await res.json();
        if (!res.ok || !data.code) {
            _gameShowLoading(false);
            const errMsg = typeof data.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data.error || 'Unbekannter Fehler');
            _gameSetStatus('Fehler: ' + errMsg);
            _gameAddHistoryBubble('ai', 'Fehler: ' + errMsg);
            return;
        }
        _gameCurrentCode = data.code;
        _gameShowLoading(false);
        _gameShowFrame(data.code);
        _gameSetStatus('Spiel bereit! ' + (isImprovement ? 'Verbesserung angewendet.' : ''));
        _gameAddHistoryBubble('ai', isImprovement ? 'Spiel wurde verbessert!' : 'Spiel erfolgreich generiert!');
    } catch (err) {
        _gameShowLoading(false);
        _gameSetStatus('Verbindungsfehler. Bitte versuche es erneut.');
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = _gameCurrentCode ? '🔧 Verbessern' : '✨ Spiel generieren';
    }
}

function downloadGame() {
    if (!_gameCurrentCode) return;
    const blob = new Blob([_gameCurrentCode], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ehoser-spiel.html';
    a.click();
    URL.revokeObjectURL(url);
}

// ── Mode-Suchleiste ───────────────────────────────────────────────────────────
function filterModeCards(query) {
    const q = (query || '').toLowerCase().trim();
    const cards = document.querySelectorAll('#modeCardsGrid .mode-card');
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.classList.toggle('hidden', q.length > 0 && !text.includes(q));
    });
}

// ── QR-Code Generator ─────────────────────────────────────────────────────────
let _qrDebounce = null;

function generateQR() {
    clearTimeout(_qrDebounce);
    _qrDebounce = setTimeout(_doGenerateQR, 150);
}

function _doGenerateQR() {
    const input = document.getElementById('qrInput');
    const canvas = document.getElementById('qrCanvas');
    const output = document.getElementById('qrOutput');
    const actions = document.getElementById('qrActions');
    const empty = document.getElementById('qrEmpty');
    const text = input ? input.value.trim() : '';

    if (!text) {
        if (output) output.classList.remove('visible');
        if (actions) actions.style.display = 'none';
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    if (typeof QRCode === 'undefined') {
        if (empty) { empty.textContent = 'QR-Bibliothek wird geladen…'; empty.style.display = ''; }
        return;
    }

    QRCode.toCanvas(canvas, text, { width: 260, margin: 2, color: { dark: '#000', light: '#fff' } }, function(err) {
        if (err) {
            if (empty) { empty.textContent = 'Fehler: ' + err.message; empty.style.display = ''; }
            return;
        }
        if (output) output.classList.add('visible');
        if (actions) actions.style.display = 'flex';
    });
}

function downloadQR() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'qr-code.png';
    a.click();
}

async function copyQRToClipboard() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    try {
        canvas.toBlob(async blob => {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            showAlert('QR-Code in die Zwischenablage kopiert!', 'success');
        });
    } catch {
        showAlert('Kopieren nicht unterstützt – bitte herunterladen.', 'error');
    }
}

// ── Taschenrechner ────────────────────────────────────────────────────────────
let _calcExpr = '';
let _calcHistory = [];

function calcInput(val) {
    _calcExpr += val;
    _calcRender();
}

function calcClear() {
    _calcExpr = '';
    _calcRender();
}

function calcDel() {
    _calcExpr = _calcExpr.slice(0, -1);
    _calcRender();
}

function calcEquals() {
    if (!_calcExpr) return;
    try {
        // Sichere Auswertung: nur Zahlen, Operatoren, Math-Funktionen erlaubt
        const sanitized = _calcExpr
            .replace(/sqrt\(/g, 'Math.sqrt(')
            .replace(/sin\(/g, 'Math.sin(')
            .replace(/cos\(/g, 'Math.cos(')
            .replace(/tan\(/g, 'Math.tan(')
            .replace(/log\(/g, 'Math.log10(')
            .replace(/\*\*/g, '**');
        // Nur sichere Zeichen erlauben
        if (/[^0-9+\-*/().^eMath.PIE\s]/.test(sanitized.replace(/Math\.(sqrt|sin|cos|tan|log10|PI|E)/g, ''))) {
            throw new Error('Ungültige Zeichen');
        }
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + sanitized + ')')();
        const displayResult = Number.isFinite(result) ? +result.toPrecision(12) : 'Fehler';
        _calcHistory.unshift(_calcExpr + ' = ' + displayResult);
        if (_calcHistory.length > 20) _calcHistory.pop();
        _calcExpr = String(displayResult);
        _calcRender(displayResult);
        _calcRenderHistory();
    } catch {
        const resultEl = document.getElementById('calcResult');
        if (resultEl) resultEl.textContent = 'Fehler';
    }
}

function _calcRender(result) {
    const exprEl = document.getElementById('calcExpression');
    const resultEl = document.getElementById('calcResult');
    if (exprEl) exprEl.textContent = _calcExpr || '';
    if (resultEl) {
        if (result !== undefined) {
            resultEl.textContent = result;
        } else {
            // Live-Vorschau
            try {
                const sanitized = _calcExpr
                    .replace(/sqrt\(/g, 'Math.sqrt(')
                    .replace(/sin\(/g, 'Math.sin(')
                    .replace(/cos\(/g, 'Math.cos(')
                    .replace(/tan\(/g, 'Math.tan(')
                    .replace(/log\(/g, 'Math.log10(');
                // eslint-disable-next-line no-new-func
                const r = Function('"use strict"; return (' + sanitized + ')')();
                resultEl.textContent = Number.isFinite(r) ? +r.toPrecision(12) : (_calcExpr || '0');
            } catch {
                resultEl.textContent = _calcExpr || '0';
            }
        }
    }
}

function _calcRenderHistory() {
    const histEl = document.getElementById('calcHistory');
    if (!histEl) return;
    if (_calcHistory.length === 0) { histEl.classList.remove('visible'); return; }
    histEl.classList.add('visible');
    histEl.innerHTML = _calcHistory.map(h => `<div class="calc-history-item">${h}</div>`).join('');
}

// ── Notizen ───────────────────────────────────────────────────────────────────
let _notesData = [];

function _notesLoad() {
    try {
        _notesData = JSON.parse(localStorage.getItem('ehoser_notes') || '[]');
    } catch { _notesData = []; }
}

function _notesSave() {
    localStorage.setItem('ehoser_notes', JSON.stringify(_notesData));
}

function _notesRender() {
    const grid = document.getElementById('notesGrid');
    const empty = document.getElementById('notesEmpty');
    if (!grid) return;
    grid.innerHTML = '';
    if (_notesData.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    _notesData.forEach((note, idx) => {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.innerHTML = `
            <input class="note-title-input" placeholder="Titel…" value="${_escapeAttr(note.title)}" oninput="notesUpdateField(${idx},'title',this.value)">
            <textarea class="note-body-input" placeholder="Notiz hier eingeben…" oninput="notesUpdateField(${idx},'content',this.value)">${_escapeHtmlText(note.content)}</textarea>
            <div class="note-footer">
                <span class="note-date">${new Date(note.created).toLocaleDateString('de-DE')}</span>
                <button class="note-delete" onclick="notesDelete(${idx})">🗑 Löschen</button>
            </div>`;
        grid.appendChild(card);
    });
}

function _escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _escapeHtmlText(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function notesAddNew() {
    _notesLoad();
    _notesData.unshift({ id: Date.now(), title: '', content: '', created: Date.now() });
    _notesSave();
    _notesRender();
    // Fokus auf den Titel der neuen Notiz
    setTimeout(() => document.querySelector('.note-title-input')?.focus(), 50);
}

function notesUpdateField(idx, field, value) {
    if (_notesData[idx]) {
        _notesData[idx][field] = value;
        _notesSave();
    }
}

function notesDelete(idx) {
    _notesData.splice(idx, 1);
    _notesSave();
    _notesRender();
}

// ═══════════════════════════════════════════════════════════════
// ██████  PASSWORT-GENERATOR
// ═══════════════════════════════════════════════════════════════
function pwdGenerate() {
    const len = parseInt(document.getElementById('pwdLen').value);
    const upper = document.getElementById('pwdUpper').checked;
    const lower = document.getElementById('pwdLower').checked;
    const nums  = document.getElementById('pwdNums').checked;
    const syms  = document.getElementById('pwdSyms').checked;
    let chars = '';
    if (upper) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (lower) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (nums)  chars += '0123456789';
    if (syms)  chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
    if (!chars) { chars = 'abcdefghijklmnopqrstuvwxyz'; }
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    let pwd = '';
    for (let i = 0; i < len; i++) pwd += chars[arr[i] % chars.length];
    document.getElementById('pwdOutput').textContent = pwd;
    // Stärke-Anzeige
    const strength = [upper, lower, nums, syms].filter(Boolean).length;
    const labels = ['', 'Schwach', 'Mittel', 'Stark', 'Sehr Stark'];
    const colors = ['', '#e53e3e', '#dd6b20', '#38a169', '#0e8a9b'];
    const el = document.getElementById('pwdStrength');
    el.textContent = labels[strength] || '';
    el.style.color = colors[strength] || '';
}
function pwdCopy() {
    const t = document.getElementById('pwdOutput').textContent;
    if (t && t !== 'Passwort erscheint hier…') {
        navigator.clipboard.writeText(t).then(() => showAlert('Passwort kopiert!', 'success'));
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  FARBPALETTEN-GENERATOR
// ═══════════════════════════════════════════════════════════════
let _paletteColors = [];
function paletteGenerate() {
    const baseH = Math.floor(Math.random() * 360);
    const schemes = ['analogous', 'complementary', 'triadic', 'splitComp', 'monochromatic'];
    const scheme = schemes[Math.floor(Math.random() * schemes.length)];
    let hues = [];
    if (scheme === 'analogous')       hues = [baseH, baseH+30, baseH+60, baseH+90, baseH+120];
    else if (scheme === 'complementary') hues = [baseH, baseH+30, baseH+60, baseH+180, baseH+210];
    else if (scheme === 'triadic')    hues = [baseH, baseH+120, baseH+240, baseH+60, baseH+180];
    else if (scheme === 'splitComp')  hues = [baseH, baseH+150, baseH+210, baseH+30, baseH+330];
    else hues = [baseH, baseH, baseH, baseH, baseH];
    const sats = scheme === 'monochromatic' ? [20, 40, 60, 80, 100] : [60, 70, 75, 65, 80];
    const lights = scheme === 'monochromatic' ? [80, 65, 50, 35, 20] : [80, 60, 45, 60, 35];
    _paletteColors = hues.map((h, i) => {
        h = ((h % 360) + 360) % 360;
        const s = sats[i], l = lights[i];
        return { hsl: `hsl(${h},${s}%,${l}%)`, hex: hslToHex(h, s, l) };
    });
    const grid = document.getElementById('paletteGrid');
    grid.innerHTML = _paletteColors.map((c, i) => `
        <div class="palette-swatch" style="background:${c.hsl};" onclick="navigator.clipboard.writeText('${c.hex}').then(()=>showAlert('${c.hex} kopiert!','success'))">
            <span class="palette-hex">${c.hex}</span>
        </div>`).join('');
}
function paletteCopyCSS() {
    const css = _paletteColors.map((c, i) => `--color-${i+1}: ${c.hex};`).join('\n');
    navigator.clipboard.writeText(`:root {\n${css}\n}`).then(() => showAlert('CSS kopiert!', 'success'));
}
function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════════════════════
// ██████  JSON FORMATTER
// ═══════════════════════════════════════════════════════════════
function jsonFormat() {
    const input = document.getElementById('jsonInput').value.trim();
    const out = document.getElementById('jsonOutput');
    const status = document.getElementById('jsonStatus');
    if (!input) { out.textContent = ''; status.textContent = ''; return; }
    try {
        const parsed = JSON.parse(input);
        out.textContent = JSON.stringify(parsed, null, 2);
        status.textContent = '✅ Gültiges JSON';
        status.style.color = '#38a169';
    } catch (e) {
        out.textContent = '';
        status.textContent = '❌ ' + e.message;
        status.style.color = '#e53e3e';
    }
}
function jsonMinify() {
    const input = document.getElementById('jsonInput').value.trim();
    const out = document.getElementById('jsonOutput');
    const status = document.getElementById('jsonStatus');
    try {
        const parsed = JSON.parse(input);
        out.textContent = JSON.stringify(parsed);
        status.textContent = '✅ Minifiziert';
        status.style.color = '#38a169';
    } catch (e) {
        status.textContent = '❌ ' + e.message;
        status.style.color = '#e53e3e';
    }
}
function jsonClear() {
    document.getElementById('jsonInput').value = '';
    document.getElementById('jsonOutput').textContent = '';
    document.getElementById('jsonStatus').textContent = '';
}

// ═══════════════════════════════════════════════════════════════
// ██████  STOPPUHR & TIMER
// ═══════════════════════════════════════════════════════════════
let _swRunning = false, _swStart = 0, _swElapsed = 0, _swTimer = null, _swLaps = [];
let _cdRunning = false, _cdTimer = null, _cdRemaining = 0;

function swSwitchTab(tab) {
    document.getElementById('swPanel').style.display = tab === 'sw' ? '' : 'none';
    document.getElementById('cdPanel').style.display = tab === 'cd' ? '' : 'none';
    document.querySelectorAll('.sw-tab').forEach(b => b.classList.toggle('active', b.textContent === (tab === 'sw' ? 'Stoppuhr' : 'Countdown')));
}
function swToggle() {
    if (_swRunning) {
        clearInterval(_swTimer);
        _swElapsed += Date.now() - _swStart;
        _swRunning = false;
        document.getElementById('swStartBtn').textContent = '▶ Start';
    } else {
        _swStart = Date.now();
        _swRunning = true;
        _swTimer = setInterval(swTick, 100);
        document.getElementById('swStartBtn').textContent = '⏸ Pause';
    }
}
function swTick() {
    const total = _swElapsed + (Date.now() - _swStart);
    const ms = Math.floor((total % 1000) / 100);
    const s  = Math.floor(total / 1000) % 60;
    const m  = Math.floor(total / 60000) % 60;
    const h  = Math.floor(total / 3600000);
    document.getElementById('swDisplay').textContent =
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${ms}`;
}
function swLap() {
    if (!_swRunning) return;
    const total = _swElapsed + (Date.now() - _swStart);
    _swLaps.push(total);
    const laps = document.getElementById('swLaps');
    const ms = Math.floor((total % 1000) / 100);
    const s  = Math.floor(total / 1000) % 60;
    const m  = Math.floor(total / 60000) % 60;
    laps.innerHTML = `<div class="sw-lap">🏁 Runde ${_swLaps.length}: ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${ms}</div>` + laps.innerHTML;
}
function swReset() {
    clearInterval(_swTimer);
    _swRunning = false; _swElapsed = 0; _swLaps = [];
    document.getElementById('swDisplay').textContent = '00:00:00.0';
    document.getElementById('swStartBtn').textContent = '▶ Start';
    document.getElementById('swLaps').innerHTML = '';
}
function cdToggle() {
    if (_cdRunning) {
        clearInterval(_cdTimer); _cdRunning = false;
        document.getElementById('cdStartBtn').textContent = '▶ Start';
    } else {
        const m = parseInt(document.getElementById('cdMin').value) || 0;
        const s = parseInt(document.getElementById('cdSec').value) || 0;
        if (_cdRemaining <= 0) _cdRemaining = m * 60000 + s * 1000;
        if (_cdRemaining <= 0) return;
        _cdRunning = true;
        document.getElementById('cdStartBtn').textContent = '⏸ Pause';
        _cdTimer = setInterval(() => {
            _cdRemaining -= 1000;
            if (_cdRemaining <= 0) {
                _cdRemaining = 0; clearInterval(_cdTimer); _cdRunning = false;
                document.getElementById('cdStartBtn').textContent = '▶ Start';
                cdTick();
                // Beep
                const ctx = new AudioContext();
                const osc = ctx.createOscillator(); osc.connect(ctx.destination);
                osc.frequency.value = 880; osc.start(); osc.stop(ctx.currentTime + 0.4);
            }
            cdTick();
        }, 1000);
    }
}
function cdTick() {
    const m = Math.floor(_cdRemaining / 60000);
    const s = Math.floor((_cdRemaining % 60000) / 1000);
    document.getElementById('cdDisplay').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function cdReset() {
    clearInterval(_cdTimer); _cdRunning = false; _cdRemaining = 0;
    document.getElementById('cdDisplay').textContent = '00:00';
    document.getElementById('cdStartBtn').textContent = '▶ Start';
}

// ═══════════════════════════════════════════════════════════════
// ██████  TEXT ENCODER / DECODER
// ═══════════════════════════════════════════════════════════════
function encUpdate() {
    const input = document.getElementById('encInput').value;
    const mode = document.querySelector('input[name="encMode"]:checked').value;
    let out = '';
    try {
        if (mode === 'b64e')   out = btoa(unescape(encodeURIComponent(input)));
        else if (mode === 'b64d') out = decodeURIComponent(escape(atob(input)));
        else if (mode === 'rot13') out = input.replace(/[a-zA-Z]/g, c => {
            const base = c <= 'Z' ? 65 : 97;
            return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
        });
        else if (mode === 'url')  out = encodeURIComponent(input);
        else if (mode === 'urld') out = decodeURIComponent(input);
    } catch (e) { out = '❌ Fehler: ' + e.message; }
    document.getElementById('encOutput').value = out;
}

// ═══════════════════════════════════════════════════════════════
// ██████  EINHEITEN-UMRECHNER
// ═══════════════════════════════════════════════════════════════
const _unitsData = {
    length:  { m:1, km:0.001, cm:100, mm:1000, mi:0.000621371, ft:3.28084, inch:39.3701, yd:1.09361 },
    weight:  { kg:1, g:1000, mg:1e6, lb:2.20462, oz:35.274, t:0.001 },
    data:    { B:1, KB:1/1024, MB:1/1024**2, GB:1/1024**3, TB:1/1024**4, bit:8 },
    speed:   { 'km/h':1, 'm/s':0.277778, 'mph':0.621371, knots:0.539957 },
    temp:    null
};
function unitsUpdateCat() {
    const cat = document.getElementById('unitsCat').value;
    const fromSel = document.getElementById('unitsFromUnit');
    const toSel   = document.getElementById('unitsToUnit');
    let keys = [];
    if (cat === 'temp') keys = ['°C','°F','K'];
    else keys = Object.keys(_unitsData[cat]);
    const opts = keys.map(k => `<option value="${k}">${k}</option>`).join('');
    fromSel.innerHTML = opts; toSel.innerHTML = opts;
    if (keys.length > 1) toSel.selectedIndex = 1;
    unitsConvert();
}
function unitsConvert() {
    const cat = document.getElementById('unitsCat').value;
    const val = parseFloat(document.getElementById('unitsFrom').value);
    const from = document.getElementById('unitsFromUnit').value;
    const to   = document.getElementById('unitsToUnit').value;
    if (isNaN(val)) return;
    let result;
    if (cat === 'temp') {
        let celsius;
        if (from === '°C') celsius = val;
        else if (from === '°F') celsius = (val - 32) * 5/9;
        else celsius = val - 273.15;
        if (to === '°C') result = celsius;
        else if (to === '°F') result = celsius * 9/5 + 32;
        else result = celsius + 273.15;
    } else {
        const table = _unitsData[cat];
        const base = val / table[from];
        result = base * table[to];
    }
    document.getElementById('unitsTo').value = parseFloat(result.toPrecision(7));
}

// ═══════════════════════════════════════════════════════════════
// ██████  ZUFALLSGENERATOR
// ═══════════════════════════════════════════════════════════════
function rngRollDice() {
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    const val = (arr[0] % 6) + 1;
    const faces = ['', '⚀','⚁','⚂','⚃','⚄','⚅'];
    document.getElementById('rngDice').textContent = faces[val] + ' ' + val;
}
function rngRollNum() {
    const min = parseInt(document.getElementById('rngMin').value) || 1;
    const max = parseInt(document.getElementById('rngMax').value) || 100;
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    document.getElementById('rngNum').textContent = min + (arr[0] % (max - min + 1));
}
function rngFlipCoin() {
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    document.getElementById('rngCoin').textContent = arr[0] % 2 === 0 ? '🪙 Kopf' : '🪙 Zahl';
}
function rngPickName() {
    const lines = document.getElementById('rngNameList').value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    document.getElementById('rngName').textContent = '🎉 ' + lines[arr[0] % lines.length];
}

// ═══════════════════════════════════════════════════════════════
// ██████  TON-GENERATOR
// ═══════════════════════════════════════════════════════════════
let _toneCtx = null, _toneOsc = null, _toneGain = null, _tonePlaying = false;
function toneUpdate() {
    const freq = parseFloat(document.getElementById('toneFreq').value);
    const vol  = parseFloat(document.getElementById('toneVol').value);
    const wave = document.getElementById('toneWave').value;
    document.getElementById('toneFreqLabel').textContent = freq + ' Hz';
    if (_toneOsc) { _toneOsc.frequency.value = freq; _toneOsc.type = wave; }
    if (_toneGain) _toneGain.gain.value = vol;
}
function toneSetFreq(f) {
    document.getElementById('toneFreq').value = f;
    toneUpdate();
}
function toneToggle() {
    if (_tonePlaying) {
        _toneOsc?.stop();
        _toneOsc = null;
        _tonePlaying = false;
        document.getElementById('tonePlayBtn').textContent = '▶ Play';
    } else {
        _toneCtx = _toneCtx || new AudioContext();
        _toneGain = _toneCtx.createGain();
        _toneGain.gain.value = parseFloat(document.getElementById('toneVol').value);
        _toneGain.connect(_toneCtx.destination);
        _toneOsc = _toneCtx.createOscillator();
        _toneOsc.type = document.getElementById('toneWave').value;
        _toneOsc.frequency.value = parseFloat(document.getElementById('toneFreq').value);
        _toneOsc.connect(_toneGain);
        _toneOsc.start();
        _tonePlaying = true;
        document.getElementById('tonePlayBtn').textContent = '⏹ Stop';
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  ZEICHENPAD
// ═══════════════════════════════════════════════════════════════
let _drawCtx = null, _drawTool = 'pen', _drawMouseDown = false;
function drawInit() {
    const canvas = document.getElementById('drawCanvas');
    if (_drawCtx) return;
    canvas.width = canvas.offsetWidth || 800;
    canvas.height = canvas.offsetHeight || 500;
    _drawCtx = canvas.getContext('2d');
    _drawCtx.fillStyle = '#1a2332';
    _drawCtx.fillRect(0, 0, canvas.width, canvas.height);
    const getPos = (e) => {
        const r = canvas.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const down = (e) => { _drawMouseDown = true; const p = getPos(e); _drawCtx.beginPath(); _drawCtx.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e) => {
        if (!_drawMouseDown) return;
        const p = getPos(e);
        _drawCtx.lineWidth = document.getElementById('drawSize').value;
        _drawCtx.lineCap = 'round';
        if (_drawTool === 'eraser') { _drawCtx.globalCompositeOperation = 'destination-out'; _drawCtx.strokeStyle = 'rgba(0,0,0,1)'; }
        else { _drawCtx.globalCompositeOperation = 'source-over'; _drawCtx.strokeStyle = document.getElementById('drawColor').value; }
        _drawCtx.lineTo(p.x, p.y); _drawCtx.stroke(); e.preventDefault();
    };
    const up = () => { _drawMouseDown = false; };
    canvas.addEventListener('mousedown', down); canvas.addEventListener('mousemove', move); canvas.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, {passive:false}); canvas.addEventListener('touchmove', move, {passive:false}); canvas.addEventListener('touchend', up);
}
function drawSetTool(t) { _drawTool = t; }
function drawClear() { if (_drawCtx) { const c = document.getElementById('drawCanvas'); _drawCtx.globalCompositeOperation = 'source-over'; _drawCtx.fillStyle = '#1a2332'; _drawCtx.fillRect(0, 0, c.width, c.height); } }
function drawExport() {
    const canvas = document.getElementById('drawCanvas');
    const a = document.createElement('a'); a.download = 'zeichnung.png'; a.href = canvas.toDataURL(); a.click();
}

// ═══════════════════════════════════════════════════════════════
// ██████  HABIT TRACKER
// ═══════════════════════════════════════════════════════════════
let _habits = [];
function habitsLoad() { try { _habits = JSON.parse(localStorage.getItem('ehoser_habits') || '[]'); } catch(e) { _habits = []; } }
function habitsSave() { localStorage.setItem('ehoser_habits', JSON.stringify(_habits)); }
function habitsRender() {
    habitsLoad();
    const today = new Date().toISOString().split('T')[0];
    const grid = document.getElementById('habitsGrid');
    const empty = document.getElementById('habitsEmpty');
    if (!_habits.length) { grid.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    grid.innerHTML = _habits.map((h, i) => {
        const doneTodday = h.daysCompleted && h.daysCompleted.includes(today);
        return `<div class="habit-card ${doneTodday ? 'habit-done' : ''}">
            <div class="habit-name">${escapeHtml(h.name)}</div>
            <div class="habit-streak">🔥 ${h.streak || 0} Tage Streak</div>
            <div class="habit-actions">
                <button class="btn-primary" onclick="habitToggle(${i})">${doneTodday ? '✅ Erledigt' : '⬜ Heute erledigen'}</button>
                <button class="btn-secondary" onclick="habitDelete(${i})">🗑</button>
            </div>
        </div>`;
    }).join('');
}
function habitAdd() {
    const name = prompt('Gewohnheit (z.B. Sport, Lesen, Wasser trinken):');
    if (!name || !name.trim()) return;
    habitsLoad();
    _habits.push({ name: name.trim(), streak: 0, daysCompleted: [] });
    habitsSave(); habitsRender();
}
function habitToggle(i) {
    habitsLoad();
    const today = new Date().toISOString().split('T')[0];
    const h = _habits[i];
    if (!h.daysCompleted) h.daysCompleted = [];
    if (h.daysCompleted.includes(today)) {
        h.daysCompleted = h.daysCompleted.filter(d => d !== today);
        h.streak = Math.max(0, (h.streak || 1) - 1);
    } else {
        h.daysCompleted.push(today);
        h.streak = (h.streak || 0) + 1;
    }
    habitsSave(); habitsRender();
}
function habitDelete(i) {
    habitsLoad();
    _habits.splice(i, 1);
    habitsSave(); habitsRender();
}

// ═══════════════════════════════════════════════════════════════
// ██████  TEXT TOOLS
// ═══════════════════════════════════════════════════════════════
function ttUpdate() {
    const v = document.getElementById('ttInput').value;
    const words = v.trim() ? v.trim().split(/\s+/).length : 0;
    document.getElementById('ttStats').textContent = `Wörter: ${words} · Zeichen: ${v.length} · Zeilen: ${v.split('\n').length}`;
}
function ttTransform(action) {
    const el = document.getElementById('ttInput');
    let v = el.value;
    if (action === 'upper')  v = v.toUpperCase();
    else if (action === 'lower')  v = v.toLowerCase();
    else if (action === 'title')  v = v.replace(/\b\w/g, c => c.toUpperCase());
    else if (action === 'reverse') v = v.split('').reverse().join('');
    else if (action === 'trim')   v = v.split('\n').map(l => l.trim()).join('\n');
    else if (action === 'nodup')  v = [...new Set(v.split('\n'))].join('\n');
    else if (action === 'slug')   v = v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    el.value = v;
    ttUpdate();
}

// ═══════════════════════════════════════════════════════════════
// ██████  GRADIENT GENERATOR
// ═══════════════════════════════════════════════════════════════
function gradUpdate() {
    const type  = document.getElementById('gradType').value;
    const angle = document.getElementById('gradAngle').value;
    document.getElementById('gradAngleLabel').textContent = angle + '°';
    const c1 = document.getElementById('gradC1').value;
    const c2 = document.getElementById('gradC2').value;
    const c3 = document.getElementById('gradC3').value;
    let css;
    if (type === 'linear')       css = `linear-gradient(${angle}deg, ${c1}, ${c2}, ${c3})`;
    else if (type === 'radial')  css = `radial-gradient(circle, ${c1}, ${c2}, ${c3})`;
    else                          css = `conic-gradient(from ${angle}deg, ${c1}, ${c2}, ${c3})`;
    document.getElementById('gradPreview').style.background = css;
    document.getElementById('gradCode').textContent = `background: ${css};`;
}

// ═══════════════════════════════════════════════════════════════
// ██████  JS SANDBOX
// ═══════════════════════════════════════════════════════════════
function sandboxRun() {
    const code = document.getElementById('sandboxInput').value;
    const out  = document.getElementById('sandboxOutput');
    const logs = [];
    const fakeConsole = { log: (...a) => logs.push(a.map(x => typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x)).join(' ')), warn: (...a) => logs.push('⚠️ ' + a.join(' ')), error: (...a) => logs.push('❌ ' + a.join(' ')) };
    try {
        const fn = new Function('console', code);
        const ret = fn(fakeConsole);
        if (ret !== undefined) logs.push('→ ' + (typeof ret === 'object' ? JSON.stringify(ret, null, 2) : String(ret)));
        out.innerHTML = logs.map(l => `<div class="sandbox-line">${escapeHtml(l)}</div>`).join('') || '<div class="sandbox-line" style="color:#8ab4c9;">Kein Output</div>';
    } catch(e) {
        out.innerHTML = `<div class="sandbox-line" style="color:#e53e3e;">❌ ${escapeHtml(e.message)}</div>`;
    }
}
function sandboxClear() {
    document.getElementById('sandboxInput').value = '';
    document.getElementById('sandboxOutput').innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════
// ██████  REGEX TESTER
// ═══════════════════════════════════════════════════════════════
function regexTest() {
    const pattern = document.getElementById('regexPattern').value;
    const flags   = document.getElementById('regexFlags').value;
    const text    = document.getElementById('regexInput').value;
    const hl      = document.getElementById('regexHighlight');
    const matches = document.getElementById('regexMatches');
    if (!pattern) { hl.innerHTML = escapeHtml(text); matches.textContent = ''; return; }
    try {
        const re = new RegExp(pattern, flags);
        const found = [...text.matchAll(re)];
        hl.innerHTML = escapeHtml(text).replace(new RegExp(escapeHtml(pattern), flags), m => `<mark class="regex-mark">${m}</mark>`);
        matches.textContent = found.length ? `${found.length} Match${found.length > 1 ? 'es' : ''}: ${found.map(m => '"' + m[0] + '"').slice(0, 10).join(', ')}` : 'Keine Matches';
        matches.style.color = found.length ? '#38a169' : '#e53e3e';
    } catch(e) {
        hl.textContent = '';
        matches.textContent = '❌ ' + e.message;
        matches.style.color = '#e53e3e';
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  GLÜCKSRAD
// ═══════════════════════════════════════════════════════════════
let _wheelAngle = 0, _wheelSpinning = false;
const _wheelColors = ['#0e8a9b','#f47c2a','#a855f7','#38a169','#e53e3e','#ecc94b','#3182ce','#dd6b20','#2f855a','#b794f4'];
function wheelDraw() {
    const canvas = document.getElementById('wheelCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const entries = document.getElementById('wheelEntries').value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!entries.length) return;
    const cx = canvas.width / 2, cy = canvas.height / 2, r = Math.min(cx, cy) - 10;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const step = (Math.PI * 2) / entries.length;
    entries.forEach((e, i) => {
        const start = _wheelAngle + i * step, end = start + step;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, end);
        ctx.fillStyle = _wheelColors[i % _wheelColors.length];
        ctx.fill(); ctx.strokeStyle = '#1a2332'; ctx.lineWidth = 2; ctx.stroke();
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(start + step / 2);
        ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(10, 16 - entries.length)}px "Space Grotesk"`;
        ctx.fillText(e.length > 12 ? e.slice(0, 12) + '…' : e, r - 10, 5);
        ctx.restore();
    });
    // Pointer
    ctx.beginPath(); ctx.moveTo(cx + r - 5, cy - 8); ctx.lineTo(cx + r + 15, cy); ctx.lineTo(cx + r - 5, cy + 8);
    ctx.fillStyle = '#fff'; ctx.fill();
}
function wheelSpin() {
    if (_wheelSpinning) return;
    const entries = document.getElementById('wheelEntries').value.split('\n').map(l => l.trim()).filter(Boolean);
    if (entries.length < 2) return;
    _wheelSpinning = true;
    document.getElementById('wheelSpinBtn').disabled = true;
    document.getElementById('wheelResult').textContent = '';
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    const totalRot = (Math.PI * 2 * (5 + arr[0] % 5)) + (Math.PI * 2 * (arr[0] % entries.length) / entries.length);
    const duration = 3000 + arr[0] % 2000;
    const start = performance.now(); const startAngle = _wheelAngle;
    function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 4);
        _wheelAngle = startAngle + totalRot * ease;
        wheelDraw();
        if (t < 1) { requestAnimationFrame(frame); }
        else {
            _wheelSpinning = false;
            document.getElementById('wheelSpinBtn').disabled = false;
            const step = (Math.PI * 2) / entries.length;
            const norm = ((-_wheelAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const idx = Math.floor(norm / step) % entries.length;
            document.getElementById('wheelResult').textContent = '🎉 ' + entries[(entries.length - 1 - idx + entries.length) % entries.length];
        }
    }
    requestAnimationFrame(frame);
}

// ═══════════════════════════════════════════════════════════════
// ██████  HASH GENERATOR
// ═══════════════════════════════════════════════════════════════
async function hashUpdate() {
    const text = document.getElementById('hashInput').value;
    const results = document.getElementById('hashResults');
    if (!text) { results.innerHTML = ''; return; }
    const enc = new TextEncoder();
    const data = enc.encode(text);
    const algos = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
    const hashes = await Promise.all(algos.map(async alg => {
        const buf = await crypto.subtle.digest(alg, data);
        const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
        return { alg, hex };
    }));
    results.innerHTML = hashes.map(h => `
        <div class="hash-row">
            <span class="hash-algo">${h.alg}</span>
            <code class="hash-val">${h.hex}</code>
            <button class="btn-secondary" onclick="navigator.clipboard.writeText('${h.hex}').then(()=>showAlert('${h.alg} kopiert!','success'))">📋</button>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// ██████  TIPP-TEST
// ═══════════════════════════════════════════════════════════════
const _typingTexts = [
    'Der schnelle braune Fuchs springt über den faulen Hund. Packe jetzt zwölf Boxkämpfer und halte sie zurück.',
    'Technologie verändert die Welt schneller als je zuvor. Jeden Tag entstehen neue Innovationen die unser Leben revolutionieren.',
    'ehoser ist eine Plattform für Kreativität und Technologie. Hier findest du Tools die deinen Alltag einfacher machen.',
    'JavaScript ist eine der beliebtesten Programmiersprachen der Welt. Mit ihr lassen sich moderne Webanwendungen entwickeln.',
    'Musik ist die universelle Sprache der Menschheit. Sie verbindet Kulturen und Generationen auf der ganzen Welt.'
];
let _typingWords = [], _typingIdx = 0, _typingTimer = null, _typingSeconds = 60, _typingStarted = false, _typingCorrect = 0, _typingTotal = 0;
function typingReset() {
    clearInterval(_typingTimer);
    _typingStarted = false; _typingSeconds = 60; _typingIdx = 0; _typingCorrect = 0; _typingTotal = 0;
    const arr = new Uint32Array(1); crypto.getRandomValues(arr);
    const text = _typingTexts[arr[0] % _typingTexts.length];
    _typingWords = text.split(' ');
    document.getElementById('typingTime').textContent = '60';
    document.getElementById('typingWPM').textContent = '0';
    document.getElementById('typingAcc').textContent = '100';
    document.getElementById('typingInput').value = '';
    document.getElementById('typingInput').disabled = false;
    document.getElementById('typingResult').textContent = '';
    typingRenderWords();
}
function typingRenderWords() {
    const el = document.getElementById('typingWords');
    el.innerHTML = _typingWords.map((w, i) => `<span class="tw${i === _typingIdx ? ' tw-cur' : (i < _typingIdx ? ' tw-done' : '')}">${escapeHtml(w)}</span>`).join(' ');
    const cur = el.querySelector('.tw-cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function typingCheck() {
    if (!_typingStarted) {
        _typingStarted = true;
        _typingTimer = setInterval(() => {
            _typingSeconds--;
            document.getElementById('typingTime').textContent = _typingSeconds;
            const elapsed = 60 - _typingSeconds;
            if (elapsed > 0) document.getElementById('typingWPM').textContent = Math.round(_typingCorrect / (elapsed / 60));
            if (_typingSeconds <= 0) {
                clearInterval(_typingTimer);
                document.getElementById('typingInput').disabled = true;
                const acc = _typingTotal ? Math.round(_typingCorrect / _typingTotal * 100) : 0;
                document.getElementById('typingResult').textContent = `Fertig! ${_typingCorrect} WPM · ${acc}% Genauigkeit`;
            }
        }, 1000);
    }
    const input = document.getElementById('typingInput').value;
    if (input.endsWith(' ') || input === _typingWords[_typingIdx]) {
        const typed = input.trim();
        _typingTotal++;
        if (typed === _typingWords[_typingIdx]) _typingCorrect++;
        _typingIdx++;
        document.getElementById('typingInput').value = '';
        if (_typingIdx >= _typingWords.length) {
            clearInterval(_typingTimer);
            document.getElementById('typingInput').disabled = true;
            const elapsed = Math.max(1, 60 - _typingSeconds);
            const acc = Math.round(_typingCorrect / _typingTotal * 100);
            document.getElementById('typingWPM').textContent = Math.round(_typingCorrect / (elapsed / 60));
            document.getElementById('typingResult').textContent = `🎉 Text abgeschlossen! ${Math.round(_typingCorrect / (elapsed / 60))} WPM · ${acc}% Genauigkeit`;
        }
        typingRenderWords();
    }
}

// ═══════════════════════════════════════════════════════════════
// ██████  KAMERA
// ═══════════════════════════════════════════════════════════════
let _cameraStream = null, _cameraFacing = 'user';
async function cameraStart() {
    if (_cameraStream) { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
    try {
        _cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: _cameraFacing }, audio: false });
        const video = document.getElementById('cameraVideo');
        video.srcObject = _cameraStream;
        document.getElementById('cameraCanvas').style.display = 'none';
        video.style.display = '';
        document.getElementById('cameraSaveBtn').style.display = 'none';
    } catch(e) {
        showAlert('Kamera konnte nicht gestartet werden: ' + e.message, 'error');
    }
}
function cameraFlip() {
    _cameraFacing = _cameraFacing === 'user' ? 'environment' : 'user';
    cameraStart();
}
function cameraSnap() {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const filter = document.getElementById('cameraFilter').value;
    ctx.filter = filter || 'none';
    ctx.drawImage(video, 0, 0);
    canvas.style.display = '';
    video.style.display = 'none';
    document.getElementById('cameraSaveBtn').style.display = '';
}
function cameraApplyFilter() {
    const video = document.getElementById('cameraVideo');
    video.style.filter = document.getElementById('cameraFilter').value;
}
function cameraSave() {
    const canvas = document.getElementById('cameraCanvas');
    const a = document.createElement('a'); a.download = 'foto.png'; a.href = canvas.toDataURL(); a.click();
}

// ═══════════════════════════════════════════════════════════════
// ██████  COUNTDOWN
// ═══════════════════════════════════════════════════════════════
let _cdEventTimer = null;
function cdStart() {
    clearInterval(_cdEventTimer);
    const name = document.getElementById('cdEventName').value.trim() || 'Event';
    const target = new Date(document.getElementById('cdTargetDate').value).getTime();
    if (!target || isNaN(target)) { showAlert('Bitte ein gültiges Datum wählen.', 'error'); return; }
    document.getElementById('cdEventLabel').textContent = '⏳ bis ' + name;
    document.getElementById('cdTimerDisplay').style.display = '';
    const tick = () => {
        const diff = target - Date.now();
        if (diff <= 0) {
            clearInterval(_cdEventTimer);
            document.getElementById('cdTimerDisplay').innerHTML = '<span style="color:#38a169;font-size:2rem;">🎉 Jetzt!</span>';
            return;
        }
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        document.getElementById('cdTimerDisplay').innerHTML =
            `<span class="cd-unit"><strong>${d}</strong><small>Tage</small></span>
             <span class="cd-sep">:</span>
             <span class="cd-unit"><strong>${String(h).padStart(2,'0')}</strong><small>Std</small></span>
             <span class="cd-sep">:</span>
             <span class="cd-unit"><strong>${String(m).padStart(2,'0')}</strong><small>Min</small></span>
             <span class="cd-sep">:</span>
             <span class="cd-unit"><strong>${String(s).padStart(2,'0')}</strong><small>Sek</small></span>`;
    };
    tick(); _cdEventTimer = setInterval(tick, 1000);
}

// ═══════════════════════════════════════════════════════════════
// ██████  METRONOM
// ═══════════════════════════════════════════════════════════════
let _metroCtx = null, _metroRunning = false, _metroBeat = 0, _metroBeats = 4, _metroNext = 0, _metroWorker = null;
function metroInit() {
    metroRenderDots();
}
function metroUpdateBpm() {
    const bpm = document.getElementById('metroBpm').value;
    document.getElementById('metroBpmDisplay').textContent = bpm + ' BPM';
    if (_metroRunning) { metroStop(); metroStart(); }
}
function metroUpdateBeats() {
    _metroBeats = parseInt(document.getElementById('metroBeats').value);
    _metroBeat = 0;
    metroRenderDots();
}
function metroRenderDots() {
    const dots = document.getElementById('metroDots');
    dots.innerHTML = Array.from({length: _metroBeats}, (_, i) =>
        `<div class="metro-dot ${i === _metroBeat ? 'metro-dot-active' : ''}" id="metroDot${i}"></div>`).join('');
}
function metroToggle() {
    if (_metroRunning) metroStop(); else metroStart();
}
function metroStart() {
    _metroCtx = _metroCtx || new AudioContext();
    _metroRunning = true; _metroBeat = 0;
    document.getElementById('metroStartBtn').textContent = '⏹ Stop';
    const bpm = parseInt(document.getElementById('metroBpm').value);
    const interval = 60 / bpm * 1000;
    metroClick();
    _metroWorker = setInterval(() => {
        _metroBeat = (_metroBeat + 1) % _metroBeats;
        metroRenderDots();
        metroClick();
    }, interval);
}
function metroStop() {
    clearInterval(_metroWorker); _metroRunning = false;
    document.getElementById('metroStartBtn').textContent = '▶ Start';
}
function metroClick() {
    if (!_metroCtx) return;
    const osc = _metroCtx.createOscillator();
    const gain = _metroCtx.createGain();
    osc.connect(gain); gain.connect(_metroCtx.destination);
    osc.frequency.value = _metroBeat === 0 ? 1000 : 800;
    gain.gain.setValueAtTime(0.3, _metroCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _metroCtx.currentTime + 0.1);
    osc.start(_metroCtx.currentTime); osc.stop(_metroCtx.currentTime + 0.1);
}

function inviteClassToWebsite() {
    const text = `Hey, schau dir meine ehoser Seite an: ${window.location.origin}`;
    navigator.clipboard.writeText(text).then(() => {
        showAlert('Einladung kopiert. Schick den Text an deine Klasse.', 'success');
    }).catch(() => {
        showAlert('Kopieren fehlgeschlagen.', 'error');
    });
}

async function chatOpenGroupManage() {
    if (!_chatCurrentGroupId) return;
    const group = _chatGroups.find(g => g.id === _chatCurrentGroupId);
    if (!group || !group.is_admin) {
        showAlert('Nur Gruppenadmins können verwalten.', 'error');
        return;
    }
    const action = window.prompt(
        'Gruppenverwaltung:\n1 = Beschreibung setzen\n2 = Gruppenbild setzen\n3 = Mitglied hinzufügen\n4 = Mitglied entfernen\n5 = Nutzer zum Admin machen\n6 = Namen ändern\n7 = Gruppe löschen\n8 = Gruppe melden\nBitte Zahl eingeben:'
    );
    if (!action) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    const postGroupSettings = async (payload) => {
        const res = await fetch(`${API_BASE}/chat/groups/${_chatCurrentGroupId}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Gruppeneinstellung konnte nicht gespeichert werden');
    };

    try {
        if (action === '1') {
            const description = window.prompt('Neue Gruppenbeschreibung:', group.description || '') || '';
            await postGroupSettings({ description });
        } else if (action === '2') {
            const mode = (window.prompt('Gruppenbild setzen:\n1 = Bild hochladen\n2 = URL eingeben\nBitte Zahl eingeben:', '1') || '1').trim();
            let photoUrl = '';
            if (mode === '1') {
                const file = await _chatPickImageFile();
                if (!file) return;
                if (!file.type.startsWith('image/')) {
                    showAlert('Nur Bilder sind erlaubt.', 'error');
                    return;
                }
                const fd = new FormData();
                fd.append('file', file);
                const uploadRes = await fetch(`${API_BASE}/chat/upload`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                    body: fd
                });
                const uploadData = await uploadRes.json().catch(() => ({}));
                if (!uploadRes.ok) throw new Error(uploadData.error || 'Bild-Upload fehlgeschlagen');
                photoUrl = String(uploadData.url || '').trim();
            } else {
                photoUrl = window.prompt('Neue Gruppenfoto URL:', group.photo_url || '') || '';
            }
            await postGroupSettings({ photoUrl });
        } else if (action === '3') {
            const username = (window.prompt('Nutzername zum Hinzufügen:') || '').trim();
            if (!username) return;
            const res = await fetch(`${API_BASE}/chat/groups/${_chatCurrentGroupId}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ username, encryptedGroupKey: 'plain' })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Mitglied konnte nicht hinzugefügt werden');
        } else if (action === '4') {
            const username = (window.prompt('Nutzername zum Entfernen:') || '').trim();
            if (!username) return;
            const res = await fetch(`${API_BASE}/chat/groups/${_chatCurrentGroupId}/members/${encodeURIComponent(username)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Mitglied konnte nicht entfernt werden');
        } else if (action === '5') {
            const username = (window.prompt('Nutzername als Admin:') || '').trim();
            if (!username) return;
            const res = await fetch(`${API_BASE}/chat/groups/${_chatCurrentGroupId}/admins`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ username })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Admin konnte nicht gesetzt werden');
        } else if (action === '6') {
            const name = (window.prompt('Neuer Gruppenname:', group.name || _chatCurrentGroupName) || '').trim();
            if (!name) return;
            await postGroupSettings({ name });
        } else if (action === '7') {
            const ok = window.confirm(`Gruppe "${group.name || _chatCurrentGroupName}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`);
            if (!ok) return;
            const res = await fetch(`${API_BASE}/chat/groups/${_chatCurrentGroupId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Gruppe konnte nicht gelöscht werden');

            clearInterval(_chatPollInterval);
            _chatCurrentGroupId = null;
            _chatCurrentGroupName = '';
            document.getElementById('chatConv').style.display = 'none';
            document.getElementById('chatEmptyState').style.display = 'flex';

            await chatLoadGroups();
            showAlert('Gruppe wurde gelöscht.', 'success');
            return;
        } else if (action === '8') {
            await chatReportCurrentGroup();
            return;
        } else {
            return;
        }

        await chatLoadGroups();
        const refreshed = _chatGroups.find(g => g.id === _chatCurrentGroupId);
        openChatGroup(_chatCurrentGroupId, refreshed?.name || _chatCurrentGroupName);
        showAlert('Gruppenverwaltung aktualisiert.', 'success');
    } catch (err) {
        showAlert(err?.message || 'Aktion fehlgeschlagen.', 'error');
    }
}

async function chatReportCurrentGroup() {
    if (!_chatCurrentGroupId) {
        showAlert('Bitte erst eine Gruppe öffnen.', 'error');
        return;
    }
    const token = localStorage.getItem('token');
    if (!token) return;

    const targetUsername = (window.prompt('Optional: Nutzername gegen den sich die Meldung richtet:', '') || '').trim();
    const reason = (window.prompt('Grund der Meldung (optional):', '') || '').trim();

    try {
        const res = await fetch(`${API_BASE}/chat/groups/${_chatCurrentGroupId}/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ targetUsername, reason })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Meldung fehlgeschlagen');
        showAlert(`Meldung gesendet (ID ${data.reportId}).`, 'success');
    } catch (err) {
        showAlert(err?.message || 'Meldung konnte nicht gesendet werden.', 'error');
    }
}

const SUPPORT_SYSTEM_PROMPT = `Du bist Ehoser Support, der hilfreiche Support-Mitarbeiter fuer Ehoser und das Ehoser Control Center.
Du sprichst im Namen des Ehoser Supports. Erwaehne nicht ungefragt, dass du automatisiert bist. Wenn jemand direkt fragt, ob du ein Mensch bist, antworte ehrlich und kurz: "Ich bin der digitale Ehoser Support und helfe dir so gut wie moeglich weiter." Behaupte niemals, ein echter Mensch, Admin oder Entwickler zu sein.

Ton:
- Deutsch, freundlich, direkt, ruhig und hilfreich.
- Kurz und praktisch antworten, meistens 2 bis 5 Saetze.
- Bei Stress oder Frust des Nutzers ruhig bleiben und konkrete Schritte geben.
- Keine geheimen Codes, Admin-Codes, Tokens, API Keys oder Environment Variables verraten.
- Nutzer niemals auffordern, Passwort, Login-Code oder Token in den Chat zu schreiben.
- Wenn etwas nur Admins pruefen koennen, sage: "Das muss ein Admin pruefen."

Wissen ueber Ehoser:
- Ehoser ist ein Control Center als Web-App und Desktop-App.
- Die Desktop-App heisst Ehoser Control Center und wird als EXE/Installer ausgeliefert.
- Die Desktop-App nutzt fuer Online-Funktionen die API von ehoser.de. Vercel Environment Variables bleiben serverseitig und werden nicht direkt in der EXE gespeichert.
- Manche Bereiche sind offline nutzbar, Online-Funktionen brauchen Internet.
- Es gibt Anmeldung, Registrierung, Entsperrcode, Passwort, Login-Code, Google-Anmeldung in der Web-App und Desktop-Anmeldung ueber Web-App-Code.
- Desktop-Web-Login: In der Desktop-App Code anzeigen, in der Web-App mit Google anmelden, Account Einstellungen oeffnen, Code bei "Anmelden mit Web-App" eingeben und Anwenden klicken.
- Account Einstellungen enthalten Profil, Anzeigename, Profilbild, KI-Personalisierung, Referral/Einladung, Login-Code, Chat Token und Desktop-Web-App-Verknuepfung.
- Pro/Premium: Premium schaltet Pro-Funktionen mit frei. Pro kann Face Warp Pro, bessere Exporte, Sticker, bestimmte Tools, Chat-Extras und Spiel-Erstellen freischalten.
- Face Warp hat Basics und Pro. Basics hat normale Warp-Tools und begrenzte Exporte. Pro hat bessere Qualitaet, Pixabay, Sticker-Modus und mehr Export.
- Ehoser Chat bietet Chats, Gruppen, Dateien/Bilder, Face-Warp-Bilder, Pro Sticker und Meldungen.
- Ehoser KI hat Ehoser 1 und Premium Ehoser. Premium Ehoser braucht Premium.
- Tools/Spiele enthalten Online-Spiele, KI, Chat, Maps, YouTube/Medien, News, Bilder, Wetter, Texttools, QR, Rechner, Notizen, Passworttools, Timer, Spiele und weitere Browser-Tools.
- Desktop-Updates erscheinen oben rechts als "Update herunterladen" und zeigen Dateigroesse, Geschwindigkeit und Fortschritt.
- Admin-Bereich ist nur fuer Admins. Keine Admin-Interna oder Umgehungen erklaeren.
- Moderation kann Warnungen, Sperren oder Account-Loeschungen anzeigen. Bei Einspruch muss ein Admin pruefen.

Problemloesung:
- Wenn Login nicht gespeichert bleibt: aktuelle Desktop-Version installieren, App komplett schliessen, neu anmelden, App neu starten, ggf. Sicherheitssoftware/AppData-Speicher pruefen.
- Wenn Google nicht geht: Entsperrcode pruefen, Web-App nutzen, Server-Konfiguration/GOOGLE_CLIENT_ID kann fehlen.
- Wenn Face Warp laggt: kleineres Bild, andere Tabs schliessen, App/Browser neu starten, aktuelle Version nutzen, Basics testen.
- Wenn "Verlassen" nicht ins Hauptmenue fuehrt: aktuelle Version nutzen, genaue Schritte/Tool-Namen abfragen.
- Wenn Chat nicht geht: Internet, Login, Gruppe/Chat-Schluessel und Neu laden pruefen.
- Wenn Pro nicht erkannt wird: neu anmelden, App neu starten, Internet pruefen, Account vom Admin pruefen lassen.

Wenn der Nutzer unklar schreibt, frage maximal 2 konkrete Rueckfragen: Web oder Desktop? Welche Meldung steht da?`;

let _supportReason = '';
let _supportHistory = [];
let _supportConnectingTimer = null;
let _supportIsSending = false;

function supportShowStage(stage) {
    ['supportLoading', 'supportReasons', 'supportConnecting', 'supportChat'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === stage ? (id === 'supportChat' ? 'flex' : 'flex') : 'none';
    });
}

function openSupport() {
    const modal = document.getElementById('supportModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    supportShowStage('supportLoading');
    clearInterval(_supportConnectingTimer);
    setTimeout(() => {
        if (!modal.classList.contains('show')) return;
        if (!_supportReason) supportShowStage('supportReasons');
        else supportShowStage('supportChat');
    }, 900);
}

function closeSupport() {
    const modal = document.getElementById('supportModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

function selectSupportReason(reason) {
    _supportReason = reason || 'Sonstiges';
    supportShowStage('supportConnecting');
    const bar = document.getElementById('supportConnectBar');
    if (bar) bar.style.width = '0%';
    clearInterval(_supportConnectingTimer);
    const started = Date.now();
    _supportConnectingTimer = setInterval(() => {
        const elapsed = Date.now() - started;
        const percent = Math.min(100, Math.round((elapsed / 10000) * 100));
        if (bar) bar.style.width = `${percent}%`;
        if (elapsed >= 10000) {
            clearInterval(_supportConnectingTimer);
            startSupportChat();
        }
    }, 180);
}

function startSupportChat() {
    supportShowStage('supportChat');
    if (!_supportHistory.length) {
        const greeting = `Hallo, hier ist der Ehoser Support. Ich sehe, es geht um ${_supportReason || 'Support'}. Beschreiben Sie kurz, was genau passiert ist.`;
        appendSupportBubble('agent', greeting);
        _supportHistory.push({ role: 'assistant', content: greeting });
    }
}

function appendSupportBubble(type, text) {
    const messages = document.getElementById('supportMessages');
    if (!messages) return null;
    const div = document.createElement('div');
    div.className = `support-bubble support-bubble-${type}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
}

function supportInputKey(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendSupportMessage();
    }
}

function supportSetTyping(active) {
    const typing = document.getElementById('supportTyping');
    if (typing) typing.style.display = active ? 'block' : 'none';
    const messages = document.getElementById('supportMessages');
    if (messages) messages.scrollTop = messages.scrollHeight;
}

function supportHumanDelay(text) {
    const chars = String(text || '').length;
    return Math.min(8500, Math.max(1800, 900 + chars * 38 + Math.random() * 1200));
}

async function sendSupportMessage() {
    if (_supportIsSending) return;
    const input = document.getElementById('supportInput');
    const sendBtn = document.getElementById('supportSendBtn');
    const text = (input?.value || '').trim();
    if (!text) return;

    input.value = '';
    _supportIsSending = true;
    if (sendBtn) sendBtn.disabled = true;
    appendSupportBubble('user', text);

    const userContext = `Support-Grund: ${_supportReason || 'Sonstiges'}\nDesktop-Modus: ${isDesktopMode() ? 'ja' : 'nein'}\nAngemeldet: ${localStorage.getItem('token') ? 'ja' : 'nein'}\nNachricht: ${text}`;
    _supportHistory.push({ role: 'user', content: userContext });
    supportSetTyping(true);

    try {
        const token = localStorage.getItem('token');
        const supportMessages = [
            { role: 'system', content: SUPPORT_SYSTEM_PROMPT },
            ..._supportHistory.filter(msg => msg.role !== 'system').slice(-12)
        ];
        const res = await fetch(`${API_BASE}/support/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ messages: supportMessages })
        });

        if (!res.ok) {
            throw new Error(`Support nicht erreichbar (${res.status})`);
        }

        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim()
            || 'Ich bin da. Beschreiben Sie bitte kurz, welche Meldung genau angezeigt wird.';
        await new Promise(resolve => setTimeout(resolve, supportHumanDelay(reply)));
        supportSetTyping(false);
        appendSupportBubble('agent', reply);
        _supportHistory.push({ role: 'assistant', content: reply });
    } catch {
        await new Promise(resolve => setTimeout(resolve, 2200));
        supportSetTyping(false);
        const fallback = 'Die Verbindung zum Support-Dienst ist gerade nicht sauber erreichbar. Bitte prüfen Sie kurz Internet und Anmeldung, und schreiben Sie mir dann die genaue Fehlermeldung.';
        appendSupportBubble('error', fallback);
        _supportHistory.push({ role: 'assistant', content: fallback });
    } finally {
        _supportIsSending = false;
        if (sendBtn) sendBtn.disabled = false;
        input?.focus();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    startMojibakeFixer();
    initEntryGate();
    const modal = document.getElementById('supportModal');
    if (modal) {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeSupport();
        });
    }
});
