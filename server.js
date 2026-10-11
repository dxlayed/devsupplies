// DevSupplies: starts the website. Run with `npm start`.
const express = require('express');
const path = require('path');

const sessions = require('./src/sessions');
const auth = require('./src/auth');
const shop = require('./src/shop');
const deposits = require('./src/deposits');
const owner = require('./src/owner');

const app = express();
const PORT = process.env.PORT || 3000;
const page = name => (req, res) => res.sendFile(path.join(__dirname, 'public', name + '.html'));

app.set('trust proxy', 1); // Railway sits behind a proxy; needed for secure login cookies
app.use(express.json({ limit: '1mb' }));
app.use(sessions);

// API
app.use('/api', auth.router);
app.use('/api', shop.router);
app.use('/api', deposits.router);
app.use('/api', owner.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Pages
app.get(['/', '/index.html'],         page('index'));
app.get(['/login', '/login.html'],    auth.pageGuestsOnly, page('login'));
app.get(['/signup', '/signup.html'],  auth.pageGuestsOnly, page('signup'));
app.get(['/deposit', '/deposit.html'], auth.pageNeedsLogin, page('deposit'));
app.get(['/orders', '/orders.html'],  auth.pageNeedsLogin, page('orders'));
app.get(['/owner', '/owner.html'],    auth.pageNeedsOwner, page('owner'));

// Shared CSS and JS
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Anything else goes back to the store
app.use((req, res) => res.redirect('/'));

deposits.startWatcher();
app.listen(PORT, () => console.log(`DevSupplies running on port ${PORT}`));
