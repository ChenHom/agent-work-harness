// 測試不需要真的 Docker：在 PATH 最前面放一個 Node 寫的 `docker`，處理 image inspect、run、kill，
// 並把收到的 argv 與環境變數名稱記下來（做法同 Reviewer 的 tests/cli/docker-review.test.js）。
// 設定放在 stub 旁邊的 config.json —— runner 只傳白名單環境變數，stub 讀不到測試自訂的 env。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_IMAGE_ID = `sha256:${'6'.repeat(64)}`;
export const STUB_REVISION = '2d84ad61ec635db110bd5d1fe16fdce7cac3d64f';

export interface DockerStubConfig {
  inspect?: 'ok' | 'fail' | 'no-label';
  /** report：寫入 reportText（__BASE__／__HEAD__ 換成 argv 的值）；symlink：report.json 指向 /output 外的合法報表；hang：等到被 kill。 */
  run?: 'report' | 'exit' | 'hang' | 'no-report' | 'symlink';
  reportText?: string;
  exitCode?: number;
  stderr?: string;
  /** run 期間對 Harness DB 執行的 SQL，用來製造審查期間的變化（REVIEW_STALE）。 */
  sql?: { db: string; statement: string };
}

export interface DockerCall { argv: string[]; envKeys: string[] }

const STUB = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, envKeys: Object.keys(process.env) }) + '\\n');
const after = (flag) => argv[argv.indexOf(flag) + 1];
if (argv[0] === 'image' && argv[1] === 'inspect') {
  if (cfg.inspect === 'fail') { process.stderr.write('Error: No such image: ' + argv.at(-1) + '\\n'); process.exit(1); }
  process.stdout.write(${JSON.stringify(STUB_IMAGE_ID)} + '|' + (cfg.inspect === 'no-label' ? '<no value>' : ${JSON.stringify(STUB_REVISION)}) + '\\n');
  process.exit(0);
}
if (argv[0] === 'kill') {
  const pidFile = path.join(dir, 'run-' + argv[1] + '.pid');
  if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
  process.exit(0);
}
if (argv[0] === 'run') {
  fs.writeFileSync(path.join(dir, 'run-' + after('--name') + '.pid'), String(process.pid));
  const volume = argv.find((arg) => arg.endsWith(':/output:rw'));
  const out = path.join(volume.slice(0, -':/output:rw'.length), 'report.json');
  if (cfg.sql) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(cfg.sql.db);
    db.exec(cfg.sql.statement);
    db.close();
  }
  const mode = cfg.run ?? 'report';
  if (mode === 'hang') { setTimeout(() => {}, 60000); return; }
  if (mode === 'exit') { process.stderr.write(cfg.stderr ?? ''); process.exit(cfg.exitCode ?? 1); }
  const text = () => cfg.reportText.replaceAll('__BASE__', after('--base')).replaceAll('__HEAD__', after('--head'));
  if (mode === 'symlink') {
    // 合法的報表放在 /output 以外：只有不跟隨 symlink 才擋得住
    const outside = path.join(dir, 'outside-report.json');
    fs.writeFileSync(outside, text());
    fs.symlinkSync(outside, out);
    process.exit(0);
  }
  if (mode === 'report') fs.writeFileSync(out, text());
  process.stdout.write('review done\\n');
  process.exit(0);
}
process.stderr.write('stub docker: unsupported ' + argv.join(' ') + '\\n');
process.exit(64);
`;

export interface DockerStub {
  dir: string;
  configure(config: DockerStubConfig): void;
  calls(): DockerCall[];
  reset(): void;
}

/** 安裝 stub 並把它放到 process.env.PATH 最前面。 */
export function installDockerStub(dir: string): DockerStub {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'docker'), STUB, { mode: 0o755 });
  writeFileSync(join(dir, 'config.json'), '{}');
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
  const callsPath = join(dir, 'calls.jsonl');
  return {
    dir,
    configure(config) { writeFileSync(join(dir, 'config.json'), JSON.stringify(config)); },
    calls() {
      if (!existsSync(callsPath)) return [];
      return readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as DockerCall);
    },
    reset() { writeFileSync(callsPath, ''); },
  };
}
