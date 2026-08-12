# Holy Pixel Wall — Vercel

## Deploy
1. Push this folder to GitHub
2. Import project at vercel.com
3. Set Environment Variables (Production):
   - STRIPE_SECRET_KEY
   - STRIPE_PUBLISHABLE_KEY (optional)
   - PUBLIC_URL=https://www.holypixelwall.com
   - ADMIN_KEY=your-secret
   - UPSTASH_REDIS_REST_URL
   - UPSTASH_REDIS_REST_TOKEN
4. Deploy

## Domain (Fasthosts)
- CNAME `www` → `cname.vercel-dns.com` (value Vercel shows)
- A `holypixelwall.com` → `76.76.21.21` (Vercel default) OR use Vercel’s exact IPs
- Add domain in Vercel → Project → Settings → Domains

## Upstash required
Vercel has no permanent disk. Claims only persist with Upstash Redis.
