// The file panel's timings and storage keys, shared by the writer's client (client/panel.ts,
// client/panel-peek.ts, client/tree.ts) and panelCss. No imports, so a browser bundle that takes
// only these constants takes nothing else.

/** Peek (D73): how long a mouse rests on the left edge or the panel button before the panel peeks. */
export const PEEK_OPEN_DELAY: number = 150;
/** Peek: how long after the pointer leaves (and nothing holds it) the peeking panel slides away. */
export const PEEK_CLOSE_GRACE: number = 250;
/** Peek: the slide-out's length in panelCss; the client drops `.peek-out` after it. */
export const PEEK_SLIDE_OUT: number = 100;
/** localStorage key of the docked panel's state, "open" or "closed". */
export const PANEL_STORAGE_KEY: string = "wp:panel";
/** sessionStorage key prefix of the folders a reader opened by hand (D72), per collection. */
export const TREE_STORAGE_PREFIX: string = "wp:tree:";
