// DevSupplies: starts the website. Run with `npm start`.
// Works with either layout: server code in src/ and pages in public/, or everything in one folder.
// Only the pages, style.css, main.js and deal photos are ever sent to visitors;
// the server code and the database are never served.
const express = require('express');
const path = require('path');
const fs = require('fs');

const code = name => require(fs.existsSync(path.join(__dirname, name + '.js')) ? './' + name : './src/' + name);
const PAGES = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;

const sessions = code('sessions');
const auth = code('auth');
const shop = code('shop');
const deposits = code('deposits');
const owner = code('owner');
const deals = code('deals');
const support = code('support');

const app = express();
const PORT = process.env.PORT || 3000;
const file = name => (req, res) => res.sendFile(path.join(PAGES, name));

app.set('trust proxy', 1); // Railway sits behind a proxy; needed for secure login cookies
app.use(express.json({ limit: '25mb' })); // room for deal photos (up to 8 per deal)
app.use(sessions);

// API
app.use('/api', auth.router);
app.use('/api', shop.router);
app.use('/api', deposits.router);
app.use('/api', owner.router);
app.use('/api', deals.router);
app.use('/api', support.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Pages
app.get(['/', '/index.html'],          file('index.html'));
app.get(['/login', '/login.html'],     auth.pageGuestsOnly, file('login.html'));
app.get(['/signup', '/signup.html'],   auth.pageGuestsOnly, file('signup.html'));
app.get(['/deposit', '/deposit.html'], auth.pageNeedsLogin, file('deposit.html'));
app.get(['/orders', '/orders.html'],   auth.pageNeedsLogin, file('orders.html'));
app.get(['/support', '/support.html'], auth.pageNeedsLogin, file('support.html'));
app.get(['/owner', '/owner.html'],     auth.pageNeedsOwner, file('owner.html'));

// Shared look and script
app.get('/style.css', file('style.css'));
app.get('/main.js', file('main.js'));
app.get('/deal-image/:id', deals.serveImage);

// Anything else goes back to the store
app.use((req, res) => res.redirect('/'));

// Bad or oversized requests get a short message, never a technical error page
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too big. Try fewer or smaller photos.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

deposits.startWatcher();
app.listen(PORT, () => console.log(`DevSupplies running on port ${PORT}`));
