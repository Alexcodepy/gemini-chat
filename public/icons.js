// public/icons.js — iconos SVG de trazo, en línea. Heredan color y grosor del CSS.
const PATHS = {
  menu: '<path d="M3 5h18M3 12h18M3 19h18"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="M14.5 6.5l3 3"/>',
  trash: '<path d="M3.5 6h17M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6"/><path d="M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6"/><path d="M10 11v6M14 11v6"/>',
  paperclip: '<path d="M20.5 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.7-8.7a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
  mic: '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5v.8a6.5 6.5 0 0 0 13 0v-.8"/><path d="M12 18.8V21.5"/>',
  send: '<path d="M12 20V4.5"/><path d="M5.5 11L12 4.5 18.5 11"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M13.5 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M13.5 2.5V8H19"/>'
};

export function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${PATHS[name]}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, Number(el.dataset.iconSize) || 18));
    delete el.dataset.icon;
  }
}
