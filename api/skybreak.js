const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Payload zu gross'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function authUser(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.slice(7).trim(), JWT_SECRET);
    if (!decoded?.username) return null;
    return {
      id: String(decoded.id || decoded.userId || decoded.username),
      username: String(decoded.username).trim().slice(0, 40)
    };
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function fresh(iso, ms) {
  const time = Date.parse(iso || '');
  return Number.isFinite(time) && Date.now() - time <= ms;
}

function cleanUsername(username) {
  return String(username || '').trim().slice(0, 40);
}

function skySettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const skybreak = source.skybreak && typeof source.skybreak === 'object' ? source.skybreak : {};
  return {
    friends: Array.isArray(skybreak.friends) ? skybreak.friends.map(cleanUsername).filter(Boolean).slice(0, 200) : [],
    invites: Array.isArray(skybreak.invites) ? skybreak.invites.slice(-40) : [],
    match: skybreak.match && typeof skybreak.match === 'object' ? skybreak.match : null,
    player: skybreak.player && typeof skybreak.player === 'object' ? skybreak.player : null
  };
}

async function readProfile(username) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('username,settings')
    .eq('username', username)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return { username, settings: data?.settings && typeof data.settings === 'object' ? data.settings : {} };
}

async function writeProfile(username, updater) {
  const current = await readProfile(username);
  const settings = current.settings && typeof current.settings === 'object' ? current.settings : {};
  const nextSettings = updater({ ...settings, skybreak: skySettings(settings) });
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ username, settings: nextSettings }, { onConflict: 'username' });
  if (error) throw error;
  return nextSettings;
}

async function allProfiles() {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('username,settings')
    .limit(500);
  if (error) throw error;
  return data || [];
}

async function listUsers() {
  const onlineSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('users')
    .select('username,last_seen')
    .order('last_seen', { ascending: false })
    .limit(200);
  if (error) throw error;
  return {
    users: (data || []).map(row => ({
      username: row.username,
      online: Boolean(row.last_seen && row.last_seen >= onlineSince)
    }))
  };
}

function profilePlayer(row) {
  const sky = skySettings(row.settings);
  if (!sky.player || !sky.player.matchId || !fresh(sky.player.lastSeen, 25000)) return null;
  return {
    username: cleanUsername(row.username || sky.player.username),
    team_id: cleanUsername(sky.player.teamId),
    x: Number(sky.player.x) || 0,
    y: Number(sky.player.y) || 0,
    z: Number(sky.player.z) || 0,
    yaw: Number(sky.player.yaw) || 0,
    hp: Math.max(0, Math.min(200, Number(sky.player.hp || 200))),
    state: String(sky.player.state || 'lobby').slice(0, 24),
    meta: sky.player.meta && typeof sky.player.meta === 'object' ? sky.player.meta : {},
    last_seen: sky.player.lastSeen,
    matchId: sky.player.matchId,
    match: sky.match || null
  };
}

async function getPlayers(matchId) {
  if (!matchId) return [];
  return (await allProfiles())
    .map(profilePlayer)
    .filter(player => player && player.matchId === matchId)
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen));
}

async function findOrCreateMatch(user, body) {
  const profiles = await allProfiles();
  const grouped = new Map();
  for (const row of profiles) {
    const player = profilePlayer(row);
    if (!player?.match) continue;
    const match = player.match;
    if (match.status !== 'lobby' || !fresh(match.updatedAt, 2 * 60 * 1000)) continue;
    const entry = grouped.get(match.id) || { match, players: [] };
    entry.players.push(player);
    grouped.set(match.id, entry);
  }

  for (const entry of grouped.values()) {
    if (entry.players.length < Number(entry.match.maxPlayers || 8)) return entry.match;
  }

  return {
    id: `sky_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    leader: user.username,
    status: 'lobby',
    teamMode: body.teamMode === 'solo' ? 'solo' : 'squad',
    maxPlayers: Math.max(2, Math.min(16, Number(body.maxPlayers || 8))),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function playerPayload(user, match, body) {
  return {
    matchId: match.id,
    username: user.username,
    userId: user.id,
    teamId: body.teamMode === 'solo' ? user.username : (match.leader || user.username),
    x: Number(body.x) || 0,
    y: Number(body.y) || 0,
    z: Number(body.z) || 0,
    yaw: Number(body.yaw) || 0,
    hp: Math.max(0, Math.min(200, Number(body.hp || 200))),
    state: String(body.state || 'lobby').slice(0, 24),
    meta: body.meta && typeof body.meta === 'object' ? body.meta : { source: 'ehoser' },
    lastSeen: nowIso()
  };
}

async function joinMatch(user, body) {
  const match = body.matchId
    ? { id: String(body.matchId), leader: cleanUsername(body.leader || user.username), status: 'lobby', teamMode: body.teamMode || 'squad', maxPlayers: 8, updatedAt: nowIso() }
    : await findOrCreateMatch(user, body);
  match.updatedAt = nowIso();

  await writeProfile(user.username, settings => ({
    ...settings,
    skybreak: {
      ...settings.skybreak,
      match,
      player: playerPayload(user, match, body)
    }
  }));

  return { match, players: await getPlayers(match.id), storage: 'user_profiles.settings.skybreak' };
}

async function heartbeat(user, body) {
  const matchId = String(body.matchId || '').trim();
  if (!matchId) throw new Error('matchId fehlt');
  const current = await readProfile(user.username);
  const sky = skySettings(current.settings);
  const match = sky.match?.id === matchId ? { ...sky.match, updatedAt: nowIso() } : {
    id: matchId,
    leader: cleanUsername(body.teamId || user.username),
    status: 'lobby',
    teamMode: 'squad',
    maxPlayers: 8,
    updatedAt: nowIso()
  };
  if (user.username.toLowerCase() === String(match.leader || '').toLowerCase() && ['bus', 'glide', 'playing'].includes(body.state)) {
    match.status = 'playing';
    match.startedAt = match.startedAt || nowIso();
  }

  await writeProfile(user.username, settings => ({
    ...settings,
    skybreak: {
      ...settings.skybreak,
      match,
      player: playerPayload(user, match, body)
    }
  }));

  return { players: await getPlayers(matchId), storage: 'user_profiles.settings.skybreak' };
}

async function listFriends(user) {
  const profile = await readProfile(user.username);
  return { friends: skySettings(profile.settings).friends };
}

async function addFriend(user, body) {
  const friend = cleanUsername(body.username);
  if (!friend || friend.toLowerCase() === user.username.toLowerCase()) throw new Error('Ungueltiger Nutzer');
  let friends = [];
  await writeProfile(user.username, settings => {
    friends = [...new Set([...(settings.skybreak.friends || []), friend])].slice(0, 200);
    return { ...settings, skybreak: { ...settings.skybreak, friends } };
  });
  return { friends };
}

async function invite(user, body) {
  const to = cleanUsername(body.username);
  const matchId = String(body.matchId || '').trim();
  if (!to || !matchId) throw new Error('Einladung unvollstaendig');
  const invite = {
    id: `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    from_username: user.username,
    to_username: to,
    match_id: matchId,
    status: 'pending',
    created_at: nowIso()
  };
  await writeProfile(to, settings => ({
    ...settings,
    skybreak: {
      ...settings.skybreak,
      invites: [...(settings.skybreak.invites || []).filter(item => fresh(item.created_at, 10 * 60 * 1000)), invite].slice(-40)
    }
  }));
  return { invite };
}

async function invites(user) {
  const profile = await readProfile(user.username);
  return {
    invites: skySettings(profile.settings).invites
      .filter(item => item.status === 'pending' && fresh(item.created_at, 10 * 60 * 1000))
      .slice(-20)
  };
}

async function acceptInvite(user, body) {
  const inviteId = String(body.inviteId || '').trim();
  if (!inviteId) throw new Error('Einladung fehlt');
  const profile = await readProfile(user.username);
  const sky = skySettings(profile.settings);
  const invite = sky.invites.find(item => item.id === inviteId && item.status === 'pending' && fresh(item.created_at, 10 * 60 * 1000));
  if (!invite) throw new Error('Diese Einladung ist abgelaufen oder wurde bereits bearbeitet');

  const accepted = { ...invite, status: 'accepted', accepted_at: nowIso() };
  await writeProfile(user.username, settings => ({
    ...settings,
    skybreak: {
      ...settings.skybreak,
      invites: (settings.skybreak.invites || []).map(item => item.id === inviteId ? accepted : item)
    }
  }));

  const match = await joinMatch(user, {
    matchId: invite.match_id,
    leader: invite.from_username,
    teamMode: 'squad',
    state: 'lobby'
  });
  return { invite: accepted, match: match.match, players: match.players };
}

async function leave(user, body) {
  const matchId = String(body.matchId || '').trim();
  await writeProfile(user.username, settings => {
    const player = settings.skybreak.player;
    return {
      ...settings,
      skybreak: {
        ...settings.skybreak,
        player: player?.matchId === matchId ? null : player
      }
    };
  });
  return { ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  if (!supabase) return json(res, 500, { error: 'Supabase ist nicht konfiguriert' });

  const user = authUser(req);
  if (!user) return json(res, 401, { error: 'ehoser Login erforderlich' });

  try {
    const url = new URL(req.url, 'https://ehoser.de');
    const path = url.pathname.replace(/^\/api\/skybreak/, '') || '/';
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (req.method === 'GET' && path === '/users') return json(res, 200, await listUsers());
    if (req.method === 'GET' && path === '/friends') return json(res, 200, await listFriends(user));
    if (req.method === 'GET' && path === '/invites') return json(res, 200, await invites(user));
    if (req.method === 'GET' && path === '/state') return json(res, 200, { players: await getPlayers(String(url.searchParams.get('matchId') || '')) });
    if (req.method === 'POST' && path === '/join') return json(res, 200, await joinMatch(user, body));
    if (req.method === 'POST' && path === '/heartbeat') return json(res, 200, await heartbeat(user, body));
    if (req.method === 'POST' && path === '/friends') return json(res, 200, await addFriend(user, body));
    if (req.method === 'POST' && path === '/invite') return json(res, 200, await invite(user, body));
    if (req.method === 'POST' && path === '/invite/accept') return json(res, 200, await acceptInvite(user, body));
    if (req.method === 'POST' && path === '/leave') return json(res, 200, await leave(user, body));

    return json(res, 404, { error: 'SKYBREAK API nicht gefunden' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'SKYBREAK API Fehler' });
  }
};
