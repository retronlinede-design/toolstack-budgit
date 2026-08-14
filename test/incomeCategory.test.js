import assert from "node:assert/strict";
import test from "node:test";

import { calculateMonthTotals } from "../src/domain/calculations.js";
import { INCOME_CATEGORIES, MAX_INCOME_CATEGORY_LENGTH, normalizeIncomeCategory } from "../src/domain/incomeCategory.js";
import { calculateYearOverview } from "../src/domain/yearOverview.js";

test("category normalization preserves absence, known values, and bounded unknown values", () => {
  assert.deepEqual(normalizeIncomeCategory({ name: "Salary" }), {});
  for (const category of INCOME_CATEGORIES) assert.deepEqual(normalizeIncomeCategory({ category }), { category });
  assert.deepEqual(normalizeIncomeCategory({ category: "future_income_category" }), { category: "future_income_category" });
});

test("invalid categories are omitted without label inference or source mutation", () => {
  const source = { name: "Salary from employer", amount: "100", category: { bad: true } };
  const before = structuredClone(source);
  assert.deepEqual(normalizeIncomeCategory(source), {});
  assert.deepEqual(normalizeIncomeCategory({ name: "DAK employer contribution" }), {});
  assert.deepEqual(normalizeIncomeCategory({ category: "x".repeat(MAX_INCOME_CATEGORY_LENGTH + 1) }), {});
  assert.deepEqual(source, before);
});

test("income categories have zero effect on month and Year View calculations", () => {
  const baseIncomes = [
    { id: "salary", name: "Salary", amount: "3250", status: "received" },
    { id: "contribution", name: "Employer contribution", amount: "800", status: "received" },
  ];
  const classified = baseIncomes.map((income, index) => ({ ...income, category: index === 0 ? "salary" : "employer_contribution" }));
  const expenseGroups = [{ id: "social", label: "Insurance", items: [{ id: "dak", name: "DAK", amount: "1600", paid: true, breakdown: [{ id: "health", amount: "800" }, { id: "pension", amount: "800" }] }] }];
  const unclassifiedMonth = { incomes: baseIncomes, expenseGroups };
  const classifiedMonth = { incomes: classified, expenseGroups };
  assert.deepEqual(calculateMonthTotals(classifiedMonth), calculateMonthTotals(unclassifiedMonth));
  const totals = calculateMonthTotals(classifiedMonth);
  assert.equal(totals.expectedIncome, 4050);
  assert.equal(totals.receivedIncome, 4050);
  assert.equal(totals.plannedExpenses, 1600);
  assert.equal(totals.paidExpenses, 1600);
  assert.equal(totals.leftAfterPlannedExpenses, 2450);
  const classifiedOverview = calculateYearOverview({ months: { "2026-08": classifiedMonth } }, 2026, { currentMonthKey: "2026-08" });
  const unclassifiedOverview = calculateYearOverview({ months: { "2026-08": unclassifiedMonth } }, 2026, { currentMonthKey: "2026-08" });
  assert.deepEqual(classifiedOverview.totals, unclassifiedOverview.totals);
  assert.equal(classifiedOverview.totals.actualNet, 2450);
  assert.equal(classifiedOverview.incomeComposition.received.classifiedEarnings, 3250);
  assert.equal(classifiedOverview.incomeComposition.received.employerContributions, 800);
  assert.equal(unclassifiedOverview.incomeComposition.received.unclassifiedCash, 4050);
});
