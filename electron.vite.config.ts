import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { rollupOptions: { input: 'src/main/index.ts' } } },
  preload: { build: { rollupOptions: { input: 'src/preload/index.ts', output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { root: 'src/renderer', build: { rollupOptions: { input: { index: 'src/renderer/index.html', gallery: 'src/renderer/gallery.html' } } } }
})
