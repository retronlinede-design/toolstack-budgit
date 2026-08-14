import { normalizeIncomeStatus, parseMoney } from "./calculations.js";

const EARNINGS_CATEGORIES = new Set(["salary", "overtime", "bonus", "allowance"]);

function emptyComposition() {
  return {
    cashTotal: 0,
    classifiedEarnings: 0,
    employerContributions: 0,
    reimbursements: 0,
    ambiguousOtherCash: 0,
    unclassifiedCash: 0,
    ambiguousEntryCount: 0,
    unclassifiedEntryCount: 0,
    invalidAmountCount: 0,
    classificationComplete: true,
    amountsComplete: true,
    complete: true,
  };
}

function categoryBucket(category) {
  if (typeof category !== "string" || !category.trim()) return "unclassifiedCash";
  if (EARNINGS_CATEGORIES.has(category)) return "classifiedEarnings";
  if (category === "employer_contribution") return "employerContributions";
  if (category === "reimbursement") return "reimbursements";
  return "ambiguousOtherCash";
}

function addValidAmount(composition, item, value) {
  const bucket = categoryBucket(item?.category);
  composition.cashTotal += value;
  composition[bucket] += value;
  if (bucket === "ambiguousOtherCash") composition.ambiguousEntryCount += 1;
  if (bucket === "unclassifiedCash") composition.unclassifiedEntryCount += 1;
}

function finalize(composition) {
  composition.classificationComplete = composition.ambiguousEntryCount === 0 && composition.unclassifiedEntryCount === 0;
  composition.amountsComplete = composition.invalidAmountCount === 0;
  composition.complete = composition.classificationComplete && composition.amountsComplete;
  return composition;
}

export function calculateIncomeComposition(incomes) {
  const planned = emptyComposition();
  const received = emptyComposition();
  const invalidAmounts = [];

  (Array.isArray(incomes) ? incomes : []).forEach((item, index) => {
    const status = normalizeIncomeStatus(item?.status);
    const qualifiesForPlanned = status !== "cancelled";
    const qualifiesForReceived = status === "received";
    const parsed = parseMoney(item?.amount);

    if (!parsed.valid) {
      invalidAmounts.push({
        index,
        id: item?.id || null,
        input: item?.amount,
        reason: parsed.reason,
        status,
      });
      if (qualifiesForPlanned) planned.invalidAmountCount += 1;
      if (qualifiesForReceived) received.invalidAmountCount += 1;
      return;
    }

    if (qualifiesForPlanned) addValidAmount(planned, item, parsed.value);
    if (qualifiesForReceived) addValidAmount(received, item, parsed.value);
  });

  return { planned: finalize(planned), received: finalize(received), invalidAmounts };
}

export function aggregateIncomeCompositions(compositions) {
  const result = { planned: emptyComposition(), received: emptyComposition() };
  const numericFields = [
    "cashTotal",
    "classifiedEarnings",
    "employerContributions",
    "reimbursements",
    "ambiguousOtherCash",
    "unclassifiedCash",
    "ambiguousEntryCount",
    "unclassifiedEntryCount",
    "invalidAmountCount",
  ];

  (Array.isArray(compositions) ? compositions : []).forEach((composition) => {
    for (const lifecycle of ["planned", "received"]) {
      for (const field of numericFields) result[lifecycle][field] += Number(composition?.[lifecycle]?.[field]) || 0;
    }
  });

  finalize(result.planned);
  finalize(result.received);
  return result;
}
