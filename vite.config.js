import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // 警告が出るサイズ制限を 500kb -> 1000kb に引き上げて警告を消す
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // 大きなライブラリを別のファイルに分割する設定
        manualChunks: {
          // React本体を分離
          'react-vendor': ['react', 'react-dom'],
          // グラフライブラリ（これが一番重い）を分離
          'recharts': ['recharts'],
          // アイコンライブラリを分離
          'icons': ['lucide-react'],
        },
      },
    },
  },
})
