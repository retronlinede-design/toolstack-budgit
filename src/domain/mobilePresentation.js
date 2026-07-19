const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

function validDueDate(activeMonth, dueDay) {
  if (!MONTH_KEY.test(String(activeMonth || ""))) return null;
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const [year, month] = activeMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const actualDay = Math.min(dueDay, lastDay);
  return { year, month, actualDay };
}

export function formatMobileDueDate(activeMonth, dueDay, language = "en") {
  const due = validDueDate(activeMonth, dueDay);
  if (!due) return null;
  const locale = language === "de" ? "de-DE" : "en-US";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(due.year, due.month - 1, due.actualDay)));
}

export function getMobileIncomePresentation(income) {
  return {
    id: income?.id,
    name: typeof income?.name === "string" ? income.name : "",
    amount: income?.amount,
    status: typeof income?.status === "string" ? income.status : "expected",
    date: typeof income?.date === "string" && income.date ? income.date : null,
    notes: typeof income?.notes === "string" && income.notes.trim() ? income.notes : null,
  };
}

export function getMobileExpensePresentation(expense, { activeMonth, language = "en" } = {}) {
  return {
    id: expense?.id,
    name: typeof expense?.name === "string" ? expense.name : "",
    amount: expense?.amount,
    paid: expense?.paid === true,
    paidLabel: expense?.paid === true
      ? (language === "de" ? "Bezahlt" : "Paid")
      : (language === "de" ? "Offen" : "Unpaid"),
    dueLabel: formatMobileDueDate(activeMonth, expense?.dueDay, language),
    notes: typeof expense?.note === "string" && expense.note.trim() ? expense.note : null,
  };
}
