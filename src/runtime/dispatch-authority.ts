import type { ExecutionOwnership } from './ownership.ts';

export type DispatchAction = 'dispatch' | 'reconcile' | 'publish';

export interface DispatchAuthority {
  beginOperation(): boolean;
  endOperation(): void;
  validate(action: DispatchAction): boolean | Promise<boolean>;
}

export function localDispatchAuthority(ownership: ExecutionOwnership): DispatchAuthority {
  return {
    beginOperation: () => ownership.beginOperation(),
    endOperation: () => ownership.endOperation(),
    validate: () => ownership.validate(),
  };
}

export async function assertDispatchAuthority(
  authority: DispatchAuthority,
  action: DispatchAction,
  phase: string,
): Promise<void> {
  if (!await authority.validate(action)) {
    throw new Error(`OWNER_UNKNOWN: dispatch authority is stale during ${phase}`);
  }
}
