import type { KeyCommand } from "../src/viewer/keymap.ts";

/** Registered commands whose handlers don't reference the keymap command yet. Shrink-only:
 *  keymap.test.ts fails once a command's literal appears in src/client/ and it's still listed. */
export const PENDING_HANDLERS: readonly KeyCommand[] = [
  // A11Y-05b: changes-nav.ts
  "next-change",
  "prev-change",
  "changes-done",
  // A11Y-05b: gallery.ts and its Esc helper
  "image-prev",
  "image-next",
  "gallery-done",
  // NAV-02: search.ts
  "find-prev",
  "find-next",
  "find-open",
  "find-all",
];
