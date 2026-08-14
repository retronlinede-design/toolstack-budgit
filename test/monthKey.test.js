import test from "node:test";
import assert from "node:assert/strict";

import {
  compareMonthKeys,
  formatMonthKey,
  getCanonicalMonthYears,
  getQuarantinedMonthKeys,
  isCanonicalMonthKey,
  nextMonthKey,
  normalizeCanonicalMonthRecords,
  parseCanonicalMonthKey,
  previousMonthKey,
  resolveOperationalActiveMonth,
} from "../src/domain/monthKey.js";

test("canonical month keys use a four-digit non-leading-zero year and valid month", () => {
  for (const key of ["2026-01", "2026-12", "1000-01", "9999-12"]) assert.equal(isCanonicalMonthKey(key), true, key);
  for (const key of ["", "abc", "0202-01", "0000-01", "2026-1", "202-02", "26-01", "2026-00", "2026-13"]) {
    assert.equal(isCanonicalMonthKey(key), false, key);
    assert.equal(parseCanonicalMonthKey(key).ok, false, key);
  }
});

test("formatting and comparison return explicit results", () => {
  assert.deepEqual(formatMonthKey(2026, 8), { ok: true, key: "2026-08", year: 2026, month: 8 });
  assert.equal(formatMonthKey(999, 1).ok, false);
  assert.deepEqual(compareMonthKeys("2026-01", "2026-08"), { ok: true, value: -1 });
  assert.equal(compareMonthKeys("0202-01", "2026-08").ok, false);
});

test("month arithmetic crosses year boundaries without Date rollover", () => {
  assert.deepEqual(nextMonthKey("2026-12"), { ok: true, key: "2027-01", year: 2027, month: 1 });
  assert.deepEqual(previousMonthKey("2026-01"), { ok: true, key: "2025-12", year: 2025, month: 12 });
  for (const key of ["0202-01", "0000-01", "202-02", ""]) assert.equal(nextMonthKey(key).ok, false);
  assert.equal(nextMonthKey("9999-12").ok, false);
  assert.equal(previousMonthKey("1000-01").ok, false);
});

test("quarantined records are preserved verbatim while canonical records normalize", () => {
  const emptyKeyRecord = { raw: ["keep", { nested: true }] };
  const lowYearRecord = { unsupported: "keep this too" };
  const canonicalRecord = { value: 1 };
  const source = { "": emptyKeyRecord, "0202-01": lowYearRecord, "2026-08": canonicalRecord };
  const normalized = normalizeCanonicalMonthRecords(source, (month) => ({ ...month, normalized: true }));
  assert.strictEqual(normalized[""], emptyKeyRecord);
  assert.strictEqual(normalized["0202-01"], lowYearRecord);
  assert.deepEqual(normalized["2026-08"], { value: 1, normalized: true });
  assert.deepEqual(source["2026-08"], { value: 1 });
  assert.deepEqual(getQuarantinedMonthKeys(source), ["", "0202-01"]);
  assert.deepEqual(getCanonicalMonthYears(source), [2026]);
});

test("malformed active months fall back operationally without changing source data", () => {
  const source = { activeMonth: "0202-01", months: { "0202-01": { data: "preserved" } } };
  assert.equal(resolveOperationalActiveMonth(source.activeMonth, "2026-08"), "2026-08");
  assert.equal(source.activeMonth, "0202-01");
  assert.deepEqual(source.months["0202-01"], { data: "preserved" });
  assert.equal(resolveOperationalActiveMonth("2026-07", "2026-08"), "2026-07");
});

