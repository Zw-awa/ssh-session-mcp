export type ResultStatus = 'success' | 'partial_success' | 'blocked' | 'failure';

export type FailureCategory =
  | 'config-error'
  | 'environment-missing'
  | 'auth-failure'
  | 'connection-failure'
  | 'ambiguous-session'
  | 'input-locked'
  | 'terminal-state-abnormal'
  | 'viewer-unavailable'
  | 'runtime-state-abnormal'
  | 'policy-blocked';

export interface ToolContractFields {
  resultStatus: ResultStatus;
  summary: string;
  nextAction?: string;
  failureCategory?: FailureCategory;
  evidence?: string[];
}

function normalizeEvidence(evidence: Array<string | undefined | null>) {
  return evidence
    .map(item => item?.trim())
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function withToolContract<T extends object>(
  payload: T,
  contract: ToolContractFields,
) {
  const evidence = normalizeEvidence(contract.evidence || []);

  return {
    ...payload,
    ...contract,
    evidence: evidence.length > 0 ? evidence : undefined,
  };
}
