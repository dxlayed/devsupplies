const crypto = require('crypto');
const db = require('../database');

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/api/v1/auth/discord/callback';

class DiscordAuth {
  /**
   * Generates the Discord OAuth2 URL
   */
  getOAuthUrl() {
    if (!DISCORD_CLIENT_ID) {
      return null;
    }
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify'
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Finds or creates a user record by Discord profile
   */
  async upsertDiscordUser({ discordId, username, discriminator = '0', avatar = null }) {
    let user = await db.get(`SELECT * FROM users WHERE discord_id = ?`, [discordId]);

    if (!user) {
      const res = await db.run(
        `INSERT INTO users (discord_id, username, discriminator, avatar) VALUES (?, ?, ?, ?)`,
        [discordId, username, discriminator, avatar]
      );
      user = await db.get(`SELECT * FROM users WHERE id = ?`, [res.lastID]);
    } else {
      await db.run(
        `UPDATE users SET username = ?, discriminator = ?, avatar = ? WHERE id = ?`,
        [username, discriminator, avatar, user.id]
      );
      user = await db.get(`SELECT * FROM users WHERE id = ?`, [user.id]);
    }

    return user;
  }

  /**
   * Quick-login helper for instant testing/demo
   */
  async devLogin(customUsername = 'RobloxPro') {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const mockDiscordId = `10892837492817${randomSuffix}`;
    const username = `${customUsername}_${randomSuffix.toString().slice(-2)}`;
    const avatar = `https://cdn.discordapp.com/embed/avatars/${Math.floor(Math.random() * 5)}.png`;

    return await this.upsertDiscordUser({
      discordId: mockDiscordId,
      username,
      discriminator: '0',
      avatar
    });
  }
}

module.exports = new DiscordAuth();

