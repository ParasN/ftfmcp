#!/bin/bash

echo "🚀 BigQuery Chat App - Setup Script"
echo "===================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18 or higher."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18 or higher is required. Current version: $(node -v)"
    exit 1
fi

echo "✓ Node.js $(node -v) detected"
echo ""

if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI is not installed."
    echo "   Please install it from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

echo "✓ gcloud CLI detected"
echo ""

echo "🔐 Checking Google Cloud authentication..."
if ! gcloud auth application-default print-access-token &> /dev/null; then
    echo "⚠️  Not authenticated with Google Cloud"
    echo ""
    echo "Please authenticate by running:"
    echo "  gcloud auth application-default login"
    echo ""
    read -p "Press Enter after you've authenticated..."
else
    echo "✓ Google Cloud authenticated"
fi

echo ""

if [ ! -f ".env" ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "✓ .env file created"
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env file and add your:"
    echo "   - GCP_PROJECT_ID"
    echo "   - GEMINI_API_KEY"
    echo ""
    read -p "Press Enter after you've configured .env file..."
else
    echo "✓ .env file already exists"
fi

echo ""
echo "📦 Installing dependencies..."
echo ""

npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Make sure your .env file is configured with:"
echo "   - GCP_PROJECT_ID"
echo "   - GEMINI_API_KEY"
echo ""
echo "2. Verify Google Cloud authentication:"
echo "   gcloud auth application-default login"
echo ""
echo "3. Start the application:"
echo "   npm run dev"
echo ""
echo "4. Open your browser to http://localhost:5173"
echo ""
