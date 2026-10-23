import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Godot 联调需要启动真实引擎进程，单条用例可能超过默认 5 秒
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // 联调用例会启动真实 Godot 进程并占用固定端口（TCP 47821 / UDP 47820），
    // 并发跑多个测试文件会互相抢端口、互相看到对方的请求，必须串行
    fileParallelism: false
  }
})
