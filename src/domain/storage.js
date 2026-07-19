export function classifyStorageError(error) {
  if (error && (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014)) {
    return "quota_exceeded";
  }
  if (error && error.name === "SecurityError") return "storage_blocked";
  return "storage_unavailable";
}

export function readStorageValue(storage, key) {
  if (!storage || typeof storage.getItem !== "function") {
    return { ok: false, code: "storage_unavailable", error: null };
  }
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch (error) {
    return { ok: false, code: classifyStorageError(error), error };
  }
}

export function writeStorageValue(storage, key, value) {
  if (!storage || typeof storage.setItem !== "function") {
    return { ok: false, code: "storage_unavailable", error: null };
  }
  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: classifyStorageError(error), error };
  }
}

export function getBrowserStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
