import { Drive } from './drive.mjs';
const $ = id => document.getElementById(id);
let config, map, marker, selection, drive, controller, generation = 0, toastTimer, searchController, searchGeneration = 0;
const assets = new Map();
const places = {
  berlin: { name: 'Berlin', lat: 52.5161, lon: 13.3782 },
  tokyo: { name: 'Tokio', lat: 35.6598, lon: 139.7005 },
  sanfrancisco: { name: 'San Francisco', lat: 37.7937, lon: -122.4088 }
};
function toast(message, duration = 4500) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}
function loadAsset(url, css = false) {
  if (assets.has(url)) return assets.get(url);
  const promise = new Promise((resolve, reject) => {
    const element = document.createElement(css ? 'link' : 'script');
    if (css) { element.rel = 'stylesheet'; element.href = url; } else { element.src = url; element.async = true; }
    const timer = setTimeout(() => { element.remove(); assets.delete(url); reject(new Error('Die Grafik-Bibliothek lädt nicht. Prüfe deine Verbindung und versuche es erneut.')); }, 22000);
    element.onload = () => { clearTimeout(timer); resolve(); };
    element.onerror = () => { clearTimeout(timer); assets.delete(url); element.remove(); reject(new Error('Die Kartenansicht konnte nicht geladen werden. Bitte erneut versuchen.')); };
    document.head.append(element);
  });
  assets.set(url, promise); return promise;
}
async function api(path, { timeout = 15000, signal } = {}) {
  const token = localStorage.getItem('token');
  if (!token) throw Object.assign(new Error('Bitte mit deinem ehoser-Konto anmelden.'), { status: 401 });
  const timed = AbortSignal.timeout(timeout);
  const response = await fetch(`/api/earthdrive${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: signal ? AbortSignal.any([signal, timed]) : timed });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Der Kartendienst antwortet gerade nicht.'), { status: response.status });
  return data;
}
function gate(error) {
  if (drive) { drive.dispose(); drive = null; }
  controller?.abort(); generation++;
  $('picker').hidden = true; $('driving').hidden = true; $('loading').hidden = true; $('gate').hidden = false;
  $('gate-title').textContent = error.status === 403 ? 'Deine Welt mit Pro.' : error.status === 401 ? 'Melde dich an. Fahr los.' : 'Kurzer Boxenstopp.';
  $('gate-text').textContent = error.message;
  const action = document.createElement(error.status === 401 || error.status === 403 ? 'a' : 'button');
  action.className = 'primary';
  action.textContent = error.status === 401 ? 'Bei ehoser anmelden →' : error.status === 403 ? 'Zurück zu meinem Konto →' : 'Erneut versuchen →';
  if (error.status === 401 || error.status === 403) action.href = error.status === 401 ? '/?returnTo=%2Fearthdrive%2F' : '/';
  else action.addEventListener('click', boot);
  $('gate-actions').replaceChildren(action);
}
function selectPlace(place, move = true) {
  selection = place;
  $('place-name').textContent = place.name || 'Dein Startpunkt';
  $('place-coordinates').textContent = `${place.lat.toFixed(5)}°, ${place.lon.toFixed(5)}° · Start auf einer nahen Straße`;
  $('start-drive').disabled = false;
  if (marker) marker.remove();
  marker = window.L.marker([place.lat, place.lon], { icon: window.L.divIcon({ className: '', html: '<div class="spawn-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 24] }) }).addTo(map);
  const label = document.createElement('span'); label.textContent = place.name || 'Hier starten';
  marker.bindTooltip(label, { direction: 'top', offset: [0, -30] });
  if (move) map.flyTo([place.lat, place.lon], 15, { animate: !matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 1.2 });
  $('search-results').hidden = true;
}
async function boot() {
  $('gate-title').textContent = 'Dein Roadtrip wartet.'; $('gate-text').textContent = 'Dein Zugang wird geprüft …'; $('gate-actions').replaceChildren();
  try {
    config = await api('/config');
    await Promise.all([loadAsset('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', true), loadAsset('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js')]);
    $('gate').hidden = true; $('picker').hidden = false;
    if (!map) {
      map = window.L.map('map', { zoomControl: true, minZoom: 2, maxZoom: 19, worldCopyJump: true }).setView([48.8, 11.5], 5);
      let tiles = window.L.tileLayer(config.osmTileUrl, { maxZoom: 19, attribution: config.osmAttribution || '© OpenStreetMap contributors', crossOrigin: true }).addTo(map);
      let tileErrors = 0;
      tiles.on('tileerror', () => {
        if (++tileErrors === 3) toast('Die Kartenbilder laden gerade nicht. Du kannst weiterhin einen Ort suchen.');
      });
      map.on('click', e => selectPlace({ lat: Math.max(-85, Math.min(85, e.latlng.lat)), lon: ((e.latlng.lng + 180) % 360 + 360) % 360 - 180, name: 'Dein Startpunkt' }, false));
    }
    map.invalidateSize();
  } catch (error) { gate(error); }
}
async function search(event) {
  event.preventDefault();
  const query = $('search').value.trim();
  if (query.length < 2) return;
  searchController?.abort(); searchController = new AbortController();
  const current = ++searchGeneration;
  $('search-button').disabled = true; $('search-results').hidden = false;
  const message = document.createElement('p'); message.textContent = 'Orte werden gesucht …'; $('search-results').replaceChildren(message);
  try {
    const data = await api(`/search?q=${encodeURIComponent(query)}`, { signal: searchController.signal });
    if (current !== searchGeneration) return;
    $('search-results').replaceChildren();
    if (!data.results.length) { message.textContent = 'Kein Ort gefunden. Versuch einen anderen Namen.'; $('search-results').append(message); }
    for (const place of data.results) {
      const button = document.createElement('button'); const title = document.createElement('b'); const subtitle = document.createElement('small');
      title.textContent = place.name; subtitle.textContent = place.label; button.append(title, subtitle);
      button.addEventListener('click', () => selectPlace(place)); $('search-results').append(button);
    }
  } catch (error) {
    if (current !== searchGeneration || error.name === 'AbortError') return;
    if ([401, 403].includes(error.status)) gate(error);
    else { message.textContent = error.message; $('search-results').replaceChildren(message); }
  } finally { if (current === searchGeneration) $('search-button').disabled = false; }
}
function showMap() {
  generation++; controller?.abort(); drive?.dispose(); drive = null;
  $('loading').hidden = true; $('driving').hidden = true; $('picker').hidden = false;
  $('start-drive').disabled = !selection;
  requestAnimationFrame(() => map?.invalidateSize());
}
async function startDrive() {
  if (!selection || drive) return;
  const attempt = ++generation; controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  $('start-drive').disabled = true; $('loading').hidden = false; $('picker').hidden = true;
  const progress = (value, text) => { if (attempt === generation) { $('loading-progress').value = value; $('loading-detail').textContent = text; } };
  progress(10, 'Pro-Zugang und Grafik werden vorbereitet …');
  try {
    config = await api('/config', { signal });
    window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.127.0/Build/Cesium/';
    await Promise.all([loadAsset(`${window.CESIUM_BASE_URL}Widgets/widgets.css`, true), loadAsset(`${window.CESIUM_BASE_URL}Cesium.js`)]);
    if (signal.aborted || attempt !== generation) return;
    $('driving').hidden = false;
    drive = new Drive({ origin: { ...selection }, api, config, progress, toast, signal });
    await drive.init();
    if (attempt !== generation) return;
    config = await api('/config', { signal });
    if (attempt !== generation) return;
    drive.config = config;
    $('loading').hidden = true;
  } catch (error) {
    if (attempt !== generation || error.name === 'AbortError') return;
    if ([401, 403].includes(error.status)) gate(error);
    else { showMap(); toast(error.message || 'Die Fahrt konnte nicht gestartet werden.', 7000); }
  }
}
$('search-form').addEventListener('submit', search);
document.querySelectorAll('[data-place]').forEach(button => button.addEventListener('click', () => selectPlace(places[button.dataset.place])));
$('start-drive').addEventListener('click', startDrive);
$('back-map').addEventListener('click', showMap);
$('cancel-load').addEventListener('click', showMap);
// Revalidate active subscriptions and stop on logout/revocation/network failure.
setInterval(async () => {
  if (!drive?.ready || document.hidden) return;
  const active = drive;
  try { const next = await api('/config'); if (drive === active) { config = next; active.config = next; } }
  catch (error) { if (drive === active) gate(error); }
}, 45000);
window.addEventListener('storage', event => { if (event.key === 'token') gate(Object.assign(new Error('Deine Anmeldung hat sich geändert. Bitte melde dich erneut an.'), { status: 401 })); });
window.addEventListener('pagehide', () => { controller?.abort(); drive?.dispose(); });
boot();
