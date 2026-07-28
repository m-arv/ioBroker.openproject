'use strict';

/**
 * Builds the sendTo() payload for common ioBroker messaging adapters. The field names (e.g.
 * "text" vs. "message", and the recipient-override key) follow each adapter's documented
 * convention, but could NOT be verified live against a real instance - none was available in
 * this environment. Unknown adapters get both "text" and "message" set as a best-effort
 * fallback. See README.md "Annahmen" if the target adapter you use does not pick up the text.
 *
 * @param {string} adapterName - adapter name without instance number, e.g. "telegram"
 * @param {string} text
 * @param {string} [recipient]
 */
function buildNotifyPayload(adapterName, text, recipient) {
    switch (adapterName) {
        case 'telegram':
            return recipient ? { text, user: recipient } : { text };
        case 'pushover':
            return recipient
                ? { message: text, title: 'OpenProject', user: recipient }
                : { message: text, title: 'OpenProject' };
        case 'email':
            return recipient ? { text, to: recipient, subject: 'OpenProject' } : { text, subject: 'OpenProject' };
        case 'signal-cmd':
        case 'sms':
            return recipient ? { text, phone: recipient } : { text };
        case 'matrix-bot':
            return recipient ? { text, roomId: recipient } : { text };
        case 'pushsafer':
        case 'pushbullet':
        case 'ntfy':
        case 'gotify':
            return { message: text, title: 'OpenProject' };
        case 'whatsapp-cmb':
        case 'discord':
        case 'synochat':
        case 'webhook':
            return { text };
        default:
            return { text, message: text };
    }
}

module.exports = { buildNotifyPayload };
