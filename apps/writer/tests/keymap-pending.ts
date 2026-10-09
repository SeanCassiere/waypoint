import type { KeyCommand } from "../src/viewer/keymap.ts";

/** Registered commands whose handlers don't reference the keymap command yet. Shrink-only:
 *  keymap.test.ts fails once a command's literal appears in src/client/ and it's still listed. */
export const PENDING_HANDLERS: readonly KeyCommand[] = [
  // NAV-02: search.ts
  "find-prev",
  "find-next",
  "find-open",
  "find-all",
];
