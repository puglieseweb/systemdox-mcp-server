// report_decision keeps a decision as a draft spec named "ADR: <title>". It holds
// a decision, not requirements, so "0 requirements" misreads it.
const DECISION_PREFIX = "ADR: ";

export function isDecisionDraft(name: string): boolean {
  return name.startsWith(DECISION_PREFIX);
}

export function specLabel(spec: { name: string; requirementCount: number }): string {
  return isDecisionDraft(spec.name)
    ? "decision record"
    : `${spec.requirementCount} requirements`;
}
