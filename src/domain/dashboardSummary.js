const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localDateStamp(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function compareNames(left, right) {
  const a = String(left || "").toLocaleLowerCase("en");
  const b = String(right || "").toLocaleLowerCase("en");
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function resolveMonthDueDate(activeMonth, dueDay) {
  if (typeof activeMonth !== "string" || !MONTH_KEY.test(activeMonth)) return null;
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const [year, month] = activeMonth.split("-").map(Number);
  const actualDueDay = Math.min(dueDay, daysInMonth(year, month));
  const dueStamp = Date.UTC(year, month - 1, actualDueDay);
  return {
    requestedDueDay: dueDay,
    actualDueDay,
    dueStamp,
    dueDateISO: `${activeMonth}-${String(actualDueDay).padStart(2, "0")}`,
  };
}

export function createExpenseAttentionSummary({ activeMonth, expenseGroups, currentDate }) {
  const todayStamp = localDateStamp(currentDate);
  const unpaid = [];
  let ordinal = 0;

  for (const group of Array.isArray(expenseGroups) ? expenseGroups : []) {
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (item?.paid) continue;
      const due = resolveMonthDueDate(activeMonth, item?.dueDay);
      unpaid.push({
        name: typeof item?.name === "string" ? item.name : "",
        due,
        ordinal: ordinal++,
      });
    }
  }

  const dated = unpaid.filter((item) => item.due);
  const overdueCount = todayStamp == null ? 0 : dated.filter((item) => item.due.dueStamp < todayStamp).length;
  dated.sort((left, right) => (
    left.due.dueStamp - right.due.dueStamp
    || compareNames(left.name, right.name)
    || left.ordinal - right.ordinal
  ));

  const next = dated[0];
  return {
    unpaidCount: unpaid.length,
    overdueCount,
    nextDue: next ? {
      name: next.name,
      dueDay: next.due.requestedDueDay,
      actualDueDay: next.due.actualDueDay,
      dueDateISO: next.due.dueDateISO,
      overdue: todayStamp == null ? false : next.due.dueStamp < todayStamp,
    } : null,
  };
}

export function formatSavingsRate(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}
