// Usage: node scripts/benchmark-recovery.ts [--seed N] [--runs N] > report.json
// Prints { report, runs }: the aggregate plus every raw run record, so results can be re-summarized and compared.
import { parseArgs } from 'node:util';
import { benchmarkRecoveryReport } from '../src/benchmark/recovery.ts';

const { values } = parseArgs({ options: { seed: { type: 'string', default: '1' }, runs: { type: 'string', default: '64' } } });
const result = await benchmarkRecoveryReport({ seed: Number(values.seed), runs: Number(values.runs) });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
