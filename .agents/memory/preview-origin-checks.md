---
name: Replit preview origin checks
description: Secure same-origin checks for API requests routed through the local Vite proxy.
---

When a browser request from the Replit preview is proxied through local Vite to the backend, the backend sees a local `Host` while the browser `Origin` is the preview domain.

**Rule:** Keep forwarded-host support enabled in the Vite proxy and accept a matching `X-Forwarded-Host` only when the request came from a loopback address. Never trust forwarded hosts from remote clients.

**Why:** Settings saves failed same-origin validation through the preview proxy. Trusting forwarded values globally would let untrusted callers spoof the app origin.

**How to apply:** When changing same-origin checks or proxy config, test that local forwarded requests pass and remote forwarded-host spoofing is rejected.
