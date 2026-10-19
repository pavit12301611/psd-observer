# Observer AI Status Page

A real-time status monitoring dashboard for Observer AI models.

## Features

- Real-time model status monitoring
- 24-hour uptime visualization
- Auto-refresh every 60 seconds
- Dark theme UI inspired by modern status pages
- Graceful error handling

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Deployment to Cloudflare Pages

### Method 1: Automatic GitHub Deployment

1. Go to Cloudflare Pages dashboard
2. Create a new project
3. Connect your GitHub repository
4. Configure build settings:
   - **Build command**: `cd websites/status && npm install && npm run build`
   - **Build output directory**: `websites/status/dist`
   - **Root directory**: `/` (or leave empty)

### Method 2: Manual Deployment

```bash
# Build the project
npm run build

# Deploy using Wrangler (if you have it installed)
npx wrangler pages deploy dist
```

## API Endpoint

The status page fetches data from:
```
https://api.observer-ai.com/status
```

### Expected Response Format

```json
{
  "checked_at": "2025-10-22T17:13:54.606768",
  "window_hours": 24,
  "models": [
    {
      "name": "model-name",
      "overall_success_rate": 100.0,
      "hourly_stats": [
        {
          "hour": "2025-10-22T17:00:00",
          "success_rate": 100.0
        }
      ]
    }
  ]
}
```

## Tech Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
