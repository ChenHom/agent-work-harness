import { tmpdir } from 'node:os';
import { runIsolated } from '../src/evidence/exec.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';

/**
 * 需要真實跑 bwrap 的測試，在 verification 自己的隔離環境中跑不起來（巢狀 sandbox）。
 * probe 走與測試相同的執行路徑才不會漏判。
 */
const probe = await runIsolated(DEFAULT_POLICY, ['git', '--version'], { workspace: tmpdir(), timeoutMs: 20_000 });
export const skipWithoutSandbox: false | string =
  probe.exitCode === 0 ? false : '隔離執行不可用（多半是巢狀 bwrap），本測試需要未隔離的環境';
