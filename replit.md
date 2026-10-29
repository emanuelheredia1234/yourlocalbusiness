# Running this project on Replit

- The workspace preview runs the Vite app on port 5000 with `npm run dev -- --host 0.0.0.0 --port 5000`.
- The `Start application` workflow runs the API and production static-file server with `npm run server` on port 8787. Vite proxies `/api` requests to it.
- Publishing builds with `npm run build` and runs `node server/ai-server.mjs`; the server serves the generated `dist/` files.
- `ANTHROPIC_API_KEY` is needed for Claude-powered generation. The app can start without it; image generation also needs a separately configured image-provider key.
