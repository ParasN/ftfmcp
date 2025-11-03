@echo off
echo.
echo BigQuery Chat App - Setup Script
echo ====================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js 18 or higher.
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%

if %NODE_MAJOR% LSS 18 (
    echo [ERROR] Node.js version 18 or higher is required.
    node -v
    exit /b 1
)

echo [OK] Node.js detected
node -v
echo.

where gcloud >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] gcloud CLI is not installed.
    echo    Please install it from: https://cloud.google.com/sdk/docs/install
    exit /b 1
)

echo [OK] gcloud CLI detected
echo.

echo [INFO] Checking Google Cloud authentication...
gcloud auth application-default print-access-token >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] Not authenticated with Google Cloud
    echo.
    echo Please authenticate by running:
    echo   gcloud auth application-default login
    echo.
    pause
) else (
    echo [OK] Google Cloud authenticated
)

echo.

if not exist ".env" (
    echo [INFO] Creating .env file from template...
    copy .env.example .env
    echo [OK] .env file created
    echo.
    echo [WARNING] IMPORTANT: Please edit .env file and add your:
    echo    - GCP_PROJECT_ID
    echo    - GEMINI_API_KEY
    echo.
    pause
) else (
    echo [OK] .env file already exists
)

echo.
echo [INFO] Installing dependencies...
echo.

call npm install

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install dependencies
    exit /b 1
)

echo.
echo [SUCCESS] Setup complete!
echo.
echo Next steps:
echo 1. Make sure your .env file is configured with:
echo    - GCP_PROJECT_ID
echo    - GEMINI_API_KEY
echo.
echo 2. Verify Google Cloud authentication:
echo    gcloud auth application-default login
echo.
echo 3. Start the application:
echo    npm run dev
echo.
echo 4. Open your browser to http://localhost:5173
echo.
pause
