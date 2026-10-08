'use strict';
(function () {
  const isChat = Boolean(document.getElementById('chatApp'));
  const isControlCenter = /Control Center/i.test(document.title);
  document.body.classList.add('ehoser-majestic');

  function makeItem(icon, title, subtitle, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ehoser-more-item';
    button.innerHTML = '<span aria-hidden="true">' + icon + '</span><span><b>' + title + '</b><small>' + subtitle + '</small></span>';
    button.addEventListener('click', function () { closeMenus(); action(); });
    return button;
  }

  function closeMenus() {
    document.querySelectorAll('.ehoser-more-menu').forEach(function (menu) { menu.hidden = true; });
  }

  function openNotes() {
    const old = document.getElementById('ehoserQuickNoteModal');
    if (old) { old.remove(); return; }
    const modal = document.createElement('section');
    modal.id = 'ehoserQuickNoteModal';
    modal.className = 'ehoser-note-modal';
    modal.innerHTML = '<div class="ehoser-note-card" role="dialog" aria-modal="true" aria-labelledby="ehoserNoteTitle"><h2 id="ehoserNoteTitle">Notizen</h2><p>Deine Notiz bleibt auf diesem Gerät gespeichert.</p><textarea id="ehoserQuickNoteText" placeholder="Schreib etwas auf …"></textarea><div class="ehoser-note-actions"><button class="secondary" type="button">Schließen</button><button class="primary" type="button">Speichern</button></div></div>';
    document.body.appendChild(modal);
    const area = modal.querySelector('textarea');
    area.value = localStorage.getItem('ehoserQuickNote') || '';
    modal.querySelector('.secondary').onclick = function () { modal.remove(); };
    modal.querySelector('.primary').onclick = function () { localStorage.setItem('ehoserQuickNote', area.value); modal.remove(); };
    modal.addEventListener('click', function (event) { if (event.target === modal) modal.remove(); });
    setTimeout(function () { area.focus(); }, 10);
  }

  function openGenerator() {
    const idea = window.prompt('Beschreibe deine Website. Zum Beispiel: „Eine goldene Fan-Seite für Minecraft-Bauten mit Galerie und Kontakt.“');
    if (!idea || !idea.trim()) return;
    window.location.href = '/sites/?generate=' + encodeURIComponent(idea.trim());
  }

  function clickPicker(id) {
    const picker = document.getElementById(id);
    if (picker) picker.click();
  }

  function addMenu(parent, triggerLabel, withUploads) {
    const wrap = document.createElement('div');
    wrap.className = 'ehoser-more-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'input-btn ehoser-more-btn';
    button.title = triggerLabel;
    button.setAttribute('aria-label', triggerLabel);
    button.textContent = '•••';
    const menu = document.createElement('div');
    menu.className = 'ehoser-more-menu';
    menu.hidden = true;
    menu.innerHTML = '<div class="ehoser-more-head">Ehoser Werkzeuge</div>';
    if (withUploads) {
      menu.appendChild(makeItem('🖼️', 'Bild oder Video', 'Vom Gerät hochladen', function () { clickPicker('filePickerImg'); }));
      menu.appendChild(makeItem('📎', 'Datei', 'PDF, ZIP und weitere Dateien', function () { clickPicker('filePickerFile'); }));
      menu.appendChild(makeItem('🔊', 'Audiodatei', 'Audio als Datei hochladen', function () {
        let picker = document.getElementById('ehoserAudioPicker');
        if (!picker) {
          picker = document.createElement('input');
          picker.type = 'file'; picker.id = 'ehoserAudioPicker'; picker.accept = 'audio/*'; picker.hidden = true;
          picker.addEventListener('change', function () { if (picker.files && picker.files[0] && typeof window.handleFilePick === 'function') window.handleFilePick(picker, 'file'); });
          document.body.appendChild(picker);
        }
        picker.click();
      }));
    }
    menu.appendChild(makeItem('📝', 'Notizen-Editor', 'Schnelle Notiz auf diesem Gerät', openNotes));
    menu.appendChild(makeItem('✨', 'Webseiten-Generator', 'Eigene Seite mit ehoser Sites erstellen', openGenerator));
    menu.appendChild(makeItem('🌐', 'Meine Sites', 'Veröffentlichen, teilen und Subdomain wählen', function () { window.location.href = '/sites/'; }));
    menu.appendChild(makeItem('⚙️', 'Developer API', 'Server-Schlüssel und API-Dokumentation', function () { window.location.href = '/developer/'; }));
    button.addEventListener('click', function (event) { event.stopPropagation(); const willOpen = menu.hidden; closeMenus(); menu.hidden = !willOpen; });
    wrap.appendChild(button); wrap.appendChild(menu);
    parent.appendChild(wrap);
  }

  function installConnectionBadge() {
    if (!isChat || document.getElementById('ehoserConnectionBadge')) return;
    const badge = document.createElement('div');
    badge.id = 'ehoserConnectionBadge';
    badge.className = 'ehoser-connection';
    badge.textContent = 'Verbindung wird wiederhergestellt …';
    badge.hidden = navigator.onLine;
    document.body.appendChild(badge);
    window.addEventListener('offline', function () { badge.hidden = false; });
    window.addEventListener('online', function () {
      badge.textContent = 'Wieder verbunden – Chat wird synchronisiert';
      badge.hidden = false;
      if (typeof window.loadMessages === 'function' && window._activeGroupId) window.loadMessages(window._activeGroupId, false).catch(function () {});
      setTimeout(function () { badge.hidden = true; }, 2200);
    });
  }

  function installChatTools() {
    const input = document.querySelector('.input-wrap');
    if (!input || document.getElementById('ehoserChatMore')) return;
    const anchor = document.createElement('div');
    anchor.id = 'ehoserChatMore';
    input.insertBefore(anchor, document.getElementById('micBtn') || input.firstChild);
    addMenu(anchor, 'Weitere Optionen', true);
    installConnectionBadge();
  }

  function installControlTools() {
    if (document.getElementById('ehoserControlTools')) return;
    const fab = document.createElement('div');
    fab.id = 'ehoserControlTools';
    fab.className = 'ehoser-tools-fab';
    const label = document.createElement('button');
    label.type = 'button'; label.className = 'ehoser-fab-label'; label.textContent = 'Sites';
    label.onclick = openGenerator;
    fab.appendChild(label);
    addMenu(fab, 'Weitere Control-Center-Optionen', false);
    document.body.appendChild(fab);
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.ehoser-more-wrap') && !event.target.closest('.ehoser-tools-fab')) closeMenus();
  });
  if (isChat) installChatTools();
  if (isControlCenter) installControlTools();
  window.ehoserOpenSiteGenerator = openGenerator;
})();