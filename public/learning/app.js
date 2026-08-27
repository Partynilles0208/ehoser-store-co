const API_BASE = `${window.location.origin}/api`;
const LEARNING_UNLOCK_KEY = 'ehoserEntryUnlocked';

const state = {
    messages: [],
    autoSpeak: true,
    pendingSpeakText: '',
    targetLanguage: 'de'
};

const els = {};

const DEFAULT_SYSTEM_PROMPT = `Du bist Ehoser Learning, ein Lern-Assistent für Sprachen und Grammatik.
Antworte kurz, freundlich und klar.
Wenn der Nutzer eine Übersetzung will, liefere die direkte Übersetzung zuerst.
Gib danach eine kurze Erklärung, eine einfache Aussprachehilfe und 1-2 Beispielsätze.
Wenn passend, nenne Artikel, Plural, Zeiten, Konjugation oder typische Grammatikregeln.
Antworte auf Deutsch, außer die Aufgabe verlangt ausdrücklich eine andere Zielsprache.
Formuliere Antworten so, dass sie sich gut vorlesen lassen.`;

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripMarkdown(value) {
    return String(value || '')
        .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ''))
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function pickVoice(lang) {
    const voices = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
    const normalized = String(lang || 'de').slice(0, 2).toLowerCase();
    const preferred = voices.find((voice) => voice.lang?.toLowerCase().startsWith(normalized) && voice.localService)
        || voices.find((voice) => voice.lang?.toLowerCase().startsWith(normalized))
        || voices.find((voice) => /de|en|fr|es|it|pt|tr/i.test(voice.lang || ''))
        || voices[0]
        || null;
    return preferred;
}

function speakText(text, lang = state.targetLanguage) {
    const speakable = stripMarkdown(text).replace(/\s+/g, ' ').trim().slice(0, 700);
    if (!speakable || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speakable);
    utterance.rate = Number(els.speechRate?.value || 0.95);
    utterance.pitch = 1;
    utterance.lang = ({ de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', tr: 'tr-TR' })[lang] || 'de-DE';
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;
    speechSynthesis.speak(utterance);
}

function appendMessage(role, text) {
    const messages = els.chatMessages;
    const bubble = document.createElement('div');
    bubble.className = `message message-${role}`;
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');

    if (role === 'assistant') {
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        const speakBtn = document.createElement('button');
        speakBtn.type = 'button';
        speakBtn.className = 'message-speak';
        speakBtn.textContent = 'Vorlesen';
        speakBtn.addEventListener('click', () => speakText(text));
        meta.appendChild(speakBtn);
        bubble.appendChild(meta);
        state.pendingSpeakText = text;
    }

    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
}

function setTyping(active) {
    let typing = $('typingBubble');
    if (active) {
        if (!typing) {
            typing = document.createElement('div');
            typing.id = 'typingBubble';
            typing.className = 'message message-assistant';
            typing.textContent = 'Ehoser Learning schreibt…';
            els.chatMessages.appendChild(typing);
        }
        els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
        return;
    }
    typing?.remove();
}

function updatePromptChips(prompt) {
    els.messageInput.value = prompt;
    els.messageInput.focus();
}

function buildSystemPrompt() {
    const languageLabel = els.languageSelect?.selectedOptions?.[0]?.textContent || 'Deutsch';
    return `${DEFAULT_SYSTEM_PROMPT}\n\nZielsprache des Nutzers: ${languageLabel}. Wenn möglich, passe Beispiele und Aussprachehinweise an diese Sprache an.`;
}

async function sendMessage() {
    const text = els.messageInput.value.trim();
    if (!text) return;

    state.targetLanguage = els.languageSelect.value;
    els.messageInput.value = '';
    appendMessage('user', text);
    state.messages.push({ role: 'user', content: text });
    setTyping(true);

    try {
        const res = await fetch(`${API_BASE}/learning/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                language: state.targetLanguage,
                messages: [
                    { role: 'system', content: buildSystemPrompt() },
                    ...state.messages
                ]
            })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const reply = data?.choices?.[0]?.message?.content || 'Keine Antwort erhalten.';
        setTyping(false);
        appendMessage('assistant', reply);
        state.messages.push({ role: 'assistant', content: reply });
        if (state.autoSpeak) {
            speakText(reply, state.targetLanguage);
        }
    } catch (error) {
        setTyping(false);
        appendMessage('assistant', `Fehler: ${error.message || 'Verbindung fehlgeschlagen.'}`);
    }
}

function clearChat() {
    state.messages = [];
    els.chatMessages.innerHTML = '';
    const intro = 'Stell mir eine Frage zu Übersetzungen, Grammatik, Aussprache oder Beispielsätzen.';
    appendMessage('assistant', intro);
    state.messages.push({ role: 'assistant', content: intro });
}

function speakLastAnswer() {
    const lastAssistant = [...state.messages].reverse().find((entry) => entry.role === 'assistant');
    if (lastAssistant?.content) {
        speakText(lastAssistant.content, state.targetLanguage);
    }
}

function copyLastAnswer() {
    const lastAssistant = [...state.messages].reverse().find((entry) => entry.role === 'assistant');
    if (!lastAssistant?.content) return;
    navigator.clipboard?.writeText(stripMarkdown(lastAssistant.content)).catch(() => {});
}

function initVoiceLoading() {
    if (!('speechSynthesis' in window)) {
        els.autoSpeakBtn.textContent = 'Vorlesen nicht verfügbar';
        els.autoSpeakBtn.disabled = true;
        els.speakNowBtn.disabled = true;
        return;
    }
    const refreshVoices = () => pickVoice(state.targetLanguage);
    speechSynthesis.onvoiceschanged = refreshVoices;
    refreshVoices();
}

function initLearningApp() {
    els.learningApp = $('learningApp');
    els.lockedNotice = $('lockedNotice');
    els.chatMessages = $('chatMessages');
    els.messageInput = $('messageInput');
    els.languageSelect = $('languageSelect');
    els.sendBtn = $('sendBtn');
    els.clearBtn = $('clearBtn');
    els.copyLastBtn = $('copyLastBtn');
    els.autoSpeakBtn = $('autoSpeakBtn');
    els.speakNowBtn = $('speakNowBtn');
    els.speechRate = $('speechRate');

    const unlocked = sessionStorage.getItem(LEARNING_UNLOCK_KEY) === '1';
    if (!unlocked) {
        els.lockedNotice.style.display = 'grid';
        return;
    }

    els.learningApp.style.display = 'grid';
    els.lockedNotice.style.display = 'none';

    initVoiceLoading();
    clearChat();

    els.sendBtn.addEventListener('click', sendMessage);
    els.messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    els.clearBtn.addEventListener('click', clearChat);
    els.copyLastBtn.addEventListener('click', copyLastAnswer);
    els.speakNowBtn.addEventListener('click', speakLastAnswer);
    els.autoSpeakBtn.addEventListener('click', () => {
        state.autoSpeak = !state.autoSpeak;
        els.autoSpeakBtn.textContent = `Auto-Vorlesen: ${state.autoSpeak ? 'an' : 'aus'}`;
    });
    els.languageSelect.addEventListener('change', () => {
        state.targetLanguage = els.languageSelect.value;
    });
    els.speechRate.addEventListener('input', () => {
        if (state.autoSpeak && speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }
    });

    document.querySelectorAll('[data-prompt]').forEach((button) => {
        button.addEventListener('click', () => updatePromptChips(button.dataset.prompt || ''));
    });

    appendMessage('assistant', 'Hallo. Frag mich nach Übersetzungen, Grammatik oder Beispielen. Zum Beispiel: „Wie heißt Decke auf Französisch?“');
}

document.addEventListener('DOMContentLoaded', initLearningApp);
