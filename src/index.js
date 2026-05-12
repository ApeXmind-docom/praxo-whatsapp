require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const { getAIResponse, getConversations, getEscalatedChats, clearConversation, reactivateNova } = require('./ai');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let qrImageData = null;
let isConnected = false;
let clientPhone = null;
const messageLog = [];

const whatsappClient = new Client({
  authStrategy: new LocalAuth({ dataPath: './data/session' }),
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
    ],
  },
});

whatsappClient.on('qr', async (qr) => {
  console.log('📱 QR generado');
  qrImageData = await qrcode.toDataURL(qr);
  isConnected = false;
  io.emit('qr', qrImageData);
  io.emit('status', { connected: false, message: 'Escanea el QR con WhatsApp' });
});

whatsappClient.on('ready', () => {
  console.log('✅ WhatsApp conectado');
  isConnected = true;
  qrImageData = null;
  clientPhone = whatsappClient.info?.wid?.user || 'Desconocido';
  io.emit('status', { connected: true, phone: clientPhone, message: 'NOVA activa ❄️' });
});

whatsappClient.on('disconnected', () => {
  console.log('❌ WhatsApp desconectado');
  isConnected = false;
  io.emit('status', { connected: false, message: 'Desconectado' });
});

whatsappClient.on('message', async (message) => {
  if (message.from === 'status@broadcast') return;
  if (message.from.includes('@g.us')) return;
  if (message.isStatus) return;

  const phoneNumber = message.from.replace('@c.us', '');
  const messageText = message.body;
  const timestamp = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });

  console.log(`📩 [${timestamp}] ${phoneNumber}: ${messageText}`);

  const incomingLog = {
    id: Date.now(),
    phone: phoneNumber,
    message: messageText,
    type: 'incoming',
    timestamp,
    date: new Date().toLocaleDateString('es-CO'),
  };
  messageLog.unshift(incomingLog);
  if (messageLog.length > 200) messageLog.pop();
  io.emit('new_message', incomingLog);

  const novaResponse = await getAIResponse(phoneNumber, messageText);

  if (novaResponse === null) {
    console.log(`🔇 [${phoneNumber}] Chat escalado — NOVA en silencio`);
    io.emit('escalated_chat', { phone: phoneNumber, timestamp });
    return;
  }

  try {
    await message.reply(novaResponse);

    const outgoingLog = {
      id: Date.now() + 1,
      phone: phoneNumber,
      message: novaResponse,
      type: 'outgoing',
      timestamp: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' }),
      date: new Date().toLocaleDateString('es-CO'),
      escalated: novaResponse.includes('CASO ESCALADO — NOVA'),
    };
    messageLog.unshift(outgoingLog);
    io.emit('new_message', outgoingLog);

    if (novaResponse.includes('CASO ESCALADO — NOVA')) {
      io.emit('new_escalation', {
        phone: phoneNumber,
        timestamp: outgoingLog.timestamp,
        preview: messageText.substring(0, 80),
      });
      if (process.env.ADMIN_PHONE) {
        try {
          await whatsappClient.sendMessage(
            `${process.env.ADMIN_PHONE}@c.us`,
            `🚨 *NOVA — Caso escalado*\n\n📱 Cliente: ${phoneNumber}\n💬 Mensaje: "${messageText.substring(0, 100)}"\n\n⚠️ Requiere atención del asesor.\nEscribe *NOVA* en el chat para reactivar.`
          );
        } catch (e) {
          console.log('No se pudo notificar al admin:', e.message);
        }
      }
    }
  } catch (error) {
    console.error('Error enviando mensaje:', error.message);
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    phone: clientPhone,
    qr: qrImageData,
    totalConversations: Object.keys(getConversations()).length,
    escalatedChats: Object.entries(getEscalatedChats()).filter(([,v]) => v).map(([k]) => k),
  });
});

app.get('/api/messages', (req, res) => { res.json(messageLog); });

app.get('/api/conversations', (req, res) => {
  const convs = getConversations();
  const escalated = getEscalatedChats();
  const result = Object.entries(convs).map(([phone, messages]) => ({
    phone,
    messageCount: messages.length,
    lastMessage: messages[messages.length - 1]?.content?.substring(0, 80) || '',
    escalated: escalated[phone] || false,
  }));
  res.json(result);
});

app.post('/api/reactivate/:phone', (req, res) => {
  reactivateNova(req.params.phone);
  io.emit('nova_reactivated', { phone: req.params.phone });
  res.json({ success: true });
});

app.post('/api/clear/:phone', (req, res) => {
  clearConversation(req.params.phone);
  res.json({ success: true });
});

io.on('connection', (socket) => {
  socket.emit('status', {
    connected: isConnected,
    phone: clientPhone,
    message: isConnected ? 'NOVA activa ❄️' : 'Esperando conexión...',
  });
  if (qrImageData && !isConnected) socket.emit('qr', qrImageData);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 PRAXO arrancado en puerto ${PORT}`);
  console.log(`🖥️  Panel: http://localhost:${PORT}`);
});

whatsappClient.initialize();
