import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DurableCallback, DurableContinueAsNewInput, DurableWorkflowInput, DurableWorkflowSnapshot,
} from '../src/durable/contracts.ts';
import {
  applyDurableCallback, buildContinueAsNewInput, createCallbackInbox,
} from '../src/durable/signals.ts';

function callback(overrides: Partial<DurableCallback> = {}): DurableCallback {
  return {
    eventId: 'event-1', sourceVersion: 3, sequence: 10,
    operationId: 'operation-1', receiptRef: 'provider:receipt-1',
    ...overrides,
  };
}

test('callback inbox accepts one transition and ignores duplicates and stale delivery', () => {
  let inbox = createCallbackInbox();
  inbox = applyDurableCallback(inbox, callback(), 'operation-1', 3, 8);
  assert.equal(inbox.acceptedTransitionCount, 1);
  assert.equal(inbox.acceptedEventId, 'event-1');
  assert.equal(inbox.acceptedReceiptRef, 'provider:receipt-1');

  inbox = applyDurableCallback(inbox, callback(), 'operation-1', 3, 8);
  inbox = applyDurableCallback(inbox, callback({ eventId: 'event-stale', sequence: 9 }), 'operation-1', 3, 8);
  inbox = applyDurableCallback(inbox, callback({ eventId: 'event-same-receipt', sequence: 11 }), 'operation-1', 3, 8);
  assert.equal(inbox.acceptedTransitionCount, 1);
  assert.equal(inbox.ignoredCount, 3);
  assert.equal(inbox.conflictReason, undefined);
  assert.equal(inbox.lastSequence, 11);
});

test('callback inbox records operation, source-version, sequence, and receipt conflicts', () => {
  const cases: Array<[string, DurableCallback]> = [
    ['operation mismatch', callback({ operationId: 'operation-2' })],
    ['source version ahead of workflow', callback({ sourceVersion: 4 })],
  ];
  for (const [reason, event] of cases) {
    const inbox = applyDurableCallback(createCallbackInbox(), event, 'operation-1', 3, 8);
    assert.match(inbox.conflictReason ?? '', new RegExp(reason));
    assert.equal(inbox.acceptedTransitionCount, 0);
  }

  let inbox = applyDurableCallback(createCallbackInbox(), callback(), 'operation-1', 3, 8);
  inbox = applyDurableCallback(
    inbox,
    callback({ eventId: 'event-conflict', sequence: 11, receiptRef: 'provider:receipt-2' }),
    'operation-1', 3, 8,
  );
  assert.match(inbox.conflictReason ?? '', /receipt conflict/);
  assert.equal(inbox.acceptedTransitionCount, 1);
});

test('callback inbox keeps a bounded dedupe horizon without losing accepted evidence', () => {
  let inbox = applyDurableCallback(createCallbackInbox(), callback(), 'operation-1', 3, 3);
  for (let sequence = 11; sequence <= 15; sequence += 1) {
    inbox = applyDurableCallback(
      inbox,
      callback({ eventId: `event-${sequence}`, sequence }),
      'operation-1', 3, 3,
    );
  }
  assert.deepEqual(inbox.recentEvents.map((event) => event.eventId), ['event-13', 'event-14', 'event-15']);
  assert.equal(inbox.acceptedEventId, 'event-1');
  assert.equal(inbox.acceptedReceiptRef, 'provider:receipt-1');
  assert.equal(inbox.lastSequence, 15);
});

test('Continue-As-New input carries identity, budget, deadline, operation, artifacts, and dedupe state', () => {
  const input: DurableWorkflowInput = {
    workId: 'W-1', epoch: 7, businessId: 'customer-1', value: 'enabled',
    generatedText: 'output', callbackTimeoutMs: 5_000,
  };
  const snapshot: DurableWorkflowSnapshot = {
    status: 'WAITING_EXTERNAL', outputArtifactId: 'artifact-output',
    operationId: 'operation-1', operationStatus: 'UNKNOWN', receiptArtifactId: 'artifact-receipt',
  };
  const inbox = applyDurableCallback(createCallbackInbox(), callback(), 'operation-1', 3, 8);
  const continued: DurableContinueAsNewInput = buildContinueAsNewInput(input, snapshot, inbox, 123_456);

  assert.equal(continued.workId, 'W-1');
  assert.equal(continued.historyEventLimit, 10_000);
  assert.deepEqual(continued.carry, {
    budgetWorkId: 'W-1', deadlineAtMs: 123_456,
    outputArtifactId: 'artifact-output', operationId: 'operation-1',
    operationStatus: 'UNKNOWN', receiptArtifactId: 'artifact-receipt', callbackInbox: inbox,
  });
});
