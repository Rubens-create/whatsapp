const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const Pino = require('pino');
const fs = require('fs');

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('/sessions');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    browser: Browsers.ubuntu('n8n‑Chatwoot‑Bot'),
    auth: state,
    printQRInTerminal: true,
    logger: Pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      console.log('✅ Baileys conectado!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message) {
      const jid = msg.key.remoteJid;
      const text = msg.message.conversation?.toLowerCase() || '';

      if (text === 'oi') {
        await sock.sendMessage(jid, { text: 'Olá 👋 como posso ajudar?' });
      }
      if (text === 'status') {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise((r) => setTimeout(r, 1500));
        await sock.sendPresenceUpdate('recording', jid);
        await new Promise((r) => setTimeout(r, 1500));
        await sock.sendMessage(jid, { text: 'Gravando e digitando simulados 🔊' });
      }
      if (text === 'audio') {
        const buffer = fs.readFileSync('./audios/exemplo.ogg');
        await sock.sendMessage(jid, { audio: buffer, ptt: true });
      }
      if (text === 'foto') {
        const ppUrl = await sock.profilePictureUrl(jid).catch(() => null);
        if (ppUrl) await sock.sendMessage(jid, { image: { url: ppUrl }, caption: 'Sua foto de perfil' });
        else await sock.sendMessage(jid, { text: 'Não encontrei sua foto de perfil.' });
      }
    }
  });
}

start();
