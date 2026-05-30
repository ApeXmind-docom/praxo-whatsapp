require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const { getAIResponse, getConversations, getEscalatedChats, clearConversation, reactivateNova, escalateChat } = require('./ai');
const { connectDB, saveClient, saveMessage, getClients, getStats, getMessages, setEscalated, isEscalated, getAllEscalated, checkClientExists } = require('./database');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.PANEL_USER || 'Refriadvanced';
  const validPass = process.env.PANEL_PASS || 'Refriadvanced2026#';
  if (username === validUser && password === validPass) {
    res.json({ success: true, token: Buffer.from(username + ':' + password).toString('base64') });
  } else {
    res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
  }
});

function authMiddleware(req, res, next) {
  const auth = req.headers['x-auth-token'];
  const validUser = process.env.PANEL_USER || 'Refriadvanced';
  const validPass = process.env.PANEL_PASS || 'Refriadvanced2026#';
  const expected = Buffer.from(validUser + ':' + validPass).toString('base64');
  if (auth === expected) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// Auth aplicado por ruta individualmente en cada endpoint
app.use(express.static(path.join(__dirname, '../public')));

const messageLog = [];

// Números de los asesores
const NUMEROS_ASESORES = ['573166293733', '573118576272', '55314917417149', '263071847153902', '573204542460'];

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

      // ── MENSAJE DEL ASESOR: fromMe O número de asesor ──
      const esAsesor = message.key.fromMe || NUMEROS_ASESORES.some(n => phoneNumber.includes(n));

      if (esAsesor) {
        if (message.key.fromMe) {
          const cmd = messageText.trim().toUpperCase();

          if (cmd === 'NOVA') {
            // Reactivar NOVA
            reactivateNova(conversationId);
            await setEscalated(conversationId, false);
            console.log('✅ [' + account.label + '] NOVA reactivada para ' + phoneNumber);

          } else if (cmd === 'PAUSA') {
            // Asesor pausa NOVA manualmente — 100% confiable
            escalateChat(conversationId);
            await setEscalated(conversationId, true);
            console.log('⏸️  [' + account.label + '] PAUSA activada para ' + phoneNumber);
            io.emit('escalated_chat', { phone: phoneNumber, account: account.label });

          } else {
            // Asesor respondió normalmente → silenciar NOVA automáticamente
            escalateChat(conversationId);
            await setEscalated(conversationId, true);
            console.log('🤫 [' + account.label + '] Asesor intervino en ' + phoneNumber + ' — NOVA en silencio');
            io.emit('escalated_chat', { phone: phoneNumber, account: account.label });
          }
        }
        // Si es número de asesor escribiendo → ignorar siempre
        continue;
      }

      // ── MENSAJE DE CLIENTE ───────────────────────────────────────────────
      // Doble verificación: RAM + MongoDB antes de responder
      const escaladoEnDB = await isEscalated(conversationId);
      if (escaladoEnDB) {
        escalateChat(conversationId); // sincronizar RAM
        console.log('🔇 [' + account.label + '] [' + phoneNumber + '] Escalado — NOVA en silencio');
        continue;
      }

      const timestamp = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
      console.log('📩 [' + account.label + '] [' + timestamp + '] ' + phoneNumber + ': ' + messageText);

      // Verificar si es cliente nuevo ANTES de guardarlo
      const esClienteNuevo = !(await checkClientExists(phoneNumber));
      console.log('👤 [' + phoneNumber + '] Es cliente nuevo: ' + esClienteNuevo);

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
        // Enviar catálogo, web y dirección solo si es cliente NUEVO
        if (esClienteNuevo) {
          console.log('🆕 Cliente nuevo — enviando catálogo, web y dirección');
          try {
            // 1. Catálogo PDF
            await account.sock.sendMessage(message.key.remoteJid, {
              document: { url: 'https://raw.githubusercontent.com/ApeXmind-docom/praxo-whatsapp/main/public/catalogo-compressed.pdf' },
              mimetype: 'application/pdf',
              fileName: 'Catalogo-Refriadvanced.pdf',
              caption: '📄 Te compartimos nuestro catálogo con todos los equipos y precios'
            });
            console.log('✅ PDF enviado');
            // 2. Link de la web
            await account.sock.sendMessage(message.key.remoteJid, {
              text: '🌐 Visita nuestra página web: www.refriadvanced.com'
            });
            // 3. Dirección
            await account.sock.sendMessage(message.key.remoteJid, {
              text: '📍 Nuestra dirección: Cra 52C #34-28 Sur, Barrio Alquería, Bogotá'
            });
            console.log('✅ Web y dirección enviadas');
          } catch (mediaError) {
            console.error('❌ Error enviando catálogo:', mediaError.message);
          }
        }

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

app.get('/api/status', authMiddleware, async (req, res) => {
  res.json({
    numero1: { connected: accounts.numero1.isConnected, phone: accounts.numero1.clientPhone, qr: accounts.numero1.qrImageData },
    numero2: { connected: accounts.numero2.isConnected, phone: accounts.numero2.clientPhone, qr: accounts.numero2.qrImageData },
    totalConversations: Object.keys(getConversations()).length,
    escalatedChats: await getAllEscalated(),
  });
});

app.get('/api/messages', (req, res) => { res.json(messageLog); });

app.get('/api/conversations', authMiddleware, (req, res) => {
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

app.get('/api/clients', authMiddleware, async (req, res) => {
  const clients = await getClients();
  res.json(clients);
});

app.post('/api/reactivate/:phone', authMiddleware, async (req, res) => {
  reactivateNova(req.params.phone);
  await setEscalated(req.params.phone, false);
  io.emit('nova_reactivated', { phone: req.params.phone });
  res.json({ success: true });
});

app.post('/api/clear/:phone', authMiddleware, (req, res) => {
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

// Servir archivos estáticos de assets
// Archivos estáticos servidos desde public/

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log('🚀 PRAXO arrancado en puerto ' + PORT);
  console.log('🖥️  Panel: http://localhost:' + PORT);
  await connectDB();
  connectWhatsApp('numero1');
  connectWhatsApp('numero2');
});
