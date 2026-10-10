import { getHealth } from "../health.ts";
import type { HttpServices } from "../http.ts";
import type { Chrome } from "./layout.tsx";

export async function getChrome(s: HttpServices, now = Date.now()): Promise<Chrome> {
  return { health: await getHealth(s, now), now, host: new URL(s.reads.baseUrl).hostname };
}
