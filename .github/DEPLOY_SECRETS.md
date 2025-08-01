# GitHub Secrets Setup for Auto-Deployment

To enable automatic deployment of Supabase Edge Functions with every push, you need to add these secrets to your GitHub repository.

## Required GitHub Secrets

1. **Go to your GitHub repository**
2. **Navigate to Settings → Secrets and variables → Actions**
3. **Click "New repository secret"** and add:

### 1. SUPABASE_ACCESS_TOKEN
- Get it from: https://supabase.com/dashboard/account/tokens
- Click "Generate new token"
- Copy and paste as secret value

sbp_58fae10b187ef930a0aafabf6482198b137990d9

### 2. SUPABASE_PROJECT_ID
- Value: `umdranpjoplxbgxkhoix`
- This is your project reference ID

### 3. OPENAI_API_KEY (Optional)
- Only if you want AI-enhanced chapter processing
- Get from: https://platform.openai.com/api-keys

## How It Works

- Every push to `main` branch that changes edge functions will trigger deployment
- Functions are automatically deployed to your Supabase project
- No manual intervention needed
- Check Actions tab in GitHub to see deployment status

## Deployment Flow

1. Push changes to `main` branch
2. GitHub Actions runs automatically
3. Deploys all edge functions in `/supabase/functions/`
4. Sets environment secrets
5. Done! Functions are live

## Monitoring

- Check deployment status: GitHub repo → Actions tab
- View function logs: Supabase Dashboard → Edge Functions → Logs