export function errorMessage(value: unknown, status: number): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return `Request failed (${status})`;
}
async function body(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return null;
  }
}
/** Same-origin JSON request. Mutations always send Content-Type: application/json (CSRF rule). */
export async function api(url: string, method = "GET", payload?: object): Promise<unknown> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(method === "GET"
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) }),
  });
  const value = await body(response);
  if (!response.ok) throw new Error(errorMessage(value, response.status));
  return value;
}
export function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  const found: unknown = Reflect.get(value, key);
  return found;
}
