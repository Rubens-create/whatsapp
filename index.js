// =================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL
// =================================================================
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const Pino = require('pino');
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

// --- Variáveis de Ambiente ---
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const API_PORT = process.env.PORT || 21465;
const API_KEY = process.env.API_KEY;

// =================================================================
// 2. ESCOPO COMPARTILHADO PARA O SOQUETE
// =================================================================
// MUDANÇA 1: Criamos uma variável "global" para guardar a instância do socket.
// Isso permite que a função de reconexão atualize o socket e a API sempre
// use a versão mais recente.
let sockInstance = null;

// =================================================================
// 3. FUNÇÃO PRINCIPAL DO BOT (BAILEYS)
// =================================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('sessions');
  const { version } = await fetchLatestBaileysVersion();

  function connectToWhatsApp() {
    // MUDANÇA 2: Atribuímos a nova conexão à variável compartilhada 'sockInstance'.
    sockInstance = makeWASocket({
      version,
      browser: Browsers.ubuntu('n8n-Chatwoot-Bot'),
      auth: state,
      logger: Pino({ level: 'silent' }),
    });

    sockInstance.ev.on('creds.update', saveCreds);

    sockInstance.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('================================================');
        console.log('           📱 ESCANEIE O QR CODE ABAIXO 📱           ');
        console.log('================================================');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Conexão fechada, motivo:', lastDisconnect?.error, ', reconectando:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000); // Tenta reconectar
        }
      } else if (connection === 'open') {
        console.log('================================================');
        console.log('        ✅ CONEXÃO ESTABELECIDA COM SUCESSO ✅        ');
        console.log('================================================');
      }
    });

    // WEBHOOK PARA O N8N
    sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.message.protocolMessage || msg.key.remoteJid === 'status@broadcast') {
        return;
      }
      if (!N8N_WEBHOOK_URL) return;
      try {
        const direction = msg.key.fromMe ? 'OUTGOING' : 'INCOMING';
        console.log(`✅ Webhook [${direction}] enviado para n8n. De/Para: ${msg.key.remoteJid}`);
        await axios.post(N8N_WEBHOOK_URL, msg);
      } catch (error) {
        console.error(`❌ Erro ao enviar webhook para o n8n:`, error.message);
      }
    });
  }

  // Inicia a primeira tentativa de conexão
  connectToWhatsApp();
}

// =================================================================
// 4. CRIAÇÃO DA API REST (EXPRESS)
// =================================================================
function createApi() {
  const app = express();
  app.use(express.json());

  const checkApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!API_KEY || apiKey === API_KEY) {
      next();
    } else {
      res.status(401).json({ success: false, error: 'Chave de API inválida.' });
    }
  };

  app.use(checkApiKey);

  const formatJid = (number) => {
    if (number.includes('@s.whatsapp.net')) return number;
    return `${number}@s.whatsapp.net`;
  };

  // MUDANÇA 3: Todas as rotas agora usam 'sockInstance' diretamente,
  // garantindo que sempre peguem a conexão mais recente.
  // Também adicionamos uma verificação para ver se o bot está pronto.

  app.get('/status', (req, res) => {
    const isConnected = sockInstance && sockInstance.ws.readyState === 1;
    res.json({ success: true, status: isConnected ? 'online' : 'offline' });
  });

  app.post('/send-text', async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ success: false, error: 'Parâmetros "to" e "text" são obrigatórios.' });
    if (!sockInstance) return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
    try {
      await sockInstance.sendMessage(formatJid(to), { text });
      res.json({ success: true, message: 'Mensagem de texto enviada.' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/send-audio-binary', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    const { to } = req.query;
    if (!to) return res.status(400).json({ success: false, error: 'Parâmetro "to" na URL é obrigatório.' });
    if (!sockInstance) return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
    try {
      const audioBuffer = req.body;
      await sockInstance.sendMessage(formatJid(to), { audio: audioBuffer, ptt: true });
      res.json({ success: true, message: 'Áudio binário enviado.' });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Falha ao processar ou enviar o áudio: ' + e.message });
    }
  });

  app.post('/get-profile-pic', async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'Parâmetro "to" é obrigatório.' });
    if (!sockInstance) return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
    try {
      const jid = formatJid(to);
      const ppUrl = await sockInstance.profilePictureUrl(jid, 'image');
      res.json({ success: true, url: ppUrl });
    } catch (e) {
      res.status(404).json({ success: false, error: 'Foto de perfil não encontrada ou é privada.' });
    }
  });

  app.post('/view-status', async (req, res) => {
    const { jid } = req.body;
    if (!jid || !jid.endsWith('@s.whatsapp.net')) return res.status(400).json({ success: false, error: 'Parâmetro "jid" inválido.' });
    if (!sockInstance) return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
    try {
      const key = { remoteJid: 'status@broadcast', fromMe: false, id: '', participant: jid };
      await sockInstance.readMessages([key]);
      res.json({ success: true, message: `Status de ${jid} marcado como visto.` });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Falha ao marcar status como visto: ' + e.message });
    }
  });


// NOVO ENDPOINT PARA REAGIR A UMA MENSAGEM
app.post('/send-reaction', async (req, res) => {
  // Para reagir, precisamos de 3 coisas:
  // 1. O chat onde a mensagem está (to)
  // 2. O emoji que queremos usar (reaction)
  // 3. A chave da mensagem original que vamos reagir (messageKey)
  const { to, reaction, messageKey } = req.body;

  if (!to || !reaction || !messageKey || !messageKey.id) {
    return res.status(400).json({ success: false, error: 'Parâmetros "to", "reaction" e "messageKey" (com ID) são obrigatórios.' });
  }
  if (!sockInstance) {
    return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
  }

  try {
    // A função sendMessage também é usada para reagir.
    // Passamos o texto da reação e a chave da mensagem a ser reagida.
    await sockInstance.sendMessage(formatJid(to), {
      react: {
        text: reaction, // O emoji, ex: "👍"
        key: messageKey, // O objeto 'key' da mensagem original
      },
    });
    res.json({ success: true, message: `Reação '${reaction}' enviada.` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// NOVO ENDPOINT PARA ENVIAR IMAGEM A PARTIR DE UMA URL
app.post('/send-image-from-url', async (req, res) => {
  // Para esta rota, esperamos o corpo em JSON
  const { to, url, caption } = req.body;

  if (!to || !url) {
    return res.status(400).json({ success: false, error: 'Parâmetros "to" e "url" são obrigatórios.' });
  }
  if (!sockInstance) {
    return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
  }

  try {
    // Montamos o objeto da mensagem
    const messageOptions = {
      // A MUDANÇA ESTÁ AQUI: passamos um objeto com a URL
      image: { url: url }, 
      caption: caption || '', // Adiciona a legenda se ela existir, senão, string vazia
    };

    // Enviamos a imagem
    await sockInstance.sendMessage(formatJid(to), messageOptions);

    res.json({ success: true, message: 'Imagem da URL enviada.' });
  } catch (e) {
    console.error('Erro ao enviar imagem da URL:', e);
    res.status(500).json({ success: false, error: 'Falha ao processar ou enviar a imagem da URL: ' + e.message });
  }
});

  app.post('/send-presence', async (req, res) => {
    const { to, presence } = req.body;
    if (!to || !presence) return res.status(400).json({ success: false, error: 'Parâmetros "to" e "presence" são obrigatórios.' });
    if (!sockInstance) return res.status(503).json({ success: false, error: 'Bot não está pronto ou conectado.' });
    try {
      await sockInstance.sendPresenceUpdate(presence, formatJid(to));
      res.json({ success: true, message: `Status '${presence}' enviado para o chat ${to}.` });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.listen(API_PORT, () => {
    console.log(`🚀 API do bot rodando na porta ${API_PORT}`);
  });
}


// =================================================================
// 5. INICIA TODO O SISTEMA
// =================================================================
try {
  startBot();   // Inicia o processo do bot em segundo plano
  createApi();  // Inicia a API que usará a instância do bot
} catch (error) {
  console.error("❌ Falha crítica ao iniciar a aplicação:", error);
  process.exit(1);
}
