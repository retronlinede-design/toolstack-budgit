import React, { useEffect, useMemo, useRef, useState } from "react";

// ToolStack Budgit — Simple monthly budgeting tool (free)
// - Runs fully in-browser
// - Saves to localStorage
// - Tracks Income + Expenses for each month
// - Expenses support user-labeled sections (Creditors, Loans, Transport, etc.)
// - Labels are edited inline (no prompt dialogs)
// - Drag & drop reordering (income + expense items; expenses can be moved between sections)
// - Collapsible expense sections
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

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const arrayMove = (arr, fromIndex, toIndex) => {
  const a = Array.isArray(arr) ? [...arr] : [];
  if (!a.length) return a;
  const from = clamp(fromIndex, 0, a.length - 1);
  const to = clamp(toIndex, 0, a.length - 1);
  if (from === to) return a;
  const [item] = a.splice(from, 1);
  a.splice(to, 0, item);
  return a;
};

function SmallButton({ children, onClick, tone = "default", className = "", disabled, title, type = "button" }) {
  const cls =
    tone === "primary"
      ? "bg-neutral-900 hover:bg-neutral-800 text-white border-neutral-900 shadow-sm"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200 shadow-sm"
        : "bg-white hover:bg-neutral-50 text-neutral-900 border-neutral-200 shadow-sm";

  return (
    <button
      type={type}
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

function DragHandle({ title = "Drag to reorder" }) {
  return (
    <div
      title={title}
      className="print:hidden select-none h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm flex items-center justify-center text-neutral-700 cursor-grab active:cursor-grabbing"
      aria-label={title}
    >
      <span className="leading-none text-lg">⋮⋮</span>
    </div>
  );
}

/** ToolStack — Help Pack v1 (shared modal) */
function HelpModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl bg-white border border-neutral-200 shadow-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-100 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-neutral-900">Help</div>
            <div className="text-sm text-neutral-600 mt-1">How your data is saved + how to keep continuity.</div>
            <div className="mt-3 h-[2px] w-56 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
          </div>
          <button
            type="button"
            className="px-3 py-2 rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-900 transition"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Autosave (default)</div>
            <div className="text-sm text-neutral-700 mt-1">
              Budgit saves automatically in your browser (localStorage) under:
              <span className="ml-2 font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg px-2 py-1">
                {LS_KEY}
              </span>
            </div>
            <div className="text-xs text-neutral-500 mt-2">
              If you clear browser data or switch devices/browsers, your local data won’t follow automatically.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Best practice (continuity)</div>
            <ul className="mt-2 space-y-2 text-sm text-neutral-700 list-disc pl-5">
              <li>
                Use <span className="font-semibold">Export</span> once a week (or after big updates) to create a backup
                JSON file.
              </li>
              <li>Store that JSON in a safe place (Google Drive / iCloud / email to yourself / USB).</li>
              <li>
                On a new device/browser, use <span className="font-semibold">Import</span> to restore everything.
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Reordering (drag & drop)</div>
            <div className="text-sm text-neutral-700 mt-1">
              Grab the <span className="font-semibold">⋮⋮</span> handle to reorder items. Expense items can also be
              moved into a different section by dropping them there.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Printing / PDF</div>
            <div className="text-sm text-neutral-700 mt-1">
              Use <span className="font-semibold">Preview</span> to check the layout, then{" "}
              <span className="font-semibold">Print / Save PDF</span> and choose “Save as PDF”.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Privacy</div>
            <div className="text-sm text-neutral-700 mt-1">
              Budgit runs in your browser. There’s no account system here yet, and nothing is uploaded unless you choose
              to share your exported file.
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-neutral-100 text-xs text-neutral-500">ToolStack • Help Pack v1</div>
      </div>
    </div>
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

  // Help Pack v1
  const [helpOpen, setHelpOpen] = useState(false);

  // Collapsed expense groups (UI-only)
  const [collapsed, setCollapsed] = useState(() => ({}));

  // Drag state (UI-only)
  const [drag, setDrag] = useState(null);
  const [dropHint, setDropHint] = useState(null);

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
    return groups.reduce((sum, g) => sum + (g.items || []).reduce((s2, it) => s2 + toNumber(it.amount), 0), 0);
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
    setCollapsed((c) => ({ ...c, [newId]: false }));
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

    setCollapsed((c) => {
      const n = { ...(c || {}) };
      delete n[groupId];
      return n;
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

    // If collapsed, auto-open
    setCollapsed((c) => ({ ...c, [groupId]: false }));
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
    setCollapsed({});
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
    setCollapsed({});
    notify("Imported");
  };

  const openPreview = () => setPreviewOpen(true);

  // Drag & drop helpers
  const setDragPayload = (payload, e) => {
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    } catch {
      // ignore
    }
    setDrag(payload);
  };

  const readDragPayload = (e) => {
    try {
      const j = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
      if (!j) return drag;
      const p = safeParse(j, null);
      return p || drag;
    } catch {
      return drag;
    }
  };

  const clearDragState = () => {
    setDrag(null);
    setDropHint(null);
  };

  const moveIncomeItem = (fromId, toId) => {
    updateMonth((cur) => {
      const items = [...(cur.incomes || [])];
      const fromIndex = items.findIndex((x) => x.id === fromId);
      const toIndex = items.findIndex((x) => x.id === toId);
      if (fromIndex < 0 || toIndex < 0) return cur;
      return { ...cur, incomes: arrayMove(items, fromIndex, toIndex) };
    });
  };

  const moveExpenseItem = (fromGroupId, fromItemId, toGroupId, toItemId) => {
    updateMonth((cur) => {
      const groups = (cur.expenseGroups || []).map((g) => ({ ...g, items: [...(g.items || [])] }));
      const fromG = groups.find((g) => g.id === fromGroupId);
      const toG = groups.find((g) => g.id === toGroupId);
      if (!fromG || !toG) return cur;

      const fromIndex = fromG.items.findIndex((x) => x.id === fromItemId);
      if (fromIndex < 0) return cur;

      const [moved] = fromG.items.splice(fromIndex, 1);
      if (!moved) return cur;

      // If dropping onto empty list / group container, append
      if (!toItemId) {
        toG.items.push(moved);
      } else {
        const toIndex = toG.items.findIndex((x) => x.id === toItemId);
        if (toIndex < 0) toG.items.push(moved);
        else toG.items.splice(toIndex, 0, moved);
      }

      return { ...cur, expenseGroups: groups };
    });

    // ensure target group is visible
    setCollapsed((c) => ({ ...c, [toGroupId]: false }));
  };

  // Preview-only computed structures
  const previewIncomes = active.incomes || [];
  const previewGroups = active.expenseGroups || [];

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <style>{`
        :root { color-scheme: light; }
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-none { border: none !important; }
          .print\\:p-0 { padding: 0 !important; }
        }
      `}</style>

      {/* Help Pack v1 */}
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

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
                    <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-900">Income</div>
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
                    <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-900">Expenses</div>
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
            <div className="text-sm text-neutral-600">Simple monthly budget • reorder items • clear section totals</div>
            <div className="mt-3 h-[2px] w-80 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
          </div>

          <div className="w-full sm:w-[520px] lg:w-[620px]">
            {/* Top actions + pinned Help icon (standard) */}
            <div className="relative">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 pr-12">
                <ActionButton onClick={openPreview}>Preview</ActionButton>
                <ActionButton onClick={() => window.print()}>Print / Save PDF</ActionButton>
                <ActionButton onClick={exportJSON}>Export</ActionButton>
                <ActionFileButton onFile={(f) => importJSON(f)} tone="primary">
                  Import
                </ActionFileButton>
              </div>

              <button
                type="button"
                title="Help"
                onClick={() => setHelpOpen(true)}
                className="print:hidden absolute right-0 top-0 h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm flex items-center justify-center font-bold text-neutral-900"
                aria-label="Help"
              >
                ?
              </button>
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
                  className="print:hidden rounded-xl border border-neutral-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-lime-300"
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
                      <div
                        key={i.id}
                        className={`grid grid-cols-12 gap-2 items-center rounded-2xl p-2 border ${
                          dropHint?.type === "income" && dropHint?.overId === i.id
                            ? "border-lime-300 bg-lime-50/30"
                            : "border-transparent"
                        }`}
                        onDragOver={(e) => {
                          const p = readDragPayload(e);
                          if (p?.type !== "income") return;
                          e.preventDefault();
                          setDropHint({ type: "income", overId: i.id });
                        }}
                        onDrop={(e) => {
                          const p = readDragPayload(e);
                          if (!p || p.type !== "income") return;
                          e.preventDefault();
                          if (p.itemId && p.itemId !== i.id) moveIncomeItem(p.itemId, i.id);
                          clearDragState();
                        }}
                      >
                        <div
                          className="col-span-1"
                          draggable
                          onDragStart={(e) => setDragPayload({ type: "income", itemId: i.id }, e)}
                          onDragEnd={() => clearDragState()}
                        >
                          <DragHandle title="Drag income item" />
                        </div>

                        <input
                          className="col-span-6 rounded-xl border border-neutral-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-lime-300"
                          value={i.name || ""}
                          onChange={(e) => updateIncome(i.id, { name: e.target.value })}
                          placeholder="Income name"
                        />
                        <input
                          className="col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-300"
                          value={i.amount ?? 0}
                          onChange={(e) => updateIncome(i.id, { amount: e.target.value })}
                          inputMode="decimal"
                          placeholder="0"
                        />
                        <button
                          className="print:hidden col-span-1 h-10 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 px-3"
                          title="Remove"
                          onClick={() => deleteIncome(i.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}

                  {(active.incomes || []).length ? (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div className="text-sm text-neutral-600">Total income</div>
                      <div className="font-semibold text-neutral-900">
                        <Money value={incomeTotal} />
                      </div>
                    </div>
                  ) : null}
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
                  {(active.expenseGroups || []).map((g) => {
                    const isCollapsed = !!collapsed[g.id];
                    const itemsCount = (g.items || []).length;
                    return (
                      <div
                        key={g.id}
                        className={`rounded-2xl border border-neutral-200 overflow-hidden ${
                          dropHint?.type === "expenseGroup" && dropHint?.overGroupId === g.id
                            ? "ring-2 ring-lime-300"
                            : ""
                        }`}
                        onDragOver={(e) => {
                          const p = readDragPayload(e);
                          if (p?.type !== "expense") return;
                          e.preventDefault();
                          setDropHint({ type: "expenseGroup", overGroupId: g.id });
                        }}
                        onDrop={(e) => {
                          const p = readDragPayload(e);
                          if (!p || p.type !== "expense") return;
                          e.preventDefault();
                          // Drop onto group container -> append into this group
                          if (p.fromGroupId && p.itemId) moveExpenseItem(p.fromGroupId, p.itemId, g.id, null);
                          clearDragState();
                        }}
                      >
                        <div className="px-3 py-2 border-b border-neutral-100 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="print:hidden h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm flex items-center justify-center"
                              title={isCollapsed ? "Expand" : "Collapse"}
                              onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c?.[g.id] }))}
                            >
                              <span className="text-lg leading-none">{isCollapsed ? "▸" : "▾"}</span>
                            </button>

                            <input
                              ref={focusGroupId === g.id ? groupLabelInputRef : null}
                              className="w-[220px] max-w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 font-semibold text-neutral-900 focus:outline-none focus:ring-2 focus:ring-lime-300"
                              value={g.label ?? ""}
                              onChange={(e) => updateExpenseGroupLabel(g.id, e.target.value)}
                              onBlur={() => normalizeExpenseGroupLabel(g.id)}
                              placeholder="Section label (e.g., Loans)"
                            />

                            <div className="text-sm text-neutral-600 hidden sm:block">
                              {itemsCount} item{itemsCount === 1 ? "" : "s"} • Total:{" "}
                              <span className="font-semibold text-neutral-900">
                                <Money value={groupTotal(g)} />
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <div className="text-sm text-neutral-600 sm:hidden">
                              {itemsCount} item{itemsCount === 1 ? "" : "s"} •{" "}
                              <span className="font-semibold text-neutral-900">
                                <Money value={groupTotal(g)} />
                              </span>
                            </div>
                            <SmallButton tone="primary" onClick={() => addExpenseItem(g.id)}>
                              + Add item
                            </SmallButton>
                            <SmallButton tone="danger" onClick={() => deleteExpenseGroup(g.id)}>
                              Delete
                            </SmallButton>
                          </div>
                        </div>

                        {!isCollapsed ? (
                          <div className="p-3 space-y-2">
                            {(g.items || []).length === 0 ? (
                              <div className="text-sm text-neutral-600">No items in this section.</div>
                            ) : (
                              (g.items || []).map((e) => (
                                <div
                                  key={e.id}
                                  className={`grid grid-cols-12 gap-2 items-center rounded-2xl p-2 border ${
                                    dropHint?.type === "expense" &&
                                    dropHint?.overGroupId === g.id &&
                                    dropHint?.overItemId === e.id
                                      ? "border-lime-300 bg-lime-50/30"
                                      : "border-transparent"
                                  }`}
                                  onDragOver={(ev) => {
                                    const p = readDragPayload(ev);
                                    if (p?.type !== "expense") return;
                                    ev.preventDefault();
                                    setDropHint({ type: "expense", overGroupId: g.id, overItemId: e.id });
                                  }}
                                  onDrop={(ev) => {
                                    const p = readDragPayload(ev);
                                    if (!p || p.type !== "expense") return;
                                    ev.preventDefault();
                                    if (p.fromGroupId && p.itemId) {
                                      // Drop onto a specific item -> insert before it
                                      if (!(p.fromGroupId === g.id && p.itemId === e.id)) {
                                        moveExpenseItem(p.fromGroupId, p.itemId, g.id, e.id);
                                      }
                                    }
                                    clearDragState();
                                  }}
                                >
                                  <div
                                    className="col-span-1"
                                    draggable
                                    onDragStart={(ev) =>
                                      setDragPayload({ type: "expense", fromGroupId: g.id, itemId: e.id }, ev)
                                    }
                                    onDragEnd={() => clearDragState()}
                                  >
                                    <DragHandle title="Drag expense item" />
                                  </div>

                                  <input
                                    className="col-span-6 rounded-xl border border-neutral-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-lime-300"
                                    value={e.name || ""}
                                    onChange={(ev) => updateExpenseItem(g.id, e.id, { name: ev.target.value })}
                                    placeholder="Expense name"
                                  />
                                  <input
                                    className="col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-300"
                                    value={e.amount ?? 0}
                                    onChange={(ev) => updateExpenseItem(g.id, e.id, { amount: ev.target.value })}
                                    inputMode="decimal"
                                    placeholder="0"
                                  />
                                  <button
                                    className="print:hidden col-span-1 h-10 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 px-3"
                                    title="Remove"
                                    onClick={() => deleteExpenseItem(g.id, e.id)}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        ) : (
                          <div className="p-3 text-sm text-neutral-600">
                            Collapsed. Drop an item here to move it into this section.
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {(active.expenseGroups || []).length === 0 ? (
                    <div className="text-sm text-neutral-600">No expense sections yet. Click “Add section”.</div>
                  ) : (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div className="text-sm text-neutral-600">Total expenses</div>
                      <div className="font-semibold text-neutral-900">
                        <Money value={expenseTotal} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100">
                  <div className="font-semibold text-neutral-900">Notes</div>
                </div>
                <div className="p-4">
                  <textarea
                    className="w-full rounded-xl border border-neutral-200 px-3 py-2 bg-white min-h-[90px] focus:outline-none focus:ring-2 focus:ring-lime-300"
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

              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-600">Quick view</div>
                <div className="mt-2 text-sm text-neutral-700 space-y-1">
                  <div className="flex items-center justify-between">
                    <span>Sections</span>
                    <span className="font-medium text-neutral-900">{(active.expenseGroups || []).length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Expense items</span>
                    <span className="font-medium text-neutral-900">
                      {(active.expenseGroups || []).reduce((s, g) => s + (g.items || []).length, 0)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="text-xs text-neutral-500">
                Tip: Use “Preview” to check layout before saving to PDF. Drag items using the ⋮⋮ handle.
              </div>
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
