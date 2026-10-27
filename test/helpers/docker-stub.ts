// 測試不需要真的 Docker：在 PATH 最前面放一個 Node 寫的 `docker`，處理 image inspect、run、kill，
// 並把收到的 argv 與環境變數名稱記下來（做法同 Reviewer 的 tests/cli/docker-review.test.js）。
// 設定放在 stub 旁邊的 config.json —— runner 只傳白名單環境變數，stub 讀不到測試自訂的 env。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_IMAGE_ID = `sha256:${'6'.repeat(64)}`;
export const STUB_REVISION = '2d84ad61ec635db110bd5d1fe16fdce7cac3d64f';

export interface DockerStubConfig {
  inspect?: 'ok' | 'fail' | 'no-label';
  /**
   * report：寫入 reportText（__BASE__／__HEAD__ 換成 argv 的值）；symlink：report.json 指向 /output 外的合法報表；hang：等到被 kill；
   * derive：扮演 Reviewer 看到的變更 —— 以 container 收到的 `-e` 環境，在 /target 對應的 Host 路徑上執行 Reviewer 同一組
   * `git merge-base` 與 `git diff --raw -z --no-abbrev -M`，每個變更都列為需要人工（離線、沒有 fact layer 時的 FULL）。
   */
  run?: 'report' | 'exit' | 'hang' | 'no-report' | 'symlink' | 'derive';
  reportText?: string;
  exitCode?: number;
  stderr?: string;
  /** run 期間對 Harness DB 執行的 SQL，用來製造審查期間的變化（REVIEW_STALE）。 */
  sql?: { db: string; statement: string };
  /** run 期間把 review-work 目錄設成唯讀，讓暫存目錄刪不掉（清理失敗只能是警告）。 */
  lockReviewWork?: boolean;
}

export interface DockerCall { argv: string[]; envKeys: string[] }

const STUB = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const dir = path.dirname(process.argv[1]);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, envKeys: Object.keys(process.env) }) + '\\n');
const after = (flag) => argv[argv.indexOf(flag) + 1];
// 掛載的 Host 路徑：支援 -v src:dst:mode 與 --mount type=bind,src=…,dst=…[,readonly]
const mountSource = (dst) => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-v' && argv[i + 1].split(':')[1] === dst) return argv[i + 1].split(':')[0];
    if (argv[i] === '--mount') {
      const fields = Object.fromEntries(argv[i + 1].split(',').map((field) => field.split('=')));
      if (fields.dst === dst) return fields.src;
    }
  }
  throw new Error('stub docker: no mount for ' + dst);
};
function derivedReport() {
  const env = { PATH: process.env.PATH, HOME: fs.mkdtempSync(path.join(dir, 'home-')) };
  argv.forEach((arg, i) => { if (argv[i - 1] === '-e') env[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1); });
  const git = (...args) => cp.execFileSync('git', ['-C', mountSource('/target'), ...args], { env, encoding: 'utf8' });
  const base = after('--base');
  const head = after('--head');
  const mergeBase = git('merge-base', base, head).trim();
  const fields = git('diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', mergeBase, head).split('\\0');
  const paths = [];
  for (let i = 0; i < fields.length;) {
    if (!fields[i]) { i++; continue; }
    const two = / [RC]\\d*$/.test(fields[i]);
    paths.push(fields[i + (two ? 2 : 1)]);
    i += two ? 3 : 2;
  }
  fs.writeFileSync(path.join(dir, 'derived.json'), JSON.stringify(paths));
  const files = paths.map((p) => ({
    path: p, status: 'M', contentHash: 'git:' + '0'.repeat(40), analyzed: true, decision: 'HUMAN_REVIEW_REQUIRED',
    fallback: 'FULL', reasons: ['FILE_CHANGED'], facts: [], changedLines: [], track: 'AI_TRACK', oneWayDoors: [],
    findings: [], needsHuman: true,
  }));
  const n = files.length;
  return JSON.stringify({
    repository: 'repo', base: { ref: base, sha: base }, head: { ref: head, sha: head }, mergeBase,
    config: { path: '.reviewer.json', commit: mergeBase, status: 'MISSING', errors: [], digest: 'd'.repeat(64) },
    decision: {
      status: n ? 'HUMAN_REVIEW_REQUIRED' : 'NOT_SELECTED_FOR_HUMAN_REVIEW', reasons: n ? ['FILE_CHANGED'] : ['NO_CHANGES'],
      files: n, notSelected: 0, targeted: 0, full: n,
    },
    routing: { track: n ? 'AI_TRACK' : 'AUTO_PASS', autoPass: 0, aiTrack: n, escalated: 0 },
    ai: null, human: { required: n > 0, files: n, findings: 0, pendingFixes: 0 }, files,
  });
}
if (argv[0] === 'image' && argv[1] === 'inspect') {
  if (cfg.inspect === 'fail') { process.stderr.write('Error: No such image: ' + argv.at(-1) + '\\n'); process.exit(1); }
  process.stdout.write(${JSON.stringify(STUB_IMAGE_ID)} + '|' + (cfg.inspect === 'no-label' ? '<no value>' : ${JSON.stringify(STUB_REVISION)}) + '\\n');
  process.exit(0);
}
if (argv[0] === 'rm') process.exit(0);
if (argv[0] === 'kill') {
  const pidFile = path.join(dir, 'run-' + argv[1] + '.pid');
  if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
  process.exit(0);
}
if (argv[0] === 'run') {
  fs.writeFileSync(path.join(dir, 'run-' + after('--name') + '.pid'), String(process.pid));
  const out = path.join(mountSource('/output'), 'report.json');
  if (cfg.lockReviewWork) fs.chmodSync(path.dirname(path.dirname(mountSource('/output'))), 0o500);
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
  if (mode === 'derive') fs.writeFileSync(out, derivedReport());
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
