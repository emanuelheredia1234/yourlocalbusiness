import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/**
 * Dev only: published pages (/<name>, /<name>/ and /<name>/img/…) come from the server on :8787, as
 * in production. Vite answers instead when the server has no such page, isn't running, or the path
 * is one of Vite's own (/@…, /src/…, /node_modules/…) or a file in the project.
 */
function publishedPages(): Plugin {
  const name = '[a-z0-9][a-z0-9-]{1,58}[a-z0-9]';
  const page = new RegExp(`^/${name}/?$`);
  const image = new RegExp(`^/${name}/img/[^/]+$`);
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  return {
    name: 'ylb-published-pages',
    apply: 'serve',
    configureServer(server) {
      const { root, publicDir } = server.config;
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '/').split('?')[0];
        const isPage = page.test(pathname);
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (!isPage && !image.test(pathname)) return next();
        if (/^\/(@|src\/|node_modules\/)/.test(pathname) || isFile(path.join(root, pathname)) || (publicDir && isFile(path.join(publicDir, pathname)))) return next();
        const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
        // as the /api proxy does: the server tells visitors apart (its lookup limits) by the first address
        const forwardedFor = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
        let up: http.ClientRequest;
        try {
          up = http.request({ host: 'localhost', port: 8787, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': proto, 'x-forwarded-for': forwardedFor } }, (r) => {
            // the server's pages, images and "not found" page all carry a CSP; anything else (its copy of
            // the built app, for one of the app's own names) is Vite's to answer, and so is a page it doesn't have
            if (!r.headers['content-security-policy'] || (isPage && r.statusCode === 404)) {
              r.resume();
              return next();
            }
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.on('error', () => res.destroy());
            r.pipe(res);
          });
        } catch {
          // a request the server can't be asked about (Node refused its address or headers) is Vite's
          return next();
        }
        // the server isn't running (or stopped halfway through)
        up.on('error', () => (res.headersSent ? res.destroy() : next()));
        up.end();
      });
    },
  };
}

// `npm run build`           -> regular multi-file production build in dist/
// `npm run build:artifact`  -> one self-contained HTML file in dist-artifact/ (claude.ai Artifact)
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  return {
    plugins: [react(), publishedPages(), ...(artifact ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    define: {
      __ARTIFACT_BUILD__: JSON.stringify(artifact),
    },
    server: {
      port: 5173,
      // Replit serves the dev server from its own domain
      allowedHosts: process.env.REPL_ID ? true : undefined,
      // Preserve Host for same-origin checks and forward the preview host to the local API.
      proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false, xfwd: true } },
    },
    build: {
      outDir: artifact ? 'dist-artifact' : 'dist',
      target: 'es2020',
      cssCodeSplit: !artifact,
      assetsInlineLimit: artifact ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 2500,
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
    },
  };
});
