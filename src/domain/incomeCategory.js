export const INCOME_CATEGORIES = Object.freeze([
  "salary",
  "overtime",
  "bonus",
  "allowance",
  "employer_contribution",
  "reimbursement",
  "other",
]);

export const MAX_INCOME_CATEGORY_LENGTH = 500;

export function isPreservableIncomeCategory(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_INCOME_CATEGORY_LENGTH;
}

export function normalizeIncomeCategory(income) {
  if (!Object.prototype.hasOwnProperty.call(income || {}, "category")) return {};
  return isPreservableIncomeCategory(income.category) ? { category: income.category } : {};
}
