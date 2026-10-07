export function localizeTimes(root: ParentNode = document): void {
  root.querySelectorAll<HTMLTimeElement>("time[datetime]").forEach((time) => {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.valueOf())) time.textContent = date.toLocaleString();
  });
}
