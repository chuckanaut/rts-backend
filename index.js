const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const PORT = process.env.PORT || 3000;

// In-memory stores (replace with DB in production)
const users = new Map(); // userId -> user object
const promoCodes = new Map(); // code -> meta
const chatMessages = []; // simple array store
const shopCatalog = []; // full catalog
let activeShop = { start: null, end: null, items: [] };
const lobbies = new Map(); // lobbyId -> lobby meta

// Seed promo code 4110 as unlimited
promoCodes.set('4110', { code: '4110', unlimited: true, created_at: new Date().toISOString() });

// Simple helper: create or get user by googleId
function getOrCreateUser(googleId, displayName, email) {
  for (let user of users.values()) {
    if (user.google_id === googleId) return user;
  }
  const id = uuidv4();
  const user = {
    id,
    google_id: googleId,
    username: displayName || `user_${id.substr(0,6)}`,
    email: email || null,
    created_at: new Date().toISOString(),
    is_full_unlocked: false,
    trial_expires_at: null,
    redeemed_codes: []
  };
  users.set(id, user);
  return user;
}

// ---------- Auth ----------
app.post('/api/auth/google', (req, res) => {
  // Expects body: { googleId, displayName, email }
  const { googleId, displayName, email } = req.body;
  if (!googleId) return res.status(400).json({ error: 'googleId required' });
  // NOTE: Verify tokens server-side in production!
  const user = getOrCreateUser(googleId, displayName, email);
  return res.json({ success: true, user });
});

// ---------- Redeem promo code ----------
app.post('/api/redeem', (req, res) => {
  // body: { userId, code }
  const { userId, code } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const meta = promoCodes.get(code);
  if (!meta) return res.status(400).json({ error: 'invalid code' });

  // Mark user unlocked and record redemption
  user.is_full_unlocked = true;
  user.redeemed_codes.push({ code, redeemed_at: new Date().toISOString() });
  users.set(userId, user);
  return res.json({ success: true, unlocked: true, user });
});

// ---------- Start 7-day trial (no card) ----------
app.post('/api/trial', (req, res) => {
  // body: { userId }
  const { userId } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // If already full unlocked, nothing to do
  if (user.is_full_unlocked) return res.json({ success: true, message: 'already unlocked', user });

  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days
  user.trial_expires_at = expires.toISOString();
  users.set(userId, user);
  return res.json({ success: true, trial_expires_at: user.trial_expires_at, user });
});

// ---------- Profile ----------
app.get('/api/profile/:userId', (req, res) => {
  const user = users.get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  // Compute effective unlocked status (trial or full)
  const now = new Date();
  let trialActive = false;
  if (user.trial_expires_at) trialActive = new Date(user.trial_expires_at) > now;
  return res.json({ success: true, user: { ...user, trial_active: trialActive } });
});

// ---------- Shop catalog & active rotation ----------
// Simple catalog seed
function seedCatalog() {
  shopCatalog.length = 0;
  const categories = ['base_skin','building_skin','vehicle_skin','unit_skin','avatar_frame','avatar_pic'];
  for (let i=1;i<=30;i++) {
    shopCatalog.push({ id: `item_${i}`, name: `Skin ${i}`, category: categories[i % categories.length], rarity: ['common','rare','epic'][i%3], price: (i%5+1)*0.99 });
  }
}
seedCatalog();

// Endpoint to get active shop
app.get('/api/shop/active', (req, res) => {
  return res.json({ success: true, activeShop });
});

// Force-rotate (admin) - for dev only
app.post('/api/shop/rotate', (req, res) => {
  rotateShopNow();
  return res.json({ success: true, activeShop });
});

function rotateShopNow() {
  const start = new Date();
  const end = new Date(start.getTime() + 14*24*60*60*1000);
  // pick 8 random items with rarity cap
  const selected = [];
  const used = new Set();
  while (selected.length < 8 && used.size < shopCatalog.length) {
    const idx = Math.floor(Math.random()*shopCatalog.length);
    if (!used.has(idx)) {
      used.add(idx);
      selected.push(shopCatalog[idx]);
    }
  }
  activeShop = { start: start.toISOString(), end: end.toISOString(), items: selected };
}

// Schedule rotation every 2 weeks (run on server start for dev)
rotateShopNow();
cron.schedule('0 0 */14 * *', () => {
  console.log('Running scheduled shop rotation...');
  rotateShopNow();
});

// ---------- Chat endpoints (basic) ----------
app.post('/api/chat/send', (req, res) => {
  // body: { channel, userId, message }
  const { channel, userId, message } = req.body;
  if (!channel || !userId || !message) return res.status(400).json({ error: 'channel,userId,message required' });
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Basic moderation: block messages that contain banned words
  const banned = ['badword1','badword2'];
  const lower = message.toLowerCase();
  for (let b of banned) if (lower.includes(b)) return res.status(400).json({ error: 'message contains banned content' });

  const msg = { id: uuidv4(), channel, userId, username: user.username, message, timestamp: new Date().toISOString() };
  chatMessages.push(msg);
  // In production: broadcast to channel via Photon / WebSocket
  return res.json({ success: true, message: msg });
});

app.get('/api/chat/history/:channel', (req, res) => {
  const channel = req.params.channel;
  const history = chatMessages.filter(m => m.channel === channel).slice(-200);
  return res.json({ success: true, messages: history });
});

// ---------- Matchmaking / Lobby quick search & invites ----------
app.post('/api/lobby/create', (req, res) => {
  // body: { hostUserId, mode (1v1/2v2...), mapId }
  const { hostUserId, mode, mapId } = req.body;
  const id = uuidv4();
  const meta = { id, hostUserId, mode, mapId, players: [hostUserId], created_at: new Date().toISOString() };
  lobbies.set(id, meta);
  return res.json({ success: true, lobby: meta });
});

app.post('/api/lobby/join', (req, res) => {
  // body: { lobbyId, userId }
  const { lobbyId, userId } = req.body;
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return res.status(404).json({ error: 'lobby not found' });
  lobby.players.push(userId);
  lobbies.set(lobbyId, lobby);
  return res.json({ success: true, lobby });
});

app.get('/api/lobby/search', (req, res) => {
  // query params: mode, mapId, page, q
  const { mode } = req.query;
  const matches = [];
  for (let l of lobbies.values()) {
    if (!mode || l.mode === mode) matches.push(l);
  }
  return res.json({ success: true, matches });
});

app.post('/api/invite', (req, res) => {
  // body: { fromUserId, toUserId, lobbyId }
  const { fromUserId, toUserId, lobbyId } = req.body;
  // In production: send push notification / in-app notif / email
  return res.json({ success: true, invite: { fromUserId, toUserId, lobbyId, sent_at: new Date().toISOString() } });
});

// Health check
app.get('/api/health', (req, res) => res.json({ success: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`RTS backend running on port ${PORT}`);
});
