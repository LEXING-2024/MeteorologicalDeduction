import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: {
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/publish/**'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // V1 与 V2 各自打包：v2.html 是独立入口，互不影响。
      input: {
        main: 'index.html',
        v2: 'v2.html',
        sandbox: 'sandbox.html',
      },
      output: {
        // Phaser is the bulk of the payload and changes far less often than the
        // game itself: its own chunk keeps the app chunk small and cacheable.
        manualChunks(id: string) {
          if (id.includes('node_modules/phaser')) return 'phaser';
          return undefined;
        },
      },
    },
  },
});
