/** Small 24×24 line icons, drawn with currentColor. */
const paths: Record<string, string> = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 6l9 6-9 6z" fill="currentColor" stroke="none"/><path d="M17.5 6v12"/>',
  previous: '<path d="M18 6l-9 6 9 6z" fill="currentColor" stroke="none"/><path d="M6.5 6v12"/>',
  repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h11"/><path d="M15 3l3 3-3 3"/><path d="M20 13v2a3 3 0 0 1-3 3H6"/><path d="M9 21l-3-3 3-3"/>',
  "mode--1": '<circle cx="7" cy="17" r="2.5"/><circle cx="17" cy="15" r="2.5"/><path d="M9.5 17V6l10-2v11"/>',
  "mode-0": '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M17 14l4 3-4 3z" fill="currentColor" stroke="none"/>',
  "mode-1": '<path d="M3 7h3c4 0 6 10 10 10h4"/><path d="M3 17h3c4 0 6-10 10-10h4"/><path d="M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  "mode-2": '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sort: '<path d="M7 4v16M4 17l3 3 3-3"/><path d="M13 6h7M13 11h5M13 16h3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

export const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
