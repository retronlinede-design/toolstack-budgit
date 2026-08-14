import assert from "node:assert/strict";
import test from "node:test";

import { analyzeHistoricalIncome, calendarMonthKey } from "../src/domain/historicalIncome.js";

const analyze = (monthKey, incomes, currentMonthKey = "2026-08") => analyzeHistoricalIncome(
  monthKey,
  { incomes },
  { currentMonthKey },
);

test("current and future expected income remains normal planned income", () => {
  for (const monthKey of ["2026-08", "2026-09"]) {
    const result = analyze(monthKey, [{ amount: "100", status: "expected" }]);
    assert.equal(result.historical, false);
    assert.equal(result.unresolvedExpectedCount, 0);
    assert.equal(result.historicalIncomeOutcomeComplete, true);
  }
});

test("past expected income is unresolved and supports dot and comma decimals", () => {
  const result = analyze("2026-07", [
    { amount: "100.25", status: "expected" },
    { amount: "20,50", status: "expected" },
  ]);
  assert.deepEqual(result, {
    historical: true,
    unresolvedExpectedCount: 2,
    unresolvedExpectedAmount: 120.75,
    invalidUnresolvedAmountCount: 0,
    historicalIncomeOutcomeComplete: false,
  });
});

test("received, delayed, and cancelled past income are explicit outcomes", () => {
  const result = analyze("2026-07", [
    { amount: "100", status: "received" },
    { amount: "50", status: "delayed" },
    { amount: "25", status: "cancelled" },
  ]);
  assert.equal(result.unresolvedExpectedCount, 0);
  assert.equal(result.historicalIncomeOutcomeComplete, true);
});

test("mixed past statuses count expected rows and report invalid expected amounts", () => {
  const result = analyze("2026-07", [
    { amount: "100", status: "expected" },
    { amount: "", status: "expected" },
    { amount: "unknown", status: "expected" },
    { amount: "500", status: "received" },
  ]);
  assert.equal(result.unresolvedExpectedCount, 3);
  assert.equal(result.unresolvedExpectedAmount, 100);
  assert.equal(result.invalidUnresolvedAmountCount, 2);
});

test("analysis is deterministic at the month boundary and does not mutate source", () => {
  const month = { incomes: [{ id: "income", amount: "10", status: "expected" }] };
  const before = structuredClone(month);
  assert.equal(analyzeHistoricalIncome("2026-07", month, { currentMonthKey: "2026-08" }).historical, true);
  assert.equal(analyzeHistoricalIncome("2026-08", month, { currentMonthKey: "2026-08" }).historical, false);
  assert.equal(calendarMonthKey(new Date(2026, 7, 1, 0, 0, 0)), "2026-08");
  assert.deepEqual(month, before);
});
