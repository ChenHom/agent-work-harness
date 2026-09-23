import type { AdapterCapabilitySnapshot } from '../types.ts';

export interface ModelRoleConfig {
  schemaVersion: '1';
  role: 'planner' | 'executor' | 'critic';
  provider: string;
  model: string;
  configVersion: string;
  configHash: string;
  budget: {
    resourceKind: string;
    currency?: string;
    upperBoundUnits: number;
    pricingVersion: string;
  };
}

export function validateModelRoleConfig(config: ModelRoleConfig): ModelRoleConfig {
  const required = [config.provider, config.model, config.configVersion, config.configHash,
    config.budget.resourceKind, config.budget.pricingVersion];
  if (config.schemaVersion !== '1' || !['planner', 'executor', 'critic'].includes(config.role)
    || required.some((value) => !value.trim())
    || !Number.isSafeInteger(config.budget.upperBoundUnits)
    || config.budget.upperBoundUnits < 0) {
    throw new Error('MODEL_CONFIG_INVALID: role, model identity, config identity, and bounded integer cost are required');
  }
  return config;
}

export function modelBudgetCost(config: ModelRoleConfig): AdapterCapabilitySnapshot['cost'] {
  const valid = validateModelRoleConfig(config);
  return {
    mode: 'bounded', resourceKind: valid.budget.resourceKind,
    currency: valid.budget.currency, upperBoundUnits: valid.budget.upperBoundUnits,
    pricingVersion: valid.budget.pricingVersion,
  };
}
