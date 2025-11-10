import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Agent } from './agent.js';
import { ConversationStore } from './conversationStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const moodboardDir = join(__dirname, '../generated/moodboards');
mkdirSync(moodboardDir, { recursive: true });
app.use('/api/moodboards', express.static(moodboardDir));

const conversationStorePath = join(__dirname, '../data/conversations.json');
const conversationStore = new ConversationStore(conversationStorePath);

let servicesReady = false;
let geminiApiKey = null;
let projectId = null;

async function initializeServices() {
  try {
    projectId = process.env.GCP_PROJECT_ID;
    geminiApiKey = process.env.GEMINI_API_KEY;

    if (!projectId) {
      throw new Error('GCP_PROJECT_ID environment variable is required');
    }

    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }

    console.log('🔐 Using Google Cloud Application Default Credentials');
    console.log('   Make sure you have authenticated with: gcloud auth application-default login');

    servicesReady = true;
    console.log('✓ Agentic services initialized');
  } catch (error) {
    console.error('✗ Initialization error:', error.message);
    throw error;
  }
}

function ensureConversationId(conversationId) {
  if (conversationId) {
    if (!conversationStore.hasConversation(conversationId)) {
      throw new Error('Conversation not found');
    }
    return conversationId;
  }

  const fallbackId = conversationStore.getDefaultConversationId();
  if (fallbackId) {
    return fallbackId;
  }

  const conversation = conversationStore.createConversation();
  return conversation.id;
}

async function runConversationTurn({ conversationId, messageText, streamCallback = null }) {
  const targetConversationId = ensureConversationId(conversationId);
  const agent = new Agent(geminiApiKey, streamCallback);

  const history = conversationStore.getModelHistory(targetConversationId);
  agent.loadConversationHistory(history);

  const userMessage = conversationStore.appendMessage(targetConversationId, {
    role: 'user',
    content: messageText
  });

  let assistantMessage = null;

  try {
    const response = await agent.chat(messageText);
    assistantMessage = conversationStore.appendMessage(targetConversationId, {
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
      attachments: response.attachments || [],
      payload: response.payload || null
    });

    return {
      conversationId: targetConversationId,
      response,
      userMessage,
      assistantMessage
    };
  } catch (err) {
    const errorEntry = conversationStore.appendMessage(targetConversationId, {
      role: 'error',
      content: err?.message || 'An error occurred processing your request'
    });

    const normalizedError = err instanceof Error ? err : new Error(err?.message || String(err));
    normalizedError.conversationId = targetConversationId;
    normalizedError.historyEntry = errorEntry;
    throw normalizedError;
  } finally {
    const snapshot = agent.getConversationHistorySnapshot();
    conversationStore.setModelHistory(targetConversationId, snapshot);
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    initialized: servicesReady,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/conversations', (req, res) => {
  res.json({
    success: true,
    conversations: conversationStore.listConversations(),
    defaultConversationId: conversationStore.getDefaultConversationId()
  });
});

app.post('/api/conversations', (req, res) => {
  const { title } = req.body || {};
  const conversation = conversationStore.createConversation(title);

  res.status(201).json({
    success: true,
    conversation
  });
});

app.get('/api/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  if (!conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  const conversation = conversationStore.getConversation(conversationId);
  res.json({
    success: true,
    conversation
  });
});

app.patch('/api/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const { title } = req.body || {};

  if (!conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  const conversation = conversationStore.renameConversation(conversationId, title);
  res.json({
    success: true,
    conversation
  });
});

app.delete('/api/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;

  if (!conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  const nextConversation = conversationStore.deleteConversation(conversationId);
  res.json({
    success: true,
    nextConversationId: nextConversation?.id || null,
    conversations: conversationStore.listConversations()
  });
});

app.post('/api/conversations/:conversationId/reset', (req, res) => {
  const { conversationId } = req.params;

  if (!conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  const conversation = conversationStore.resetConversation(conversationId);
  res.json({
    success: true,
    conversation
  });
});

app.post('/api/chat', async (req, res) => {
  if (!servicesReady) {
    return res.status(503).json({
      error: 'Service not initialized. Check server logs.'
    });
  }

  const { message, conversationId } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      error: 'Message is required and must be a string'
    });
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return res.status(400).json({
      error: 'Message cannot be empty'
    });
  }

  if (conversationId && !conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  try {
    const result = await runConversationTurn({
      conversationId,
      messageText: trimmedMessage
    });

    res.json({
      success: true,
      conversationId: result.conversationId,
      response: result.response.text,
      toolCalls: result.response.toolCalls,
      attachments: result.response.attachments || [],
      routingSuggestion: result.response.routingSuggestion,
      formatValidation: result.response.formatValidation,
      payload: result.response.payload || null,
      timestamp: result.assistantMessage.timestamp
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: error.message || 'An error occurred processing your request',
      conversationId: error.conversationId || null
    });
  }
});

app.post('/api/reset', (req, res) => {
  if (!servicesReady) {
    return res.status(503).json({
      error: 'Service not initialized'
    });
  }

  const { conversationId } = req.body || {};

  if (conversationId && !conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  try {
    const targetId = ensureConversationId(conversationId);
    const conversation = conversationStore.resetConversation(targetId);

    res.json({
      success: true,
      conversation
    });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({
      error: error.message || 'An error occurred resetting the conversation'
    });
  }
});

app.get('/api/history', (req, res) => {
  if (!servicesReady) {
    return res.status(503).json({
      error: 'Service not initialized'
    });
  }

  const { conversationId } = req.query;

  if (conversationId && !conversationStore.hasConversation(conversationId)) {
    return res.status(404).json({
      error: 'Conversation not found'
    });
  }

  const targetId = conversationId || conversationStore.getDefaultConversationId();
  const history = conversationStore.getModelHistory(targetId);

  res.json({
    success: true,
    conversationId: targetId,
    history
  });
});

async function startServer() {
  try {
    await initializeServices();

    const server = app.listen(port, () => {
      console.log(`\n🚀 BigQuery Chat Server running on http://localhost:${port}`);
      console.log(`📊 Project ID: ${projectId}`);
      console.log(`🤖 Agentic orchestration: Enabled`);
      console.log(`\nAPI Endpoints:`);
      console.log(`  GET    /api/health                    - Health check`);
      console.log(`  GET    /api/conversations             - List conversations`);
      console.log(`  POST   /api/conversations             - Create a conversation`);
      console.log(`  GET    /api/conversations/:id         - Fetch a conversation`);
      console.log(`  PATCH  /api/conversations/:id         - Rename a conversation`);
      console.log(`  DELETE /api/conversations/:id         - Delete a conversation`);
      console.log(`  POST   /api/conversations/:id/reset   - Clear a conversation`);
      console.log(`  POST   /api/chat                      - Send a message`);
      console.log(`  POST   /api/reset                     - Reset (compat alias)`);
      console.log(`  GET    /api/history                   - Model history snapshot\n`);
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      console.log('Client connected');

      ws.on('message', async (payload) => {
        if (!servicesReady) {
          ws.send(JSON.stringify({ error: 'Service not initialized' }));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload.toString());
        } catch {
          parsed = { message: payload.toString() };
        }

        const rawMessage = parsed?.message;
        const candidateConversationId = parsed?.conversationId;

        if (!rawMessage || typeof rawMessage !== 'string') {
          ws.send(JSON.stringify({
            error: 'Message is required and must be a string',
            conversationId: candidateConversationId || null
          }));
          return;
        }

        const trimmedMessage = rawMessage.trim();
        if (!trimmedMessage) {
          ws.send(JSON.stringify({
            error: 'Message cannot be empty',
            conversationId: candidateConversationId || null
          }));
          return;
        }

        let targetConversationId;
        try {
          targetConversationId = ensureConversationId(candidateConversationId);
        } catch (error) {
          ws.send(JSON.stringify({
            error: error.message,
            conversationId: candidateConversationId || null
          }));
          return;
        }

        try {
          const result = await runConversationTurn({
            conversationId: targetConversationId,
            messageText: trimmedMessage,
            streamCallback: (chunk) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ...chunk, conversationId: targetConversationId }));
              }
            }
          });

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              final_response: result.response,
              conversationId: targetConversationId
            }));
          }
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              error: error.message || 'An error occurred processing your request',
              conversationId: error.conversationId || targetConversationId || null
            }));
          }
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected');
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
