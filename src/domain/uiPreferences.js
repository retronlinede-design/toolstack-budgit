/**
 * Persist transient UI state without leaking an adapter result into a React
 * effect, where any returned object would be treated as an effect cleanup.
 */
export function writeUiPreference(writePreference, key, value) {
  writePreference(key, value);
}
