import test from 'node:test';
import assert from 'node:assert/strict';
import { traceWork, type TraceSpan } from '../src/trace/links.ts';
import { richHistory } from './helpers/history.ts';

const linksOf = (spans: TraceSpan[], kind: string) => spans.filter((span) => span.kind === kind).flatMap((span) => span.links);

test('span links connect a recovered operation across dispatch, reconciliation, and budget settlement', async () => {
  const h = await richHistory();
  try {
    const { spans } = traceWork(h.store, 'W-OP');
    const operation = spans.find((span) => span.kind === 'operation')!;
    assert.equal(operation.spanId, h.ids.operation);
    assert.notEqual(operation.causationEventSeq, null);
    assert.deepEqual(linksOf(spans, 'operation_attempt'), [{ spanId: h.ids.operation, relation: 'attempt_of' }]);
    assert.deepEqual(linksOf(spans, 'budget_reservation'), [{ spanId: h.ids.operation, relation: 'reserves_for' }]);
    const reservation = spans.find((span) => span.kind === 'budget_reservation')!.spanId;
    assert.ok(linksOf(spans, 'budget_ledger').length >= 2);
    assert.ok(linksOf(spans, 'budget_ledger').every((link) => link.spanId === reservation && link.relation === 'settles'));
    const events = spans.filter((span) => span.kind === 'event');
    assert.ok(events.length > 0 && events.every((span) => span.causationEventSeq === Number(span.spanId.slice(6))));
    assert.ok(spans.some((span) => span.kind === 'artifact:operation-input' && span.authoritative && span.accessClass === 'internal'));

    const evaluation = traceWork(h.store, 'W-EVAL').spans;
    assert.deepEqual(linksOf(evaluation, 'evaluation_run'), [{ spanId: 'EC-1', relation: 'under_contract' }]);
    assert.deepEqual(linksOf(evaluation, 'criterion_verdict'), [{ spanId: 'ER-1', relation: 'verdict_of' }]);
    assert.deepEqual(linksOf(evaluation, 'completion_decision'), [{ spanId: 'ER-1', relation: 'decides' }]);
  } finally {
    h.cleanup();
  }
});

test('sampling drops only raw-log spans; authoritative ledger spans are never sampled', async () => {
  const h = await richHistory();
  try {
    const full = traceWork(h.store, 'W-OP', { sampleRate: 1 });
    const none = traceWork(h.store, 'W-OP', { sampleRate: 0, random: () => 0.5 });
    const rawLogs = full.spans.filter((span) => !span.authoritative);
    assert.deepEqual(rawLogs.map((span) => [span.spanId, span.kind, span.accessClass]), [[h.ids.rawLog, 'artifact:runtime_stdout', 'restricted']]);
    assert.deepEqual(none.spans, full.spans.filter((span) => span.authoritative));
    assert.deepEqual(none.sampling, { rate: 0, keptOptional: 0, droppedOptional: 1 });
    assert.deepEqual(full.sampling, { rate: 1, keptOptional: 1, droppedOptional: 0 });
    for (const rate of [-0.1, 1.5, Number.NaN]) assert.throws(() => traceWork(h.store, 'W-OP', { sampleRate: rate }), /TRACE_SAMPLE_RATE_INVALID/);
  } finally {
    h.cleanup();
  }
});
