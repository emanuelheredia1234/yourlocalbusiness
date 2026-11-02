---
name: Dev server workflow ownership
description: Avoid duplicate local backend processes when both .replit run commands and workflows start services.
---

**Rule:** Give each long-running development service one startup owner. If the `.replit` top-level `run` starts both the API and web server while a configured workflow also starts the API, the second server can fail with `EADDRINUSE`. Keep the top-level command focused on Vite and let the backend workflow own the API, or use one combined workflow instead.

**Why:** Replit may keep the `.replit` run process alive while separately starting configured workflows, so a healthy existing API can make the workflow appear broken when it tries to bind the same port.

**How to apply:** When a workflow reports `EADDRINUSE`, inspect both `.replit` `run` and workflow commands before restarting. Confirm whether the existing process is healthy, then make one process the sole owner of that port.
