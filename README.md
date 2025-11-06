# BigQuery Chat App

A full-stack agentic application that lets you chat with your Google BigQuery data using natural language. The app uses Google's Gemini AI with function calling to intelligently explore datasets, inspect schemas, and run SQL queries based on your questions.

## Features

- **Natural Language Interface**: Ask questions in plain English about your BigQuery data
- **Agentic Orchestration**: The AI autonomously decides which BigQuery operations to perform
- **Multi-turn Conversations**: Maintains context across the conversation for natural interactions
- **Real-time Tool Visibility**: See exactly which BigQuery operations the AI is running
- **Modern UI**: Clean, responsive chat interface with typing indicators and tool call displays
- **Google Cloud Authentication**: Uses Application Default Credentials - no JSON keys needed

## Architecture

### Backend (`/backend`)
- **Express.js API**: RESTful endpoints for chat, health checks, and conversation management
- **BigQuery Integration**: Direct connection to Google BigQuery with functions for:
  - Listing datasets
  - Listing tables in a dataset
  - Getting table schemas and metadata
  - Running SQL queries
- **Agentic Orchestrator**: Uses Google Gemini 2.0 Flash with function calling to:
  - Understand user intent
  - Decide which BigQuery operations to perform
  - Execute multiple operations in sequence
  - Synthesize results into natural language responses

### Frontend (`/frontend`)
- **React + Vite**: Fast, modern development experience
- **Chat Interface**: Clean UI showing:
  - User messages
  - AI responses
  - Tool calls with arguments and results
  - Connection status
  - Conversation reset

## Prerequisites

- Node.js 18 or higher
- Google Cloud SDK (gcloud CLI)
- A Google Cloud Platform account with:
  - A project with BigQuery enabled
  - BigQuery permissions for your user account
- A Google AI Studio API key for Gemini

## Setup Instructions

### 1. Install Google Cloud SDK

If you don't have the gcloud CLI installed:

**On macOS:**
```bash
brew install google-cloud-sdk
```

**On Linux:**
```bash
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

**On Windows:**
Download and run the installer from: https://cloud.google.com/sdk/docs/install

### 3. Clone and Install Dependencies

```bash
npm install
```

This will install dependencies for the root project, backend, and frontend.

### 4. Get Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the API key

### 5. Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
GCP_PROJECT_ID=your-gcp-project-id
GEMINI_API_KEY=your-gemini-api-key
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

### 6. Start the Application

#### Development Mode (Both Frontend and Backend)

```bash
npm run dev
```

This starts:
- Backend API on http://localhost:3001
- Frontend UI on http://localhost:5173

#### Start Backend Only

```bash
npm run dev:backend
```

#### Start Frontend Only

```bash
npm run dev:frontend
```

#### Production Build

```bash
npm run build
npm run start
```

- Backend API on http://localhost:3001
- Frontend UI on http://localhost:5173

#### Start Backend Only

```bash
npm run dev:backend
```

#### Start Frontend Only

```bash
npm run dev:frontend
```

#### Production Build

```bash
npm run build
npm run start
```

## Usage

1. Open your browser to http://localhost:5173
2. Wait for the "Connected" status indicator to turn green
3. Start asking questions about your BigQuery data!

### Example Questions

- "What datasets do I have?"
- "Show me the tables in the analytics dataset"
- "What's the schema of the users table?"
- "How many rows are in the orders table?"
- "Show me the top 10 customers by revenue"
- "What columns are in the sales table and what are their types?"

### How It Works

1. You type a natural language question
2. The question is sent to the backend
3. The Gemini AI model analyzes your question and decides which BigQuery operations to perform
4. The AI can call multiple functions in sequence:
   - `list_datasets()` - See available datasets
   - `list_tables(datasetId)` - See tables in a dataset
   - `get_table_schema(datasetId, tableId)` - Inspect table structure
   - `run_query(sqlQuery)` - Execute SQL queries
5. Results are displayed in the chat with full visibility into tool calls
6. The conversation context is maintained for follow-up questions

## API Endpoints

### `GET /api/health`
Check if the server is running and initialized.

**Response:**
```json
{
  "status": "ok",
  "initialized": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### `POST /api/chat`
Send a message to the AI agent.

**Request:**
```json
{
  "message": "What datasets do I have?"
}
```

**Response:**
```json
{
  "success": true,
  "response": "You have 3 datasets: analytics, sales, and marketing.",
  "toolCalls": [
    {
      "name": "list_datasets",
      "args": {},
      "result": [...]
    }
  ],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### `POST /api/reset`
Reset the conversation history.

**Response:**
```json
{
  "success": true,
  "message": "Conversation reset successfully"
}
```

### `GET /api/history`
Get the full conversation history.

**Response:**
```json
{
  "success": true,
  "history": [...]
}
```

## Project Structure

```
bigquery-chat-app/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server and API routes
│   │   ├── agent.js          # Agentic orchestration with Gemini
│   │   └── bigquery.js       # BigQuery client and operations
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # Main React component
│   │   ├── App.css           # Styles
│   │   ├── main.jsx          # React entry point
│   │   └── index.css         # Global styles
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Troubleshooting

### "Service not initialized" error
- Check that your `.env` file has the correct values
- Ensure your GCP project ID is correct
- Verify you're authenticated: `gcloud auth application-default login`
- Add quota project to to ADC: 'gcloud auth application-default set-quota-project fynd-jio-impetus-non-prod'

### "Authentication failed" error
- Run `gcloud auth application-default login` to authenticate
- Verify you have BigQuery permissions in your GCP project
- Check that you've set the correct project: `gcloud config set project YOUR_PROJECT_ID`
- Ensure BigQuery API is enabled: `gcloud services enable bigquery.googleapis.com`

### "No datasets found"
- Ensure your GCP project has BigQuery datasets
- Verify you have permission to view datasets (BigQuery Data Viewer role or higher)
- Check that you're authenticated with the correct Google account
- Try creating a test dataset in BigQuery console

### Frontend shows "Disconnected"
- Ensure backend is running on port 3001
- Check browser console for errors
- Verify CORS settings in backend

## Development

### Adding New BigQuery Functions

1. Add the function to `backend/src/bigquery.js`
2. Add the tool definition to `backend/src/agent.js` in the `tools` array
3. Add the case to the `executeToolCall` function in `backend/src/agent.js`

### Customizing the AI Behavior

Edit the `systemInstruction` in `backend/src/agent.js` to change how the AI responds and behaves.

### Styling

Modify `frontend/src/App.css` to customize the UI appearance.

## Security Notes

- Never commit your `.env` file to version control
- The `.gitignore` file is configured to exclude sensitive files
- Application Default Credentials are stored securely by gcloud
- In production, use Workload Identity or Service Account impersonation
- Consider using Google Cloud Secret Manager for API keys
- Implement rate limiting and authentication for production use

## License

MIT

## Support

For issues or questions, please check:
- [Google BigQuery Documentation](https://cloud.google.com/bigquery/docs)
- [Google Gemini API Documentation](https://ai.google.dev/docs)
- [React Documentation](https://react.dev)
