require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const { getAIResponse, getConversations, getEscalatedChats, clearConversation, reactivateNova, escalateChat } = require('./ai');
const { connectDB, saveClient, saveMessage, getClients } = require('./database');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const messageLog = [];

// Números de los asesores
const NUMEROS_ASESORES = ['573166293733', '573118576272', '55314917417149', '263071847153902'];

const accounts = {
  numero1: {
    label: 'Asesor 1',
    sessionPath: '/data/session1',
    sock: null,
    isConnected: false,
    clientPhone: null,
    qrImageData: null,
  },
  numero2: {
    label: 'Asesor 2',
    sessionPath: '/data/session2',
    sock: null,
    isConnected: false,
    clientPhone: null,
    qrImageData: null,
  },
};

async function connectWhatsApp(accountKey) {
  const account = accounts[accountKey];
  const { state, saveCreds } = await useMultiFileAuthState(account.sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  account.sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
  });

  account.sock.ev.on('creds.update', saveCreds);

  account.sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      account.qrImageData = await qrcode.toDataURL(qr);
      account.isConnected = false;
      io.emit('qr_' + accountKey, account.qrImageData);
      io.emit('status_' + accountKey, { connected: false, message: 'Escanea el QR - ' + account.label });
      console.log('📱 QR generado [' + account.label + ']');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[' + account.label + '] Conexion cerrada. Reconectando:', shouldReconnect);
      account.isConnected = false;
      io.emit('status_' + accountKey, { connected: false, message: 'Desconectado' });
      if (shouldReconnect) setTimeout(() => connectWhatsApp(accountKey), 3000);
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado [' + account.label + ']');
      account.isConnected = true;
      account.qrImageData = null;
      account.clientPhone = account.sock.user?.id?.split(':')[0] || 'Conectado';
      io.emit('status_' + accountKey, { connected: true, phone: account.clientPhone, message: 'NOVA activa - ' + account.label });
    }
  });

  account.sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      if (!message.message) continue;
      if (message.key.remoteJid === 'status@broadcast') continue;
      if (message.key.remoteJid.includes('@g.us')) continue;

      const phoneNumber = message.key.remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
      const conversationId = accountKey + '_' + phoneNumber;

      const messageText = message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption || '';

      if (!messageText) continue;

      // ── MENSAJE ENVIADO POR EL ASESOR (fromMe) ──────────────────────────
      if (message.key.fromMe) {
        // Si el asesor escribe NOVA → reactivar
        if (messageText.trim().toUpperCase() === 'NOVA') {
          reactivateNova(conversationId);
          console.log('✅ [' + account.label + '] NOVA reactivada para ' + phoneNumber);
        } else {
          // El asesor respondió manualmente → NOVA se calla automáticamente
          escalateChat(conversationId);
          console.log('🤫 [' + account.label + '] Asesor intervino en ' + phoneNumber + ' — NOVA en silencio');
          io.emit('escalated_chat', { phone: phoneNumber, account: account.label });
        }
        continue;
      }

      // ── MENSAJE ENTRE ASESORES → ignorar completamente ──────────────────
      if (NUMEROS_ASESORES.some(n => phoneNumber.includes(n))) continue;

      // ── MENSAJE DE CLIENTE ───────────────────────────────────────────────
      const timestamp = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
      console.log('📩 [' + account.label + '] [' + timestamp + '] ' + phoneNumber + ': ' + messageText);

      await saveClient({
        phone: phoneNumber,
        lastMessage: messageText,
        lastSeen: new Date(),
        status: 'active',
        client: process.env.CLIENT_NAME || 'Refriadvanced',
        account: account.label,
      });

      await saveMessage({
        phone: phoneNumber,
        message: messageText,
        type: 'incoming',
        client: process.env.CLIENT_NAME || 'Refriadvanced',
        account: account.label,
      });

      const incomingLog = {
        id: Date.now(),
        phone: phoneNumber,
        message: messageText,
        type: 'incoming',
        timestamp,
        date: new Date().toLocaleDateString('es-CO'),
        account: account.label,
      };
      messageLog.unshift(incomingLog);
      if (messageLog.length > 200) messageLog.pop();
      io.emit('new_message', incomingLog);

      const novaResponse = await getAIResponse(conversationId, messageText);

      if (novaResponse === null) {
        console.log('🔇 [' + account.label + '] [' + phoneNumber + '] Chat escalado - NOVA en silencio');
        continue;
      }

      try {
        await account.sock.sendMessage(message.key.remoteJid, { text: novaResponse });

        await saveMessage({
          phone: phoneNumber,
          message: novaResponse,
          type: 'outgoing',
          client: process.env.CLIENT_NAME || 'Refriadvanced',
          account: account.label,
        });

        const outgoingLog = {
          id: Date.now() + 1,
          phone: phoneNumber,
          message: novaResponse,
          type: 'outgoing',
          timestamp: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' }),
          date: new Date().toLocaleDateString('es-CO'),
          escalated: novaResponse.includes('CASO ESCALADO'),
          account: account.label,
        };
        messageLog.unshift(outgoingLog);
        io.emit('new_message', outgoingLog);

        if (novaResponse.includes('CASO ESCALADO')) {
          await saveClient({
            phone: phoneNumber,
            lastMessage: messageText,
            lastSeen: new Date(),
            status: 'escalated',
            client: process.env.CLIENT_NAME || 'Refriadvanced',
            account: account.label,
          });

          io.emit('new_escalation', {
            phone: phoneNumber,
            timestamp: outgoingLog.timestamp,
            preview: messageText.substring(0, 80),
            account: account.label,
          });

          const adminPhone = accountKey === 'numero1'
            ? process.env.ADMIN_PHONE
            : process.env.ADMIN_PHONE_2;

          if (adminPhone && account.sock) {
            try {
              await account.sock.sendMessage(adminPhone + '@s.whatsapp.net', {
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
    numero1: { connected: accounts.numero1.isConnected, phone: accounts.numero1.clientPhone, qr: accounts.numero1.qrImageData },
    numero2: { connected: accounts.numero2.isConnected, phone: accounts.numero2.clientPhone, qr: accounts.numero2.qrImageData },
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
  for (const [key, account] of Object.entries(accounts)) {
    socket.emit('status_' + key, {
      connected: account.isConnected,
      phone: account.clientPhone,
      message: account.isConnected ? 'NOVA activa - ' + account.label : 'Esperando conexion...',
    });
    if (account.qrImageData && !account.isConnected) {
      socket.emit('qr_' + key, account.qrImageData);
    }
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log('🚀 PRAXO arrancado en puerto ' + PORT);
  console.log('🖥️  Panel: http://localhost:' + PORT);
  await connectDB();
  connectWhatsApp('numero1');
  connectWhatsApp('numero2');
});
