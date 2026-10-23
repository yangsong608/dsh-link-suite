import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [uni()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 协议包直接用源码，避免"改了协议忘了构建"这类跨工程问题
      '@dsh-link/protocol': fileURLToPath(new URL('../shared/protocol/src/index.ts', import.meta.url)),
    },
  },
})
