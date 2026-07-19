import assert from "node:assert/strict";
import test from "node:test";
import { writeUiPreference } from "../src/domain/uiPreferences.js";

test("UI preference writes never return an adapter result as a React effect cleanup", () => {
  const calls = [];
  const adapterResult = { ok: true };
  const result = writeUiPreference((key, value) => {
    calls.push([key, value]);
    return adapterResult;
  }, "budgit_notes_open", true);

  assert.equal(result, undefined);
  assert.deepEqual(calls, [["budgit_notes_open", true]]);
});
