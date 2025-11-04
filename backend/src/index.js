import * as functions from "firebase-functions";
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
let server;

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


app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    initialized: orchestrator !== null,
    timestamp: new Date().toISOString()
  });
});


app.post('/chat', async (req, res) => {
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

app.post('/reset', (req, res) => {
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

app.get('/history', (req, res) => {
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
  await initializeServices();

  // Start the server for local development
  if (process.env.NODE_ENV !== 'production') {
    const portArg = process.argv.find(arg => arg.startsWith('--port='));
    const PORT = portArg ? portArg.split('=')[1] : (process.env.PORT || 8081);
    server = app.listen(PORT, () => {
      console.log(`🚀 Backend server running at http://localhost:${PORT}`);
    });
  }
}

if (process.env.NODE_ENV === 'production') {
  exports.api = functions.https.onRequest(app);
} else {
  startServer();
}

const gracefulShutdown = () => {
  console.log('👋 Shutting down gracefully');
  server.close(() => {
    console.log(' Fuller Stack out ✌️');
    process.exit(0);
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
