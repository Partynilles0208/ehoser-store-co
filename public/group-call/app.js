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
let videoInputCount = 0;
let devicePanelOpen = false;
let focusedParticipant = null;
let callControlsHidden = false;
let callStickerPanelOpen = false;
let preferredCameraId = localStorage.getItem('ehoserGroupCallCameraId') || '';
let preferredMicId = localStorage.getItem('ehoserGroupCallMicId') || '';
let preferredSpeakerId = localStorage.getItem('ehoserGroupCallSpeakerId') || '';
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
    // A room still needs a member list for signalling, but it must never become
    // a visible conversation in the regular chat list.
    const group = await api('/chat/groups', 'POST', { name, members: [...selectedUsers], purpose: 'group-call' });
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
  exitParticipantFocus();
  try {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: groupAudioConstraints(preferredMicId), video: false });
    } catch (error) {
      if (!['NotFoundError', 'OverconstrainedError'].includes(error?.name) || !preferredMicId) throw error;
      preferredMicId = '';
      localStorage.removeItem('ehoserGroupCallMicId');
      localStream = await navigator.mediaDevices.getUserMedia({ audio: groupAudioConstraints(), video: false });
    }
  } catch (error) {
    setRoomStatus(error.name === 'NotAllowedError' ? 'Mikrofon wurde nicht erlaubt.' : 'Mikrofon konnte nicht gestartet werden.');
    return;
  }
  renderParticipantTile(me.username, localStream, true);
  updateLocalMediaTile();
  refreshGroupDevices();
  syncRoomParticipants(room);
  await pollRoom();
  roomPoll = setInterval(pollRoom, 1200);
}

function setRoomStatus(text) {
  const element = document.getElementById('roomStatus');
  if (element) element.textContent = text;
}

function updateParticipantFocusUi() {
  const room = document.getElementById('callRoom');
  const grid = document.getElementById('videoGrid');
  const toolbar = document.getElementById('focusToolbar');
  const controlsButton = document.getElementById('focusControlsButton');
  const stickerPanel = document.getElementById('callStickerPanel');
  const active = Boolean(focusedParticipant);
  room?.classList.toggle('focus-active', active);
  room?.classList.toggle('controls-hidden', active && callControlsHidden);
  grid?.classList.toggle('focus-mode', active);
  if (toolbar) toolbar.style.display = active ? 'flex' : 'none';
  if (!active) {
    callControlsHidden = false;
    callStickerPanelOpen = false;
  }
  if (controlsButton) {
    controlsButton.textContent = callControlsHidden ? 'Leiste anzeigen' : 'Leiste ausblenden';
    controlsButton.setAttribute('aria-pressed', String(callControlsHidden));
  }
  if (stickerPanel) stickerPanel.style.display = active && callStickerPanelOpen ? 'flex' : 'none';
}

function focusParticipant(username) {
  if (!currentRoom || !username) return;
  focusedParticipant = username;
  document.querySelectorAll('.participant-tile').forEach((tile) => {
    tile.classList.toggle('focused', tile.id === tileId(username));
  });
  updateParticipantFocusUi();
}

function exitParticipantFocus() {
  focusedParticipant = null;
  document.querySelectorAll('.participant-tile.focused').forEach((tile) => tile.classList.remove('focused'));
  updateParticipantFocusUi();
}

function toggleCallControls() {
  if (!focusedParticipant) return;
  callControlsHidden = !callControlsHidden;
  updateParticipantFocusUi();
}

function toggleCallStickerPanel() {
  if (!focusedParticipant) return;
  callStickerPanelOpen = !callStickerPanelOpen;
  updateParticipantFocusUi();
}

function validCallSticker(sticker) {
  return ['🔥', '😂', '❤️', '👍', '👏', '😮'].includes(sticker);
}

function showCallSticker(sticker, username) {
  if (!validCallSticker(sticker)) return;
  const layer = document.getElementById('callStickerLayer');
  if (!layer) return;
  const item = document.createElement('div');
  item.className = 'call-sticker-pop';
  item.innerHTML = `<span>${sticker}</span><small>${esc(username || '')}</small>`;
  layer.appendChild(item);
  setTimeout(() => item.remove(), 2600);
}

async function sendCallSticker(sticker) {
  if (!currentRoom || !validCallSticker(sticker)) return;
  showCallSticker(sticker, me?.username || 'Du');
  callStickerPanelOpen = false;
  updateParticipantFocusUi();
  const recipients = (currentRoom.joined || []).filter((username) => username && username !== me?.username);
  await Promise.all(recipients.map((username) => sendSignal(username, 'sticker', { sticker }).catch(() => {})));
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
      if (focusedParticipant === username) exitParticipantFocus();
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
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', username + ' groß anzeigen');
  tile.innerHTML = `<video autoplay playsinline></video><div class="participant-avatar">${esc(username.slice(0, 2).toUpperCase())}</div><div class="participant-info"><strong>${esc(username)}</strong><small>wartet …</small></div>`;
  tile.addEventListener('click', () => focusParticipant(username));
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      focusParticipant(username);
    }
  });
  document.getElementById('videoGrid').appendChild(tile);
}

function renderParticipantTile(username, stream, own = false) {
  renderWaitingTile(username);
  const tile = document.getElementById(tileId(username));
  const video = tile.querySelector('video');
  video.srcObject = stream;
  video.muted = own;
  if (!own && preferredSpeakerId) video.setSinkId?.(preferredSpeakerId).catch(() => {});
  video.play().catch(() => {});
  tile.classList.toggle('own-camera', own);
  if (own) tile.classList.toggle('rear-camera', cameraFacingMode === 'environment');
  tile.querySelector('.participant-info small').textContent = own ? 'Du' : 'verbunden';
  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.enabled && track.readyState === 'live'));
  tile.classList.toggle('no-video', !hasVideo);
  tile.classList.toggle('focused', focusedParticipant === username);
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
  } else if (signal.kind === 'sticker') {
    showCallSticker(signal.payload?.sticker, username);
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
  switchButton.style.display = camera && videoInputCount > 1 ? 'flex' : 'none';
  switchButton.disabled = cameraSwitchBusy || !camera;
  switchButton.classList.toggle('switching', cameraSwitchBusy);
  switchButton.querySelector('small').textContent = cameraSwitchBusy ? 'Wechsel…' : 'Drehen';
}

function groupAudioConstraints(deviceId = '') {
  const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
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

function fillGroupDeviceSelect(selectId, devices, selectedId, fallbackLabel) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.replaceChildren();
  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
    select.appendChild(option);
  });
  if (selectedId && devices.some((device) => device.deviceId === selectedId)) select.value = selectedId;
}

async function refreshGroupDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    const microphones = devices.filter((device) => device.kind === 'audioinput');
    const speakers = devices.filter((device) => device.kind === 'audiooutput');
    videoInputCount = cameras.length;
    const currentCamera = localStream?.getVideoTracks?.()[0]?.getSettings?.().deviceId || preferredCameraId;
    const currentMic = localStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId || preferredMicId;
    fillGroupDeviceSelect('groupCameraSelect', cameras, currentCamera, 'Kamera');
    fillGroupDeviceSelect('groupMicSelect', microphones, currentMic, 'Mikrofon');
    fillGroupDeviceSelect('groupSpeakerSelect', speakers, preferredSpeakerId, 'Lautsprecher');
    const firstRemoteVideo = document.querySelector('.participant-tile video');
    const speakerSupported = typeof firstRemoteVideo?.setSinkId === 'function'
      || (typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype);
    document.getElementById('groupSpeakerRow').style.display = speakerSupported && speakers.length ? 'grid' : 'none';
    updateLocalMediaTile();
  } catch {}
}

function toggleDevicePanel(force) {
  if (!currentRoom) return;
  devicePanelOpen = typeof force === 'boolean' ? force : !devicePanelOpen;
  document.getElementById('groupDevicePanel').style.display = devicePanelOpen ? 'block' : 'none';
  document.getElementById('groupDeviceBtn')?.classList.toggle('active', devicePanelOpen);
  if (devicePanelOpen) refreshGroupDevices();
}

async function selectGroupCamera(deviceId) {
  const oldTrack = localStream?.getVideoTracks?.()[0];
  if (!deviceId || !oldTrack) {
    setRoomStatus('Schalte zuerst die Kamera ein.');
    return;
  }
  try {
    let newTrack = oldTrack;
    try { await oldTrack.applyConstraints(cameraVideoConstraints('user', deviceId)); } catch {}
    if (oldTrack.getSettings?.().deviceId !== deviceId) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints('user', deviceId), audio: false });
      newTrack = stream.getVideoTracks()[0];
      if (!newTrack) throw new Error('Kamera konnte nicht übernommen werden.');
      const videoSenders = [...peers.values()]
        .map((peer) => peer.pc.getSenders().find((sender) => sender.track?.kind === 'video'))
        .filter(Boolean);
      await Promise.all(videoSenders.map((sender) => sender.replaceTrack(newTrack).catch(() => null)));
      localStream.removeTrack(oldTrack);
      localStream.addTrack(newTrack);
      oldTrack.stop();
    }
    preferredCameraId = deviceId;
    localStorage.setItem('ehoserGroupCallCameraId', deviceId);
    cameraFacingMode = newTrack.getSettings?.().facingMode || 'user';
    renderParticipantTile(me.username, localStream, true);
    updateLocalMediaTile();
    await refreshGroupDevices();
    setRoomStatus('Kamera gewechselt');
  } catch (error) {
    setRoomStatus(error?.message || 'Kamera konnte nicht gewechselt werden.');
  }
}

async function selectGroupMicrophone(deviceId) {
  if (!deviceId || !localStream) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: groupAudioConstraints(deviceId), video: false });
    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) throw new Error('Mikrofon konnte nicht übernommen werden.');
    const audioSenders = [...peers.values()]
      .map((peer) => peer.pc.getSenders().find((sender) => sender.track?.kind === 'audio'))
      .filter(Boolean);
    await Promise.all(audioSenders.map((sender) => sender.replaceTrack(newTrack).catch(() => null)));
    const oldTrack = localStream.getAudioTracks()[0];
    newTrack.enabled = oldTrack?.enabled ?? true;
    if (oldTrack) {
      localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    localStream.addTrack(newTrack);
    preferredMicId = deviceId;
    localStorage.setItem('ehoserGroupCallMicId', deviceId);
    updateLocalMediaTile();
    await refreshGroupDevices();
    setRoomStatus('Mikrofon gewechselt');
  } catch (error) {
    setRoomStatus(error?.message || 'Mikrofon konnte nicht gewechselt werden.');
  }
}

async function selectGroupSpeaker(deviceId) {
  if (!deviceId) return;
  try {
    const outputs = [...document.querySelectorAll('.participant-tile video')].filter((video) => !video.muted && typeof video.setSinkId === 'function');
    await Promise.all(outputs.map((video) => video.setSinkId(deviceId)));
    preferredSpeakerId = deviceId;
    localStorage.setItem('ehoserGroupCallSpeakerId', deviceId);
    setRoomStatus('Lautsprecher gewechselt');
  } catch {
    setRoomStatus('Dieser Browser kann den Lautsprecher nicht wechseln.');
  }
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
      let cameraStream;
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints(cameraFacingMode, preferredCameraId), audio: false });
      } catch (error) {
        if (!['NotFoundError', 'OverconstrainedError'].includes(error?.name) || !preferredCameraId) throw error;
        preferredCameraId = '';
        localStorage.removeItem('ehoserGroupCallCameraId');
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints(cameraFacingMode), audio: false });
      }
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
    refreshGroupDevices();
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
    preferredCameraId = replacement.track.getSettings?.().deviceId || preferredCameraId;
    if (preferredCameraId) localStorage.setItem('ehoserGroupCallCameraId', preferredCameraId);
    renderParticipantTile(me.username, localStream, true);
    await broadcastMediaState();
    refreshGroupDevices();
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
  devicePanelOpen = false;
  focusedParticipant = null;
  callControlsHidden = false;
  callStickerPanelOpen = false;
  document.getElementById('groupDevicePanel').style.display = 'none';
  document.getElementById('groupDeviceBtn')?.classList.remove('active');
  document.getElementById('videoGrid').innerHTML = '';
  updateParticipantFocusUi();
  document.getElementById('callRoom').style.display = 'none';
  document.getElementById('lobby').style.display = 'block';
  setLobbyStatus(message);
  invitePoll = setInterval(pollInvite, 2200);
}

document.addEventListener('keydown', (event) => {
  if (!currentRoom || document.getElementById('callRoom')?.style.display === 'none') return;
  const target = event.target;
  if (target?.matches?.('input, textarea, select') || target?.isContentEditable) return;
  if (event.key === 'Escape' && devicePanelOpen) {
    event.preventDefault();
    toggleDevicePanel(false);
  } else if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    toggleMute();
  } else if (event.key.toLowerCase() === 'v') {
    event.preventDefault();
    toggleCamera();
  } else if (event.key.toLowerCase() === 'c' && videoInputCount > 1) {
    event.preventDefault();
    switchCamera();
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (currentRoom) refreshGroupDevices();
});

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
