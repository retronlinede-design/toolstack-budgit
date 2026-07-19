import assert from "node:assert/strict";
import test from "node:test";
import { calculateYearOverview } from "../src/domain/yearOverview.js";

const income = (amount, status = "expected") => ({ id: `${status}-${amount}`, name: "Income", amount, status });
const expense = (amount, paid = false) => ({ id: `${paid}-${amount}`, name: "Expense", amount, paid });
const month = ({ incomes = [], expenses = [] } = {}) => ({
  incomes,
  expenseGroups: [{ id: "group", label: "Group", items: expenses }],
});
const app = (months) => ({ lang: "en", currency: "EUR", activeMonth: "2026-01", months });

test("returns all 12 calendar months in chronological order", () => {
  const result = calculateYearOverview(app({}), 2026);
  assert.equal(result.months.length, 12);
  assert.equal(result.months[0].monthKey, "2026-01");
  assert.equal(result.months[11].monthKey, "2026-12");
});

test("summarizes one populated month with trusted monthly semantics", () => {
  const result = calculateYearOverview(app({
    "2026-03": month({
      incomes: [income("1000", "expected"), income("500", "received"), income("200", "cancelled")],
      expenses: [expense("400", true), expense("250", false)],
    }),
  }), 2026);
  const march = result.months[2];
  assert.deepEqual(
    {
      expectedIncome: march.expectedIncome,
      receivedIncome: march.receivedIncome,
      plannedExpenses: march.plannedExpenses,
      paidExpenses: march.paidExpenses,
      unpaidExpenses: march.unpaidExpenses,
      leftAfterPlanned: march.leftAfterPlanned,
      actualNet: march.actualNet,
    },
    { expectedIncome: 1500, receivedIncome: 500, plannedExpenses: 650, paidExpenses: 400, unpaidExpenses: 250, leftAfterPlanned: 850, actualNet: 100 },
  );
});

test("totals several months and ignores records outside the selected year", () => {
  const result = calculateYearOverview(app({
    "2026-01": month({ incomes: [income(100, "received")], expenses: [expense(20, true)] }),
    "2026-02": month({ incomes: [income(200, "received")], expenses: [expense(50, false)] }),
    "2025-12": month({ incomes: [income(999, "received")] }),
  }), 2026);
  assert.deepEqual(result.totals, {
    expectedIncome: 300,
    receivedIncome: 300,
    plannedExpenses: 70,
    paidExpenses: 20,
    unpaidExpenses: 50,
    leftAfterPlanned: 230,
    actualNet: 280,
  });
});

test("excludes missing months from averages", () => {
  const result = calculateYearOverview(app({
    "2026-01": month({ incomes: [income(100, "received")] }),
    "2026-03": month({ incomes: [income(300, "received")] }),
  }), 2026);
  assert.equal(result.averages.receivedIncome, 200);
  assert.equal(result.monthsWithData, 2);
});

test("includes a stored zero-value month as real data", () => {
  const result = calculateYearOverview(app({ "2026-04": month() }), 2026);
  assert.equal(result.months[3].hasData, true);
  assert.equal(result.monthsWithData, 1);
  assert.equal(result.averages.actualNet, 0);
  assert.equal(result.strongestMonth.monthKey, "2026-04");
  assert.equal(result.weakestMonth.monthKey, "2026-04");
});

test("identifies strongest and weakest months by actual net", () => {
  const result = calculateYearOverview(app({
    "2026-01": month({ incomes: [income(100, "received")], expenses: [expense(20, true)] }),
    "2026-02": month({ incomes: [income(40, "received")], expenses: [expense(90, true)] }),
    "2026-03": month({ incomes: [income(120, "received")], expenses: [expense(10, true)] }),
  }), 2026);
  assert.equal(result.strongestMonth.monthKey, "2026-03");
  assert.equal(result.weakestMonth.monthKey, "2026-02");
  assert.equal(result.months[1].actualNet, -50);
});

test("resolves strongest and weakest ties to the earliest month", () => {
  const result = calculateYearOverview(app({
    "2026-02": month({ incomes: [income(50, "received")] }),
    "2026-05": month({ incomes: [income(50, "received")] }),
  }), 2026);
  assert.equal(result.strongestMonth.monthKey, "2026-02");
  assert.equal(result.weakestMonth.monthKey, "2026-02");
});

test("counts months with data and months with unpaid expenses", () => {
  const result = calculateYearOverview(app({
    "2026-01": month({ expenses: [expense(20, false)] }),
    "2026-02": month({ expenses: [expense(20, true)] }),
    "2026-03": month(),
  }), 2026);
  assert.equal(result.monthsWithData, 3);
  assert.equal(result.monthsWithUnpaidExpenses, 1);
});

test("handles an empty year without misleading averages or insights", () => {
  const result = calculateYearOverview(app({}), 2026);
  assert.equal(result.monthsWithData, 0);
  assert.equal(result.averages.actualNet, null);
  assert.equal(result.strongestMonth, null);
  assert.equal(result.weakestMonth, null);
  assert.ok(result.months.every((entry) => !entry.hasData));
});

test("zero received income and savings rate remain safe", () => {
  const result = calculateYearOverview(app({ "2026-01": month({ expenses: [expense(10)] }) }), 2026);
  assert.equal(result.months[0].actualNet, 0);
  assert.equal(result.months[0].savingsRate, null);
  for (const value of Object.values(result.totals)) assert.equal(Number.isFinite(value), true);
});

test("does not mutate source application data", () => {
  const source = app({ "2026-01": month({ incomes: [income("100", "received")], expenses: [expense("25", true)] }) });
  const before = structuredClone(source);
  calculateYearOverview(source, 2026);
  assert.deepEqual(source, before);
});
