/**
 * JSON.stringify that never throws: circular structures and bigint values
 * degrade to placeholders instead of blowing up the event pump.
 */
export function JSONStringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value, replacer()) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

function replacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors = new Set<object>();
  return function(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") return String(value);
    if (value !== null && typeof value === "object") {
      if (ancestors.has(value as object)) return "[circular]";
      ancestors.add(value as object);
    }
    return value;
  };
}
