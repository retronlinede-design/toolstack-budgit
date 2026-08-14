const CANONICAL_MONTH_KEY = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/;
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

export function parseCanonicalMonthKey(value) {
  if (typeof value !== "string") return { ok: false, code: "invalid_month_key" };
  const match = CANONICAL_MONTH_KEY.exec(value);
  if (!match) return { ok: false, code: "invalid_month_key" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  return { ok: true, key: value, year, month };
}

export function isCanonicalMonthKey(value) {
  return parseCanonicalMonthKey(value).ok;
}

export function formatMonthKey(year, month) {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return { ok: false, code: "invalid_year" };
  if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, code: "invalid_month" };
  return { ok: true, key: `${year}-${String(month).padStart(2, "0")}`, year, month };
}

export function compareMonthKeys(left, right) {
  const a = parseCanonicalMonthKey(left);
  const b = parseCanonicalMonthKey(right);
  if (!a.ok || !b.ok) return { ok: false, code: "invalid_month_key" };
  return { ok: true, value: a.key.localeCompare(b.key) };
}

function moveMonth(value, delta) {
  const parsed = parseCanonicalMonthKey(value);
  if (!parsed.ok) return parsed;
  let year = parsed.year;
  let month = parsed.month + delta;
  if (month === 13) {
    year += 1;
    month = 1;
  } else if (month === 0) {
    year -= 1;
    month = 12;
  }
  return formatMonthKey(year, month);
}

export function nextMonthKey(value) {
  return moveMonth(value, 1);
}

export function previousMonthKey(value) {
  return moveMonth(value, -1);
}

export function getQuarantinedMonthKeys(months) {
  if (!months || typeof months !== "object" || Array.isArray(months)) return [];
  return Object.keys(months).filter((key) => !isCanonicalMonthKey(key));
}

export function getCanonicalMonthYears(months) {
  if (!months || typeof months !== "object" || Array.isArray(months)) return [];
  return [...new Set(Object.keys(months)
    .map(parseCanonicalMonthKey)
    .filter((result) => result.ok)
    .map((result) => result.year))]
    .sort((a, b) => a - b);
}

export function resolveOperationalActiveMonth(activeMonth, currentMonthKey) {
  if (isCanonicalMonthKey(activeMonth)) return activeMonth;
  if (isCanonicalMonthKey(currentMonthKey)) return currentMonthKey;
  throw new TypeError("A canonical current month key is required");
}

export function normalizeCanonicalMonthRecords(months, normalizeMonth) {
  const source = months && typeof months === "object" && !Array.isArray(months) ? months : {};
  const result = { ...source };
  Object.keys(result).forEach((key) => {
    if (isCanonicalMonthKey(key)) result[key] = normalizeMonth(result[key]);
  });
  return result;
}
