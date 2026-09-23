// Usage: node scripts/benchmark-recovery.ts [--seed N] [--runs N] > report.json
// Prints { report, runs }: the aggregate plus every raw run record, so results can be re-summarized and compared.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runRecoveryBenchmark, summarizeRecoveryBenchmark } from '../src/benchmark/recovery.ts';

const { values } = parseArgs({ options: { seed: { type: 'string', default: '1' }, runs: { type: 'string', default: '64' } } });
const stateDir = mkdtempSync(join(tmpdir(), 'harness-recovery-bench-'));
try {
  const { manifest, runs } = await runRecoveryBenchmark({ stateDir, seed: Number(values.seed), runs: Number(values.runs) });
  process.stdout.write(`${JSON.stringify({ report: summarizeRecoveryBenchmark(manifest, runs), runs }, null, 2)}\n`);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
