import test from "node:test";
import assert from "node:assert/strict";

import { classifyStorageError, readStorageValue, writeStorageValue } from "../src/domain/storage.js";

test("storage read and write return explicit success results", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.deepEqual(writeStorageValue(storage, "budget", "data"), { ok: true });
  assert.deepEqual(readStorageValue(storage, "budget"), { ok: true, value: "data" });
});

test("storage failures return observable safe error results", () => {
  const error = new Error("blocked");
  error.name = "SecurityError";
  const storage = {
    getItem: () => { throw error; },
    setItem: () => { throw error; },
  };
  const read = readStorageValue(storage, "budget");
  const write = writeStorageValue(storage, "budget", "data");
  assert.equal(read.ok, false);
  assert.equal(read.code, "storage_blocked");
  assert.equal(write.ok, false);
  assert.equal(write.code, "storage_blocked");
});

test("quota failures are classified without exposing them to UI code", () => {
  const error = new Error("full");
  error.name = "QuotaExceededError";
  assert.equal(classifyStorageError(error), "quota_exceeded");
  const result = writeStorageValue({ setItem: () => { throw error; } }, "budget", "data");
  assert.equal(result.ok, false);
  assert.equal(result.code, "quota_exceeded");
  assert.equal(result.error, error);
});

test("missing storage is reported as unavailable", () => {
  assert.deepEqual(writeStorageValue(null, "budget", "data"), { ok: false, code: "storage_unavailable", error: null });
  assert.deepEqual(readStorageValue(null, "budget"), { ok: false, code: "storage_unavailable", error: null });
});
