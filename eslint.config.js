import tseslint from 'typescript-eslint';

// tsc --noEmit 已經管型別；ESLint 在這裡只補型別檢查看不到的兩類：
// 1. 非同步呼叫忘了 await —— 整條 attempt 流程都是 async，漏一個 await 會讓
//    evidence 收集或落地靜默跳過，是 fail-open。
// 2. 架構界線 —— 見下方 no-restricted-imports。22 個檔案 0 循環，
//    不值得為此再裝 dependency-cruiser（見 DECISIONS D-30）。
export default tseslint.config({
  ignores: ['.stryker-tmp/**', '.spike/**', 'reports/**'],
}, {
  files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
  extends: tseslint.configs.recommendedTypeChecked,
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  rules: {
    // 型別檢查已涵蓋，或與本專案寫法衝突的，關掉免得吵
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/require-await': 'off',
  },
}, {
  // 架構界線一：外部程序只能從三個檔案啟動。
  // 其他地方要跑東西一律走 evidence/exec.ts 的 runIsolated —— 否則就是繞過沙箱。
  // review/docker-runner.ts 是 Reviewer 的受信任 runner：Docker 無法在 bwrap 內啟動，
  // 所以它只能執行 `docker`、argv 由程式固定組裝、shell: false（DECISIONS D-42）。
  // 兩條界線用兩個不同的 rule：flat config 裡同一個 rule 的設定後者會整個蓋掉前者，
  // 共用 no-restricted-imports 時界線二會讓下層目錄失去界線一（第一輪審查 M4）。
  files: ['src/**/*.ts'],
  ignores: ['src/evidence/exec.ts', 'src/runtime/codex-driver.ts', 'src/review/docker-runner.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: ['node:child_process', 'child_process'].map((name) => ({
        name,
        message: '外部程序只能由 evidence/exec.ts、runtime/codex-driver.ts 或 review/docker-runner.ts 啟動；其他地方請用 runIsolated()。',
      })),
    }],
  },
}, {
  // 架構界線二：orchestrator 是最上層，下層模組不得回頭 import 它。
  files: ['src/context/**', 'src/evidence/**', 'src/prompt/**', 'src/repo/**', 'src/review/**',
          'src/runtime/**', 'src/security/**', 'src/trace/**', 'src/work/**'],
  rules: {
    '@typescript-eslint/no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/orchestrator.ts', '**/orchestrator.js'],
        message: 'orchestrator 是最上層；下層模組回頭 import 它就會產生循環依賴。',
      }],
    }],
  },
}, {
  // node:test 的 test() 回傳 Promise，但 top-level 本來就不該 await 它 ——
  // runner 自己會收。在測試檔開這條規則只會得到滿螢幕的假陽性。
  files: ['test/**/*.ts'],
  rules: { '@typescript-eslint/no-floating-promises': 'off' },
});
