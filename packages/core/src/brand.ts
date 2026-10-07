// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- This is the single checked boundary for string brands.
export function brand<T extends string>(value: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Validation happens at each brand's call site.
  return value as T;
}
