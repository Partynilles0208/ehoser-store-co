'use strict';

(() => {
    const PIN_KEY = 'ehoserChatPin';
    const UNLOCKED_KEY = 'ehoserChatPinUnlocked';

    const hasPin = () => /^\d{4}$/.test(localStorage.getItem(PIN_KEY) || '');
    const unlocked = () => !hasPin() || sessionStorage.getItem(UNLOCKED_KEY) === '1';
    const byId = (id) => document.getElementById(id);

    function show(message = '') {
        const wall = byId('chatPinWall');
        if (!wall) return;
        const setup = !hasPin();
        byId('chatPinTitle').textContent = setup ? 'Chat mit Code schützen' : 'Chat entsperren';
        byId('chatPinText').textContent = setup
            ? 'Lege einen vierstelligen Code für diesen Browser fest.'
            : 'Gib deinen vierstelligen Chat-Code ein.';
        byId('chatPinConfirmWrap').style.display = setup ? '' : 'none';
        byId('chatPinSubmit').textContent = setup ? 'Code speichern' : 'Entsperren';
        byId('chatPinInput').value = '';
        byId('chatPinConfirmInput').value = '';
        byId('chatPinHelp').textContent = message;
        wall.style.display = 'flex';
        setTimeout(() => byId('chatPinInput')?.focus(), 20);
    }

    function hide() {
        const wall = byId('chatPinWall');
        if (wall) wall.style.display = 'none';
    }

    function notify(message) {
        const toast = byId('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.className = 'toast ok show';
        setTimeout(() => toast.classList.remove('show'), 3500);
    }

    window.openChatLock = () => {
        if (!localStorage.getItem('token')) return;
        sessionStorage.removeItem(UNLOCKED_KEY);
        show();
    };

    window.submitChatPin = () => {
        const code = String(byId('chatPinInput')?.value || '').trim();
        const confirmation = String(byId('chatPinConfirmInput')?.value || '').trim();
        const help = byId('chatPinHelp');
        if (!/^\d{4}$/.test(code)) {
            help.textContent = 'Bitte genau vier Zahlen eingeben.';
            return;
        }
        if (!hasPin()) {
            if (code !== confirmation) {
                help.textContent = 'Die beiden Codes stimmen nicht überein.';
                return;
            }
            localStorage.setItem(PIN_KEY, code);
            sessionStorage.setItem(UNLOCKED_KEY, '1');
            hide();
            notify('Chat-Code aktiviert. Über das Schloss kannst du den Chat sperren.');
            return;
        }
        if (code !== localStorage.getItem(PIN_KEY)) {
            help.textContent = 'Der Code ist nicht richtig.';
            byId('chatPinInput')?.select();
            return;
        }
        sessionStorage.setItem(UNLOCKED_KEY, '1');
        hide();
    };

    function apply() {
        if (localStorage.getItem('token') && hasPin() && !unlocked()) show();
    }

    apply();
    window.addEventListener('pageshow', apply);
})();
