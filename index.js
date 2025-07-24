const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => {
  console.log('QR Code para escanear:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Cliente WhatsApp pronto!');
});

client.on('message', async msg => {
  console.log('📩 Mensagem recebida:', msg.body);

  const webhookUrl = 'http://localhost:5678/webhook-test/teste';

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'received',
        from: msg.from,
        body: msg.body,
        timestamp: msg.timestamp,
        id: msg.id._serialized
      })
    });
    console.log('✅ Mensagem recebida enviada para webhook');
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem recebida para webhook:', err.message);
  }
});

// Enviar mensagem de texto
app.post('/send-message', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
  }

  try {
    await client.sendMessage(number + '@c.us', message);
    res.json({ status: 'Mensagem enviada com sucesso' });
    console.log(`✅ Mensagem enviada para ${number}`);

    // Envia para webhook
    const webhookUrl = 'http://localhost:5678/webhook-test/teste';
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'sent',
          from: 'bot',
          to: number + '@c.us',
          body: message,
          timestamp: Date.now()
        })
      });
      console.log('✅ Mensagem enviada pelo bot também para webhook');
    } catch (err) {
      console.error('❌ Erro ao enviar mensagem do bot para webhook:', err.message);
    }
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem via API:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simular digitando
app.post('/simulate-typing', async (req, res) => {
  const { number, time = 5 } = req.body;
  if (!number) return res.status(400).json({ error: 'Número é obrigatório' });

  try {
    await client.sendTyping(number + '@c.us');
    setTimeout(async () => {
      await client.clearState(number + '@c.us');
    }, time * 1000);
    res.json({ status: `Simulando digitando para ${time} segundos` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simular gravando áudio
app.post('/simulate-recording', async (req, res) => {
  const { number, time = 5 } = req.body;
  if (!number) return res.status(400).json({ error: 'Número é obrigatório' });

  try {
    await client.sendRecordingState(number + '@c.us');
    setTimeout(async () => {
      await client.clearState(number + '@c.us');
    }, time * 1000);
    res.json({ status: `Simulando gravando áudio para ${time} segundos` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar áudio como se fosse gravado na hora
app.post('/send-audio', upload.single('audio'), async (req, res) => {
  const { number } = req.body;
  if (!number || !req.file) {
    return res.status(400).json({ error: 'Número e arquivo de áudio são obrigatórios' });
  }

  try {
    const filePath = path.resolve(req.file.path);
    const audio = MessageMedia.fromFilePath(filePath);
    await client.sendMessage(number + '@c.us', audio, { sendAudioAsVoice: true });
    res.json({ status: 'Áudio enviado com sucesso' });
    fs.unlinkSync(filePath); // Remove o arquivo após envio
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pegar foto de perfil
app.get('/profile-pic/:number', async (req, res) => {
  const number = req.params.number;
  if (!number) return res.status(400).json({ error: 'Número é obrigatório' });

  try {
    const url = await client.getProfilePicUrl(number + '@c.us');
    res.json({ profilePicUrl: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reagir a uma mensagem
app.post('/react-message', async (req, res) => {
  const { chatId, messageId, emoji } = req.body;
  if (!chatId || !messageId || !emoji) {
    return res.status(400).json({ error: 'chatId, messageId e emoji são obrigatórios' });
  }

  try {
    const chat = await client.getChatById(chatId);
    const message = await chat.fetchMessage(messageId);
    await message.react(emoji);
    res.json({ status: `Reagido com ${emoji}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});
