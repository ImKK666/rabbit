import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import type { UserConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import { FileSystemIconLoader } from 'unplugin-icons/loaders'
import IconsResolver from 'unplugin-icons/resolver'
import Components from 'unplugin-vue-components/vite'

// https://vitejs.dev/config/
export default defineConfig({
  base: '',
  plugins: [
    vue(),
    Components({
      dirs: [],
      resolvers: [
        IconsResolver({
          prefix: 'i',
          customCollections: ['custom'],
        }),
      ],
    }),
    Icons({
      compiler: 'vue3',
      autoInstall: false, 
      customCollections: {
        custom: FileSystemIconLoader('src/assets/icons'),
      },
      scale: 1,
      defaultClass: 'i-icon',
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `
          @import '@/assets/styles/variable.scss';
          @import '@/assets/styles/mixin.scss';
        `
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 后端直接 import 前端的 types / configs / utils（见 06-backend.md），
      // 跑 server 单测时同样要能解析
      '@server': fileURLToPath(new URL('./server/src', import.meta.url)),
    }
  },
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'server/src/**/__tests__/**/*.test.ts',
    ],
    exclude: ['refs/**', 'node_modules/**'],
  } satisfies UserConfig['test'],
})
