// Invoker commands (commandfor/command) open and close dialogs and popovers without script.
// This fallback only runs in browsers that don't support them yet.
export function bindCommandFallback(): void {
  if ("commandForElement" in HTMLButtonElement.prototype) return;
  document.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest("button[commandfor]") : null;
    if (!button) return;
    const target = document.getElementById(button.getAttribute("commandfor") ?? "");
    const command = button.getAttribute("command");
    if (target instanceof HTMLDialogElement) {
      if (command === "show-modal" && !target.open) target.showModal();
      else if (command === "close") target.close();
    } else if (target?.hasAttribute("popover")) {
      if (command === "toggle-popover") target.togglePopover();
      else if (command === "show-popover") target.showPopover();
      else if (command === "hide-popover") target.hidePopover();
    }
  });
}
