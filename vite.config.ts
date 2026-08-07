import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // WHY: Chỉ chạy phân tích bundle khi có biến môi trường ANALYZE
    // Dùng: ANALYZE=true npx vite build
    process.env.ANALYZE ? visualizer({
      open: true,
      filename: process.env.ANALYZE_FORMAT === 'json' ? 'stats.json' : 'stats.html',
      template: process.env.ANALYZE_FORMAT === 'json' ? 'raw-data' : 'treemap',
      gzipSize: true,
      brotliSize: true,
    }) : null,
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    rollupOptions: {
      // WHY: Multi-page setup — widget.html là cửa sổ widget âm thanh độc lập
      input: {
        main: resolve(__dirname, 'index.html'),
        widget: resolve(__dirname, 'widget.html'),
      },
      output: {
        manualChunks: {
          // Tách React vendor riêng (react + react-dom) — chunk ổn định, ít thay đổi
          'vendor-react': ['react', 'react-dom'],
          // Tách các Tauri plugin APIs (chỉ dùng dynamic import trong app, nhưng
          // một số import tĩnh vẫn kéo vào main bundle nếu có component nào dùng)
          'vendor-tauri': ['@tauri-apps/api', '@tauri-apps/plugin-shell', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-updater', '@tauri-apps/plugin-process'],
          // Tách refractor (Prism.js) + dependencies syntax highlighting — 973 kB, chỉ dùng trong SqlQueryView
          'vendor-syntax': ['refractor', 'rehype-prism-plus', 'parse5', 'entities', 'hast-util-from-parse5', 'comma-separated-tokens'],
        },
      },
    },
    // WHY: Bật CSS tree-shaking và minify nâng cao
    cssCodeSplit: false,
    // WHY: target esnext cho modern Chromium (WebView2) — không cần transpile xuống ES5
    target: 'esnext',
    // WHY: Tăng giới hạn cảnh báo từ 500kB lên 1000kB — vendor chunks hợp lý có thể >500kB
    chunkSizeWarningLimit: 1000,
  },
})
