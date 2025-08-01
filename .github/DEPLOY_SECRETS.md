# GitHub Secrets Setup for Auto-Deployment

To enable automatic deployment of Supabase resources (database migrations and edge functions) with every push, you need to add these secrets to your GitHub repository.

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

- Every push to `main` branch that changes migrations or edge functions will trigger deployment
- Database migrations are deployed first, then edge functions
- Both resources are automatically deployed to your Supabase project
- No manual intervention needed
- Check Actions tab in GitHub to see deployment status
- Comprehensive error handling and status reporting included

## Deployment Flow

1. Push changes to `main` branch
2. GitHub Actions runs automatically
3. Checks for new database migrations in `/supabase/migrations/`
4. Deploys migrations first (if any exist)
5. Checks for edge functions in `/supabase/functions/`
6. Deploys edge functions (if any exist)
7. Configures function secrets (OpenAI API key)
8. Provides deployment summary with status
9. Done! All resources are live

## Monitoring

- Check deployment status: GitHub repo → Actions tab
- View migration history: Supabase Dashboard → Database → Migrations
- View function logs: Supabase Dashboard → Edge Functions → Logs
- Each deployment provides a detailed summary of what was deployed

## Supported File Changes

The workflow triggers on changes to:
- `supabase/migrations/**` - Database schema changes
- `supabase/functions/**` - Edge function code
- `.github/workflows/deploy-supabase.yml` - Workflow configuration

## Error Handling

- Migrations are deployed before functions to ensure schema compatibility
- If migrations fail, the workflow stops and functions are not deployed
- If functions fail, migrations remain applied
- Detailed error messages and exit codes help with debugging
- Secrets configuration failures are treated as warnings, not errors