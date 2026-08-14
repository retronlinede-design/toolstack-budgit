import test from "node:test";
import assert from "node:assert/strict";

import { createRawRecoveryFile } from "../src/domain/rawRecovery.js";

test("raw recovery preserves exact stored bytes and uses a safe current-date filename", () => {
  const raw = '{\n  "activeMonth":"0202-01", "months":{"":{"unknown":true}}\n}\r\n';
  const result = createRawRecoveryFile(raw, new Date(2026, 7, 14, 12));
  assert.equal(result.ok, true);
  assert.equal(result.content, raw);
  assert.equal(result.filename, "BudgIt-Raw-Recovery-2026-08-14.json");
  assert.equal(result.mimeType, "application/json");
});

test("raw recovery is unavailable when no raw storage string exists", () => {
  assert.deepEqual(createRawRecoveryFile(null), { ok: false, code: "raw_storage_unavailable" });
});
