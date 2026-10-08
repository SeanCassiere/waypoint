/** @jsxImportSource hono/jsx */
export function KeysDialog() {
  const keys: [string, string][] = [
    ["/", "Search, or paste a URL or ID"],
    ["g h", "Go to Recent"],
    ["g s", "Go to Status"],
    [".", "Show or hide the side panel"],
    ["f", "Files tab, then type to filter"],
    ["h", "History tab"],
    ["[  ]", "Previous or next revision"],
    ["d", "Changes in this revision (vs. its parent)"],
    ["c", "Copy link to latest"],
    ["⇧C", "Copy link to this revision"],
    ["a", "Copy handoff block for an agent"],
    ["s", "Share…"],
    ["j  k", "Next or previous change (Changes page)"],
    ["Esc", "Close panel, menu, or compare"],
    ["?", "This help"],
  ];
  return (
    <dialog class="dlg narrow" id="keys" aria-labelledby="keys-title">
      <div class="bd">
        <h2 id="keys-title">Keyboard shortcuts</h2>
        <div class="keys">
          {keys.map(([key, label]) => (
            <>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </>
          ))}
        </div>
        <label class="check">
          <input type="checkbox" data-keys-off />
          Disable single-key shortcuts
        </label>
        <p class="muted small">
          Shortcuts work while focus is on Waypoint itself. Inside a document, press <kbd>
            Esc
          </kbd>{" "}
          first. Every shortcut has a button or menu item too.
        </p>
      </div>
      <form method="dialog" class="ft">
        <button class="btn primary" value="close">
          Close
        </button>
      </form>
    </dialog>
  );
}
