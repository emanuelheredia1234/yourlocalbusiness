import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

// `npm run build`           -> regular multi-file production build in dist/
// `npm run build:artifact`  -> one self-contained HTML file in dist-artifact/ (claude.ai Artifact)
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  return {
    plugins: [react(), ...(artifact ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    define: {
      __ARTIFACT_BUILD__: JSON.stringify(artifact),
    },
    server: {
      port: 5173,
      proxy: { '/api': 'http://localhost:8787' },
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
