import { readFileSync } from 'node:fs';

export function readProcessStart(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[19] || 'unknown';
  } catch {
    return 'unknown';
  }
}
