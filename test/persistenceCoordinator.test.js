import test from "node:test";
import assert from "node:assert/strict";

import { applyValidatedMonthCopyToApp } from "../src/domain/monthCopy.js";
import {
  attachPersistenceLifecycle,
  createPersistenceCoordinator,
} from "../src/domain/persistenceCoordinator.js";

function createTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    runAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
    size: () => pending.size,
  };
}

function createHarness({ initialState = { value: 0 }, locked = false, failWrites = 0 } = {}) {
  const timers = createTimers();
  const writes = [];
  let failuresRemaining = failWrites;
  const coordinator = createPersistenceCoordinator({
    initialState,
    storage: {},
    storageKey: "budgit",
    locked,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    write(_storage, key, value) {
      writes.push({ key, state: JSON.parse(value) });
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return { ok: false, code: "quota_exceeded" };
      }
      return { ok: true };
    },
  });
  return { coordinator, timers, writes };
}

test("ordinary and rapid mutations debounce to the latest intended state", () => {
  const { coordinator, timers, writes } = createHarness();
  coordinator.setLatest({ value: 1 });
  coordinator.setLatest({ value: 2 });
  coordinator.setLatest({ value: 3 });
  assert.equal(timers.size(), 1);
  timers.runAll();
  assert.deepEqual(writes.map((write) => write.state), [{ value: 3 }]);
  assert.equal(coordinator.isDirty(), false);
});

test("pagehide flushes latest state, cancels debounce, and leaves no stale write", () => {
  const { coordinator, timers, writes } = createHarness();
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", { value: "visible", writable: true });
  const detach = attachPersistenceLifecycle({ windowTarget, documentTarget, flush: coordinator.flush });

  coordinator.setLatest({ value: 4 });
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(timers.size(), 0);
  timers.runAll();
  assert.deepEqual(writes.map((write) => write.state), [{ value: 4 }]);
  assert.equal(coordinator.isDirty(), false);
  detach();
});

test("hidden visibility flushes, while visible visibility changes do not", () => {
  const { coordinator, writes } = createHarness();
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", { value: "visible", writable: true });
  const detach = attachPersistenceLifecycle({ windowTarget, documentTarget, flush: coordinator.flush });
  coordinator.setLatest({ value: 5 });
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(writes.length, 0);
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(writes[0].state, { value: 5 });
  detach();
});

test("lifecycle listener cleanup removes listeners without flushing", () => {
  const { coordinator, writes } = createHarness();
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", { value: "hidden" });
  const detach = attachPersistenceLifecycle({ windowTarget, documentTarget, flush: coordinator.flush });
  coordinator.setLatest({ value: 6 });
  detach();
  windowTarget.dispatchEvent(new Event("pagehide"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(writes.length, 0);
  assert.equal(coordinator.isDirty(), true);
});

test("failed writes stay dirty and a later mutation persists the latest state", () => {
  const { coordinator, timers, writes } = createHarness({ failWrites: 1 });
  coordinator.setLatest({ value: 1 });
  timers.runAll();
  assert.equal(coordinator.isDirty(), true);
  coordinator.setLatest({ value: 2 });
  timers.runAll();
  assert.deepEqual(writes.map((write) => write.state), [{ value: 1 }, { value: 2 }]);
  assert.equal(coordinator.isDirty(), false);
});

test("a write only marks the exact revision it serialized as persisted", () => {
  const timers = createTimers();
  const writes = [];
  let coordinator;
  coordinator = createPersistenceCoordinator({
    initialState: { value: 0 }, storage: {}, storageKey: "budgit",
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    write(_storage, _key, value) {
      writes.push(JSON.parse(value));
      if (writes.length === 1) coordinator.setLatest({ value: 2 });
      return { ok: true };
    },
  });
  coordinator.setLatest({ value: 1 });
  timers.runAll();
  assert.equal(coordinator.isDirty(), true);
  timers.runAll();
  assert.deepEqual(writes, [{ value: 1 }, { value: 2 }]);
  assert.equal(coordinator.isDirty(), false);
});

test("failed lifecycle flush remains dirty and can be retried", () => {
  const { coordinator, writes } = createHarness({ failWrites: 1 });
  coordinator.setLatest({ value: 7 });
  assert.equal(coordinator.flush().ok, false);
  assert.equal(coordinator.isDirty(), true);
  assert.equal(coordinator.flush().ok, true);
  assert.deepEqual(writes.map((write) => write.state), [{ value: 7 }, { value: 7 }]);
});

test("persistence lock blocks debounce, lifecycle flush, and explicit writes", () => {
  const { coordinator, timers, writes } = createHarness({ locked: true });
  coordinator.setLatest({ fallback: true });
  coordinator.schedule();
  assert.equal(timers.size(), 0);
  assert.equal(coordinator.flush().skipped, true);
  assert.equal(coordinator.persistExplicit({ copied: true }).locked, true);
  assert.equal(writes.length, 0);
});

test("successful explicit persistence cancels pending autosave and becomes current", () => {
  const { coordinator, timers, writes } = createHarness();
  coordinator.setLatest({ value: "pending edit" });
  const explicit = { value: "imported" };
  assert.equal(coordinator.persistExplicit(explicit).ok, true);
  assert.equal(timers.size(), 0);
  timers.runAll();
  assert.deepEqual(writes.map((write) => write.state), [explicit]);
  assert.deepEqual(coordinator.getLatest(), explicit);
  assert.equal(coordinator.isDirty(), false);
});

test("failed explicit import does not install imported state and preserves pending state", () => {
  const { coordinator, timers } = createHarness({ failWrites: 1 });
  coordinator.setLatest({ value: "pending edit" });
  assert.equal(coordinator.persistExplicit({ value: "rejected import" }).ok, false);
  assert.deepEqual(coordinator.getLatest(), { value: "pending edit" });
  assert.equal(coordinator.isDirty(), true);
  assert.equal(timers.size(), 1);
  timers.runAll();
  assert.equal(coordinator.isDirty(), false);
});

test("recovery import may explicitly persist while locked and then unlock", () => {
  const { coordinator, writes } = createHarness({ locked: true });
  const restored = { value: "restored" };
  assert.equal(coordinator.persistExplicit(restored, { allowWhileLocked: true }).ok, true);
  coordinator.setLocked(false);
  assert.deepEqual(writes[0].state, restored);
  assert.equal(coordinator.isDirty(), false);
});

test("Month Copy explicit result includes pending edits and cannot be overwritten", () => {
  const source = {
    incomes: [{ id: "income", name: "Salary", amount: "100", date: "2026-08-01", status: "received", notes: "" }],
    expenseGroups: [{ id: "group", label: "General", items: [] }],
    notes: "",
    transactions: [],
    bankBalance: "",
    overdraftLimit: "",
    pendingIncomeEntries: [],
    pendingMoneyIn: "",
    pendingMoneyLabel: "",
  };
  const initial = { activeMonth: "2026-08", months: { "2026-08": source }, lang: "en", currency: "EUR" };
  const { coordinator, timers, writes } = createHarness({ initialState: initial });
  const edited = structuredClone(initial);
  edited.months["2026-08"].incomes[0].amount = "222";
  coordinator.setLatest(edited);
  const copy = applyValidatedMonthCopyToApp({
    app: coordinator.getLatest(),
    sourceMonthKey: "2026-08",
    destinationMonthKey: "2026-09",
    idFactory: () => "fresh-income",
  });
  assert.equal(copy.ok, true);
  assert.equal(coordinator.persistExplicit(copy.app).ok, true);
  timers.runAll();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state.months["2026-08"].incomes[0].amount, "222");
  assert.equal(writes[0].state.months["2026-09"].incomes[0].amount, "222");
  assert.equal(writes[0].state.activeMonth, "2026-09");
});
