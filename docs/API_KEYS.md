# API Key Setup

Quick reference for provisioning madmcp's connector credentials. Click a button to jump straight to that provider's key-creation page, copy the generated value, then paste it into the server's env vars (Vercel/Render dashboard).

None of these providers support auto-injecting the key back into our env — you still copy/paste manually. This page just skips the "where do I even go" step.

---

### GitHub — `GITHUB_TOKEN`
[![Create GitHub Token](https://img.shields.io/badge/Create-GitHub_Token-181717?style=for-the-badge&logo=github)](https://github.com/settings/tokens/new)

### Cloudflare — `CLOUDFLARE_API_TOKEN`
[![Create Cloudflare Token](https://img.shields.io/badge/Create-Cloudflare_Token-F38020?style=for-the-badge&logo=cloudflare)](https://dash.cloudflare.com/profile/api-tokens)

### Cloudflare Account ID — `CLOUDFLARE_ACCOUNT_ID`
[![Find Cloudflare Account ID](https://img.shields.io/badge/Find-Account_ID-F38020?style=for-the-badge&logo=cloudflare)](https://dash.cloudflare.com/)
> Not a key you create — just copy it from the account overview sidebar.

### Notion — `NOTION_TOKEN`
[![Create Notion Integration](https://img.shields.io/badge/Create-Notion_Integration-000000?style=for-the-badge&logo=notion)](https://www.notion.so/my-integrations)

### Mem0 — `MEM0_API_KEY`
[![Create Mem0 API Key](https://img.shields.io/badge/Create-Mem0_API_Key-6E56CF?style=for-the-badge)](https://app.mem0.ai/dashboard/api-keys)

### Gemini — `GEMINI_API_KEY`
[![Create Gemini API Key](https://img.shields.io/badge/Create-Gemini_API_Key-4285F4?style=for-the-badge&logo=googlegemini)](https://aistudio.google.com/apikey)

### Exa — `EXA_API_KEYS`
[![Create Exa API Key](https://img.shields.io/badge/Create-Exa_API_Key-000000?style=for-the-badge)](https://dashboard.exa.ai/api-keys)
> Comma-separated list — you can generate multiple keys and combine them.

### OpenRouter — `OPENROUTER_API_KEY`
[![Create OpenRouter API Key](https://img.shields.io/badge/Create-OpenRouter_Key-6467F2?style=for-the-badge)](https://openrouter.ai/keys)

### Context7 — `CONTEXT7_API_KEY` (optional)
Works unauthenticated at low rate limits — only provision this if you're hitting limits.

### Upstash Redis / Vercel KV — `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` + `KV_REST_API_TOKEN`) (optional)
[![Create Upstash Redis](https://img.shields.io/badge/Create-Upstash_Redis-00E9A3?style=for-the-badge)](https://console.upstash.com/redis)
> Optional — persists Gemini's per-model rate-limit cooldowns and `delegate_gemini` resume checkpoints across calls. Fails open (no cross-call memory, but nothing breaks) if unset. On Vercel, easier to add via **Storage → Create Database → Upstash for Redis** (Marketplace integration) instead of the link above — either path works, just note which var names your integration hands you (the two naming pairs above are interchangeable, `connectors/gemini/cooldown.js` accepts either).

### MCP_SHARED_KEY — your own secret (not a provider credential)
[![Generate Secret](https://img.shields.io/badge/Generate-Random_Secret-333333?style=for-the-badge)](https://generate-secret.vercel.app/32)
> This one isn't issued by any provider — it's just a long random string you make up yourself, used to lock down this server's `/mcp` endpoint. The badge above is a small third-party generator (the same one NextAuth's own docs point to) that generates the string client-side and shows it to you to copy. If you'd rather not depend on an external site, run this locally instead — it never leaves your machine:
> ```
> openssl rand -hex 32
> ```

---

## ⚠️ Advanced: GitHub App credentials
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`

[![Create GitHub App](https://img.shields.io/badge/Create-GitHub_App-181717?style=for-the-badge&logo=github)](https://github.com/settings/apps/new)

This isn't a single key — it's a multi-step flow:
1. Create the App at the link above.
2. Install it on the target repo/org to get the **Installation ID**.
3. Generate and download a **private key** (`.pem`) from the App settings page.
4. Copy the **App ID** from the App's general settings.

---

## Where to paste these
Set each value as an environment variable in the deployment platform's dashboard (Vercel Project Settings → Environment Variables, or Render's dashboard for `render.yaml`-based services). All connector tokens are optional at startup — missing ones just disable that connector's tools rather than crashing the server.
