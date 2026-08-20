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
