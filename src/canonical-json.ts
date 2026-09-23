export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== 'object') return item;
    const object = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, sort(object[key])]));
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value)) as unknown));
}
