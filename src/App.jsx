import React, { useEffect, useMemo, useRef, useState } from "react";

// ToolStack Budgit — Simple monthly budgeting tool (free)
// - Runs fully in-browser
// - Saves to localStorage
// - Tracks Income + Expenses for each month
// - Expenses support user-labeled sections (Creditors, Loans, Transport, etc.)
// - Labels are edited inline (no prompt dialogs)
// - Print to PDF via browser Print
// - Export/Import JSON backup
// - Print Preview (in-app)

const LS_KEY = "toolstack_budgit_v1";

const uid = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
};

const monthKey = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`; // YYYY-MM
};

const monthLabel = (ym) => {
  const [y, m] = String(ym || "").split("-");
  if (!y || !m) return String(ym || "");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
};

const safeParse = (s, fallback) => {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const toNumber = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

function SmallButton({ children, onClick, tone = "default", className = "", disabled, title }) {
  const cls =
    tone === "primary"
      ? "bg-neutral-900 hover:bg-neutral-800 text-white border-neutral-900 shadow-sm"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200 shadow-sm"
        : "bg-white hover:bg-neutral-50 text-neutral-900 border-neutral-200 shadow-sm";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden px-3 py-2 rounded-xl text-sm font-medium border transition active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

/** Normalized Top Actions (mobile-aligned “table/grid”) */
const ACTION_BASE =
  "print:hidden h-10 w-full rounded-xl text-sm font-medium border transition shadow-sm active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center";

function ActionButton({ children, onClick, tone = "default", disabled, title }) {
  const cls =
    tone === "primary"
      ? "bg-neutral-900 hover:bg-neutral-800 text-white border-neutral-900"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
        : "bg-white hover:bg-neutral-50 text-neutral-900 border-neutral-200";

  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${ACTION_BASE} ${cls}`}>
      {children}
    </button>
  );
}

function ActionFileButton({ children, onFile, accept = "application/json", tone = "primary", title }) {
  const cls =
    tone === "primary"
      ? "bg-neutral-900 hover:bg-neutral-800 text-white border-neutral-900"
      : "bg-white hover:bg-neutral-50 text-neutral-900 border-neutral-200";

  return (
    <label title={title} className={`${ACTION_BASE} ${cls} cursor-pointer`}>
      <span>{children}</span>
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onFile?.(e.target.files?.[0] || null)}
      />
    </label>
  );
}

function Money({ value }) {
  const v = Number(value) || 0;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return (
    <span className="tabular-nums">
      {sign}€{abs.toFixed(2)}
    </span>
  );
}

// Migration:
// - Legacy: { expenses: [] }
// - New: { expenseGroups: [{ id, label, items: [] }] }
function normalizeMonthData(monthData) {
  const m = monthData || { incomes: [], expenses: [], notes: "" };

  const incomes = Array.isArray(m.incomes) ? m.incomes : [];

  if (Array.isArray(m.expenseGroups)) {
    const groups = m.expenseGroups
      .filter(Boolean)
      .map((g) => ({
        id: g.id || uid(),
        label: typeof g.label === "string" ? g.label : "",
        items: Array.isArray(g.items) ? g.items : [],
      }));

    return {
      incomes,
      expenseGroups: groups.length ? groups : [{ id: uid(), label: "General", items: [] }],
      notes: typeof m.notes === "string" ? m.notes : "",
    };
  }

  const legacyExpenses = Array.isArray(m.expenses) ? m.expenses : [];
  return {
    incomes,
    expenseGroups: [{ id: uid(), label: "General", items: legacyExpenses }],
    notes: typeof m.notes === "string" ? m.notes : "",
  };
}

export default function BudgitApp() {
  const [app, setApp] = useState(() => {
    const base = {
      activeMonth: monthKey(),
      months: {
        // "YYYY-MM": { incomes: [...], expenseGroups: [{id,label,items:[...]}], notes: "" }
      },
    };

    const saved = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    const data = saved ? safeParse(saved, base) : base;

    const m = data.activeMonth || monthKey();
    data.activeMonth = m;
    data.months = data.months || {};

    // normalize all months
    Object.keys(data.months).forEach((k) => {
      data.months[k] = normalizeMonthData(data.months[k]);
    });
    if (!data.months[m]) data.months[m] = normalizeMonthData(null);

    return data;
  });

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [focusGroupId, setFocusGroupId] = useState(null);
  const groupLabelInputRef = useRef(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const notify = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(app));
  }, [app]);

  const active = useMemo(() => {
    const m = app.activeMonth;
    return normalizeMonthData(app.months?.[m]);
  }, [app]);

  useEffect(() => {
    if (!focusGroupId) return;
    const t = setTimeout(() => {
      try {
        groupLabelInputRef.current?.focus?.();
        groupLabelInputRef.current?.select?.();
      } catch {
        // ignore
      }
    }, 0);
    return () => clearTimeout(t);
  }, [focusGroupId]);

  const incomeTotal = useMemo(
    () => (active.incomes || []).reduce((sum, i) => sum + toNumber(i.amount), 0),
    [active.incomes]
  );

  const expenseTotal = useMemo(() => {
    const groups = active.expenseGroups || [];
    return groups.reduce(
      (sum, g) => sum + (g.items || []).reduce((s2, it) => s2 + toNumber(it.amount), 0),
      0
    );
  }, [active.expenseGroups]);

  const net = useMemo(() => incomeTotal - expenseTotal, [incomeTotal, expenseTotal]);

  const savingsRate = useMemo(() => {
    if (!incomeTotal) return 0;
    return (net / incomeTotal) * 100;
  }, [net, incomeTotal]);

  const updateMonth = (updater) => {
    setApp((a) => {
      const m = a.activeMonth;
      const months = { ...(a.months || {}) };
      const cur = normalizeMonthData(months[m]);
      months[m] = normalizeMonthData(updater(cur));
      return { ...a, months };
    });
  };

  const ensureMonth = (m) => {
    setApp((a) => {
      const months = { ...(a.months || {}) };
      if (!months[m]) months[m] = normalizeMonthData(null);
      return { ...a, activeMonth: m, months };
    });
  };

  // Income actions
  const addIncome = () => {
    const item = { id: uid(), name: "Salary", amount: 0 };
    updateMonth((cur) => ({ ...cur, incomes: [item, ...(cur.incomes || [])] }));
  };

  const updateIncome = (id, patch) => {
    updateMonth((cur) => ({
      ...cur,
      incomes: (cur.incomes || []).map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  };

  const deleteIncome = (id) => {
    updateMonth((cur) => ({
      ...cur,
      incomes: (cur.incomes || []).filter((x) => x.id !== id),
    }));
  };

  // Expense sections
  const addExpenseGroup = () => {
    const newId = uid();
    const group = { id: newId, label: "New section", items: [] };
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: [group, ...(cur.expenseGroups || [])],
    }));
    setFocusGroupId(newId);
  };

  const updateExpenseGroupLabel = (groupId, label) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => (g.id === groupId ? { ...g, label } : g)),
    }));
  };

  const normalizeExpenseGroupLabel = (groupId) => {
    const g = (active.expenseGroups || []).find((x) => x.id === groupId);
    const clean = String(g?.label ?? "").trim();
    updateExpenseGroupLabel(groupId, clean || "General");
    setFocusGroupId(null);
  };

  const deleteExpenseGroup = (groupId) => {
    const g = (active.expenseGroups || []).find((x) => x.id === groupId);
    const name = (g?.label || "this section").trim();
    const ok = window.confirm(`Delete “${name}” and all items inside it?`);
    if (!ok) return;

    updateMonth((cur) => {
      const next = (cur.expenseGroups || []).filter((x) => x.id !== groupId);
      return {
        ...cur,
        expenseGroups: next.length ? next : [{ id: uid(), label: "General", items: [] }],
      };
    });
  };

  const addExpenseItem = (groupId) => {
    const item = { id: uid(), name: "Expense", amount: 0 };
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) =>
        g.id === groupId ? { ...g, items: [item, ...(g.items || [])] } : g
      ),
    }));
  };

  const updateExpenseItem = (groupId, itemId, patch) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          items: (g.items || []).map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
        };
      }),
    }));
  };

  const deleteExpenseItem = (groupId, itemId) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, items: (g.items || []).filter((it) => it.id !== itemId) };
      }),
    }));
  };

  const groupTotal = (group) => (group.items || []).reduce((s, it) => s + toNumber(it.amount), 0);

  const clearMonth = () => {
    const ok = window.confirm("Clear all income and expenses for this month?");
    if (!ok) return;
    setApp((a) => {
      const m = a.activeMonth;
      const months = { ...(a.months || {}) };
      months[m] = normalizeMonthData({
        incomes: [],
        expenseGroups: [{ id: uid(), label: "General", items: [] }],
        notes: "",
      });
      return { ...a, months };
    });
    notify("Month cleared");
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(app, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `toolstack-budgit-${app.activeMonth}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importJSON = async (file) => {
    if (!file) return;
    const text = await file.text();
    const parsed = safeParse(text, null);
    if (!parsed || !parsed.months) {
      notify("Invalid JSON");
      return;
    }

    const months = { ...(parsed.months || {}) };
    Object.keys(months).forEach((k) => {
      months[k] = normalizeMonthData(months[k]);
    });

    const next = {
      activeMonth: parsed.activeMonth || monthKey(),
      months,
    };
    next.months[next.activeMonth] = normalizeMonthData(next.months[next.activeMonth]);

    setApp(next);
    notify("Imported");
  };

  const openPreview = () => setPreviewOpen(true);

  // Preview-only computed structures
  const previewIncomes = active.incomes || [];
  const previewGroups = active.expenseGroups || [];

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <style>{`
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-none { border: none !important; }
          .print\\:p-0 { padding: 0 !important; }
        }
      `}</style>

      {/* When preview is open, print only the preview sheet */}
      {previewOpen ? (
        <style>{`
          @media print {
            body * { visibility: hidden !important; }
            #budgit-print-preview, #budgit-print-preview * { visibility: visible !important; }
            #budgit-print-preview { position: absolute !important; left: 0; top: 0; width: 100%; }
          }
        `}</style>
      ) : null}

      {/* Print Preview Modal */}
      {previewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
          <div className="absolute inset-0 bg-black/40" onClick={() => setPreviewOpen(false)} />

          <div className="relative w-full max-w-4xl">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-lg font-semibold text-white">Print preview</div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-2 rounded-xl text-sm font-medium border border-white/40 bg-white/10 hover:bg-white/15 text-white transition"
                  onClick={() => window.print()}
                >
                  Print / Save PDF
                </button>
                <button
                  className="px-3 py-2 rounded-xl text-sm font-medium border border-white/40 bg-white/10 hover:bg-white/15 text-white transition"
                  onClick={() => setPreviewOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-neutral-200 shadow-lg overflow-auto max-h-[80vh]">
              <div id="budgit-print-preview" className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-2xl font-semibold text-neutral-900">Budgit</div>
                    <div className="text-sm text-neutral-600">{monthLabel(app.activeMonth)}</div>
                    <div className="mt-3 h-[2px] w-64 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
                  </div>
                  <div className="text-sm text-neutral-600">Generated: {new Date().toLocaleString()}</div>
                </div>

                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-neutral-200">
                    <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-900">
                      Income
                    </div>
                    <div className="p-4 space-y-2">
                      {previewIncomes.length === 0 ? (
                        <div className="text-sm text-neutral-600">No income items.</div>
                      ) : (
                        previewIncomes.map((i) => (
                          <div key={i.id} className="flex items-center justify-between gap-3">
                            <div className="text-neutral-900">{i.name || "(unnamed)"}</div>
                            <div className="font-semibold text-neutral-900">
                              <Money value={toNumber(i.amount)} />
                            </div>
                          </div>
                        ))
                      )}
                      <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-between">
                        <div className="font-semibold text-neutral-900">Total income</div>
                        <div className="font-semibold text-neutral-900">
                          <Money value={incomeTotal} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200">
                    <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-900">
                      Expenses
                    </div>
                    <div className="p-4 space-y-4">
                      {previewGroups.length === 0 ? (
                        <div className="text-sm text-neutral-600">No expense sections.</div>
                      ) : (
                        previewGroups.map((g) => (
                          <div key={g.id} className="rounded-2xl border border-neutral-200">
                            <div className="px-3 py-2 border-b border-neutral-100 flex items-center justify-between">
                              <div className="font-semibold text-neutral-900">{(g.label || "General").trim()}</div>
                              <div className="font-semibold text-neutral-900">
                                <Money value={groupTotal(g)} />
                              </div>
                            </div>
                            <div className="p-3 space-y-2">
                              {(g.items || []).length === 0 ? (
                                <div className="text-sm text-neutral-600">No items.</div>
                              ) : (
                                (g.items || []).map((e) => (
                                  <div key={e.id} className="flex items-center justify-between gap-3">
                                    <div className="text-neutral-900">{e.name || "(unnamed)"}</div>
                                    <div className="text-neutral-900">
                                      <Money value={toNumber(e.amount)} />
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        ))
                      )}

                      <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                        <div className="font-semibold text-neutral-900">Total expenses</div>
                        <div className="font-semibold text-neutral-900">
                          <Money value={expenseTotal} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`rounded-2xl border p-4 ${net >= 0 ? "border-emerald-200" : "border-red-200"}`}>
                    <div className="text-sm text-neutral-600">Net</div>
                    <div className="text-2xl font-semibold text-neutral-900 mt-1">
                      <Money value={net} />
                    </div>
                    <div className="text-xs text-neutral-600 mt-2">
                      Savings rate: <span className="font-medium">{savingsRate.toFixed(1)}%</span>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200 p-4">
                    <div className="text-sm text-neutral-600">Notes</div>
                    <div className="mt-2 whitespace-pre-wrap text-neutral-900 text-sm">
                      {String(active.notes || "").trim() ? active.notes : "(none)"}
                    </div>
                  </div>
                </div>

                <div className="mt-4 text-xs text-neutral-500">
                  Tip: If the preview looks right, hit “Print / Save PDF” and choose “Save as PDF”.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Header + normalized actions */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-2xl font-semibold text-neutral-900">Budgit</div>
            <div className="text-sm text-neutral-600">
              Simple monthly budget • income at the top • expenses below • totals at the bottom
            </div>
            <div className="mt-3 h-[2px] w-80 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
          </div>

          <div className="w-full sm:w-[520px] lg:w-[620px]">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ActionButton onClick={openPreview}>Preview</ActionButton>
              <ActionButton onClick={() => window.print()}>Print / Save PDF</ActionButton>
              <ActionButton onClick={exportJSON}>Export</ActionButton>
              <ActionFileButton onFile={(f) => importJSON(f)} tone="primary">
                Import
              </ActionFileButton>
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2 rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
            <div className="px-4 py-3 border-b border-neutral-100 flex items-center justify-between gap-3">
              <div className="font-semibold text-neutral-900">Month</div>
              <div className="flex items-center gap-2">
                <input
                  type="month"
                  value={app.activeMonth}
                  onChange={(e) => ensureMonth(e.target.value)}
                  className="print:hidden rounded-xl border border-neutral-200 px-3 py-2 text-sm bg-white"
                />
                <SmallButton tone="danger" onClick={clearMonth}>
                  Clear
                </SmallButton>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Income */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100 flex items-center justify-between">
                  <div className="font-semibold text-neutral-900">Income</div>
                  <SmallButton tone="primary" onClick={addIncome}>
                    + Add income
                  </SmallButton>
                </div>
                <div className="p-4 space-y-2">
                  {(active.incomes || []).length === 0 ? (
                    <div className="text-sm text-neutral-600">No income items yet.</div>
                  ) : (
                    (active.incomes || []).map((i) => (
                      <div key={i.id} className="grid grid-cols-12 gap-2 items-center">
                        <input
                          className="col-span-7 rounded-xl border border-neutral-200 px-3 py-2 bg-white"
                          value={i.name || ""}
                          onChange={(e) => updateIncome(i.id, { name: e.target.value })}
                          placeholder="Income name"
                        />
                        <input
                          className="col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right tabular-nums"
                          value={i.amount ?? 0}
                          onChange={(e) => updateIncome(i.id, { amount: e.target.value })}
                          inputMode="decimal"
                          placeholder="0"
                        />
                        <button
                          className="print:hidden col-span-1 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 px-3 py-2"
                          title="Remove"
                          onClick={() => deleteIncome(i.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Expenses */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100 flex items-center justify-between">
                  <div className="font-semibold text-neutral-900">Expenses</div>
                  <SmallButton tone="primary" onClick={addExpenseGroup}>
                    + Add section
                  </SmallButton>
                </div>

                <div className="p-4 space-y-3">
                  {(active.expenseGroups || []).map((g) => (
                    <div key={g.id} className="rounded-2xl border border-neutral-200">
                      <div className="px-3 py-2 border-b border-neutral-100 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div className="flex items-center gap-2">
                          <input
                            ref={focusGroupId === g.id ? groupLabelInputRef : null}
                            className="w-[220px] max-w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 font-semibold text-neutral-900"
                            value={g.label ?? ""}
                            onChange={(e) => updateExpenseGroupLabel(g.id, e.target.value)}
                            onBlur={() => normalizeExpenseGroupLabel(g.id)}
                            placeholder="Section label (e.g., Loans)"
                          />
                          <div className="text-sm text-neutral-600">
                            Total:{" "}
                            <span className="font-semibold text-neutral-900">
                              <Money value={groupTotal(g)} />
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <SmallButton tone="primary" onClick={() => addExpenseItem(g.id)}>
                            + Add item
                          </SmallButton>
                          <SmallButton tone="danger" onClick={() => deleteExpenseGroup(g.id)}>
                            Delete section
                          </SmallButton>
                        </div>
                      </div>

                      <div className="p-3 space-y-2">
                        {(g.items || []).length === 0 ? (
                          <div className="text-sm text-neutral-600">No items in this section.</div>
                        ) : (
                          (g.items || []).map((e) => (
                            <div key={e.id} className="grid grid-cols-12 gap-2 items-center">
                              <input
                                className="col-span-7 rounded-xl border border-neutral-200 px-3 py-2 bg-white"
                                value={e.name || ""}
                                onChange={(ev) => updateExpenseItem(g.id, e.id, { name: ev.target.value })}
                                placeholder="Expense name"
                              />
                              <input
                                className="col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right tabular-nums"
                                value={e.amount ?? 0}
                                onChange={(ev) => updateExpenseItem(g.id, e.id, { amount: ev.target.value })}
                                inputMode="decimal"
                                placeholder="0"
                              />
                              <button
                                className="print:hidden col-span-1 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 px-3 py-2"
                                title="Remove"
                                onClick={() => deleteExpenseItem(g.id, e.id)}
                              >
                                ×
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ))}

                  {(active.expenseGroups || []).length === 0 ? (
                    <div className="text-sm text-neutral-600">No expense sections yet. Click “Add section”.</div>
                  ) : null}
                </div>
              </div>

              {/* Notes */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100">
                  <div className="font-semibold text-neutral-900">Notes</div>
                </div>
                <div className="p-4">
                  <textarea
                    className="w-full rounded-xl border border-neutral-200 px-3 py-2 bg-white min-h-[90px]"
                    value={active.notes || ""}
                    onChange={(e) => updateMonth((cur) => ({ ...cur, notes: e.target.value }))}
                    placeholder="Optional notes for this month…"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
            <div className="px-4 py-3 border-b border-neutral-100">
              <div className="font-semibold text-neutral-900">Summary</div>
            </div>
            <div className="p-4 space-y-4">
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-600">Total income</div>
                <div className="text-2xl font-semibold text-neutral-900 mt-1">
                  <Money value={incomeTotal} />
                </div>
              </div>
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-600">Total expenses</div>
                <div className="text-2xl font-semibold text-neutral-900 mt-1">
                  <Money value={expenseTotal} />
                </div>
              </div>
              <div className={`rounded-2xl border p-4 ${net >= 0 ? "border-emerald-200" : "border-red-200"}`}>
                <div className="text-sm text-neutral-600">Net</div>
                <div className="text-2xl font-semibold text-neutral-900 mt-1">
                  <Money value={net} />
                </div>
                <div className="text-xs text-neutral-600 mt-2">
                  Savings rate: <span className="font-medium">{savingsRate.toFixed(1)}%</span>
                </div>
              </div>

              <div className="text-xs text-neutral-500">Tip: Use “Preview” to check layout before saving to PDF.</div>
            </div>
          </div>
        </div>

        {toast ? (
          <div className="fixed bottom-6 right-6 rounded-2xl bg-neutral-900 text-white px-4 py-3 shadow-lg print:hidden">
            <div className="text-sm">{toast}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
