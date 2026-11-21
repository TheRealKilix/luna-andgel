'use strict';

const nativeRelay = location.hostname === 'localhost' && !location.port;
const relayLabel = document.createElement('label');
relayLabel.htmlFor = 'relayUrl';
relayLabel.textContent = 'Adresse du relais';
relayLabel.className = 'relay-label';
const relayInput = document.createElement('input');
relayInput.id = 'relayUrl';
relayInput.type = 'url';
relayInput.autocomplete = 'url';
relayInput.placeholder = 'https://votre-relais.example';
relayInput.setAttribute('aria-label', 'Adresse HTTPS du relais');
const relayEndpoint = document.querySelector('meta[name="relay-endpoint"]')?.content || '';
relayInput.value = localStorage.getItem('relay-url') ||
  (nativeRelay ? '' : location.origin + relayEndpoint);
if (!nativeRelay && !localStorage.getItem('relay-url')) {
  localStorage.setItem('relay-url', relayInput.value);
}
const relayHelp = document.createElement('small');
relayHelp.className = 'relay-help';
relayHelp.textContent = 'Même adresse sur les deux téléphones (HTTPS requis).';
const identity = document.querySelector('#who');
identity.before(relayLabel, relayInput, relayHelp);

relayInput.addEventListener('change', () => {
  const value = relayInput.value.trim();
  if (!value) {
    localStorage.removeItem('relay-url');
    return;
  }
  try {
    const url = new URL(value);
    if (!['https:', 'wss:'].includes(url.protocol)) throw new Error();
    localStorage.setItem('relay-url', url.origin + url.pathname.replace(/\/+$/, ''));
  } catch {
    relayInput.setCustomValidity('Entre une adresse de relais valide.');
    relayInput.reportValidity();
  }
});
relayInput.addEventListener('input', () => relayInput.setCustomValidity(''));

if (nativeRelay) {
  document.querySelector('#go').addEventListener('click', event => {
    if (!relayInput.value.trim()) {
      event.stopImmediatePropagation();
      relayInput.setCustomValidity('Entre la même adresse HTTPS du relais sur les deux téléphones.');
      relayInput.reportValidity();
    }
  }, true);
}

const NativeWebSocket = window.WebSocket;
window.WebSocket = class RelayWebSocket extends NativeWebSocket {
  constructor(url, protocols) {
    const configured = localStorage.getItem('relay-url');
    if (configured) {
      const target = new URL(configured);
      target.protocol = target.protocol === 'https:' ? 'wss:' :
        target.protocol === 'http:' ? 'ws:' : target.protocol;
      url = target.href;
    }
    if (protocols === undefined) super(url);
    else super(url, protocols);
  }
};

const iconPaths = {
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
  settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1 1.4 1.1-1.5 2.6-1.7-.7a8 8 0 0 1-1.6.9l-.3 1.8h-3l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.7-1.5-2.6 1.4-1.1a7 7 0 0 1 0-1.9l-1.4-1.1 1.5-2.6 1.7.7a8 8 0 0 1 1.6-.9l.3-1.8h3l.3 1.8a8 8 0 0 1 1.6.9l1.7-.7 1.5 2.6-1.4 1.1a7 7 0 0 1-.1 1.8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m21 3-7.2 18-3.9-7.9L2 9.2 21 3Z"/><path d="M21 3 9.9 13.1"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M9 21.5h6"/>',
  moon: '<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5a8.5 8.5 0 1 0 12 12Z"/>',
  gallery: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  camera: '<path d="M14 4h-4L8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2-3Z"/><circle cx="12" cy="13" r="3"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 4.2 1.8c-1.2 1-1.8 1.3-1.8 2.7M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01"/>',
  cloud: '<path d="M7.5 18a4.5 4.5 0 1 1 .8-8.9A5.5 5.5 0 0 1 19 11a3.5 3.5 0 0 1-.5 7H7.5Z"/>',
  sparkle: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22V5.5ZM4 6h13"/>'
};
const makeIcon = name =>
  `<svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
const replaceIcon = (element, name) => {
  if (element) element.innerHTML = makeIcon(name);
};
for (const [selector, name] of [
  ['#hb', 'heart'], ['#settingsBtn', 'settings'], ['#plus', 'plus'],
  ['#snd', 'send'], ['#mic', 'mic'], ['#lock .moon', 'moon'],
  ['#heartOverlay span', 'heart']
]) replaceIcon(document.querySelector(selector), name);
for (const [id, name] of [
  ['gallery', 'gallery'], ['camera', 'camera'], ['videoPick', 'video'],
  ['loveNote', 'mail'], ['dailyQuestion', 'question'], ['moodQuick', 'sun'],
  ['coupleHub', 'heart'], ['truthOpen', 'dice'], ['chillOpen', 'cloud'],
  ['flirtOpen', 'sparkle'], ['scheduleOpen', 'clock'], ['memoryOpen', 'book']
]) replaceIcon(document.querySelector(`#${id} i`), name);

const micButton = document.querySelector('#mic');
new MutationObserver(() => {
  if (!micButton.classList.contains('on') && !micButton.querySelector('svg')) {
    replaceIcon(micButton, 'mic');
  }
}).observe(micButton, { childList: true });

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.error('Impossible d’activer le mode hors ligne :', error);
    });
  });
}
