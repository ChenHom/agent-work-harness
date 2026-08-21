import type { Attempt, Outcome, Work } from './types.ts';

export function formatWorkListRow(work: Work, outcome: Outcome | null): string {
  return `${work.id}  ${work.state.padEnd(12)} ${work.repositoryId.padEnd(16)} ${work.title}  outcome=${outcome ?? '-'}`;
}

export function formatPreExistingDirty(attempt: Attempt): string {
  const dirty = attempt.preExistingDirty ?? [];
  if (!dirty.length) return '    preExistingDirty: -';
  return `    preExistingDirty: ${dirty.map(({ path, hash }) => `${path} (hash=${hash ?? 'null'})`).join(', ')}`;
}

export function formatContextDropped(attempt: Attempt): string {
  const dropped = attempt.contextDropped ?? [];
  if (!dropped.length) return '    contextDropped: -';
  return `    contextDropped: ${dropped.map(({ priority, count }) => `priority=${priority} count=${count}`).join(', ')}`;
}
