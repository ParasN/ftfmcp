import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeBigQuery } from './bigquery.js';
import { AgenticOrchestrator } from './agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3001;


app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173'
}));
app.use(express.json());

let orchestrator = null;

async function initializeServices() {
  try {
    const projectId = process.env.GCP_PROJECT_ID;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!projectId) {
      throw new Error('GCP_PROJECT_ID environment variable is required');
    }

    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }

    console.log('🔐 Using Google Cloud Application Default Credentials');
    console.log('   Make sure you have authenticated with: gcloud auth application-default login');
    
    initializeBigQuery(projectId);
    console.log('✓ BigQuery client initialized');

    orchestrator = new AgenticOrchestrator(geminiApiKey);
    console.log('✓ Agentic orchestrator initialized');

    return true;
  } catch (error) {
    console.error('✗ Initialization error:', error.message);
    throw error;
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    initialized: orchestrator !== null,
    timestamp: new Date().toISOString()
  });
});


app.post('/api/chat', async (req, res) => {
  try {
    if (!orchestrator) {
      return res.status(503).json({
        error: 'Service not initialized. Check server logs.'
      });
    }

    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Message is required and must be a string'
      });
    }

    const response = await orchestrator.chat(message);

    res.json({
      success: true,
      response: response.text,
      toolCalls: response.toolCalls,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: error.message || 'An error occurred processing your request'
    });
  }
});

app.post('/api/reset', (req, res) => {
  try {
    if (!orchestrator) {
      return res.status(503).json({
        error: 'Service not initialized'
      });
    }

    orchestrator.resetConversation();

    res.json({
      success: true,
      message: 'Conversation reset successfully'
    });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({
      error: error.message || 'An error occurred resetting the conversation'
    });
  }
});

app.get('/api/history', (req, res) => {
  try {
    if (!orchestrator) {
      return res.status(503).json({
        error: 'Service not initialized'
      });
    }

    const history = orchestrator.getHistory();

    res.json({
      success: true,
      history: history
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({
      error: error.message || 'An error occurred fetching history'
    });
  }
});

async function startServer() {
  try {
    await initializeServices();

    app.listen(PORT, () => {
      console.log(`\n🚀 BigQuery Chat Server running on http://localhost:${PORT}`);
      console.log(`📊 Project ID: ${process.env.GCP_PROJECT_ID}`);
      console.log(`🤖 Agentic orchestration: Enabled`);
      console.log(`\nAPI Endpoints:`);
      console.log(`  GET  /api/health   - Health check`);
      console.log(`  POST /api/chat     - Send a message`);
      console.log(`  POST /api/reset    - Reset conversation`);
      console.log(`  GET  /api/history  - Get conversation history\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
