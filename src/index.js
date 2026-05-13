require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const { getAIResponse, getConversations, getEscalatedChats, clearConversation, reactivateNova } = require('./ai');
const { connectDB, saveClient, saveMessage, getClients } = require('./database');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let qrImageData = null;
let isConnected = false;
let clientPhone = null;
const messageLog = [];
let sock = null;

async function connectWhatsApp() {
  // Sesión guardada en disco persistente de Render (/data)
  const { state, saveCreds } = await useMultiFileAuthState('/data/session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrImageData = await qrcode.toDataURL(qr);
      isConnected = false;
      io.emit('qr', qrImageData);
      io.emit('status', { connected: false, message: 'Escanea el QR con WhatsApp' });
      console.log('📱 QR generado');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexion cerrada. Reconectando:', shouldReconnect);
      isConnected = false;
      io.emit('status', { connected: false, message: 'Desconectado' });
      if (shouldReconnect) setTimeout(connectWhatsApp, 3000);
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado');
      isConnected = true;
      qrImageData = null;
      clientPhone = sock.user?.id?.split(':')[0] || 'Conectado';
      io.emit('status', { connected: true, phone: clientPhone, message: 'NOVA activa' });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      if (!message.message) continue;
      if (message.key.fromMe) continue;
      if (message.key.remoteJid === 'status@broadcast') continue;
      if (message.key.remoteJid.includes('@g.us')) continue;

      const phoneNumber = message.key.remoteJid.replace('@s.whatsapp.net', '');
      const messageText = message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption || '';

      if (!messageText) continue;

      const timestamp = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
      console.log('📩 [' + timestamp + '] ' + phoneNumber + ': ' + messageText);

      await saveClient({
        phone: phoneNumber,
        lastMessage: messageText,
        lastSeen: new Date(),
        status: 'active',
        client: process.env.CLIENT_NAME || 'Refriadvanced'
      });

      await saveMessage({
        phone: phoneNumber,
        message: messageText,
        type: 'incoming',
        client: process.env.CLIENT_NAME || 'Refriadvanced'
      });

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
        console.log('🔇 [' + phoneNumber + '] Chat escalado - NOVA en silencio');
        io.emit('escalated_chat', { phone: phoneNumber, timestamp });
        continue;
      }

      try {
        await sock.sendMessage(message.key.remoteJid, { text: novaResponse });

        await saveMessage({
          phone: phoneNumber,
          message: novaResponse,
          type: 'outgoing',
          client: process.env.CLIENT_NAME || 'Refriadvanced'
        });

        const outgoingLog = {
          id: Date.now() + 1,
          phone: phoneNumber,
          message: novaResponse,
          type: 'outgoing',
          timestamp: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' }),
          date: new Date().toLocaleDateString('es-CO'),
          escalated: novaResponse.includes('CASO ESCALADO'),
        };
        messageLog.unshift(outgoingLog);
        io.emit('new_message', outgoingLog);

        if (novaResponse.includes('CASO ESCALADO')) {
          await saveClient({
            phone: phoneNumber,
            lastMessage: messageText,
            lastSeen: new Date(),
            status: 'escalated',
            client: process.env.CLIENT_NAME || 'Refriadvanced'
          });

          io.emit('new_escalation', {
            phone: phoneNumber,
            timestamp: outgoingLog.timestamp,
            preview: messageText.substring(0, 80),
          });

          if (process.env.ADMIN_PHONE && sock) {
            try {
              await sock.sendMessage(process.env.ADMIN_PHONE + '@s.whatsapp.net', {
                text: '🚨 *NOVA - Caso escalado*\n\n📱 Cliente: ' + phoneNumber + '\n💬 Mensaje: "' + messageText.substring(0, 100) + '"\n\n⚠️ Requiere atencion del asesor.\nEscribe *NOVA* en el chat para reactivar.'
              });
            } catch (e) {
              console.log('No se pudo notificar al admin:', e.message);
            }
          }
        }
      } catch (error) {
        console.error('Error enviando mensaje:', error.message);
      }
    }
  });
}

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

app.get('/api/clients', async (req, res) => {
  const clients = await getClients();
  res.json(clients);
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
    message: isConnected ? 'NOVA activa' : 'Esperando conexion...',
  });
  if (qrImageData && !isConnected) socket.emit('qr', qrImageData);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log('🚀 PRAXO arrancado en puerto ' + PORT);
  console.log('🖥️  Panel: http://localhost:' + PORT);
  await connectDB();
  await connectWhatsApp();
});
