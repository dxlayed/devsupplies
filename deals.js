// Deals: one-off accounts with their own photos, name, price and description.
// Each deal sells once. The buyer gets the account details right away and the deal leaves the store.
const express = require('express');
const { db, transaction, cents, freshUser } = require('./database');
const { needsLogin, needsOwner } = require('./auth');

const router = express.Router();
const MAX_PHOTOS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// "data:image/jpeg;base64,...." -> { type, bytes }
function readImage(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m || !IMAGE_TYPES.includes(m[1])) throw new Error('Photos must be JPG, PNG, WEBP or GIF.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('A photo is too big (max 5 MB each).');
  return { type: m[1], bytes };
}

// Photo links for a deal, cover first
function photoLinks(dealId, version) {
  return db.prepare('SELECT id FROM deal_images WHERE deal_id=? ORDER BY position, id').all(dealId)
    .map(r => ({ id: r.id, url: `/deal-image/${r.id}?v=${version}` }));
}

// Save the deal's photos in order. `list` items are either an existing photo id (keep it)
// or a "data:image/..." string (a new photo). The first one is the cover.
function savePhotos(dealId, list) {
  if (!Array.isArray(list)) list = [];
  if (list.length > MAX_PHOTOS) throw new Error(`Up to ${MAX_PHOTOS} photos per deal.`);
  const current = db.prepare('SELECT id FROM deal_images WHERE deal_id=?').all(dealId).map(r => r.id);
  const prepared = list.map(item => typeof item === 'string' && item.startsWith('data:') ? { add: readImage(item) } : { keep: Number(item) })
    .filter(x => x.add || current.includes(x.keep));
  const kept = prepared.filter(x => x.keep).map(x => x.keep);
  for (const id of current) if (!kept.includes(id)) db.prepare('DELETE FROM deal_images WHERE id=?').run(id);
  prepared.forEach((x, position) => {
    if (x.keep) db.prepare('UPDATE deal_images SET position=? WHERE id=?').run(position, x.keep);
    else db.prepare('INSERT INTO deal_images (deal_id, image, image_type, position) VALUES (?,?,?,?)').run(dealId, x.add.bytes, x.add.type, position);
  });
}

// ── Public ────────────────────────────────────────────────────
router.get('/deals', (req, res) => {
  const rows = db.prepare("SELECT id, name, description, price, updated FROM deals WHERE status='active' ORDER BY id DESC").all();
  res.json(rows.map(d => ({ id: d.id, name: d.name, description: d.description, price: d.price, images: photoLinks(d.id, d.updated).map(p => p.url) })));
});

router.post('/deals/:id/buy', needsLogin, (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = transaction(() => {
      const deal = db.prepare('SELECT * FROM deals WHERE id=?').get(req.params.id);
      if (!deal || deal.status === 'hidden') return { code: 404, error: 'Deal not found.' };
      if (deal.status !== 'active') return { code: 400, error: 'Sorry, this deal was just sold.' };
      const user = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
      if (!user) return { code: 401, error: 'Login required.' };
      if (user.balance + 1e-9 < deal.price) return { code: 400, error: `Not enough balance. You have $${user.balance.toFixed(2)}.` };

      const { lastInsertRowid } = db.prepare(`INSERT INTO orders (user_id, product_id, price, status, delivered, title, deal_id)
                                              VALUES (?, 'deal', ?, 'delivered', ?, ?, ?)`).run(userId, deal.price, deal.content, deal.name, deal.id);
      const orderId = Number(lastInsertRowid);
      db.prepare("UPDATE deals SET status='sold', order_id=? WHERE id=?").run(orderId, deal.id);
      db.prepare('UPDATE users SET balance=round(balance-?,2) WHERE id=?').run(deal.price, userId);
      return { order: { id: orderId, product: deal.name, price: deal.price, content: deal.content } };
    });
    if (result.error) return res.status(result.code).json({ error: result.error });
    res.json({ ok: true, order: result.order, user: freshUser(userId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// Deal photos (served from the database). Only live deals' photos are public.
function serveImage(req, res) {
  const img = db.prepare('SELECT i.image, i.image_type, d.status FROM deal_images i JOIN deals d ON d.id=i.deal_id WHERE i.id=?').get(req.params.id);
  if (!img) return res.status(404).end();
  if (img.status !== 'active' && req.session.user?.role !== 'owner') return res.status(404).end();
  res.set('Content-Type', img.image_type);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(img.image));
}

// ── Owner ─────────────────────────────────────────────────────
router.get('/owner/deals', needsOwner, (req, res) => {
  const rows = db.prepare(`
    SELECT d.id, d.name, d.description, d.price, d.content, d.status, d.updated, d.created, u.username AS buyer
    FROM deals d LEFT JOIN orders o ON o.id=d.order_id LEFT JOIN users u ON u.id=o.user_id
    ORDER BY CASE d.status WHEN 'active' THEN 0 WHEN 'hidden' THEN 1 ELSE 2 END, d.id DESC
  `).all();
  res.json(rows.map(d => ({ ...d, photos: photoLinks(d.id, d.updated) })));
});

function dealFields(body, existing) {
  const name = body.name !== undefined ? String(body.name).trim() : existing?.name;
  const description = body.description !== undefined ? String(body.description).trim() : (existing?.description ?? '');
  const content = body.content !== undefined ? String(body.content).trim() : existing?.content;
  const price = body.price !== undefined ? parseFloat(body.price) : existing?.price;
  if (!name) throw new Error('Give the deal a name.');
  if (!Number.isFinite(price) || price < 0) throw new Error('Enter a valid price.');
  if (!content) throw new Error('Add the account details the buyer will receive.');
  return { name: name.slice(0, 120), description: description.slice(0, 1000), content, price: cents(price) };
}

router.post('/owner/deals', needsOwner, (req, res) => {
  try {
    const f = dealFields(req.body);
    const id = transaction(() => {
      const { lastInsertRowid } = db.prepare('INSERT INTO deals (name, description, price, content, updated) VALUES (?,?,?,?,?)')
        .run(f.name, f.description, f.price, f.content, Date.now());
      savePhotos(Number(lastInsertRowid), req.body.photos);
      return Number(lastInsertRowid);
    });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/owner/deals/:id', needsOwner, (req, res) => {
  try {
    const d = db.prepare('SELECT * FROM deals WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found.' });
    if (d.status === 'sold') return res.status(400).json({ error: 'This deal is already sold.' });
    const f = dealFields(req.body, d);
    const status = ['active', 'hidden'].includes(req.body.status) ? req.body.status : d.status;
    transaction(() => {
      db.prepare('UPDATE deals SET name=?, description=?, price=?, content=?, status=?, updated=? WHERE id=?')
        .run(f.name, f.description, f.price, f.content, status, Date.now(), d.id);
      // Only touch photos when the editor sends them
      if (req.body.photos !== undefined) savePhotos(d.id, req.body.photos);
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/owner/deals/:id', needsOwner, (req, res) => {
  const d = db.prepare('SELECT status FROM deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found.' });
  if (d.status === 'sold') return res.status(400).json({ error: 'Sold deals stay for your records.' });
  transaction(() => {
    db.prepare('DELETE FROM deal_images WHERE deal_id=?').run(req.params.id);
    db.prepare('DELETE FROM deals WHERE id=?').run(req.params.id);
  });
  res.json({ ok: true });
});

module.exports = { router, serveImage };
