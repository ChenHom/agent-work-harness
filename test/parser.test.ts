import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, normalizePath } from '../src/work/parser.ts';

test('read-only 語句 → mode read', () => {
  assert.equal(parseRequest('只看不要改，找出原因').mode, 'read');
  assert.equal(parseRequest('read-only investigation please').mode, 'read');
  assert.equal(parseRequest('修一下登入 bug').mode, 'write');
});

test('不要碰 X → deniedPaths', () => {
  const p = parseRequest('找出登入偶發 500，可以修就修，但不要碰 payment，也不要部署。');
  assert.deepEqual(p.deniedPaths, ['payment/**']);
  assert.deepEqual(p.constraints, ['不要部署']);
  assert.equal(p.mode, 'write');
  assert.equal(p.allowedPaths, undefined); // §20.1：沒明確限定 → 不產生假的 allowlist
});

test('只改 X → allowedPaths；可以改 X → 只是授權', () => {
  const only = parseRequest('只改 src/auth/');
  assert.deepEqual(only.allowedPaths, ['src/auth/**']);
  const allow = parseRequest('可以改 src/token，但不要碰 payment/');
  assert.equal(allow.allowedPaths, undefined);
  assert.deepEqual(allow.allowPathDecisions, ['src/token/**']);
  assert.deepEqual(allow.deniedPaths, ['payment/**']);
});

test('normalizePath 區分檔案與目錄', () => {
  assert.equal(normalizePath('src/auth'), 'src/auth/**');
  assert.equal(normalizePath('src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('payment/'), 'payment/**');
  assert.equal(normalizePath('src/**'), 'src/**');
});

test('不解析自然語言語意，只保留原文 constraint', () => {
  const p = parseRequest('改動不要太大，優先沿用現在架構');
  assert.deepEqual(p.deniedPaths, []);
  assert.equal(p.constraints.length, 0); // 不硬拆；由 caller 原文保留
});

test('「不要改動 X」是限制，不是 read-only 宣告（dogfood W1 回歸）', () => {
  const w1 = parseRequest('harness list 目前只印 work id / state / repo / title，看不出上一次的判定結果。請讓它同時顯示最後一次 outcome。不要改動其他指令的輸出格式，npm test 與 typecheck 必須通過。');
  assert.equal(w1.mode, 'write');
  assert.equal(parseRequest('修 bug，但不要修改 public API').mode, 'write');
  assert.equal(parseRequest('please fix it, but don\'t change the CLI output').mode, 'write');
});

test('整體性的 read-only 宣告仍然生效', () => {
  for (const s of ['只看不要改', '不要改，先幫我分析', '這次不要修改。只要找原因', 'read-only 調查',
                   '不要修改任何檔案', 'just investigate the failure', "don't modify anything"]) {
    assert.equal(parseRequest(s).mode, 'read', `應判為 read: ${s}`);
  }
});
