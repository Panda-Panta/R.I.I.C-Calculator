import { defineConfig, configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 自动适配部署路径：
// 1. 显式环境变量 BASE_URL / VITE_BASE_URL（最高优先级）
// 2. GitHub Actions 构建 GitHub Pages 时自动使用仓库名子路径（如 /R.I.I.C-Calculator/）
// 3. Vercel、本地开发以及桌面打包时保持根路径 '/'
const getBaseUrl = (): string => {
  if (process.env.BASE_URL) return process.env.BASE_URL
  if (process.env.VITE_BASE_URL) return process.env.VITE_BASE_URL
  if (process.env.GITHUB_ACTIONS === 'true') {
    const repo = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : 'R.I.I.C-Calculator'
    return `/${repo}/`
  }
  return '/'
}

export default defineConfig({
  base: getBaseUrl(),
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
      '.antigravity-bridge/**',
      'dist/**',
      'artifacts/**',
      'scratch/**',
      'validation/**',
      'release/**',
    ],
  },
})
