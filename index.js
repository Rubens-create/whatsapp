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
const axios = require('axios'); // Importamos o axios

// --- Variáveis de Ambiente (MUITO IMPORTANTE para o Coolify) ---
// Você vai configurar estas variáveis no painel do Coolify
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; // Ex: http://seu-n8n:5678/webhook/whatsapp
const API_PORT = process.env.PORT || 3000; // Porta que a API vai rodar
const API_KEY = process.env.API_KEY; // Chave de segurança para sua API

// =================================================================
// 2. FUNÇÃO PRINCIPAL DO BOT (BAILEYS)
// =================================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('sessions');
  const { version } = await fetchLatestBaileysVersion();
  let sock; // Definimos a variável sock aqui para ser acessível em toda a função

  function connectToWhatsApp() {
    sock = makeWASocket({
      version,
      browser: Browsers.ubuntu('n8n-Chatwoot-Bot'),
      auth: state,
      printQRInTerminal: true,
      logger: Pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Conexão fechada, motivo:', lastDisconnect?.error, ', reconectando:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000); // Tenta reconectar após 5 segundos
        }
      } else if (connection === 'open') {
        console.log('✅ Baileys conectado!');
      }
    });

    // =================================================================
    // A MÁGICA DO WEBHOOK PARA O N8N ACONTECE AQUI
    // =================================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      
      // Ignora mensagens sem conteúdo, de status, ou enviadas por nós mesmos
      if (!msg.message || msg.key.fromMe) {
        return;
      }

      // Verifica se temos uma URL de webhook configurada
      if (!N8N_WEBHOOK_URL) {
        console.log('N8N_WEBHOOK_URL não configurada. Webhook ignorado.');
        return;
      }
      
      // Envia a mensagem completa para o webhook do n8n
      try {
        console.log(`Enviando mensagem para o n8n:`, JSON.stringify(msg, null, 2));
        await axios.post(N8N_WEBHOOK_URL, msg);
        console.log('✅ Mensagem enviada para o n8n com sucesso!');
      } catch (error) {
        console.error('❌ Erro ao enviar mensagem para o n8n:', error.message);
      }
    });

    return sock;
  }

  await connectToWhatsApp();
  return sock; // Retorna a instância do socket para a API usar
}

// =================================================================
// 3. CRIAÇÃO DA API REST (EXPRESS)
// =================================================================
async function createApi() {
  const sock = await startBot(); // Inicia o bot e pega a instância do socket
  const app = express();
  app.use(express.json());

  // Middleware de segurança para validar a API_KEY
  const checkApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!API_KEY || apiKey === API_KEY) {
      next(); // Chave correta ou não configurada, prossegue
    } else {
      res.status(401).json({ error: 'Chave de API inválida.' });
    }
  };

  app.use(checkApiKey); // Aplica o middleware em todas as rotas abaixo

  // --- ROTAS DA API (comandadas pelo n8n) ---

  // Rota de teste para verificar se a API está no ar
  app.get('/status', (req, res) => {
    res.json({ status: 'online', connection: sock.ws.readyState });
  });
  
  // Rota para enviar mensagem de texto
  app.post('/send-text', async (req, res) => {
    const { to, text } = req.body;
    try {
      const jid = `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
      res.json({ success: true, message: 'Mensagem de texto enviada.' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Rota para enviar áudio (como gravado)
  app.post('/send-audio', async (req, res) => {
    const { to, path } = req.body; // path: caminho para o áudio no servidor do bot
    try {
      if (!fs.existsSync(path)) throw new Error('Arquivo não encontrado');
      const jid = `${to}@s.whatsapp.net`;
      const buffer = fs.readFileSync(path);
      await sock.sendMessage(jid, { audio: buffer, ptt: true });
      res.json({ success: true, message: 'Áudio enviado.' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Rota para simular status (digitando/gravando)
  app.post('/send-presence', async (req, res) => {
    const { to, presence } = req.body; // presence: 'composing' ou 'recording'
    try {
      const jid = `${to}@s.whatsapp.net`;
      await sock.sendPresenceUpdate(presence, jid);
      res.json({ success: true, message: `Status '${presence}' enviado.` });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Inicia o servidor da API
  app.listen(API_PORT, () => {
    console.log(`🚀 API do bot rodando na porta ${API_PORT}`);
  });
}

// Inicia todo o sistema
createApi();
