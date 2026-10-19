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
let activeShop = { start: null, end: null, items: [], sales: [] };
const lobbies = new Map(); // lobbyId -> lobby meta
const bans = new Set(); // userId bans
const mutes = new Map(); // userId -> mutedUntil
const orders = new Map(); // orderId -> order object

// Seed promo code 4110 as unlimited (game entitlement only)
promoCodes.set('4110', { code: '4110', unlimited: true, created_at: new Date().toISOString(), for: 'game_entitlement' });

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
    redeemed_codes: [],
    avatar_url: null,
    purchases: []
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

// ---------- Redeem promo code (game entitlement only) ----------
app.post('/api/redeem', (req, res) => {
  // body: { userId, code }
  const { userId, code } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const meta = promoCodes.get(code);
  if (!meta) return res.status(400).json({ error: 'invalid code' });

  // Only allow code use for game entitlement
  if (meta.for && meta.for !== 'game_entitlement') return res.status(400).json({ error: 'code not valid for this purpose' });

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

// ---------- Avatar upload (signed URL placeholder) ----------
app.post('/api/avatar/request-upload', (req, res) => {
  // body: { userId, fileName }
  const { userId, fileName } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  // In production: generate signed URL from S3 / GCS and return to client. Here we return a placeholder URL.
  const uploadUrl = `https://storage.example.com/uploads/${userId}/${fileName}?signed=PLACEHOLDER`;
  const accessUrl = `https://cdn.example.com/uploads/${userId}/${fileName}`;
  return res.json({ success: true, uploadUrl, accessUrl });
});

app.post('/api/avatar/confirm', (req, res) => {
  // body: { userId, accessUrl }
  const { userId, accessUrl } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  user.avatar_url = accessUrl;
  users.set(userId, user);
  return res.json({ success: true, user });
});

// ---------- Shop catalog & active rotation ----------
// Simple catalog seed
function seedCatalog() {
  shopCatalog.length = 0;
  const categories = ['base_skin','building_skin','vehicle_skin','unit_skin','avatar_frame','avatar_pic','physical'];
  // Add some sample items, marking some physical SKUs specially
  for (let i=1;i<=30;i++) {
    const cat = categories[i % categories.length];
    const isPhysical = (cat === 'physical');
    shopCatalog.push({ id: `item_${i}`, name: `Item ${i}`, category: cat, physical: isPhysical, rarity: ['common','rare','epic'][i%3], price: Math.round(((i%5+1)*0.99)*100)/100 });
  }
  // Add explicit physical products for merch
  shopCatalog.push({ id: 'tumbler_20oz', name: 'Coffee Mug Tumbler (20 oz)', category: 'physical', physical: true, price: 20.00 });
  shopCatalog.push({ id: 'coffee_mug', name: 'Coffee Mug', category: 'physical', physical: true, price: 10.00 });
  shopCatalog.push({ id: 'coffee_mug_tumbler', name: 'Coffee Mug Tumbler', category: 'physical', physical: true, price: 15.00 });
}
seedCatalog();

// Endpoint to get active shop (includes sales metadata)
app.get('/api/shop/active', (req, res) => {
  return res.json({ success: true, activeShop });
});

// Purchase stub: in production validate Play Billing purchase token server-side
app.post('/api/shop/purchase', (req, res) => {
  // body: { userId, itemId, platformPurchaseToken (optional) }
  const { userId, itemId } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const item = shopCatalog.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'item not found' });
  // For now just record purchase (this endpoint is for digital purchases)
  user.purchases.push({ itemId, purchased_at: new Date().toISOString() });
  users.set(userId, user);
  return res.json({ success: true, purchase: { itemId } });
});

// Force-rotate (admin) - for dev only
app.post('/api/shop/rotate', (req, res) => {
  rotateShopNow();
  return res.json({ success: true, activeShop });
});

function rotateShopNow() {
  const start = new Date();
  const end = new Date(start.getTime() + 14*24*60*60*1000);
  // pick 8 random items
  const selected = [];
  const used = new Set();
  while (selected.length < 8 && used.size < shopCatalog.length) {
    const idx = Math.floor(Math.random()*shopCatalog.length);
    if (!used.has(idx)) {
      used.add(idx);
      selected.push(shopCatalog[idx]);
    }
  }

  // Create sales metadata for this rotation
  // Physical sale: 3% off for cups/tumblers (we'll detect by sku prefix 'tumbler' or category 'physical')
  const physicalSale = { type: 'physical', discountPercent: 3, categories: ['physical'], appliesTo: ['tumbler_20oz','coffee_mug','coffee_mug_tumbler'] };

  // Digital sale: pick N random digital items to discount 35%
  const digitalCandidates = shopCatalog.filter(it => !it.physical);
  const NUM_DIGITAL_DISCOUNT = 6;
  const digitalSelected = [];
  const usedD = new Set();
  while (digitalSelected.length < NUM_DIGITAL_DISCOUNT && usedD.size < digitalCandidates.length) {
    const idx = Math.floor(Math.random()*digitalCandidates.length);
    if (!usedD.has(idx)) { usedD.add(idx); digitalSelected.push(digitalCandidates[idx].id); }
  }
  const digitalSale = { type: 'digital', discountPercent: 35, itemIds: digitalSelected };

  // Build activeShop items with sale annotations
  const itemsWithSale = selected.map(it => {
    const copy = { ...it };
    copy.onSale = false;
    copy.salePercent = 0;
    copy.salePrice = null;
    // apply physical sale if matches
    if (physicalSale.appliesTo.includes(it.id)) {
      copy.onSale = true;
      copy.salePercent = physicalSale.discountPercent;
      copy.salePrice = Math.round((it.price * (1 - physicalSale.discountPercent/100)) * 100)/100;
    }
    // apply digital sale if included
    if (digitalSale.itemIds.includes(it.id)) {
      copy.onSale = true;
      copy.salePercent = digitalSale.discountPercent;
      copy.salePrice = Math.round((it.price * (1 - digitalSale.discountPercent/100)) * 100)/100;
    }
    return copy;
  });

  activeShop = { start: start.toISOString(), end: end.toISOString(), items: itemsWithSale, sales: [physicalSale, digitalSale] };
}

// Schedule rotation every 2 weeks (run on server start for dev)
rotateShopNow();
cron.schedule('0 0 */14 * *', () => {
  console.log('Running scheduled shop rotation...');
  rotateShopNow();
});

// ---------- Orders & Shipping ----------
function calculateShipping(totalQty) {
  if (totalQty <= 0) return 0.0;
  if (totalQty === 1) return 4.99;
  if (totalQty === 2) return 5.99;
  if (totalQty === 3) return 7.99;
  if (totalQty === 4) return 8.99;
  const table = {5:9.99,6:10.99,7:11.99,8:12.99,9:13.99};
  if (table[totalQty]) return table[totalQty];
  if (totalQty >= 10 && totalQty <= 20) return 0.0; // free shipping
  return null; // indicates manual quote needed for >20
}

// Create an order and return Stripe checkout URL (test-mode or placeholder)
app.post('/api/orders/create', (req, res) => {
  /* Expected body:
    { userId, items: [{ sku, qty }], shipping: { name, address1, city, region, postalCode, country }, currency }
  */
  const { userId, items, shipping, currency } = req.body;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!shipping || !shipping.country) return res.status(400).json({ error: 'shipping country required' });
  if (shipping.country.toUpperCase() !== 'US') return res.status(400).json({ error: 'Shipping only available within the United States.' });

  // compute total physical qty and line totals, apply sales if present
  let totalQty = 0;
  let subtotal = 0.0;
  const lineItems = [];
  for (let it of items) {
    const sku = it.sku;
    const qty = parseInt(it.qty) || 1;
    const catalogItem = shopCatalog.find(i => i.id === sku);
    if (!catalogItem) return res.status(400).json({ error: `unknown sku ${sku}` });

    // determine price: if activeShop has this item with salePrice use that, else base price
    const shopItem = activeShop.items.find(si => si.id === sku);
    let unitPrice = catalogItem.price;
    let appliedDiscount = 0;
    if (shopItem && shopItem.onSale && shopItem.salePrice) { unitPrice = shopItem.salePrice; appliedDiscount = shopItem.salePercent || 0; }

    lineItems.push({ sku, name: catalogItem.name, qty, unitPrice, appliedDiscount });

    if (catalogItem.physical) totalQty += qty;
    subtotal += unitPrice * qty;
  }

  // shipping calculation based on total physical qty
  const shippingCost = calculateShipping(totalQty);
  if (shippingCost === null) {
    // needs manual quote
    // create provisional order record but do not create Stripe session
    const orderId = uuidv4();
    const order = { id: orderId, userId, items: lineItems, shipping, subtotal, shippingCost: null, total: subtotal, status: 'needs_quote', created_at: new Date().toISOString() };
    orders.set(orderId, order);
    return res.json({ success: false, needsApproval: true, order });
  }

  const total = Math.round((subtotal + shippingCost) * 100)/100;
  // In production create Stripe Checkout session; here we return a placeholder URL for test
  const orderId = uuidv4();
  const checkoutUrl = `https://checkout.example.com/session/${orderId}`; // placeholder
  const order = { id: orderId, userId, items: lineItems, shipping, subtotal, shippingCost, total, status: 'created', checkoutUrl, created_at: new Date().toISOString() };
  orders.set(orderId, order);

  // Return checkout URL to client to open
  return res.json({ success: true, orderId, checkoutUrl, order });
});

// Get order history for user
app.get('/api/orders/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const userOrders = [];
  for (let o of orders.values()) if (o.userId === userId) userOrders.push(o);
  return res.json({ success: true, orders: userOrders });
});

// Admin approves manual quote: set shippingCost and create checkout
app.post('/api/orders/approve-quote', (req, res) => {
  // body: { adminKey, orderId, shippingCost }
  const { adminKey, orderId, shippingCost } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'not authorized' });
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'order not found' });
  order.shippingCost = parseFloat(shippingCost);
  order.total = Math.round(((order.subtotal || 0) + order.shippingCost) * 100)/100;
  order.status = 'created';
  order.checkoutUrl = `https://checkout.example.com/session/${orderId}`; // placeholder for Stripe session
  orders.set(orderId, order);
  return res.json({ success: true, order });
});

// ---------- Chat endpoints (basic) ----------
app.post('/api/chat/send', (req, res) => {
  // body: { channel, userId, message }
  const { channel, userId, message } = req.body;
  if (!channel || !userId || !message) return res.status(400).json({ error: 'channel,userId,message required' });
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (bans.has(userId)) return res.status(403).json({ error: 'user banned' });

  // Check mutes
  const muteUntil = mutes.get(userId);
  if (muteUntil && new Date(muteUntil) > new Date()) return res.status(403).json({ error: 'user muted' });

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

// Moderation admin endpoints (dev only) - mute/ban
app.post('/api/moderation/ban', (req, res) => {
  // body: { adminKey, userId }
  const { adminKey, userId } = req.body;
  // In production: verify adminKey properly
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'not authorized' });
  bans.add(userId);
  return res.json({ success: true });
});

app.post('/api/moderation/mute', (req, res) => {
  // body: { adminKey, userId, minutes }
  const { adminKey, userId, minutes } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'not authorized' });
  const until = new Date(new Date().getTime() + (minutes||60)*60000).toISOString();
  mutes.set(userId, until);
  return res.json({ success: true, mutedUntil: until });
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
  if (lobby.players.includes(userId)) return res.json({ success: true, lobby });
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
