require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const NOVA_PROMPT = require('./prompt');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const conversations = {};
const escalatedChats = {};

async function getAIResponse(phoneNumber, userMessage) {
  // Si está escalado → silencio total, sin importar qué escriba
  if (escalatedChats[phoneNumber]) {
    return null;
  }

  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [];
  }

  conversations[phoneNumber].push({
    role: 'user',
    content: userMessage,
  });

  if (conversations[phoneNumber].length > 10) {
    conversations[phoneNumber] = conversations[phoneNumber].slice(-10);
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: NOVA_PROMPT,
      messages: conversations[phoneNumber],
    });

    const assistantMessage = response.content[0].text;

    conversations[phoneNumber].push({
      role: 'assistant',
      content: assistantMessage,
    });

    if (assistantMessage.includes('CASO ESCALADO')) {
      escalatedChats[phoneNumber] = true;
    }

    return assistantMessage;

  } catch (error) {
    console.error('Error Claude API:', error.message);
    return 'Disculpe, tuve un problema tecnico. Un asesor lo atendera en breve.';
  }
}

function getConversations() { return conversations; }
function getEscalatedChats() { return escalatedChats; }
function clearConversation(phoneNumber) {
  conversations[phoneNumber] = [];
  escalatedChats[phoneNumber] = false;
}
function escalateChat(phoneNumber) {
  escalatedChats[phoneNumber] = true;
}
function reactivateNova(phoneNumber) {
  escalatedChats[phoneNumber] = false;
  conversations[phoneNumber] = [];
}

module.exports = {
  getAIResponse,
  getConversations,
  getEscalatedChats,
  clearConversation,
  reactivateNova,
  escalateChat,
};
