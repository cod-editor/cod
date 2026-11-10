export function readPreference<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(`cod.ui.${key}`);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}
export function writePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(`cod.ui.${key}`, JSON.stringify(value));
  } catch {
    /* UI state remains available in memory if storage is unavailable. */
  }
}
