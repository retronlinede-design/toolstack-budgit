import React, { useEffect, useMemo, useRef, useState } from "react";

// ToolStack Budgit — Simple monthly budgeting tool (free)
// - Runs fully in-browser
// - Saves to localStorage
// - Tracks Income + Expenses for each month
// - Expenses support user-labeled sections (Creditors, Loans, Transport, etc.)
// - Labels are edited inline (no prompt dialogs)
// - Drag & drop reordering with TRUE insert positions (within a section + between sections)
// - Check off expenses as paid → Remaining totals update
// - Collapsible expense sections
// - Due day per expense + sort helper
// - Copy this month → next month (all or unpaid only)
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

const parseYM = (ym) => {
  const [y, m] = String(ym || "").split("-");
  return { y: Number(y), m: Number(m) };
};

const nextMonthKey = (ym) => {
  const { y, m } = parseYM(ym);
  if (!y || !m) return monthKey();
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() + 1);
  return monthKey(d);
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
      <input type="file" accept={accept} className="hidden" onChange={(e) => onFile?.(e.target.files?.[0] || null)} />
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

function PaidCheck({ checked, onChange }) {
  return (
    <button
      type="button"
      className={`print:hidden h-10 w-10 rounded-xl border shadow-sm flex items-center justify-center transition active:translate-y-[1px] ${
        checked
          ? "bg-lime-50 border-lime-200 text-lime-800"
          : "bg-white border-neutral-200 text-neutral-700 hover:bg-neutral-50"
      }`}
      title={checked ? "Paid" : "Unpaid"}
      onClick={() => onChange?.(!checked)}
      aria-label={checked ? "Paid" : "Unpaid"}
    >
      <span className="text-lg leading-none">{checked ? "✓" : "○"}</span>
    </button>
  );
}

function InsertDropZone({ active, onDragOver, onDrop }) {
  return (
    <div
      className="print:hidden relative"
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ height: 12 }}
    >
      <div
        className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full transition ${
          active ? "bg-lime-400" : "bg-transparent"
        }`}
      />
    </div>
  );
}

function SelectAllNumberInput({ className = "", value, onChange, placeholder, inputMode = "decimal", title }) {
  return (
    <input
      className={className}
      value={value}
      onChange={onChange}
      inputMode={inputMode}
      placeholder={placeholder}
      title={title}
      onFocus={(e) => {
        try {
          e.target.select();
        } catch {
          // ignore
        }
      }}
      onMouseUp={(e) => {
        // prevent mouseup from deselecting
        try {
          e.preventDefault();
        } catch {
          // ignore
        }
      }}
    />
  );
}

function TogglePill({ on, onToggle, labelOn = "On", labelOff = "Off", title }) {
  return (
    <button
      type="button"
      title={title}
      className={`print:hidden h-10 px-3 rounded-xl border shadow-sm flex items-center gap-2 text-sm font-medium transition active:translate-y-[1px] ${
        on ? "bg-lime-50 border-lime-200 text-neutral-900" : "bg-white border-neutral-200 text-neutral-900 hover:bg-neutral-50"
      }`}
      onClick={() => onToggle?.(!on)}
    >
      <span className={`inline-block h-5 w-9 rounded-full border transition ${on ? "bg-lime-200 border-lime-300" : "bg-neutral-100 border-neutral-200"}`}>
        <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition translate-y-[2px] ${on ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
      </span>
      <span>{on ? labelOn : labelOff}</span>
    </button>
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
              <span className="ml-2 font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg px-2 py-1">{LS_KEY}</span>
            </div>
            <div className="text-xs text-neutral-500 mt-2">
              If you clear browser data or switch devices/browsers, your local data won’t follow automatically.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Best practice (continuity)</div>
            <ul className="mt-2 space-y-2 text-sm text-neutral-700 list-disc pl-5">
              <li>
                Use <span className="font-semibold">Export</span> once a week (or after big updates) to create a backup JSON file.
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
              Grab the <span className="font-semibold">⋮⋮</span> handle. Drop on the <span className="font-semibold">green line</span> to insert at that exact position.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Paid checkoffs</div>
            <div className="text-sm text-neutral-700 mt-1">
              Click the <span className="font-semibold">○ / ✓</span> button to mark an expense as paid. Remaining totals update automatically.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Printing / PDF</div>
            <div className="text-sm text-neutral-700 mt-1">
              Use <span className="font-semibold">Preview</span> to check the layout, then <span className="font-semibold">Print / Save PDF</span> and choose “Save as PDF”.
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-900">Privacy</div>
            <div className="text-sm text-neutral-700 mt-1">
              Budgit runs in your browser. There’s no account system here yet, and nothing is uploaded unless you choose to share your exported file.
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-neutral-100 text-xs text-neutral-500">ToolStack • Help Pack v1</div>
      </div>
    </div>
  );
}

// ---------------------------
// Data normalization
// ---------------------------

function normalizeIncomeItem(i) {
  const it = i || {};
  return {
    id: it.id || uid(),
    name: typeof it.name === "string" ? it.name : "",
    amount: it.amount ?? 0,
  };
}

function normalizeExpenseItem(e) {
  const it = e || {};
  const dueRaw = it.dueDay;
  const due = Number.isFinite(Number(dueRaw)) ? Number(dueRaw) : null;
  return {
    id: it.id || uid(),
    name: typeof it.name === "string" ? it.name : "",
    amount: it.amount ?? 0,
    paid: !!it.paid,
    dueDay: due && due >= 1 && due <= 31 ? due : null,
  };
}

function normalizeExpenseGroup(g) {
  const gr = g || {};
  return {
    id: gr.id || uid(),
    label: typeof gr.label === "string" ? gr.label : "",
    items: Array.isArray(gr.items) ? gr.items.map(normalizeExpenseItem) : [],
  };
}

// Migration:
// - Legacy: { expenses: [] }
// - New: { expenseGroups: [{ id, label, items: [] }] }
function normalizeMonthData(monthData) {
  const m = monthData || { incomes: [], expenses: [], notes: "" };

  const incomes = Array.isArray(m.incomes) ? m.incomes.map(normalizeIncomeItem) : [];

  if (Array.isArray(m.expenseGroups)) {
    const groups = m.expenseGroups.filter(Boolean).map(normalizeExpenseGroup);

    return {
      incomes,
      expenseGroups: groups.length ? groups : [{ id: uid(), label: "General", items: [] }],
      notes: typeof m.notes === "string" ? m.notes : "",
    };
  }

  const legacyExpenses = Array.isArray(m.expenses) ? m.expenses.map(normalizeExpenseItem) : [];
  return {
    incomes,
    expenseGroups: [{ id: uid(), label: "General", items: legacyExpenses }],
    notes: typeof m.notes === "string" ? m.notes : "",
  };
}

// ---------------------------
// App
// ---------------------------

export default function BudgitApp() {
  const [app, setApp] = useState(() => {
    const base = {
      activeMonth: monthKey(),
      months: {
        // "YYYY-MM": { incomes: [...], expenseGroups: [{id,label,items:[...]}], notes: "" }
      },
      settings: {
        showPaid: true,
      },
    };

    const saved = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    const data = saved ? safeParse(saved, base) : base;

    data.settings = data.settings || { showPaid: true };
    if (typeof data.settings.showPaid !== "boolean") data.settings.showPaid = true;

    const m = data.activeMonth || monthKey();
    data.activeMonth = m;
    data.months = data.months || {};

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

  // Copy modal
  const [copyOpen, setCopyOpen] = useState(false);

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

  const showPaid = !!app.settings?.showPaid;

  const incomeTotal = useMemo(() => (active.incomes || []).reduce((sum, i) => sum + toNumber(i.amount), 0), [active.incomes]);

  const expensePlannedTotal = useMemo(() => {
    const groups = active.expenseGroups || [];
    return groups.reduce((sum, g) => sum + (g.items || []).reduce((s2, it) => s2 + toNumber(it.amount), 0), 0);
  }, [active.expenseGroups]);

  const expenseRemainingTotal = useMemo(() => {
    const groups = active.expenseGroups || [];
    return groups.reduce(
      (sum, g) =>
        sum +
        (g.items || []).reduce((s2, it) => {
          const amt = toNumber(it.amount);
          return it.paid ? s2 : s2 + amt;
        }, 0),
      0
    );
  }, [active.expenseGroups]);

  const netRemaining = useMemo(() => incomeTotal - expenseRemainingTotal, [incomeTotal, expenseRemainingTotal]);
  const savingsRate = useMemo(() => {
    if (!incomeTotal) return 0;
    return (netRemaining / incomeTotal) * 100;
  }, [netRemaining, incomeTotal]);

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

  const setSetting = (patch) => {
    setApp((a) => ({ ...a, settings: { ...(a.settings || {}), ...(patch || {}) } }));
  };

  // ---------------------------
  // Better month picker (month + year)
  // ---------------------------

  const monthNames = useMemo(() => {
    const base = new Date(2020, 0, 1);
    return Array.from({ length: 12 }, (_, idx) => {
      const d = new Date(base);
      d.setMonth(idx);
      return d.toLocaleDateString(undefined, { month: "long" });
    });
  }, []);

  const monthOptions = useMemo(() => monthNames.map((label, idx) => ({ value: String(idx + 1).padStart(2, "0"), label })), [monthNames]);

  const years = useMemo(() => {
    const keys = Object.keys(app.months || {});
    const present = new Set(keys.map((k) => String(k).split("-")[0]).filter(Boolean));
    const curY = new Date().getFullYear();
    for (let y = curY - 3; y <= curY + 3; y++) present.add(String(y));
    return Array.from(present).map((s) => Number(s)).filter(Boolean).sort((a, b) => a - b);
  }, [app.months]);

  const activeYM = useMemo(() => {
    const { y, m } = parseYM(app.activeMonth);
    return { y: String(y || new Date().getFullYear()), m: String(m || new Date().getMonth() + 1).padStart(2, "0") };
  }, [app.activeMonth]);

  const setMonthParts = (yStr, mStr) => {
    const y = String(yStr);
    const m = String(mStr).padStart(2, "0");
    ensureMonth(`${y}-${m}`);
  };

  const prevMonth = () => {
    const { y, m } = parseYM(app.activeMonth);
    const d = new Date(y, m - 1, 1);
    d.setMonth(d.getMonth() - 1);
    ensureMonth(monthKey(d));
  };

  const nextMonth = () => {
    const { y, m } = parseYM(app.activeMonth);
    const d = new Date(y, m - 1, 1);
    d.setMonth(d.getMonth() + 1);
    ensureMonth(monthKey(d));
  };

  // ---------------------------
  // Income actions
  // ---------------------------

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

  // ---------------------------
  // Expense sections
  // ---------------------------

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
    const item = { id: uid(), name: "Expense", amount: 0, paid: false, dueDay: null };
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => (g.id === groupId ? { ...g, items: [item, ...(g.items || [])] } : g)),
    }));

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

  const markAllPaid = (groupId, paid) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, items: (g.items || []).map((it) => ({ ...it, paid: !!paid })) };
      }),
    }));
  };

  const clearPaidInGroup = (groupId) => {
    const ok = window.confirm("Remove all PAID items in this section? This cannot be undone.");
    if (!ok) return;
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, items: (g.items || []).filter((it) => !it.paid) };
      }),
    }));
  };

  const sortGroupByDue = (groupId) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        const items = [...(g.items || [])];
        items.sort((a, b) => {
          const da = a.dueDay == null ? 999 : a.dueDay;
          const db = b.dueDay == null ? 999 : b.dueDay;
          if (da !== db) return da - db;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });
        return { ...g, items };
      }),
    }));
  };

  const groupPlannedTotal = (group) => (group.items || []).reduce((s, it) => s + toNumber(it.amount), 0);
  const groupRemainingTotal = (group) => (group.items || []).reduce((s, it) => (it.paid ? s : s + toNumber(it.amount)), 0);

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

  // ---------------------------
  // Export / Import
  // ---------------------------

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
      settings: {
        showPaid: typeof parsed.settings?.showPaid === "boolean" ? parsed.settings.showPaid : true,
      },
    };
    next.months[next.activeMonth] = normalizeMonthData(next.months[next.activeMonth]);

    setApp(next);
    setCollapsed({});
    notify("Imported");
  };

  const openPreview = () => setPreviewOpen(true);

  // ---------------------------
  // Drag & drop helpers (insert positions)
  // ---------------------------

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

  const moveIncomeInsert = (itemId, toIndex) => {
    updateMonth((cur) => {
      const items = [...(cur.incomes || [])];
      const fromIndex = items.findIndex((x) => x.id === itemId);
      if (fromIndex < 0) return cur;
      const to = clamp(toIndex, 0, items.length);
      const [moved] = items.splice(fromIndex, 1);
      const adj = fromIndex < to ? to - 1 : to;
      items.splice(clamp(adj, 0, items.length), 0, moved);
      return { ...cur, incomes: items };
    });
  };

  const moveExpenseInsert = (fromGroupId, itemId, toGroupId, toIndex) => {
    updateMonth((cur) => {
      const groups = (cur.expenseGroups || []).map((g) => ({ ...g, items: [...(g.items || [])] }));
      const fromG = groups.find((g) => g.id === fromGroupId);
      const toG = groups.find((g) => g.id === toGroupId);
      if (!fromG || !toG) return cur;

      const fromIndex = fromG.items.findIndex((x) => x.id === itemId);
      if (fromIndex < 0) return cur;

      const [moved] = fromG.items.splice(fromIndex, 1);
      if (!moved) return cur;

      const to = clamp(toIndex, 0, toG.items.length);
      let adj = to;
      if (fromGroupId === toGroupId && fromIndex < to) adj = to - 1;
      toG.items.splice(clamp(adj, 0, toG.items.length), 0, moved);

      return { ...cur, expenseGroups: groups };
    });

    setCollapsed((c) => ({ ...c, [toGroupId]: false }));
  };

  // ---------------------------
  // Copy month → next month
  // ---------------------------

  const copyToNextMonth = (mode) => {
    const srcKey = app.activeMonth;
    const dstKey = nextMonthKey(srcKey);

    const dstExists = !!app.months?.[dstKey];
    if (dstExists) {
      const ok = window.confirm(`Next month (${monthLabel(dstKey)}) already has data. Overwrite it?`);
      if (!ok) return;
    }

    const src = normalizeMonthData(app.months?.[srcKey]);

    const clone = {
      incomes: (src.incomes || []).map((i) => ({ ...i })),
      expenseGroups: (src.expenseGroups || []).map((g) => ({
        id: uid(),
        label: g.label,
        items: (g.items || [])
          .filter((it) => (mode === "unpaid" ? !it.paid : true))
          .map((it) => ({
            id: uid(),
            name: it.name,
            amount: it.amount ?? 0,
            paid: false,
            dueDay: it.dueDay ?? null,
          })),
      })),
      notes: "",
    };

    // Ensure at least one group
    if (!clone.expenseGroups.length) clone.expenseGroups = [{ id: uid(), label: "General", items: [] }];

    setApp((a) => {
      const months = { ...(a.months || {}) };
      months[dstKey] = normalizeMonthData(clone);
      return { ...a, months };
    });

    setCopyOpen(false);
    notify(mode === "unpaid" ? `Copied unpaid → ${monthLabel(dstKey)}` : `Copied month → ${monthLabel(dstKey)}`);
  };

  // ---------------------------
  // Preview computed structures
  // ---------------------------

  const previewIncomes = active.incomes || [];
  const previewGroups = active.expenseGroups || [];

  // ---------------------------
  // UI
  // ---------------------------

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

      {/* Copy modal */}
      {copyOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setCopyOpen(false)} />
          <div className="relative w-full max-w-lg rounded-2xl bg-white border border-neutral-200 shadow-xl overflow-hidden">
            <div className="p-4 border-b border-neutral-100 flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-neutral-900">Copy to next month</div>
                <div className="text-sm text-neutral-600 mt-1">Choose what to carry forward.</div>
                <div className="mt-3 h-[2px] w-56 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
              </div>
              <button
                type="button"
                className="px-3 py-2 rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-900 transition"
                onClick={() => setCopyOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="font-semibold text-neutral-900">Copy everything</div>
                <div className="text-sm text-neutral-700 mt-1">
                  Copies incomes + all expenses into next month. All expenses are set to unpaid.
                </div>
                <div className="mt-3">
                  <SmallButton tone="primary" onClick={() => copyToNextMonth("all")}>Copy everything</SmallButton>
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="font-semibold text-neutral-900">Copy unpaid only</div>
                <div className="text-sm text-neutral-700 mt-1">
                  Copies incomes + only unpaid expenses into next month. Unpaid stays unpaid.
                </div>
                <div className="mt-3">
                  <SmallButton tone="primary" onClick={() => copyToNextMonth("unpaid")}>Copy unpaid only</SmallButton>
                </div>
              </div>

              <div className="text-xs text-neutral-500">
                Note: If next month already has data, Budgit will ask before overwriting.
              </div>
            </div>
            <div className="p-4 border-t border-neutral-100 text-xs text-neutral-500">ToolStack • Budgit</div>
          </div>
        </div>
      ) : null}

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
                            <div className="px-3 py-2 border-b border-neutral-100">
                              <div className="flex items-center justify-between gap-3">
                                <div className="font-semibold text-neutral-900">{(g.label || "General").trim()}</div>
                                <div className="text-right">
                                  <div className="text-sm text-neutral-600">Remaining</div>
                                  <div className="font-semibold text-neutral-900">
                                    <Money value={groupRemainingTotal(g)} />
                                  </div>
                                </div>
                              </div>
                              <div className="text-xs text-neutral-500 mt-1">Planned: €{groupPlannedTotal(g).toFixed(2)}</div>
                            </div>
                            <div className="p-3 space-y-2">
                              {(g.items || []).length === 0 ? (
                                <div className="text-sm text-neutral-600">No items.</div>
                              ) : (
                                (g.items || []).map((e) => (
                                  <div key={e.id} className="flex items-center justify-between gap-3">
                                    <div className={`text-neutral-900 ${e.paid ? "line-through text-neutral-500" : ""}`}>
                                      {e.paid ? "✓ " : ""}
                                      {e.name || "(unnamed)"}
                                      {e.dueDay ? <span className="text-xs text-neutral-500 ml-2">(Due {e.dueDay})</span> : null}
                                    </div>
                                    <div className={`text-neutral-900 ${e.paid ? "text-neutral-500" : ""}`}>
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
                        <div>
                          <div className="font-semibold text-neutral-900">Remaining expenses</div>
                          <div className="text-xs text-neutral-500">Planned: €{expensePlannedTotal.toFixed(2)}</div>
                        </div>
                        <div className="font-semibold text-neutral-900">
                          <Money value={expenseRemainingTotal} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-emerald-200" : "border-red-200"}`}>
                    <div className="text-sm text-neutral-600">Net (after remaining)</div>
                    <div className="text-2xl font-semibold text-neutral-900 mt-1">
                      <Money value={netRemaining} />
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

                <div className="mt-4 text-xs text-neutral-500">Tip: If the preview looks right, hit “Print / Save PDF” and choose “Save as PDF”.</div>
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
            <div className="text-sm text-neutral-600">Simple monthly budget • mark paid • remaining totals update</div>
            <div className="mt-3 h-[2px] w-80 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
          </div>

          <div className="w-full sm:w-[520px] lg:w-[620px]">
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
                <button
                  type="button"
                  className="print:hidden h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm flex items-center justify-center"
                  title="Previous month"
                  onClick={prevMonth}
                >
                  ‹
                </button>

                <div className="print:hidden flex items-center gap-2">
                  <select
                    className="h-10 rounded-xl border border-neutral-200 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-lime-300"
                    value={activeYM.m}
                    onChange={(e) => setMonthParts(activeYM.y, e.target.value)}
                  >
                    {monthOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>

                  <select
                    className="h-10 rounded-xl border border-neutral-200 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-lime-300"
                    value={activeYM.y}
                    onChange={(e) => setMonthParts(e.target.value, activeYM.m)}
                  >
                    {years.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  className="print:hidden h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm flex items-center justify-center"
                  title="Next month"
                  onClick={nextMonth}
                >
                  ›
                </button>

                <SmallButton onClick={() => setCopyOpen(true)} title="Copy this month into next month">
                  Copy → next
                </SmallButton>

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

                <div className="p-4">
                  {(active.incomes || []).length === 0 ? (
                    <div className="text-sm text-neutral-600">No income items yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {/* Dropzone at top */}
                      <InsertDropZone
                        active={dropHint?.type === "incomeInsert" && dropHint?.index === 0}
                        onDragOver={(e) => {
                          const p = readDragPayload(e);
                          if (p?.type !== "income") return;
                          e.preventDefault();
                          setDropHint({ type: "incomeInsert", index: 0 });
                        }}
                        onDrop={(e) => {
                          const p = readDragPayload(e);
                          if (!p || p.type !== "income") return;
                          e.preventDefault();
                          moveIncomeInsert(p.itemId, 0);
                          clearDragState();
                        }}
                      />

                      {(active.incomes || []).map((i, idx) => (
                        <div key={i.id}>
                          <div className="grid grid-cols-12 gap-2 items-center rounded-2xl p-2 border border-transparent">
                            <div
                              className="col-span-1"
                              draggable
                              onDragStart={(e) => setDragPayload({ type: "income", itemId: i.id }, e)}
                              onDragEnd={clearDragState}
                            >
                              <DragHandle title="Drag income item" />
                            </div>

                            <input
                              className="col-span-6 rounded-xl border border-neutral-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-lime-300"
                              value={i.name || ""}
                              onChange={(e) => updateIncome(i.id, { name: e.target.value })}
                              placeholder="Income name"
                            />

                            <SelectAllNumberInput
                              className="col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-300"
                              value={i.amount ?? 0}
                              onChange={(e) => updateIncome(i.id, { amount: e.target.value })}
                              inputMode="decimal"
                              placeholder="0"
                              title="Amount"
                            />

                            <button
                              className="print:hidden col-span-1 h-10 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 px-3"
                              title="Remove"
                              onClick={() => deleteIncome(i.id)}
                            >
                              ×
                            </button>
                          </div>

                          {/* Dropzone after each item */}
                          <InsertDropZone
                            active={dropHint?.type === "incomeInsert" && dropHint?.index === idx + 1}
                            onDragOver={(e) => {
                              const p = readDragPayload(e);
                              if (p?.type !== "income") return;
                              e.preventDefault();
                              setDropHint({ type: "incomeInsert", index: idx + 1 });
                            }}
                            onDrop={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "income") return;
                              e.preventDefault();
                              moveIncomeInsert(p.itemId, idx + 1);
                              clearDragState();
                            }}
                          />
                        </div>
                      ))}

                      <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                        <div className="text-sm text-neutral-600">Total income</div>
                        <div className="font-semibold text-neutral-900">
                          <Money value={incomeTotal} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Expenses */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100 flex items-center justify-between gap-2">
                  <div className="font-semibold text-neutral-900">Expenses</div>
                  <div className="flex items-center gap-2">
                    <TogglePill
                      on={showPaid}
                      onToggle={(v) => setSetting({ showPaid: v })}
                      labelOn="Show paid"
                      labelOff="Hide paid"
                      title="Show/hide paid items"
                    />
                    <SmallButton tone="primary" onClick={addExpenseGroup}>
                      + Add section
                    </SmallButton>
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  {(active.expenseGroups || []).map((g) => {
                    const isCollapsed = !!collapsed[g.id];
                    const planned = groupPlannedTotal(g);
                    const remaining = groupRemainingTotal(g);
                    const totalItems = (g.items || []).length;
                    const unpaidItems = (g.items || []).filter((it) => !it.paid).length;

                    const visibleItems = showPaid ? (g.items || []) : (g.items || []).filter((it) => !it.paid);

                    return (
                      <div key={g.id} className="rounded-2xl border border-neutral-200 overflow-hidden">
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

                            <div className="text-sm text-neutral-600 hidden lg:block">
                              {unpaidItems}/{totalItems} unpaid • Remaining: <span className="font-semibold text-neutral-900">€{remaining.toFixed(2)}</span>
                              <span className="text-neutral-500"> • Planned: €{planned.toFixed(2)}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="text-sm text-neutral-600 lg:hidden">
                              Remaining: <span className="font-semibold text-neutral-900">€{remaining.toFixed(2)}</span>
                              <span className="text-neutral-500"> • Planned: €{planned.toFixed(2)}</span>
                            </div>

                            <SmallButton onClick={() => sortGroupByDue(g.id)} title="Sort items by due day (1–31)">
                              Sort by due
                            </SmallButton>
                            <SmallButton onClick={() => markAllPaid(g.id, true)} title="Mark all paid">
                              All paid
                            </SmallButton>
                            <SmallButton onClick={() => markAllPaid(g.id, false)} title="Mark all unpaid">
                              All unpaid
                            </SmallButton>
                            <SmallButton tone="danger" onClick={() => clearPaidInGroup(g.id)} title="Remove paid items">
                              Clear paid
                            </SmallButton>
                            <SmallButton tone="primary" onClick={() => addExpenseItem(g.id)}>
                              + Add item
                            </SmallButton>
                            <SmallButton tone="danger" onClick={() => deleteExpenseGroup(g.id)}>
                              Delete
                            </SmallButton>
                          </div>
                        </div>

                        {/* Drop onto group (append) */}
                        <div
                          className="print:hidden"
                          onDragOver={(e) => {
                            const p = readDragPayload(e);
                            if (p?.type !== "expense") return;
                            e.preventDefault();
                            setDropHint({ type: "expenseAppend", groupId: g.id });
                          }}
                          onDrop={(e) => {
                            const p = readDragPayload(e);
                            if (!p || p.type !== "expense") return;
                            e.preventDefault();
                            moveExpenseInsert(p.fromGroupId, p.itemId, g.id, (g.items || []).length);
                            clearDragState();
                          }}
                        />

                        {!isCollapsed ? (
                          <div className="p-3">
                            {visibleItems.length === 0 ? (
                              <div className="text-sm text-neutral-600">No items in this section.</div>
                            ) : (
                              <div className="space-y-2">
                                {/* Top dropzone */}
                                <InsertDropZone
                                  active={dropHint?.type === "expenseInsert" && dropHint?.groupId === g.id && dropHint?.index === 0}
                                  onDragOver={(e) => {
                                    const p = readDragPayload(e);
                                    if (p?.type !== "expense") return;
                                    e.preventDefault();
                                    setDropHint({ type: "expenseInsert", groupId: g.id, index: 0 });
                                  }}
                                  onDrop={(e) => {
                                    const p = readDragPayload(e);
                                    if (!p || p.type !== "expense") return;
                                    e.preventDefault();
                                    moveExpenseInsert(p.fromGroupId, p.itemId, g.id, 0);
                                    clearDragState();
                                  }}
                                />

                                {visibleItems.map((e, idx) => (
                                  <div key={e.id}>
                                    <div className={`grid grid-cols-12 gap-2 items-center rounded-2xl p-2 border ${e.paid ? "bg-neutral-50/40" : "border-transparent"}`}>
                                      <div
                                        className="col-span-1"
                                        draggable
                                        onDragStart={(ev) => setDragPayload({ type: "expense", fromGroupId: g.id, itemId: e.id }, ev)}
                                        onDragEnd={clearDragState}
                                      >
                                        <DragHandle title="Drag expense item" />
                                      </div>

                                      <div className="col-span-1">
                                        <PaidCheck
                                          checked={!!e.paid}
                                          onChange={(v) => updateExpenseItem(g.id, e.id, { paid: v })}
                                        />
                                      </div>

                                      <input
                                        className={`col-span-5 rounded-xl border border-neutral-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-lime-300 ${
                                          e.paid ? "text-neutral-500 line-through" : ""
                                        }`}
                                        value={e.name || ""}
                                        onChange={(ev) => updateExpenseItem(g.id, e.id, { name: ev.target.value })}
                                        placeholder="Expense name"
                                      />

                                      <SelectAllNumberInput
                                        className="col-span-1 rounded-xl border border-neutral-200 px-2 py-2 bg-white text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-300"
                                        value={e.dueDay ?? ""}
                                        onChange={(ev) => {
                                          const raw = ev.target.value;
                                          if (raw === "") return updateExpenseItem(g.id, e.id, { dueDay: null });
                                          const n = Number(raw);
                                          updateExpenseItem(g.id, e.id, { dueDay: Number.isFinite(n) ? clamp(n, 1, 31) : null });
                                        }}
                                        inputMode="numeric"
                                        placeholder="DD"
                                        title="Due day (1–31)"
                                      />

                                      <SelectAllNumberInput
                                        className="col-span-3 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-300"
                                        value={e.amount ?? 0}
                                        onChange={(ev) => updateExpenseItem(g.id, e.id, { amount: ev.target.value })}
                                        inputMode="decimal"
                                        placeholder="0"
                                        title="Amount"
                                      />

                                      <button
                                        className="print:hidden col-span-1 h-10 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 px-3"
                                        title="Remove"
                                        onClick={() => deleteExpenseItem(g.id, e.id)}
                                      >
                                        ×
                                      </button>
                                    </div>

                                    {/* Dropzone after each row (insert exact position) */}
                                    <InsertDropZone
                                      active={dropHint?.type === "expenseInsert" && dropHint?.groupId === g.id && dropHint?.index === idx + 1}
                                      onDragOver={(ev) => {
                                        const p = readDragPayload(ev);
                                        if (p?.type !== "expense") return;
                                        ev.preventDefault();
                                        setDropHint({ type: "expenseInsert", groupId: g.id, index: idx + 1 });
                                      }}
                                      onDrop={(ev) => {
                                        const p = readDragPayload(ev);
                                        if (!p || p.type !== "expense") return;
                                        ev.preventDefault();
                                        moveExpenseInsert(p.fromGroupId, p.itemId, g.id, idx + 1);
                                        clearDragState();
                                      }}
                                    />
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-between">
                              <div>
                                <div className="text-sm text-neutral-600">Remaining</div>
                                <div className="text-xs text-neutral-500">Planned: €{planned.toFixed(2)}</div>
                              </div>
                              <div className="font-semibold text-neutral-900">
                                <Money value={remaining} />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="p-3 text-sm text-neutral-600">Collapsed. Drop an item on a green line to insert into this section.</div>
                        )}
                      </div>
                    );
                  })}

                  {(active.expenseGroups || []).length === 0 ? (
                    <div className="text-sm text-neutral-600">No expense sections yet. Click “Add section”.</div>
                  ) : (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-neutral-600">Remaining expenses</div>
                        <div className="text-xs text-neutral-500">Planned: €{expensePlannedTotal.toFixed(2)}</div>
                      </div>
                      <div className="font-semibold text-neutral-900">
                        <Money value={expenseRemainingTotal} />
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
                <div className="text-sm text-neutral-600">Remaining expenses</div>
                <div className="text-2xl font-semibold text-neutral-900 mt-1">
                  <Money value={expenseRemainingTotal} />
                </div>
                <div className="text-xs text-neutral-500 mt-2">Planned expenses: €{expensePlannedTotal.toFixed(2)}</div>
              </div>

              <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-emerald-200" : "border-red-200"}`}>
                <div className="text-sm text-neutral-600">Net (after remaining)</div>
                <div className="text-2xl font-semibold text-neutral-900 mt-1">
                  <Money value={netRemaining} />
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
                  <div className="flex items-center justify-between">
                    <span>Unpaid items</span>
                    <span className="font-medium text-neutral-900">
                      {(active.expenseGroups || []).reduce((s, g) => s + (g.items || []).filter((it) => !it.paid).length, 0)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="text-xs text-neutral-500">
                Tip: Paid items don’t count toward remaining expenses. Use “Hide paid” to keep lists clean.
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
