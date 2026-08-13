import { writeStorageValue } from "./storage.js";

export function createPersistenceCoordinator({
  initialState,
  storage,
  storageKey,
  locked = false,
  debounceMs = 200,
  serialize = JSON.stringify,
  write = writeStorageValue,
  onSaveStart = () => {},
  onSaveResult = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let latestState = initialState;
  let revision = 0;
  let persistedRevision = -1;
  let persistenceLocked = locked;
  let timer = null;

  const isDirty = () => revision !== persistedRevision;

  const cancelPending = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const writeState = (state, stateRevision, { report = true } = {}) => {
    let result;
    try {
      result = write(storage, storageKey, serialize(state));
    } catch (error) {
      result = { ok: false, code: "storage_unavailable", error };
    }
    if (result.ok && revision === stateRevision) persistedRevision = stateRevision;
    if (report) onSaveResult(result);
    return result;
  };

  const flush = () => {
    cancelPending();
    if (persistenceLocked || !isDirty()) return { ok: false, skipped: true };
    return writeState(latestState, revision);
  };

  const schedule = () => {
    cancelPending();
    if (persistenceLocked || !isDirty()) return;
    onSaveStart();
    timer = setTimer(() => {
      timer = null;
      if (!persistenceLocked && isDirty()) writeState(latestState, revision);
    }, debounceMs);
  };

  const setLatest = (nextState, { scheduleSave = true } = {}) => {
    cancelPending();
    latestState = nextState;
    revision += 1;
    if (scheduleSave) schedule();
    return nextState;
  };

  const persistExplicit = (nextState, { allowWhileLocked = false } = {}) => {
    cancelPending();
    if (persistenceLocked && !allowWhileLocked) {
      return { ok: false, code: "storage_unavailable", locked: true };
    }

    const nextRevision = revision + 1;
    let result;
    try {
      result = write(storage, storageKey, serialize(nextState));
    } catch (error) {
      result = { ok: false, code: "storage_unavailable", error };
    }
    if (result.ok) {
      latestState = nextState;
      revision = nextRevision;
      persistedRevision = nextRevision;
    } else if (isDirty()) {
      schedule();
    }
    return result;
  };

  return {
    cancelPending,
    flush,
    getLatest: () => latestState,
    isDirty,
    isLocked: () => persistenceLocked,
    persistExplicit,
    schedule,
    setLatest,
    setLocked(nextLocked) {
      persistenceLocked = !!nextLocked;
      if (persistenceLocked) cancelPending();
    },
  };
}

export function attachPersistenceLifecycle({ windowTarget, documentTarget, flush }) {
  const onPageHide = () => flush();
  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === "hidden") flush();
  };

  windowTarget?.addEventListener("pagehide", onPageHide);
  documentTarget?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    windowTarget?.removeEventListener("pagehide", onPageHide);
    documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
