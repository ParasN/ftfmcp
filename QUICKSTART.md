# Quick Start Guide

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] Node.js 18+ installed
- [ ] Google Cloud SDK (gcloud CLI) installed
- [ ] A Google Cloud Platform project with BigQuery enabled
- [ ] Google Cloud authentication configured
- [ ] A Gemini API key from Google AI Studio

## Quick Setup (5 minutes)

### 1. Install Google Cloud SDK

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
Download from: https://cloud.google.com/sdk/docs/install

### 2. Authenticate with Google Cloud

```bash
gcloud auth application-default login
```

This opens a browser for authentication. Optionally set your project:

```bash
gcloud config set project YOUR_PROJECT_ID
```

### 3. Install Dependencies

**On macOS/Linux:**
```bash
chmod +x setup.sh
./setup.sh
```

### 4. Configure Environment

Create `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
GCP_PROJECT_ID=your-project-id
GEMINI_API_KEY=your-gemini-api-key
```

### 5. Start the App

```bash
npm run dev
```

This starts:
- **Backend** on http://localhost:3001
- **Frontend** on http://localhost:5173

### 6. Open in Browser

Navigate to: http://localhost:5173

## Getting Your Credentials

### GCP Project ID

1. Go to https://console.cloud.google.com
2. Select your project from the dropdown at the top
3. The project ID is shown in the project info card

Or use the CLI:
```bash
gcloud config get-value project
```

### Google Cloud Authentication

Simply run:
```bash
gcloud auth application-default login
```

This authenticates you and stores credentials locally. The app will automatically use these credentials.

### Gemini API Key
## Verify Setup

After starting the app:

1. Check the backend logs for:
   ```
   🔐 Using Google Cloud Application Default Credentials
   ✓ BigQuery client initialized
   ✓ Agentic orchestrator initialized
   🚀 BigQuery Chat Server running on http://localhost:3001
   ```

2. Check the frontend shows "Connected" status (green dot)

3. Try asking: "What datasets do I have?"

## Troubleshooting

### Backend won't start
- Check `.env` file exists and has all required values
- Verify you're authenticated: `gcloud auth application-default login`
- Check Node.js version: `node -v` (must be 18+)

### "Service not initialized" error
- Verify GCP_PROJECT_ID is correct
- Run: `gcloud auth application-default login`
- Ensure BigQuery API is enabled: `gcloud services enable bigquery.googleapis.com`

### Frontend shows "Disconnected"
- Ensure backend is running on port 3001
- Check browser console for errors
- Verify CORS settings in backend

### Authentication errors
- Run: `gcloud auth application-default login`
- Verify you have BigQuery permissions (BigQuery Data Viewer role or higher)
- Check you're using the correct project: `gcloud config get-value project`

### No datasets found
- Ensure your GCP project has BigQuery datasets
- Verify you have permission to view datasets
- Try creating a test dataset in BigQuery console

### Frontend shows "Disconnected"
- Ensure backend is running on port 3001
- Check browser console for errors
- Verify CORS settings in backend


### No datasets found
- Ensure your GCP project has BigQuery datasets
- Verify you have permission to view datasets
- Try creating a test dataset in BigQuery console


## Example Queries to Try

Once connected, try these questions:

1. "What datasets do I have?"
2. "Show me the tables in [dataset_name]"
3. "What's the schema of [table_name]?"
4. "How many rows are in [table_name]?"
5. "Show me the first 10 rows from [table_name]"
6. "What are the column names and types in [table_name]?"

## Next Steps

- Read the full [README.md](README.md) for detailed documentation
- Explore the code in `backend/src/` to understand the architecture
- Customize the UI in `frontend/src/App.jsx` and `frontend/src/App.css`
- Add new BigQuery functions in `backend/src/bigquery.js`

## Need Help?

- Check the [README.md](README.md) for detailed documentation
- Review [Google BigQuery Docs](https://cloud.google.com/bigquery/docs)
- Review [Gemini API Docs](https://ai.google.dev/docs)
