import { parseMoney } from "./calculations.js";

export const EXPENSE_BREAKDOWN_CATEGORIES = Object.freeze([
  "health",
  "pension",
  "unemployment",
  "long_term_care",
  "tax",
  "insurance",
  "other",
]);

export const MAX_BREAKDOWN_COMPONENTS = 100;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function normalizeExpenseBreakdown(expense, idFactory) {
  if (!hasOwn(expense, "breakdown")) return {};
  if (!Array.isArray(expense.breakdown)) return { breakdown: expense.breakdown };
  return {
    breakdown: expense.breakdown.map((component) => ({
      id: component?.id || idFactory(),
      label: typeof component?.label === "string" ? component.label : "",
      category: typeof component?.category === "string" ? component.category : "",
      amount: component?.amount != null ? component.amount : "",
    })),
  };
}

export function toMoneyMinorUnits(value) {
  return Math.round((value + Number.EPSILON) * 100);
}

export function analyzeExpenseBreakdown(expense) {
  const components = Array.isArray(expense?.breakdown) ? expense.breakdown : [];
  if (!components.length) {
    return {
      state: "none", complete: false, componentCount: 0, validComponentSubtotal: 0,
      blankComponentCount: 0, invalidComponentCount: 0, unallocatedAmount: null,
      overallocatedAmount: null, issues: [],
    };
  }

  const parent = parseMoney(expense?.amount);
  const parentValid = parent.valid && parent.value >= 0;
  let validComponentSubtotal = 0;
  let blankComponentCount = 0;
  let invalidComponentCount = 0;
  const issues = [];

  components.forEach((component, index) => {
    const parsed = parseMoney(component?.amount);
    if (!parsed.valid) {
      const reason = parsed.reason === "empty" ? "empty" : parsed.reason;
      if (reason === "empty") blankComponentCount += 1;
      else invalidComponentCount += 1;
      issues.push({ index, path: `breakdown.components[${index}].amount`, reason });
      return;
    }
    if (parsed.value < 0) {
      invalidComponentCount += 1;
      issues.push({ index, path: `breakdown.components[${index}].amount`, reason: "negative_not_allowed" });
      return;
    }
    validComponentSubtotal += parsed.value;
  });

  if (!parentValid) {
    return {
      state: "unavailable", complete: false, componentCount: components.length,
      validComponentSubtotal, blankComponentCount, invalidComponentCount,
      unallocatedAmount: null, overallocatedAmount: null, issues,
    };
  }

  const differenceMinor = toMoneyMinorUnits(parent.value) - toMoneyMinorUnits(validComponentSubtotal);
  const allComponentsValid = blankComponentCount === 0 && invalidComponentCount === 0;
  const complete = allComponentsValid && differenceMinor === 0;
  if (!complete && differenceMinor !== 0) {
    issues.push({ path: "breakdown", reason: "breakdown_total_mismatch" });
  }
  return {
    state: complete ? "complete" : "incomplete",
    complete,
    componentCount: components.length,
    validComponentSubtotal,
    blankComponentCount,
    invalidComponentCount,
    unallocatedAmount: differenceMinor > 0 ? differenceMinor / 100 : 0,
    overallocatedAmount: differenceMinor < 0 ? -differenceMinor / 100 : 0,
    issues,
  };
}
