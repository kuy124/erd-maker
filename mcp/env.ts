/**
 * Reading configuration without assuming Node.
 *
 * process.env exists in Node and in some Workers compatibility modes, but a
 * Worker receives its configuration as an object instead. Everything that needs
 * a setting goes through here so both hosts read it the same way.
 */

let overrides: Record<string, string | undefined> = {};

/** Called by a host that was handed configuration rather than env vars. */
export function useEnv(values: Record<string, string | undefined>): void {
  overrides = { ...overrides, ...values };
}

export function env(name: string): string | undefined {
  const override = overrides[name];
  if (override !== undefined) return override;
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}
