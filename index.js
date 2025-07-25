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
const qrcode = require('qrcode-terminal'); // Importação da nova dependência

// --- Variáveis de Ambiente (MUITO IMPORTANTE para o Coolify) ---
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const API_PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// =================================================================
// 2. FUNÇÃO PRINCIPAL DO BOT (BAILEYS)
// =================================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('sessions');
  const { version } = await fetchLatestBaileysVersion();
  let sock;

  function connectToWhatsApp() {
    sock = makeWASocket({
      version,
      browser: Browsers.ubuntu('n8n-Chatwoot-Bot'),
      auth: state,
      logger: Pino({ level: 'silent' }), // Opção obsoleta 'printQRInTerminal' removida
    });

    sock.ev.on('creds.update', saveCreds);

    // --- LÓGICA DE CONEXÃO E QR CODE ATUALIZADA ---
    sock.ev.on('connection.update', (update) => {
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
          setTimeout(connectToWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        console.log('================================================');
        console.log('        ✅ CONEXÃO ESTABELECIDA COM SUCESSO ✅        ');
        console.log('================================================');
      }
    });

      // =================================================================
      // WEBHOOK PARA O N8N (VERSÃO FILTRADA E CORRETA)
      // =================================================================
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Verificamos o 'type' do evento. 'notify' é para novas mensagens.
        // 'append' pode ser para mensagens antigas sendo carregadas.
        if (type !== 'notify') {
          return;
        }
        
        const msg = messages[0];
        
        // O FILTRO DEFINITIVO:
        // 1. !msg.message: Ignora eventos que não são mensagens (como atualizações de status de entrega/leitura).
        // 2. msg.key.remoteJid === 'status@broadcast': Ignora atualizações de Status do WhatsApp.
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') {
          return;
        }
      
        // Se a URL do webhook não estiver configurada, não faz nada.
        if (!N8N_WEBHOOK_URL) {
          return; // Não precisa de log aqui, para não poluir
        }
        
        try {
          const direction = msg.key.fromMe ? 'OUTGOING' : 'INCOMING';
          // Log apenas para mensagens reais, não para status.
          console.log(`✅ Webhook [${direction}] enviado para n8n. De/Para: ${msg.key.remoteJid}`);
          
          // Envia o objeto da mensagem original, sem modificações.
          await axios.post(N8N_WEBHOOK_URL, msg);
      
        } catch (error) {
          const direction = msg.key.fromMe ? 'OUTGOING' : 'INCOMING';
          console.error(`❌ Erro ao enviar webhook [${direction}] para o n8n:`, error.message);
        }
      });

    return sock;
  }

  await connectToWhatsApp();
  return sock;
}

// =================================================================
// 3. CRIAÇÃO DA API REST (EXPRESS)
// =================================================================
async function createApi() {
  try {
    const sock = await startBot();
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

    app.get('/status', (req, res) => {
      const isConnected = sock && sock.ws.readyState === 1;
      res.json({ success: true, status: isConnected ? 'online' : 'offline' });
    });

    const formatJid = (number) => {
      if (number.includes('@s.whatsapp.net')) return number;
      return `${number}@s.whatsapp.net`;
    };

    app.post('/send-text', async (req, res) => {
      const { to, text } = req.body;
      if (!to || !text) return res.status(400).json({ success: false, error: 'Parâmetros "to" e "text" são obrigatórios.' });
      try {
        await sock.sendMessage(formatJid(to), { text });
        res.json({ success: true, message: 'Mensagem de texto enviada.' });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    app.post('/send-audio', async (req, res) => {
      const { to, path } = req.body;
      if (!to || !path) return res.status(400).json({ success: false, error: 'Parâmetros "to" e "path" são obrigatórios.' });
      try {
        if (!fs.existsSync(path)) throw new Error('Arquivo de áudio não encontrado no caminho especificado.');
        const buffer = fs.readFileSync(path);
        await sock.sendMessage(formatJid(to), { audio: buffer, ptt: true });
        res.json({ success: true, message: 'Áudio enviado.' });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    app.post('/get-profile-pic', async (req, res) => {
      const { to } = req.body;
      if (!to) return res.status(400).json({ success: false, error: 'Parâmetro "to" é obrigatório.' });
    
      try {
        const jid = formatJid(to);
        // O parâmetro 'image' pega a foto em alta resolução. 'preview' pega a miniatura.
        const ppUrl = await sock.profilePictureUrl(jid, 'image');
        res.json({ success: true, url: ppUrl });
      } catch (e) {
        // Ocorre um erro se o usuário não tiver foto ou se for privada
        res.status(404).json({ success: false, error: 'Foto de perfil não encontrada ou é privada.' });
      }
    });

    app.post('/send-presence', async (req, res) => {
      const { to, presence } = req.body;
      if (!to || !presence) return res.status(400).json({ success: false, error: 'Parâmetros "to" e "presence" são obrigatórios.' });
      try {
        await sock.sendPresenceUpdate(presence, formatJid(to));
        res.json({ success: true, message: `Status '${presence}' enviado.` });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    app.listen(API_PORT, () => {
      console.log(`🚀 API do bot rodando na porta ${API_PORT}`);
    });
  } catch (error) {
    console.error("❌ Falha crítica ao iniciar a aplicação:", error);
    process.exit(1); // Encerra o processo se não conseguir iniciar
  }
}

// Inicia todo o sistema
createApi();
