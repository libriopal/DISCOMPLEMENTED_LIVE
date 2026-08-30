# Custom Domain Configuration — discomplemented.com

## DNS Setup (Cloudflare)

### Required DNS Records

| Type | Name | Content | Proxy | Purpose |
|------|------|---------|-------|---------|
| A | `@` | Worker IP (auto) | Proxied | Root domain |
| AAAA | `@` | Worker IPv6 (auto) | Proxied | Root domain IPv6 |
| CNAME | `www` | `discomplemented.com` | Proxied | WWW redirect |
| CNAME | `api` | `discomplemented.com` | Proxied | API subdomain |
| CNAME | `lattice` | `discomplemented.com` | Proxied | WebSocket lattice |
| TXT | `_dmarc` | `v=DMARC1; p=reject; rua=mailto:admin@discomplemented.com` | - | Email auth |

### Cloudflare Workers Custom Domain

```toml
# Add to wrangler.toml [env.production] section:
[[env.production.routes]]
pattern = "discomplemented.com/*"
custom_domain = true

[[env.production.routes]]
pattern = "www.discomplemented.com/*"
custom_domain = true
```

### SSL/TLS Settings
- Mode: Full (strict)
- Always Use HTTPS: Yes
- Min TLS Version: 1.2
- Opportunistic Encryption: On

### Page Rules
1. `www.discomplemented.com/*` → 301 redirect to `discomplemented.com/$1`
2. `discomplemented.com/api/*` → Cache Level: Bypass (dynamic API)
3. `discomplemented.com/assets/*` → Cache Everything, Edge TTL: 1 day

### Workers Route Configuration
The Worker will handle all traffic on `discomplemented.com/*` with:
- `/api/*` → Hono API routes
- `/ws` → WebSocket upgrade for Memory Lattice
- `/*` → Static assets (React SPA)
