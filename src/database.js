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
    const collection = database.collection('clients');
    await collection.updateOne(
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
    const collection = database.collection('messages');
    await collection.insertOne({ ...data, timestamp: new Date() });
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

module.exports = { connectDB, saveClient, saveMessage, getClients };
