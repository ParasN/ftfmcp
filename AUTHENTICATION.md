# Authentication Guide

This application uses **Google Cloud Application Default Credentials (ADC)** for BigQuery authentication. This is more secure and convenient than managing service account key files.

## Why Application Default Credentials?

✅ **No JSON key files to manage** - Credentials are stored securely by gcloud  
✅ **Works seamlessly in development** - Authenticate once, use everywhere  
✅ **Production ready** - Works with Workload Identity on GKE, Cloud Run, etc.  
✅ **Secure** - No risk of accidentally committing credentials to git  
✅ **Easy rotation** - Re-authenticate anytime with one command  

## Setup Authentication

### One-Time Setup

1. **Install Google Cloud SDK** (if not already installed):

   **macOS:**
   ```bash
   brew install google-cloud-sdk
   ```

   **Linux:**
   ```bash
   curl https://sdk.cloud.google.com | bash
   exec -l $SHELL
   ```

   **Windows:**
   Download from https://cloud.google.com/sdk/docs/install

2. **Authenticate with your Google account:**

   ```bash
   gcloud auth application-default login
   ```

   This opens a browser window where you log in with your Google account. The credentials are stored locally and used automatically by the BigQuery client.

3. **Set your default project** (optional but recommended):

   ```bash
   gcloud config set project YOUR_PROJECT_ID
   ```

That's it! The application will now automatically use your credentials.

## Required Permissions

Your Google Cloud account needs these permissions:

- **BigQuery Data Viewer** - To view datasets and table schemas
- **BigQuery Job User** - To run queries

Or use the predefined role:
- **BigQuery User** - Includes both permissions above

## How It Works

When you run the application:

1. The BigQuery client looks for credentials in this order:
   - Environment variable `GOOGLE_APPLICATION_CREDENTIALS` (if set)
   - Application Default Credentials (what we're using)
   - Compute Engine/GKE service account (in production)

2. It uses the credentials stored by `gcloud auth application-default login`

3. No code changes needed for production - it automatically uses the right credentials in Cloud Run, GKE, etc.

## Common Commands

### Check current authentication
```bash
gcloud auth application-default print-access-token
```

### View current project
```bash
gcloud config get-value project
```

### Switch projects
```bash
gcloud config set project ANOTHER_PROJECT_ID
```

### Revoke credentials
```bash
gcloud auth application-default revoke
```

### Re-authenticate
```bash
gcloud auth application-default login
```

## Production Deployment

### Cloud Run / App Engine / Cloud Functions
No additional setup needed! These services automatically provide credentials via the service account attached to the resource.

### Google Kubernetes Engine (GKE)
Use Workload Identity:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  GSA_NAME@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:PROJECT_ID.svc.id.goog[NAMESPACE/KSA_NAME]"
```

### Compute Engine / VM
The VM's service account is automatically used.

### Outside Google Cloud
For production deployments outside Google Cloud, you can:

1. Use service account impersonation
2. Set `GOOGLE_APPLICATION_CREDENTIALS` to point to a service account key
3. Use Workload Identity Federation

## Troubleshooting

### "Could not load the default credentials"

Run:
```bash
gcloud auth application-default login
```

### "Permission denied" errors

Check your permissions:
```bash
gcloud projects get-iam-policy YOUR_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:user:YOUR_EMAIL"
```

Add required roles if needed:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:YOUR_EMAIL" \
  --role="roles/bigquery.user"
```

### "API not enabled"

Enable the BigQuery API:
```bash
gcloud services enable bigquery.googleapis.com
```

### Credentials from wrong account/project

Revoke and re-authenticate:
```bash
gcloud auth application-default revoke
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

## Security Best Practices

✅ **DO**:
- Use Application Default Credentials for development
- Use Workload Identity in GKE
- Use service accounts attached to Cloud Run/Functions/App Engine
- Regularly review IAM permissions
- Use the principle of least privilege

❌ **DON'T**:
- Commit credentials to git (even though we don't use key files now)
- Share your local credentials with others
- Use personal credentials in production
- Grant overly broad permissions

## Further Reading

- [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
- [BigQuery Access Control](https://cloud.google.com/bigquery/docs/access-control)
- [Workload Identity](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
- [Best Practices for Application Authentication](https://cloud.google.com/docs/authentication/best-practices-applications)
