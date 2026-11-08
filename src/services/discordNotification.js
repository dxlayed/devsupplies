/**
 * Discord Webhook Notification Service
 * Sends automated transaction alerts, middleman trade requests,
 * and key renewals directly to your Discord server channels.
 */

const DISCORD_SALES_WEBHOOK = process.env.DISCORD_SALES_WEBHOOK || '';
const DISCORD_ESCROW_WEBHOOK = process.env.DISCORD_ESCROW_WEBHOOK || '';

class DiscordNotificationService {
  /**
   * Sends an embed message to a Discord Webhook
   */
  async sendWebhook(webhookUrl, payload) {
    if (!webhookUrl) {
      // In dev or when webhook is not configured, log cleanly
      console.log(`[Discord Notification] (Simulated):`, JSON.stringify(payload.embeds?.[0]?.title || payload.content));
      return { simulated: true };
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { success: response.ok, status: response.status };
    } catch (err) {
      console.error('[Discord Webhook Error]:', err.message);
      return { error: err.message };
    }
  }

  /**
   * Notifies staff channel of a successful key purchase
   */
  async notifySale({ orderId, username, tier, amountUsd, paymentMethod, keyCode, expiresAt }) {
    const embed = {
      title: '💎 New Waurks License Activated!',
      color: 0x34d17e, // Green
      description: `A new customer has subscribed to Waurks.`,
      fields: [
        { name: 'Customer', value: `\`${username}\``, inline: true },
        { name: 'Plan Tier', value: `**${tier.toUpperCase()}**`, inline: true },
        { name: 'Amount Paid', value: `**$${amountUsd} USD**`, inline: true },
        { name: 'Payment Method', value: paymentMethod === 'crypto' ? '🪙 Crypto' : '🎮 In-Game Items', inline: true },
        { name: 'Order ID', value: `\`${orderId}\``, inline: true },
        { name: 'Access Expiration', value: new Date(expiresAt).toLocaleDateString(), inline: true },
        { name: 'Generated Key', value: `\`${keyCode}\``, inline: false }
      ],
      footer: { text: 'Waurks Automated Security System' },
      timestamp: new Date().toISOString()
    };

    return await this.sendWebhook(DISCORD_SALES_WEBHOOK, { embeds: [embed] });
  }

  /**
   * Alerts Discord middleman staff when an in-game item trade is requested
   */
  async notifyItemTradeRequested({ orderId, tradeTicketId, username, tier, amountUsd }) {
    const embed = {
      title: '🎮 In-Game Item Escrow Ticket Created',
      color: 0xf0b429, // Gold
      description: `A customer requested to pay with in-game items (Roblox Limiteds / MM2 / Adopt Me / Blox Fruits). Staff middleman required!`,
      fields: [
        { name: 'Ticket ID', value: `\`${tradeTicketId}\``, inline: true },
        { name: 'Customer Discord', value: `\`${username}\``, inline: true },
        { name: 'Plan Tier', value: `**${tier.toUpperCase()}** ($${amountUsd})`, inline: true },
        { name: 'Order ID', value: `\`${orderId}\``, inline: true },
        { name: 'Action Required', value: `A middleman must contact the user in Discord, accept the trade items, and approve the ticket in the Admin Dashboard to issue the key.`, inline: false }
      ],
      footer: { text: 'Waurks Middleman System' },
      timestamp: new Date().toISOString()
    };

    return await this.sendWebhook(DISCORD_ESCROW_WEBHOOK || DISCORD_SALES_WEBHOOK, { embeds: [embed] });
  }
}

module.exports = new DiscordNotificationService();

