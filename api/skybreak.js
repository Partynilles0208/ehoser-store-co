const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
}) : null;

let schemaReady = null;

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
    return { id: String(decoded.id || decoded.userId || decoded.username), username: String(decoded.username).slice(0, 40) };
  } catch {
    return null;
  }
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS skybreak_matches (
        id TEXT PRIMARY KEY,
        leader TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'lobby',
        team_mode TEXT NOT NULL DEFAULT 'squad',
        max_players INTEGER NOT NULL DEFAULT 8,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS skybreak_players (
        match_id TEXT NOT NULL REFERENCES skybreak_matches(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        user_id TEXT,
        team_id TEXT,
        x DOUBLE PRECISION NOT NULL DEFAULT 0,
        y DOUBLE PRECISION NOT NULL DEFAULT 0,
        z DOUBLE PRECISION NOT NULL DEFAULT 0,
        yaw DOUBLE PRECISION NOT NULL DEFAULT 0,
        hp DOUBLE PRECISION NOT NULL DEFAULT 200,
        state TEXT NOT NULL DEFAULT 'lobby',
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, username)
      );
      CREATE TABLE IF NOT EXISTS skybreak_friends (
        owner_username TEXT NOT NULL,
        friend_username TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner_username, friend_username)
      );
      CREATE TABLE IF NOT EXISTS skybreak_invites (
        id TEXT PRIMARY KEY,
        from_username TEXT NOT NULL,
        to_username TEXT NOT NULL,
        match_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_skybreak_players_seen ON skybreak_players(match_id, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_skybreak_invites_to ON skybreak_invites(to_username, status, created_at DESC);
    `);
  })();
  return schemaReady;
}

async function cleanup() {
  const stalePlayers = new Date(Date.now() - 45 * 1000).toISOString();
  const staleMatches = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await supabase.from('skybreak_players').delete().lt('last_seen', stalePlayers);
  await supabase.from('skybreak_matches').delete().lt('updated_at', staleMatches);
}

async function getPlayers(matchId) {
  const since = new Date(Date.now() - 25 * 1000).toISOString();
  const { data, error } = await supabase
    .from('skybreak_players')
    .select('username,team_id,x,y,z,yaw,hp,state,meta,last_seen')
    .eq('match_id', matchId)
    .gte('last_seen', since)
    .order('last_seen', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function findOrCreateMatch(user, body) {
  await cleanup();
  const fresh = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: matches, error } = await supabase
    .from('skybreak_matches')
    .select('id,leader,status,team_mode,max_players,created_at,updated_at')
    .eq('status', 'lobby')
    .gte('updated_at', fresh)
    .order('updated_at', { ascending: false })
    .limit(5);
  if (error) throw error;

  for (const match of matches || []) {
    const players = await getPlayers(match.id);
    if (players.length < Number(match.max_players || 8)) return match;
  }

  const id = `sky_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const match = {
    id,
    leader: user.username,
    status: 'lobby',
    team_mode: body.teamMode === 'solo' ? 'solo' : 'squad',
    max_players: Math.max(2, Math.min(16, Number(body.maxPlayers || 8))),
    updated_at: new Date().toISOString()
  };
  const { data, error: insertError } = await supabase.from('skybreak_matches').insert(match).select().single();
  if (insertError) throw insertError;
  return data;
}

async function joinMatch(user, body) {
  const match = body.matchId
    ? (await supabase.from('skybreak_matches').select('*').eq('id', String(body.matchId)).single()).data
    : await findOrCreateMatch(user, body);
  if (!match) throw new Error('Match nicht gefunden');

  await supabase.from('skybreak_matches').update({ updated_at: new Date().toISOString() }).eq('id', match.id);
  const teamId = body.teamMode === 'solo' ? user.username : match.leader;
  const { error } = await supabase.from('skybreak_players').upsert({
    match_id: match.id,
    username: user.username,
    user_id: user.id,
    team_id: teamId,
    state: body.state || 'lobby',
    hp: 200,
    last_seen: new Date().toISOString(),
    meta: { source: 'ehoser', skin: body.skin || 0 }
  }, { onConflict: 'match_id,username' });
  if (error) throw error;

  return { match, players: await getPlayers(match.id) };
}

async function heartbeat(user, body) {
  const matchId = String(body.matchId || '');
  if (!matchId) throw new Error('matchId fehlt');
  const now = new Date().toISOString();
  const { error } = await supabase.from('skybreak_players').upsert({
    match_id: matchId,
    username: user.username,
    user_id: user.id,
    team_id: body.teamId || user.username,
    x: Number(body.x) || 0,
    y: Number(body.y) || 0,
    z: Number(body.z) || 0,
    yaw: Number(body.yaw) || 0,
    hp: Math.max(0, Math.min(200, Number(body.hp || 200))),
    state: String(body.state || 'lobby').slice(0, 24),
    meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
    last_seen: now
  }, { onConflict: 'match_id,username' });
  if (error) throw error;
  await supabase.from('skybreak_matches').update({ updated_at: now }).eq('id', matchId);
  return { players: await getPlayers(matchId) };
}

async function listUsers() {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('users')
    .select('username,last_seen')
    .order('last_seen', { ascending: false })
    .limit(200);
  if (error) throw error;
  return {
    users: (data || []).map(row => ({
      username: row.username,
      online: row.last_seen ? row.last_seen >= since : false
    }))
  };
}

async function listFriends(user) {
  const { data, error } = await supabase
    .from('skybreak_friends')
    .select('friend_username')
    .eq('owner_username', user.username);
  if (error) throw error;
  return { friends: (data || []).map(row => row.friend_username) };
}

async function addFriend(user, body) {
  const friend = String(body.username || '').trim().slice(0, 40);
  if (!friend || friend.toLowerCase() === user.username.toLowerCase()) throw new Error('Ungueltiger Nutzer');
  const { error } = await supabase.from('skybreak_friends').upsert({
    owner_username: user.username,
    friend_username: friend
  }, { onConflict: 'owner_username,friend_username' });
  if (error) throw error;
  return listFriends(user);
}

async function invite(user, body) {
  const to = String(body.username || '').trim().slice(0, 40);
  const matchId = String(body.matchId || '').trim();
  if (!to || !matchId) throw new Error('Einladung unvollstaendig');
  const id = `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const { error } = await supabase.from('skybreak_invites').insert({
    id,
    from_username: user.username,
    to_username: to,
    match_id: matchId,
    status: 'pending',
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
  return { invite: { id, from: user.username, to, matchId, status: 'pending' } };
}

async function invites(user) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('skybreak_invites')
    .select('id,from_username,match_id,status,created_at')
    .eq('to_username', user.username)
    .eq('status', 'pending')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return { invites: data || [] };
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
    await ensureSchema();
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
    if (req.method === 'POST' && path === '/leave') {
      await supabase.from('skybreak_players').delete().eq('match_id', String(body.matchId || '')).eq('username', user.username);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'SKYBREAK API nicht gefunden' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'SKYBREAK API Fehler' });
  }
};
