import { getHealth } from "../health.js";
import type { HttpServices } from "../http.js";
import type { Chrome } from "./layout.js";

export async function getChrome(s: HttpServices, now = Date.now()): Promise<Chrome> {
  return { health: await getHealth(s, now), now, host: new URL(s.reads.baseUrl).hostname };
}
