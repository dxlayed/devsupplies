// Tough cases for the bot checker. Run with: npm run test:detection
// Bots here avoid the admin block list on purpose, so the scoring itself is tested.
const assert = require('assert');
const db = require('./src/database');
const engine = require('./src/services/detectionEngine');

const days = n => new Date(Date.now() - n * 86400000).toISOString();
let nextId = 990000000 + Math.floor(Math.random() * 1000000);
const P = o => ({ id: nextId++, name: 'x', displayName: '', description: '', created: days(400),
  badgeCount: null, friendsCount: null, followersCount: null, followingsCount: null,
  groupsCount: null, avatarAssetCount: null, nameChanges: null, ...o });

const cases = [
  // ---------- Bots ----------
  ['Scam bio + brand new + empty account', 'DECLINE',
    P({ name: 'LilyHarper2291', description: 'want free robux? visit my link rbx-win.xyz', created: days(1), badgeCount: 0, friendsCount: 0, groupsCount: 0, avatarAssetCount: 1 })],
  ['Fake official display name, 2 days old', 'DECLINE',
    P({ name: 'jacob_r0bloxteam', displayName: 'Roblox Rewards', created: days(2), badgeCount: 0, friendsCount: 0, avatarAssetCount: 2 })],
  ['Empty brand-new account, follows hundreds', 'DECLINE',
    P({ name: 'qwrtzpls8812', created: days(0.5), badgeCount: 0, friendsCount: 0, followingsCount: 480, groupsCount: 0, avatarAssetCount: 0 })],
  ['Discord invite in bio, 4 days old, no activity', 'DECLINE',
    P({ name: 'EmmaBrooks5521', description: 'join for trades discord.gg/abc123', created: days(4), badgeCount: 0, friendsCount: 0, avatarAssetCount: 2 })],

  // ---------- Real players ----------
  ['Normal kid with a Roblox-suggested name', 'ACCEPT',
    P({ name: 'AidenMason4471', created: days(800), badgeCount: 25, friendsCount: 60, groupsCount: 4, avatarAssetCount: 12 })],
  ['Old player who never changed avatar', 'ACCEPT',
    P({ name: 'coolguy_ben', created: days(1200), badgeCount: 25, friendsCount: 14, avatarAssetCount: 1, groupsCount: 0 })],
  ['Big creator with followers', 'ACCEPT',
    P({ name: 'BuildWithNova', description: 'I make obbies! check my games', created: days(1500), badgeCount: 25, friendsCount: 200, followersCount: 5400, groupsCount: 9, avatarAssetCount: 15 })],
  ['New account wearing a paid hat', 'ACCEPT',
    P({ name: 'kxqz_new', created: days(1), badgeCount: 0, friendsCount: 0, avatarAssetCount: 3, paidItem: { name: 'Pirate Captain\'s Hat', price: 2000 } })],
  ['Scam bio even with a paid item', 'DECLINE',
    P({ name: 'helper_1', description: 'free robux at rbx-win.xyz', created: days(2), badgeCount: 0, friendsCount: 0, paidItem: { name: 'Cap', price: 50 } })],
  ['Verified account', 'ACCEPT',
    P({ name: 'SomeStar', hasVerifiedBadge: true, created: days(3) })],

  // ---------- Should be "not sure", never auto-declined ----------
  ['Brand new real kid (no badges yet)', 'REVIEW',
    P({ name: 'mia_plays', created: days(3), badgeCount: 0, friendsCount: 1, avatarAssetCount: 4 })],
  ['Young account with nothing known', 'REVIEW',
    P({ name: 'tom', created: days(10) })],
];

// Aged bot accounts (old, bought/stolen) and floods
cases.push(
  ['5 year old account that never played', 'DECLINE',
    P({ name: 'dodfixase', created: days(1900), badgeCount: 0, friendsCount: 6, groupsCount: 0, avatarAssetCount: 2 })],
  // 8 friends makes it less certain: hidden on Normal/Strict (score 40+), not auto-declined
  ['8 year old never-played account, 8 friends', 'REVIEW',
    P({ name: 'Twwetygirrll', created: days(3000), badgeCount: 0, friendsCount: 8, avatarAssetCount: 3, groupsCount: 0 })],
);

const notDecline = [
  ['New account but met in a game together', { metInGame: true },
    P({ name: 'skater_kid', created: days(2), badgeCount: 0, friendsCount: 0, avatarAssetCount: 3 })],
  ['New account with 2 mutual friends', { mutualFriends: 2 },
    P({ name: 'zoe_xo', created: days(5), badgeCount: 1, friendsCount: 3, avatarAssetCount: 5 })],
];

(async () => {
  await new Promise(r => setTimeout(r, 300));
  let failed = 0;
  const show = (label, r) => console.log(`  ${r.verdict.padEnd(7)} ${String(r.threatScore).padStart(3)}  ${label}\n            ${r.reasons.slice(0, 4).join(' | ')}`);

  for (const [label, want, profile] of cases) {
    const r = await engine.evaluateProfile(profile);
    show(label, r);
    if (r.verdict !== want) { failed++; console.log(`    FAIL: wanted ${want}`); }
  }
  for (const [label, ctx, profile] of notDecline) {
    const r = await engine.evaluateProfile(profile, ctx);
    show(label, r);
    if (r.verdict === 'DECLINE') { failed++; console.log('    FAIL: should not be declined'); }
  }

  // Flood: an active-looking account that's part of a wave of 300 requests
  const fl = await engine.evaluateProfile(P({ name: 'Aquasama21', created: days(400), badgeCount: 25, friendsCount: 24, avatarAssetCount: 6 }), { wave: 300 });
  show('Normal-looking account inside a flood of 300', fl);
  if (fl.verdict !== 'DECLINE') { failed++; console.log('    FAIL: flood not caught'); }
  const flPaid = await engine.evaluateProfile(P({ name: 'rich_bot', created: days(900), badgeCount: 25, friendsCount: 40, paidItem: { name: 'Hat', price: 100 } }), { wave: 300 });
  show('Paid item but inside a flood', flPaid);
  if (flPaid.verdict !== 'DECLINE') { failed++; console.log('    FAIL: flood with paid item not caught'); }
  const flFriend = await engine.evaluateProfile(P({ name: 'my_real_friend', created: days(900), badgeCount: 25, friendsCount: 40 }), { wave: 300, mutualFriends: 2 });
  show('Inside a flood but has mutual friends', flFriend);
  if (flFriend.verdict === 'DECLINE') { failed++; console.log('    FAIL: real friend declined in a flood'); }
  const flGame = await engine.evaluateProfile(P({ name: 'met_in_mm2', created: days(30), badgeCount: 5, friendsCount: 10 }), { wave: 300, metInGame: true });
  show('Inside a flood but met in a game', flGame);
  if (flGame.verdict === 'DECLINE') { failed++; console.log('    FAIL: in-game friend declined in a flood'); }

  // Bot farm: same bio copied on several fresh accounts. The 3rd one should be caught
  // even though each account alone only looks "new and empty".
  const farmBio = 'hi im new here add me plz i love adopt me and mm2 ' + nextId;
  const farm = [];
  for (let i = 0; i < 4; i++) farm.push(await engine.evaluateProfile(P({ name: `sarah_${['k', 'j', 'm', 'p'][i]}${nextId}`, description: farmBio, created: days(2), badgeCount: 0, friendsCount: 0, avatarAssetCount: 2 })));
  show('Bot farm, 4th account with the same bio', farm[3]);
  if (farm[3].verdict !== 'DECLINE') { failed++; console.log('    FAIL: bot farm not caught'); }

  // Spammer: same account sends requests to many different Waurks customers
  const spammer = P({ name: 'noah_v' + nextId, created: days(6), badgeCount: 0, friendsCount: 0, avatarAssetCount: 3 });
  for (let u = 0; u < 5; u++) {
    await db.run(`INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason) VALUES (?, '1', ?, ?, 'REVIEW', 40, 'test')`,
      [800000 + u, String(spammer.id), spammer.name]);
  }
  const sp = await engine.evaluateProfile(spammer, { forUserId: 1 });
  show('Same account spamming 5 Waurks users', sp);
  if (sp.verdict !== 'DECLINE') { failed++; console.log('    FAIL: spammer not caught'); }

  // Learning: other customers marked an account as a real player
  const liked = P({ name: 'new_friend' + nextId, created: days(4), badgeCount: 0, friendsCount: 0, avatarAssetCount: 2 });
  await engine.recordReport(liked.id, 700001, false);
  await engine.recordReport(liked.id, 700002, false);
  const lk = await engine.evaluateProfile(liked, { forUserId: 1 });
  show('2 customers said it is a real player', lk);
  if (lk.verdict === 'DECLINE') { failed++; console.log('    FAIL: declined despite human reports'); }

  // cleanup test rows
  await db.run(`DELETE FROM scan_activity_logs WHERE reason = 'test' AND target_id = ?`, [String(spammer.id)]);
  await db.run(`DELETE FROM bot_reports WHERE user_id IN (700001, 700002)`);
  await db.run(`DELETE FROM bio_fingerprints WHERE roblox_id >= '990000000'`);

  console.log(failed ? `\n${failed} case(s) FAILED` : '\nAll detection cases passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
