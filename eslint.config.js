import tseslint from 'typescript-eslint';

// tsc --noEmit 已經管型別；ESLint 在這裡只補型別檢查看不到的那一類 ——
// 主要是「非同步呼叫忘了 await」。這個專案整條 attempt 流程都是 async，
// 漏掉一個 await 會讓 evidence 收集或落地靜默跳過，是 fail-open。
export default tseslint.config({
  files: ['src/**/*.ts', 'test/**/*.ts'],
  extends: tseslint.configs.recommendedTypeChecked,
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  rules: {
    // 型別檢查已涵蓋，或與本專案寫法衝突的，關掉免得吵
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/require-await': 'off',
  },
}, {
  // node:test 的 test() 回傳 Promise，但 top-level 本來就不該 await 它 ——
  // runner 自己會收。在測試檔開這條規則只會得到滿螢幕的假陽性。
  files: ['test/**/*.ts'],
  rules: { '@typescript-eslint/no-floating-promises': 'off' },
});
