// Stores owner policy selections under exact append-only Sprint Plan approvals.
export const planDecisionSelectionsMigration = {
  version: 20,
  statements: [`CREATE TABLE plan_decision_selections (
    decision_id TEXT PRIMARY KEY REFERENCES plan_decisions(decision_id),
    selections_json TEXT NOT NULL
  )`]
};
