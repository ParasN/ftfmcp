# Firebase + Cloud Run Deployment

This guide mirrors the workflow you see in Firebase Studio: the frontend is deployed with Firebase Hosting, while the Node.js backend (Express API + WebSocket + MCP server) runs as a single Cloud Run service behind the Hosting rewrites.

## 1. Prerequisites

1. **Google Cloud project** with billing enabled.
2. **Firebase project** linked to the same Cloud project. In the Firebase console, open *App Hosting* (Firebase Studio) and link this repository when you are ready.
3. **APIs enabled**: Cloud Run, Artifact Registry (or Container Registry), Cloud Build, Secret Manager, BigQuery, Vertex AI/Generative AI, and Firebase Hosting.
4. **Credentials**:
   - `GCP_PROJECT_ID`
   - `GEMINI_API_KEY`
   - BigQuery access (Application Default Credentials or a service account JSON).
5. **CLI tools**: `gcloud` (with `gcloud auth login` + `gcloud config set project <id>`), `firebase-tools` (`npm install -g firebase-tools`), and Docker or Cloud Build.

## 2. Build the frontend and sync assets

```bash
npm install
npm run install:all
npm run build   # builds frontend and copies assets into backend/public
```

The `build` script runs the Vite build and copies the output into `backend/public` so that the Cloud Run container can serve the SPA for debugging (Firebase Hosting will handle production traffic).

## 3. Build & deploy the Cloud Run service

1. **Container image**
   ```bash
   gcloud builds submit \
     --tag gcr.io/PROJECT_ID/ftfmcp-backend
   ```

2. **Deploy to Cloud Run**
   ```bash
   gcloud run deploy ftfmcp-backend \
     --image gcr.io/PROJECT_ID/ftfmcp-backend \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars PORT=8080,MCP_PORT=3002,MCP_SERVER_URL=http://127.0.0.1:3002 \
     --set-env-vars GCP_PROJECT_ID=your-project-id,GEMINI_API_KEY=your-gemini-key \
     --set-env-vars GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcp-sa.json \
     --set-secrets GOOGLE_APPLICATION_CREDENTIALS=gcp-sa:latest
   ```

   - Replace `PROJECT_ID`, `your-project-id`, secret names, and regions as needed.
   - Attach a secret that contains your service account JSON with BigQuery + Vertex permissions, then mount it at `/secrets/gcp-sa.json`.
   - Cloud Run automatically injects the `PORT` environment variable; the Dockerfile defaults to `8080`.

3. **Verify**
   ```bash
   curl https://ftfmcp-backend-xxxxxx-uc.a.run.app/api/health
   ```

   You should see `{ "status": "ok", "initialized": true, ... }`.

## 4. Configure Firebase Hosting (Firebase Studio)

The repository now includes:

- `.firebaserc` – set `"default"` to your Firebase project id.
- `firebase.json` – serves `frontend/dist` and rewrites `/api/**` + `/ws` to the Cloud Run service named `ftfmcp-backend`.

Update the rewrite block if you choose a different service name or region.

1. **Login and set project**
   ```bash
   firebase login
   firebase use your-firebase-project-id
   ```

2. **Build the frontend for hosting**
   ```bash
   npm run build
   ```

3. **Deploy Hosting**
   ```bash
   firebase deploy --only hosting
   ```

   Firebase Hosting uploads `frontend/dist`. Requests to `/api/**` and `/ws` are proxied to Cloud Run, so the React app can call the API and open the WebSocket without knowing the service URL.

## 5. Using Firebase Studio

In Firebase Studio (App Hosting) you can now:

1. Connect this GitHub repository.
2. Configure build steps:
   - Install: `npm install && npm run install:all`
   - Build: `npm run build`
   - Deploy: `firebase deploy --only hosting`
   - Cloud Run deploys happen through Cloud Build/GitHub Actions; point the workflow at the included `Dockerfile`.
3. Provide the same environment variables/secrets defined above. Firebase Studio can inject them as build secrets or runtime configs.

Once the pipeline finishes, you get a Firebase Hosting URL (and optionally your custom domain) that serves the SPA, while backend traffic stays in Cloud Run.

## 6. Runtime configuration checklist

| Variable | Where | Description |
| --- | --- | --- |
| `GCP_PROJECT_ID` | Cloud Run | BigQuery project id |
| `GEMINI_API_KEY` | Cloud Run | Gemini API key |
| `GOOGLE_APPLICATION_CREDENTIALS` | Cloud Run | Path to mounted service-account JSON |
| `MCP_PORT` | Cloud Run | Leave at `3002` inside the container |
| `MCP_SERVER_URL` | Cloud Run | `http://127.0.0.1:3002` so the backend can reach the MCP process |
| `WEBSOCKET_PATH` | Cloud Run (optional) | Defaults to `/ws`; must match Firebase rewrite & frontend |
| `FRONTEND_URL` | Optional | If used in CORS/webhooks |

## 7. Post-deployment tasks

- Add your custom domain in Firebase Hosting and provision HTTPS.
- Verify `/api/health` and the chat UI on Hosting.
- Monitor Cloud Run logs (`gcloud logs tail --service=ftfmcp-backend`).
- Rotate secrets via Secret Manager and redeploy when credentials change.

With these files committed, you can import the repo inside Firebase Studio, point builds at `firebase.json`/`Dockerfile`, and ship demos without hand-configuring infrastructure each time.
