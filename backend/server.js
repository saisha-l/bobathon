/**
 * BOB, WYD? — Backend Server
 *
 * REST  → http://localhost:3001
 * WS    → ws://localhost:3001
 *
 * In-memory store (no DB required for MVP).
 * Squads expire 24 h after creation.
 */

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const crypto  = require('crypto');

// ─────────────────────────────────────────────────────────────
//  Config — swap these out or set as env vars before deploying
// ─────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || 'bc62fc7f29ea4b43b8fa9595bab35970';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '4b1f27bddab94c3faced622c6bff0953';
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  || 'http://127.0.0.1:3001/auth/spotify/callback';
const PORT = process.env.PORT || 3001;

const SQUAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─────────────────────────────────────────────────────────────
//  In-memory stores
// ─────────────────────────────────────────────────────────────
const squads      = new Map(); // code → SquadRecord
const squadSockets = new Map(); // code → Set<WebSocket>

// Spotify tokens keyed by memberId
// { accessToken, refreshToken, expiresAt }
const spotifyTokens = new Map();

// OAuth state → memberId (short-lived, cleared after callback)
const oauthStates = new Map();

// ─────────────────────────────────────────────────────────────
//  Daily poll pool
// ─────────────────────────────────────────────────────────────
const POLL_POOL = [
  { question: 'How productive are you feeling today?',        options: ['Super focused 🎯', 'Pretty good 👍', "Meh, it's okay 😐", 'Struggling today 😅'] },
  { question: "What's your WFH setup vibe today?",            options: ['Desk setup perfection 💻', 'Couch mode activated 🛋', 'Kitchen table chaos 🍕', 'Coffee shop remote ☕'] },
  { question: 'First thing you do at the start of your day?', options: ['Check Slack/emails 📬', 'Make coffee/tea ☕', 'Review my to-do list 📋', 'Open VS Code immediately 💻'] },
  { question: 'Current energy level?',                        options: ['Fully charged ⚡', 'Running okay 🔋', 'On low power 🪫', 'Need a reboot 😴'] },
  { question: 'Best background for deep work?',               options: ['Total silence 🤫', 'Lo-fi beats 🎧', 'Coffee shop noise ☕', 'White noise 🌊'] },
];

function todayPoll() {
  const dayIndex = Math.floor(Date.now() / 86400000) % POLL_POOL.length;
  return POLL_POOL[dayIndex];
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(0, chars.length)];
  return squads.has(code) ? genCode() : code;
}

function genMemberId() { return crypto.randomBytes(8).toString('hex'); }
function genState()    { return crypto.randomBytes(16).toString('hex'); }

function squadPublic(squad) {
  return {
    code:        squad.code,
    name:        squad.name,
    theme:       squad.theme,
    createdAt:   squad.createdAt,
    expiresAt:   squad.expiresAt,
    members:     [...squad.members.values()],
    poll:        squad.poll,
    pollVotes:   squad.pollVotes,
    memberCount: squad.members.size,
  };
}

function isExpired(squad) { return Date.now() > squad.expiresAt; }

// Prune expired squads every 10 minutes
setInterval(() => {
  for (const [code, squad] of squads.entries()) {
    if (isExpired(squad)) { squads.delete(code); squadSockets.delete(code); }
  }
  // Prune stale oauth states older than 10 min
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, entry] of oauthStates.entries()) {
    if (entry.createdAt < cutoff) oauthStates.delete(state);
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
//  Broadcast helpers
// ─────────────────────────────────────────────────────────────
function broadcast(code, message) {
  const sockets = squadSockets.get(code);
  if (!sockets) return;
  const payload = JSON.stringify(message);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastSquadState(code) {
  const squad = squads.get(code);
  if (squad) broadcast(code, { type: 'SQUAD_STATE', data: squadPublic(squad) });
}

// ─────────────────────────────────────────────────────────────
//  Spotify API helpers
// ─────────────────────────────────────────────────────────────
async function spotifyFetch(url, accessToken) {
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res;
}

async function refreshSpotifyToken(memberId) {
  const tokens = spotifyTokens.get(memberId);
  if (!tokens) return null;

  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body,
  });
  if (!res.ok) { spotifyTokens.delete(memberId); return null; }
  const data = await res.json();
  tokens.accessToken = data.access_token;
  tokens.expiresAt   = Date.now() + (data.expires_in - 60) * 1000;
  if (data.refresh_token) tokens.refreshToken = data.refresh_token;
  return tokens.accessToken;
}

async function getValidAccessToken(memberId) {
  const tokens = spotifyTokens.get(memberId);
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  return refreshSpotifyToken(memberId);
}

async function fetchNowPlaying(memberId) {
  const accessToken = await getValidAccessToken(memberId);
  if (!accessToken) return null;

  // Node 18+ has native fetch; fall back to node-fetch if needed
  let fetchFn;
  try { fetchFn = fetch; } catch { const m = await import('node-fetch'); fetchFn = m.default; }

  const res = await fetchFn('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 204 || res.status === 404) return { playing: false }; // nothing playing
  if (!res.ok) return null;

  const data = await res.json();
  if (!data || !data.item) return { playing: false };

  return {
    playing:    data.is_playing,
    track:      data.item.name,
    artist:     data.item.artists.map(a => a.name).join(', '),
    album:      data.item.album.name,
    albumArt:   data.item.album.images?.[1]?.url || data.item.album.images?.[0]?.url || null,
    trackUrl:   data.item.external_urls?.spotify || null,
    progressMs: data.progress_ms,
    durationMs: data.item.duration_ms,
  };
}

// ─────────────────────────────────────────────────────────────
//  Express app
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, squads: squads.size }));

// ─────────────────────────────────────────────────────────────
//  SPOTIFY OAUTH
// ─────────────────────────────────────────────────────────────

// Step 1: frontend opens this URL in a popup
// GET /auth/spotify?memberId=xxx&squadCode=xxx
app.get('/auth/spotify', (req, res) => {
  const { memberId, squadCode } = req.query;
  if (!memberId || !squadCode) return res.status(400).send('Missing memberId or squadCode');

  const state = genState();
  oauthStates.set(state, { memberId, squadCode, createdAt: Date.now() });

  const scopes = 'user-read-currently-playing user-read-playback-state';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     SPOTIFY_CLIENT_ID,
    scope:         scopes,
    redirect_uri:  SPOTIFY_REDIRECT_URI,
    state,
  });

  res.redirect('https://accounts.spotify.com/authorize?' + params.toString());
});

// Step 2: Spotify redirects back here with ?code=&state=
app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<script>window.opener?.postMessage({type:'SPOTIFY_ERROR',error:'${error}'},'*');window.close();</script>`);
  }

  const entry = oauthStates.get(state);
  if (!entry) {
    return res.send(`<script>window.opener?.postMessage({type:'SPOTIFY_ERROR',error:'Invalid state'},'*');window.close();</script>`);
  }
  oauthStates.delete(state);

  const { memberId, squadCode } = entry;

  // Exchange code for tokens
  let fetchFn;
  try { fetchFn = fetch; } catch { const m = await import('node-fetch'); fetchFn = m.default; }

  try {
    const tokenRes = await fetchFn('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.send(`<script>window.opener?.postMessage({type:'SPOTIFY_ERROR',error:'Token exchange failed'},'*');window.close();</script>`);
    }

    const tokenData = await tokenRes.json();
    spotifyTokens.set(memberId, {
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt:    Date.now() + (tokenData.expires_in - 60) * 1000,
    });

    // Fetch first now-playing immediately and push to squad
    const nowPlaying = await fetchNowPlaying(memberId);
    if (nowPlaying) {
      const squad  = squads.get(squadCode);
      const member = squad?.members.get(memberId);
      if (member) {
        member.spotify = nowPlaying.playing ? {
          track:    nowPlaying.track,
          artist:   nowPlaying.artist,
          album:    nowPlaying.album,
          albumArt: nowPlaying.albumArt,
          trackUrl: nowPlaying.trackUrl,
        } : null;
        broadcastSquadState(squadCode);
      }
    }

    // Return success to the popup — it will close itself
    res.send(`<!DOCTYPE html><html><body>
      <p style="font-family:sans-serif;text-align:center;padding:40px;color:#22c55e">
        ✅ Spotify connected! You can close this window.
      </p>
      <script>
        window.opener?.postMessage({type:'SPOTIFY_CONNECTED',memberId:'${memberId}'},'*');
        setTimeout(()=>window.close(), 1000);
      </script>
    </body></html>`);
  } catch (e) {
    console.error('Spotify callback error:', e);
    res.send(`<script>window.opener?.postMessage({type:'SPOTIFY_ERROR',error:'Server error'},'*');window.close();</script>`);
  }
});

// Step 3: frontend calls this to get current now-playing
// GET /auth/spotify/now-playing?memberId=xxx&squadCode=xxx
app.get('/auth/spotify/now-playing', async (req, res) => {
  const { memberId, squadCode } = req.query;
  if (!memberId) return res.status(400).json({ error: 'Missing memberId' });
  if (!spotifyTokens.has(memberId)) return res.status(401).json({ error: 'Not connected' });

  try {
    const nowPlaying = await fetchNowPlaying(memberId);
    if (!nowPlaying) return res.status(502).json({ error: 'Spotify API error' });

    // Update member's spotify field in the squad and broadcast
    if (squadCode) {
      const squad  = squads.get(squadCode);
      const member = squad?.members.get(memberId);
      if (member) {
        member.spotify = nowPlaying.playing ? {
          track:    nowPlaying.track,
          artist:   nowPlaying.artist,
          album:    nowPlaying.album,
          albumArt: nowPlaying.albumArt,
          trackUrl: nowPlaying.trackUrl,
        } : null;
        broadcastSquadState(squadCode);
      }
    }

    return res.json(nowPlaying);
  } catch (e) {
    console.error('now-playing error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Step 4: disconnect Spotify
// DELETE /auth/spotify?memberId=xxx&squadCode=xxx
app.delete('/auth/spotify', (req, res) => {
  const { memberId, squadCode } = req.query;
  if (!memberId) return res.status(400).json({ error: 'Missing memberId' });

  spotifyTokens.delete(memberId);

  if (squadCode) {
    const squad  = squads.get(squadCode);
    const member = squad?.members.get(memberId);
    if (member) { member.spotify = null; broadcastSquadState(squadCode); }
  }

  res.status(204).send();
});

// Check if a member has Spotify connected
// GET /auth/spotify/status?memberId=xxx
app.get('/auth/spotify/status', (req, res) => {
  const { memberId } = req.query;
  res.json({ connected: spotifyTokens.has(memberId) });
});

// ─────────────────────────────────────────────────────────────
//  SQUAD ROUTES
// ─────────────────────────────────────────────────────────────

// POST /squads
app.post('/squads', (req, res) => {
  const { name, theme = 'galaxy', creatorName, creatorAvatar, creatorMood = 7, creatorStatus = 'Just arrived' } = req.body;
  if (!name || name.trim().length < 3 || name.trim().length > 30)
    return res.status(400).json({ error: 'Squad name must be 3–30 characters.' });
  if (!creatorName || creatorName.trim().length < 2 || creatorName.trim().length > 20)
    return res.status(400).json({ error: 'Display name must be 2–20 characters.' });
  if (!creatorAvatar)
    return res.status(400).json({ error: 'Avatar is required.' });

  const code = genCode();
  const memberId = genMemberId();
  const now = Date.now();
  const poll = todayPoll();

  const member = {
    id: memberId, name: creatorName.trim(), avatar: creatorAvatar,
    status: creatorStatus, mood: Math.min(10, Math.max(1, Number(creatorMood))),
    theme, spotify: null, isCreator: true, joinedAt: now, lastSeen: now,
  };

  squads.set(code, {
    code, name: name.trim(), theme, createdAt: now, expiresAt: now + SQUAD_TTL_MS,
    members: new Map([[memberId, member]]),
    poll, pollVotes: new Array(poll.options.length).fill(0), voterIds: new Set(),
  });

  return res.status(201).json({ squad: squadPublic(squads.get(code)), memberId, token: memberId });
});

// GET /squads/:code
app.get('/squads/:code', (req, res) => {
  const code  = req.params.code.toUpperCase();
  const squad = squads.get(code);
  if (!squad)           return res.status(404).json({ error: 'Code not found.' });
  if (isExpired(squad)) return res.status(410).json({ error: 'This squad has ended.' });
  return res.json({ squad: squadPublic(squad) });
});

// POST /squads/:code/join
app.post('/squads/:code/join', (req, res) => {
  const code  = req.params.code.toUpperCase();
  const squad = squads.get(code);
  if (!squad)           return res.status(404).json({ error: 'Code not found.' });
  if (isExpired(squad)) return res.status(410).json({ error: 'This squad has ended.' });

  const { name, avatar, mood = 7, status = 'Just arrived' } = req.body;
  if (!name || name.trim().length < 2 || name.trim().length > 20)
    return res.status(400).json({ error: 'Display name must be 2–20 characters.' });
  if (!avatar) return res.status(400).json({ error: 'Avatar is required.' });

  const memberId = genMemberId();
  const now = Date.now();
  const member = {
    id: memberId, name: name.trim(), avatar, status,
    mood: Math.min(10, Math.max(1, Number(mood))),
    theme: squad.theme, spotify: null, isCreator: false, joinedAt: now, lastSeen: now,
  };
  squad.members.set(memberId, member);
  broadcastSquadState(code);
  return res.status(201).json({ squad: squadPublic(squad), memberId, token: memberId });
});

// PATCH /squads/:code/members/:memberId
app.patch('/squads/:code/members/:memberId', (req, res) => {
  const code     = req.params.code.toUpperCase();
  const memberId = req.params.memberId;
  const squad    = squads.get(code);
  if (!squad)           return res.status(404).json({ error: 'Squad not found.' });
  if (isExpired(squad)) return res.status(410).json({ error: 'This squad has ended.' });
  const member = squad.members.get(memberId);
  if (!member) return res.status(404).json({ error: 'Member not found.' });

  const { status, mood, spotify } = req.body;
  if (status  !== undefined) member.status = status;
  if (mood    !== undefined) member.mood   = Math.min(10, Math.max(1, Number(mood)));
  if (spotify !== undefined) {
    member.spotify = spotify === null ? null
      : (spotify.track && spotify.artist ? { track: spotify.track, artist: spotify.artist, art: spotify.art || '🎵' } : member.spotify);
  }
  member.lastSeen = Date.now();
  broadcastSquadState(code);
  return res.json({ member });
});

// DELETE /squads/:code/members/:memberId
app.delete('/squads/:code/members/:memberId', (req, res) => {
  const code     = req.params.code.toUpperCase();
  const memberId = req.params.memberId;
  const squad    = squads.get(code);
  if (!squad) return res.status(404).json({ error: 'Squad not found.' });
  squad.members.delete(memberId);
  broadcastSquadState(code);
  if (squad.members.size === 0) squads.delete(code);
  return res.status(204).send();
});

// POST /squads/:code/poll/vote
app.post('/squads/:code/poll/vote', (req, res) => {
  const code  = req.params.code.toUpperCase();
  const squad = squads.get(code);
  if (!squad)           return res.status(404).json({ error: 'Squad not found.' });
  if (isExpired(squad)) return res.status(410).json({ error: 'This squad has ended.' });
  const { memberId, optionIndex } = req.body;
  if (squad.voterIds.has(memberId)) return res.status(409).json({ error: 'Already voted.' });
  const idx = Number(optionIndex);
  if (idx < 0 || idx >= squad.poll.options.length) return res.status(400).json({ error: 'Invalid option.' });
  squad.voterIds.add(memberId);
  squad.pollVotes[idx]++;
  broadcastSquadState(code);
  return res.json({ pollVotes: squad.pollVotes });
});

// POST /squads/:code/extend
app.post('/squads/:code/extend', (req, res) => {
  const code  = req.params.code.toUpperCase();
  const squad = squads.get(code);
  if (!squad) return res.status(404).json({ error: 'Squad not found.' });
  const { memberId } = req.body;
  const member = squad.members.get(memberId);
  if (!member || !member.isCreator) return res.status(403).json({ error: 'Only the creator can extend the squad.' });
  squad.expiresAt = Date.now() + SQUAD_TTL_MS;
  broadcast(code, { type: 'SQUAD_EXTENDED', expiresAt: squad.expiresAt });
  return res.json({ expiresAt: squad.expiresAt });
});

// ─────────────────────────────────────────────────────────────
//  HTTP + WebSocket server
// ─────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let subscribedCode   = null;
  let subscribedMember = null;

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'SUBSCRIBE') {
      const code     = (msg.code || '').toUpperCase();
      const memberId = msg.memberId || '';
      const squad    = squads.get(code);
      if (!squad || isExpired(squad)) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Squad not found or expired.' })); return;
      }
      if (!squad.members.has(memberId)) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Member not found in squad.' })); return;
      }
      subscribedCode   = code;
      subscribedMember = memberId;
      ws._memberId     = memberId;
      if (!squadSockets.has(code)) squadSockets.set(code, new Set());
      squadSockets.get(code).add(ws);
      ws.send(JSON.stringify({ type: 'SQUAD_STATE', data: squadPublic(squad) }));
      return;
    }

    if (msg.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
      if (subscribedCode && subscribedMember) {
        const m = squads.get(subscribedCode)?.members.get(subscribedMember);
        if (m) m.lastSeen = Date.now();
      }
      return;
    }

    if (msg.type === 'PRESENCE_UPDATE') {
      if (!subscribedCode || !subscribedMember) return;
      const squad  = squads.get(subscribedCode);
      const member = squad?.members.get(subscribedMember);
      if (!squad || !member) return;
      if (msg.status  !== undefined) member.status  = msg.status;
      if (msg.mood    !== undefined) member.mood     = Math.min(10, Math.max(1, Number(msg.mood)));
      if (msg.spotify !== undefined) member.spotify  = msg.spotify;
      member.lastSeen = Date.now();
      broadcastSquadState(subscribedCode);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (subscribedCode) {
      const sockets = squadSockets.get(subscribedCode);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) squadSockets.delete(subscribedCode);
      }
      setTimeout(() => {
        const squad  = squads.get(subscribedCode);
        const member = squad?.members.get(subscribedMember);
        if (!member) return;
        const stillConnected = [...(squadSockets.get(subscribedCode) || [])].some(s => s._memberId === subscribedMember);
        if (!stillConnected) {
          squad.members.delete(subscribedMember);
          if (squad.members.size === 0) squads.delete(subscribedCode);
          else broadcastSquadState(subscribedCode);
        }
      }, 5000);
    }
  });

  ws.on('error', () => ws.terminate());
});

server.listen(PORT, () => {
  console.log(`BOB, WYD? backend  →  http://localhost:${PORT}`);
  console.log(`WebSocket          →  ws://localhost:${PORT}`);
  console.log(`Spotify OAuth      →  http://localhost:${PORT}/auth/spotify`);
});
