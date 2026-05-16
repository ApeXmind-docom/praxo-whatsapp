const { MongoClient } = require('mongodb');

let db = null;

async function connectDB() {
  if (db) return db;
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('praxo');
    console.log('✅ MongoDB conectado');
    return db;
  } catch (error) {
    console.error('Error MongoDB:', error.message);
    return null;
  }
}

async function saveClient(data) {
  try {
    const database = await connectDB();
    if (!database) return;
    await database.collection('clients').updateOne(
      { phone: data.phone },
      { $set: { ...data, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error guardando cliente:', error.message);
  }
}

async function saveMessage(data) {
  try {
    const database = await connectDB();
    if (!database) return;
    await database.collection('messages').insertOne({ ...data, timestamp: new Date() });
  } catch (error) {
    console.error('Error guardando mensaje:', error.message);
  }
}

async function getClients() {
  try {
    const database = await connectDB();
    if (!database) return [];
    return await database.collection('clients').find({}).sort({ updatedAt: -1 }).toArray();
  } catch (error) {
    console.error('Error obteniendo clientes:', error.message);
    return [];
  }
}

async function getStats() {
  try {
    const database = await connectDB();
    if (!database) return {};

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalClients,
      activeToday,
      escalatedTotal,
      messagesTotal,
      messagesThisMonth,
      messagesThisWeek,
      clientsByCity,
      messagesByDay,
    ] = await Promise.all([
      database.collection('clients').countDocuments(),
      database.collection('clients').countDocuments({ updatedAt: { $gte: startOfDay } }),
      database.collection('clients').countDocuments({ status: 'escalated' }),
      database.collection('messages').countDocuments(),
      database.collection('messages').countDocuments({ timestamp: { $gte: startOfMonth } }),
      database.collection('messages').countDocuments({ timestamp: { $gte: startOfWeek } }),
      database.collection('clients').aggregate([
        { $group: { _id: '$client', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 5 }
      ]).toArray(),
      database.collection('messages').aggregate([
        { $match: { timestamp: { $gte: startOfWeek }, type: 'incoming' } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'America/Bogota' } },
          count: { $sum: 1 }
        }},
        { $sort: { _id: 1 } }
      ]).toArray(),
    ]);

    return {
      totalClients,
      activeToday,
      escalatedTotal,
      messagesTotal,
      messagesThisMonth,
      messagesThisWeek,
      clientsByCity,
      messagesByDay,
    };
  } catch (error) {
    console.error('Error obteniendo stats:', error.message);
    return {};
  }
}

async function getMessages(phone, limit = 50) {
  try {
    const database = await connectDB();
    if (!database) return [];
    return await database.collection('messages')
      .find({ phone })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  } catch (error) {
    return [];
  }
}

module.exports = { connectDB, saveClient, saveMessage, getClients, getStats, getMessages };
