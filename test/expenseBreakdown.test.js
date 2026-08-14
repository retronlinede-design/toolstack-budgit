import assert from "node:assert/strict";
import test from "node:test";

import { calculateBalanceProjection, calculateMonthTotals } from "../src/domain/calculations.js";
import { analyzeExpenseBreakdown, normalizeExpenseBreakdown } from "../src/domain/expenseBreakdown.js";
import { calculateYearOverview } from "../src/domain/yearOverview.js";

const expense = (amount, breakdown) => ({ id: "expense", name: "Payment", amount, paid: false, ...(breakdown === undefined ? {} : { breakdown }) });
const component = (amount, extra = {}) => ({ id: "component", label: "Part", category: "other", amount, ...extra });

test("no breakdown is absence-preserved and source is not mutated", () => {
  const source = expense("100");
  const before = structuredClone(source);
  assert.deepEqual(analyzeExpenseBreakdown(source), {
    state: "none", complete: false, componentCount: 0, validComponentSubtotal: 0,
    blankComponentCount: 0, invalidComponentCount: 0, unallocatedAmount: null,
    overallocatedAmount: null, issues: [],
  });
  assert.deepEqual(normalizeExpenseBreakdown(source, () => "new"), {});
  assert.deepEqual(source, before);
});

test("complete, underallocated, overallocated and minor-unit values are derived safely", () => {
  assert.equal(analyzeExpenseBreakdown(expense("0.30", [component("0.1"), component("0,20", { id: "two" })])).complete, true);
  const under = analyzeExpenseBreakdown(expense("100", [component("60")]));
  assert.equal(under.state, "incomplete");
  assert.equal(under.unallocatedAmount, 40);
  const over = analyzeExpenseBreakdown(expense("100", [component("125")]));
  assert.equal(over.overallocatedAmount, 25);
});

test("blank, malformed, negative and zero components retain accurate states", () => {
  const result = analyzeExpenseBreakdown(expense("10", [component(""), component("bad", { id: "bad" }), component("-2", { id: "negative" }), component("0", { id: "zero" })]));
  assert.equal(result.blankComponentCount, 1);
  assert.equal(result.invalidComponentCount, 2);
  assert.equal(result.validComponentSubtotal, 0);
  assert.deepEqual(result.issues.slice(0, 3).map((issue) => issue.reason), ["empty", "invalid_format", "negative_not_allowed"]);
});

test("invalid parent makes comparison unavailable", () => {
  const result = analyzeExpenseBreakdown(expense("bad", [component("5")]));
  assert.equal(result.state, "unavailable");
  assert.equal(result.unallocatedAmount, null);
});

test("normalization preserves IDs/raw values/unknown bounded category and malformed structure", () => {
  const breakdown = [component("12,50", { category: "future_category" })];
  assert.deepEqual(normalizeExpenseBreakdown({ breakdown }, () => "new"), { breakdown });
  const malformed = { future: "payload" };
  assert.deepEqual(normalizeExpenseBreakdown({ breakdown: malformed }, () => "new"), { breakdown: malformed });
});

test("breakdowns never enter cash, balance, or Year View totals", () => {
  const parent = expense("1650", [component("700"), component("950", { id: "two" })]);
  parent.paid = true;
  const month = { incomes: [{ id: "income", amount: "2000", status: "received" }], expenseGroups: [{ id: "group", label: "Insurance", items: [parent] }] };
  const totals = calculateMonthTotals(month);
  assert.equal(totals.plannedExpenses, 1650);
  assert.equal(totals.paidExpenses, 1650);
  assert.equal(totals.unpaidExpenses, 0);
  assert.equal(totals.receivedIncome - totals.paidExpenses, 350);
  assert.equal(calculateBalanceProjection({ bankBalance: "2000", overdraftLimit: "0", pendingIncomeEntries: [], remainingExpenses: totals.unpaidExpenses }).balanceAfterUnpaid, 2000);
  const overview = calculateYearOverview({ months: { "2026-08": month } }, 2026, { currentMonthKey: "2026-08" });
  assert.equal(overview.totals.plannedExpenses, 1650);
  assert.equal(overview.totals.paidExpenses, 1650);
  assert.equal(overview.totals.actualNet, 350);
});
