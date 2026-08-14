import assert from "node:assert/strict";
import test from "node:test";

import { calculateMonthTotals } from "../src/domain/calculations.js";
import { analyzeHistoricalIncome } from "../src/domain/historicalIncome.js";
import { aggregateIncomeCompositions, calculateIncomeComposition } from "../src/domain/incomeComposition.js";
import { calculateYearOverview } from "../src/domain/yearOverview.js";

test("salary and employer contribution reconcile without changing cash accounting", () => {
  const incomes = [
    { id: "salary", amount: "3250", status: "received", category: "salary" },
    { id: "employer", amount: "800", status: "received", category: "employer_contribution" },
  ];
  const month = {
    incomes,
    expenseGroups: [{ id: "social", items: [{ id: "dak", amount: "1600", paid: true }] }],
  };
  const totals = calculateMonthTotals(month);
  const composition = calculateIncomeComposition(incomes);

  assert.equal(totals.expectedIncome, 4050);
  assert.equal(totals.receivedIncome, 4050);
  assert.equal(totals.paidExpenses, 1600);
  assert.equal(totals.leftAfterPlannedExpenses, 2450);
  assert.equal(totals.savingsRate, (2450 / 4050) * 100);
  assert.equal(totals.receivedIncome - totals.paidExpenses, 2450);
  assert.equal(composition.planned.cashTotal, 4050);
  assert.equal(composition.received.cashTotal, 4050);
  assert.equal(composition.received.classifiedEarnings, 3250);
  assert.equal(composition.received.employerContributions, 800);
  assert.equal(
    composition.received.classifiedEarnings
      + composition.received.employerContributions
      + composition.received.reimbursements
      + composition.received.ambiguousOtherCash
      + composition.received.unclassifiedCash,
    composition.received.cashTotal,
  );
});

test("all supported and forward-compatible categories use mutually exclusive buckets", () => {
  const incomes = [
    ["salary", "100"], ["overtime", "20"], ["bonus", "30"], ["allowance", "40"],
    ["employer_contribution", "50"], ["reimbursement", "60"], ["other", "70"],
    ["future_category", "80"], [undefined, "90"],
  ].map(([category, amount], index) => ({ id: String(index), category, amount, status: "received" }));
  delete incomes.at(-1).category;
  const result = calculateIncomeComposition(incomes).received;

  assert.equal(result.cashTotal, 540);
  assert.equal(result.classifiedEarnings, 190);
  assert.equal(result.employerContributions, 50);
  assert.equal(result.reimbursements, 60);
  assert.equal(result.ambiguousOtherCash, 150);
  assert.equal(result.unclassifiedCash, 90);
  assert.equal(result.ambiguousEntryCount, 2);
  assert.equal(result.unclassifiedEntryCount, 1);
  assert.equal(result.classificationComplete, false);
});

test("planned and received compositions follow existing lifecycle status semantics", () => {
  const result = calculateIncomeComposition([
    { amount: "100", status: "expected", category: "employer_contribution" },
    { amount: "20", status: "delayed", category: "salary" },
    { amount: "30", status: "received", category: "bonus" },
    { amount: "40", status: "cancelled", category: "salary" },
  ]);

  assert.equal(result.planned.cashTotal, 150);
  assert.equal(result.planned.employerContributions, 100);
  assert.equal(result.planned.classifiedEarnings, 50);
  assert.equal(result.received.cashTotal, 30);
  assert.equal(result.received.classifiedEarnings, 30);
});

test("negative valid values reconcile while malformed qualifying values expose incompleteness", () => {
  const result = calculateIncomeComposition([
    { id: "negative", amount: "-25", status: "received", category: "reimbursement" },
    { id: "bad", amount: "unknown", status: "received", category: "salary" },
    { id: "cancelled-bad", amount: "bad", status: "cancelled", category: "salary" },
  ]);

  assert.equal(result.received.cashTotal, -25);
  assert.equal(result.received.reimbursements, -25);
  assert.equal(result.received.invalidAmountCount, 1);
  assert.equal(result.received.amountsComplete, false);
  assert.equal(result.planned.invalidAmountCount, 1);
  assert.equal(result.invalidAmounts.length, 2);
});

test("aggregation preserves composition and classification completeness", () => {
  const first = calculateIncomeComposition([{ amount: "100", status: "received", category: "salary" }]);
  const second = calculateIncomeComposition([{ amount: "25", status: "received" }]);
  const total = aggregateIncomeCompositions([first, second]);
  assert.equal(total.received.cashTotal, 125);
  assert.equal(total.received.classifiedEarnings, 100);
  assert.equal(total.received.unclassifiedCash, 25);
  assert.equal(total.received.classificationComplete, false);
});

test("Year View cash totals and historical uncertainty remain independent from composition", () => {
  const source = {
    months: {
      "2026-01": {
        incomes: [
          { amount: "3250", status: "received", category: "salary" },
          { amount: "800", status: "received", category: "employer_contribution" },
          { amount: "100", status: "expected" },
        ],
        expenseGroups: [{ items: [{ amount: "1600", paid: true }] }],
      },
    },
  };
  const overview = calculateYearOverview(source, 2026, { currentMonthKey: "2026-08" });
  assert.equal(overview.totals.receivedIncome, 4050);
  assert.equal(overview.totals.actualNet, 2450);
  assert.equal(overview.incomeComposition.received.classifiedEarnings, 3250);
  assert.equal(overview.incomeComposition.received.employerContributions, 800);
  assert.equal(overview.incomeComposition.planned.classificationComplete, false);
  assert.equal(overview.months[0].actualNetProvisional, true);
  assert.equal(analyzeHistoricalIncome("2026-01", source.months["2026-01"], { currentMonthKey: "2026-08" }).unresolvedExpectedCount, 1);
});

test("composition analysis does not mutate source rows", () => {
  const source = [{ id: "one", amount: "12,50", status: "received", category: "allowance" }];
  const before = structuredClone(source);
  const result = calculateIncomeComposition(source);
  assert.equal(result.received.classifiedEarnings, 12.5);
  assert.deepEqual(source, before);
});
