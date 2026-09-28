'use strict';

const API = (location.protocol === 'file:' ? 'https://ehoser.de' : location.origin) + '/api';
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 4
};

let token = localStorage.getItem('token');
let me = null;
let selectedUsers = new Set();
let currentRoom = null;
let pendingRoom = null;
let localStream = null;
let roomPoll = null;
let invitePoll = null;
let lastCursor = 0;
let userSearchTimer = null;
let cameraFacingMode = 'user';
let cameraSwitchBusy = false;
const peers = new Map();

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

async function api(path, method = 'GET', body = null) {
  const options = { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(API + path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
  return data;
}

function setLobbyStatus(text, error = false) {
  const element = document.getElementById('lobbyStatus');
  if (!element) return;
  element.textContent = text || '';
  element.style.color = error ? '#ff8c94' : '#8696a0';
}

async function boot() {
  if (!token) {
    document.getElementById('loginWall').style.display = 'grid';
    return;
  }
  try {
    const result = await api('/verify-token', 'POST');
    me = result.user;
    if (result.token) {
      token = result.token;
      localStorage.setItem('token', token);
    }
  } catch {
    document.getElementById('loginWall').style.display = 'grid';
    return;
  }
  document.getElementById('lobby').style.display = 'block';
  document.getElementById('userSearch').addEventListener('input', (event) => scheduleUserSearch(event.target.value));
  await searchUsers('');
  await pollInvite();
  invitePoll = setInterval(pollInvite, 2200);
}

function scheduleUserSearch(value) {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => searchUsers(value), 220);
}

async function searchUsers(value) {
  try {
    const query = String(value || '').trim();
    const data = await api('/chat/users/search?limit=100' + (query ? '&q=' + encodeURIComponent(query) : ''));
    const users = (data.users || []).filter((username) => username !== me?.username);
    document.getElementById('userResults').innerHTML = users.map((username) => `
      <button class="user-row${selectedUsers.has(username) ? ' selected' : ''}" onclick="toggleUser('${esc(username)}')">
        <span class="user-avatar">${esc(username.slice(0, 2).toUpperCase())}</span>
        <span><strong>${esc(username)}</strong><br><small>${selectedUsers.has(username) ? 'Ausgewählt' : 'Zum Anruf hinzufügen'}</small></span>
      </button>`).join('') || '<p class="status-line">Kein Nutzer gefunden.</p>';
  } catch (error) {
    setLobbyStatus(error.message, true);
  }
}

function toggleUser(username) {
  if (selectedUsers.has(username)) selectedUsers.delete(username);
  else if (selectedUsers.size < 7) selectedUsers.add(username);
  else return setLobbyStatus('Maximal 7 weitere Personen.', true);
  renderSelectedUsers();
  searchUsers(document.getElementById('userSearch').value);
}

function renderSelectedUsers() {
  const element = document.getElementById('selectedUsers');
  element.innerHTML = selectedUsers.size
    ? [...selectedUsers].map((username) => `<button class="user-chip" onclick="toggleUser('${esc(username)}')">${esc(username)} ×</button>`).join('')
    : '<span>Noch niemand ausgewählt</span>';
  document.getElementById('startGroupCallBtn').disabled = selectedUsers.size === 0;
}

async function startGroupCall() {
  if (!selectedUsers.size) return;
  const button = document.getElementById('startGroupCallBtn');
  button.disabled = true;
  setLobbyStatus('Anrufgruppe wird erstellt …');
  try {
    const name = 'Gruppenanruf · ' + new Date().toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const group = await api('/chat/groups', 'POST', { name, members: [...selectedUsers] });
    const { room } = await api('/chat/group-calls', 'POST', { groupId: group.id });
    await enterRoom(room);
  } catch (error) {
    setLobbyStatus(error.message || 'Anruf fehlgeschlagen oder nicht erreichbar.', true);
    button.disabled = false;
  }
}

async function pollInvite() {
  if (currentRoom) return;
  try {
    const { room } = await api('/chat/group-calls/pending');
    pendingRoom = room || null;
    const overlay = document.getElementById('incomingInvite');
    if (!room) {
      overlay.style.display = 'none';
      return;
    }
    document.getElementById('inviteHost').textContent = room.host + ' ruft an';
    document.getElementById('invitePeople').textContent = (room.participants || []).length + ' Teilnehmer';
    overlay.style.display = 'grid';
    try { navigator.vibrate?.([300, 180, 300]); } catch {}
  } catch {}
}

async function acceptInvite() {
  if (!pendingRoom) return;
  try {
    const { room } = await api('/chat/group-calls/' + pendingRoom.id + '/join', 'POST');
    document.getElementById('incomingInvite').style.display = 'none';
    await enterRoom(room);
  } catch (error) {
    setLobbyStatus(error.message, true);
  }
}

async function declineInvite() {
  if (!pendingRoom) return;
  try { await api('/chat/group-calls/' + pendingRoom.id + '/leave', 'POST'); } catch {}
  pendingRoom = null;
  document.getElementById('incomingInvite').style.display = 'none';
}

async function enterRoom(room) {
  currentRoom = room;
  lastCursor = 0;
  clearInterval(invitePoll);
  document.getElementById('incomingInvite').style.display = 'none';
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('callRoom').style.display = 'flex';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch (error) {
    setRoomStatus(error.name === 'NotAllowedError' ? 'Mikrofon wurde nicht erlaubt.' : 'Mikrofon konnte nicht gestartet werden.');
    return;
  }
  renderParticipantTile(me.username, localStream, true);
  updateLocalMediaTile();
  syncRoomParticipants(room);
  await pollRoom();
  roomPoll = setInterval(pollRoom, 1200);
}

function setRoomStatus(text) {
  const element = document.getElementById('roomStatus');
  if (element) element.textContent = text;
}

async function pollRoom() {
  if (!currentRoom) return;
  try {
    const data = await api('/chat/group-calls/' + currentRoom.id + '?after=' + lastCursor);
    currentRoom = data.room;
    lastCursor = Math.max(lastCursor, Number(data.cursor) || 0);
    if (!currentRoom || currentRoom.status !== 'active') {
      await endLocally('Der Gruppenanruf wurde beendet.');
      return;
    }
    for (const signal of data.signals || []) await handleSignal(signal);
    syncRoomParticipants(currentRoom);
    setRoomStatus(`${currentRoom.joined.length} von ${currentRoom.participants.length} Teilnehmern verbunden`);
  } catch (error) {
    setRoomStatus(error.message);
  }
}

function syncRoomParticipants(room) {
  const joined = new Set(room.joined || []);
  for (const username of room.participants || []) {
    if (!joined.has(username)) renderWaitingTile(username);
  }
  for (const username of joined) {
    if (username === me.username) continue;
    const peer = ensurePeer(username);
    if (me.username.localeCompare(username) < 0 && !peer.offerStarted && peer.pc.signalingState === 'stable') {
      makeOffer(username);
    }
  }
  for (const [username, peer] of peers) {
    if (!joined.has(username)) {
      peer.pc.close();
      peers.delete(username);
      document.getElementById(tileId(username))?.remove();
    }
  }
}

function tileId(username) {
  return 'participant-' + String(username).replace(/[^a-z0-9_-]/gi, '-');
}

function renderWaitingTile(username) {
  if (document.getElementById(tileId(username))) return;
  const tile = document.createElement('article');
  tile.id = tileId(username);
  tile.className = 'participant-tile no-video';
  tile.innerHTML = `<video autoplay playsinline></video><div class="participant-avatar">${esc(username.slice(0, 2).toUpperCase())}</div><div class="participant-info"><strong>${esc(username)}</strong><small>wartet …</small></div>`;
  document.getElementById('videoGrid').appendChild(tile);
}

function renderParticipantTile(username, stream, own = false) {
  renderWaitingTile(username);
  const tile = document.getElementById(tileId(username));
  const video = tile.querySelector('video');
  video.srcObject = stream;
  video.muted = own;
  video.play().catch(() => {});
  tile.classList.toggle('own-camera', own);
  if (own) tile.classList.toggle('rear-camera', cameraFacingMode === 'environment');
  tile.querySelector('.participant-info small').textContent = own ? 'Du' : 'verbunden';
  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.enabled && track.readyState === 'live'));
  tile.classList.toggle('no-video', !hasVideo);
}

function ensurePeer(username) {
  if (peers.has(username)) return peers.get(username);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const remoteStream = new MediaStream();
  const peer = { pc, remoteStream, queuedIce: [], offerStarted: false };
  peers.set(username, peer);
  for (const track of localStream?.getTracks() || []) pc.addTrack(track, localStream);
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(username, 'ice', event.candidate.toJSON ? event.candidate.toJSON() : event.candidate).catch(() => {});
  };
  pc.ontrack = (event) => {
    const tracks = event.streams?.[0]?.getTracks?.() || [event.track];
    for (const track of tracks) if (!remoteStream.getTracks().some((item) => item.id === track.id)) remoteStream.addTrack(track);
    renderParticipantTile(username, remoteStream, false);
    event.track.onmute = () => updateRemoteTile(username);
    event.track.onunmute = () => updateRemoteTile(username);
  };
  pc.onconnectionstatechange = () => {
    const tile = document.getElementById(tileId(username));
    const label = tile?.querySelector('.participant-info small');
    if (label) label.textContent = pc.connectionState === 'connected' ? 'verbunden' : pc.connectionState;
  };
  return peer;
}

async function makeOffer(username, force = false) {
  const peer = ensurePeer(username);
  if (!force && peer.offerStarted) return;
  if (peer.pc.signalingState !== 'stable') return;
  peer.offerStarted = true;
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  await sendSignal(username, 'offer', peer.pc.localDescription.toJSON ? peer.pc.localDescription.toJSON() : peer.pc.localDescription);
}

async function sendSignal(to, kind, payload) {
  return api('/chat/group-calls/' + currentRoom.id + '/signals', 'POST', { to, kind, payload });
}

async function handleSignal(signal) {
  const username = signal.sender;
  if (!username || username === me.username) return;
  const peer = ensurePeer(username);
  if (signal.kind === 'ice') {
    if (!peer.pc.remoteDescription) peer.queuedIce.push(signal.payload);
    else try { await peer.pc.addIceCandidate(signal.payload); } catch {}
    return;
  }
  if (signal.kind === 'offer') {
    await peer.pc.setRemoteDescription(signal.payload);
    for (const candidate of peer.queuedIce.splice(0)) try { await peer.pc.addIceCandidate(candidate); } catch {}
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    await sendSignal(username, 'answer', peer.pc.localDescription.toJSON ? peer.pc.localDescription.toJSON() : peer.pc.localDescription);
  } else if (signal.kind === 'answer' && peer.pc.signalingState === 'have-local-offer') {
    await peer.pc.setRemoteDescription(signal.payload);
    for (const candidate of peer.queuedIce.splice(0)) try { await peer.pc.addIceCandidate(candidate); } catch {}
  } else if (signal.kind === 'media') {
    const tile = document.getElementById(tileId(username));
    if (tile) tile.classList.toggle('no-video', !signal.payload?.video);
  }
}

function updateRemoteTile(username) {
  const peer = peers.get(username);
  const tile = document.getElementById(tileId(username));
  if (!peer || !tile) return;
  const videoOn = peer.remoteStream.getVideoTracks().some((track) => track.enabled && track.readyState === 'live' && !track.muted);
  tile.classList.toggle('no-video', !videoOn);
}

function updateLocalMediaTile() {
  renderParticipantTile(me.username, localStream, true);
  const muted = !localStream?.getAudioTracks()[0]?.enabled;
  const camera = Boolean(localStream?.getVideoTracks()[0]?.enabled);
  document.getElementById('muteBtn').classList.toggle('active', muted);
  document.getElementById('muteBtn').querySelector('small').textContent = muted ? 'Mikro an' : 'Stumm';
  document.getElementById('cameraBtn').classList.toggle('active', camera);
  document.getElementById('cameraBtn').querySelector('small').textContent = camera ? 'Kamera aus' : 'Kamera an';
  const switchButton = document.getElementById('switchCameraBtn');
  switchButton.style.display = camera ? 'flex' : 'none';
  switchButton.disabled = cameraSwitchBusy || !camera;
  switchButton.classList.toggle('switching', cameraSwitchBusy);
  switchButton.querySelector('small').textContent = cameraSwitchBusy ? 'Wechsel…' : 'Drehen';
}

function cameraVideoConstraints(facingMode, deviceId = '') {
  const constraints = {
    facingMode: { ideal: facingMode },
    width: { ideal: 1280 },
    height: { ideal: 720 }
  };
  if (deviceId) {
    delete constraints.facingMode;
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

async function acquireOtherCamera(oldTrack, facingMode) {
  const oldDeviceId = oldTrack?.getSettings?.().deviceId || '';
  const devices = navigator.mediaDevices.enumerateDevices
    ? (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput')
    : [];
  const alternatives = devices.filter((device) => !oldDeviceId || device.deviceId !== oldDeviceId);
  const labelPattern = facingMode === 'environment'
    ? /(back|rear|environment|rück|hinten)/i
    : /(front|user|face|vorder|selfie)/i;
  const target = alternatives.find((device) => labelPattern.test(device.label || '')) || alternatives[0] || null;
  const constraints = cameraVideoConstraints(facingMode, target?.deviceId || '');

  if (oldTrack?.applyConstraints) {
    try {
      await oldTrack.applyConstraints(constraints);
      const settings = oldTrack.getSettings?.() || {};
      if ((target?.deviceId && settings.deviceId === target.deviceId) || settings.facingMode === facingMode) {
        return { track: oldTrack, stream: null };
      }
    } catch {}
  }

  if (devices.length === 1 && !alternatives.length) throw new Error('Keine zweite Kamera gefunden.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('Andere Kamera konnte nicht geöffnet werden.');
  return { track, stream };
}

async function broadcastMediaState() {
  const payload = {
    audio: Boolean(localStream?.getAudioTracks()[0]?.enabled),
    video: Boolean(localStream?.getVideoTracks()[0]?.enabled)
  };
  await Promise.all([...peers.keys()].map((username) => sendSignal(username, 'media', payload).catch(() => {})));
}

async function toggleMute() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  updateLocalMediaTile();
  await broadcastMediaState();
}

async function toggleCamera() {
  let track = localStream?.getVideoTracks()[0];
  try {
    if (!track) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints(cameraFacingMode), audio: false });
      track = cameraStream.getVideoTracks()[0];
      localStream.addTrack(track);
      for (const [username, peer] of peers) {
        peer.pc.addTrack(track, localStream);
        await makeOffer(username, true);
      }
    } else {
      track.enabled = !track.enabled;
    }
    updateLocalMediaTile();
    await broadcastMediaState();
  } catch (error) {
    setRoomStatus(error.name === 'NotAllowedError' ? 'Kamera wurde nicht erlaubt.' : 'Kamera konnte nicht gestartet werden.');
  }
}

async function switchCamera() {
  const oldTrack = localStream?.getVideoTracks?.()[0];
  if (!oldTrack?.enabled || cameraSwitchBusy) return;
  cameraSwitchBusy = true;
  updateLocalMediaTile();
  const nextFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';
  let replacement = null;
  let installed = false;
  try {
    replacement = await acquireOtherCamera(oldTrack, nextFacingMode);
    if (replacement.track !== oldTrack) {
      const videoSenders = [...peers.values()]
        .map((peer) => peer.pc.getSenders().find((sender) => sender.track?.kind === 'video'))
        .filter(Boolean);
      await Promise.all(videoSenders.map((sender) => sender.replaceTrack(replacement.track).catch(() => null)));
      localStream.removeTrack(oldTrack);
      localStream.addTrack(replacement.track);
      oldTrack.stop();
      installed = true;
    }
    cameraFacingMode = nextFacingMode;
    renderParticipantTile(me.username, localStream, true);
    await broadcastMediaState();
    setRoomStatus(nextFacingMode === 'environment' ? 'Rückkamera aktiv' : 'Vorderkamera aktiv');
  } catch (error) {
    if (!installed && replacement?.track && replacement.track !== oldTrack) replacement.track.stop();
    setRoomStatus(error?.message || 'Kamera konnte nicht gewechselt werden.');
  } finally {
    cameraSwitchBusy = false;
    updateLocalMediaTile();
  }
}

async function leaveRoom() {
  if (currentRoom) try { await api('/chat/group-calls/' + currentRoom.id + '/leave', 'POST'); } catch {}
  await endLocally('Anruf beendet.');
}

async function endLocally(message) {
  clearInterval(roomPoll);
  for (const peer of peers.values()) peer.pc.close();
  peers.clear();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  currentRoom = null;
  lastCursor = 0;
  cameraFacingMode = 'user';
  cameraSwitchBusy = false;
  document.getElementById('videoGrid').innerHTML = '';
  document.getElementById('callRoom').style.display = 'none';
  document.getElementById('lobby').style.display = 'block';
  setLobbyStatus(message);
  invitePoll = setInterval(pollInvite, 2200);
}

function copyRoomId() {
  if (!currentRoom) return;
  navigator.clipboard?.writeText(currentRoom.id).then(() => setRoomStatus('Raum-ID kopiert.')).catch(() => {});
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.getElementById('callRoom').requestFullscreen?.();
  else document.exitFullscreen?.();
}

window.addEventListener('beforeunload', () => {
  if (currentRoom) {
    fetch(API + '/chat/group-calls/' + currentRoom.id + '/leave', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      keepalive: true
    }).catch(() => {});
  }
});

boot();
