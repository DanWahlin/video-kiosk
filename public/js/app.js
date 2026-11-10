import { $, loadUiIcons } from './dom.js';
import { createBackend } from './backend.js';
import { createAdmin } from './admin.js';
import { createKiosk } from './kiosk.js';

const [backend] = await Promise.all([createBackend(), loadUiIcons()]);

const admin = createAdmin({ backend, onLaunch: () => kiosk.launch({ fullscreen: true }) });
const kiosk = createKiosk({
  backend,
  onExit: () => {
    if (location.hash) history.replaceState(null, '', location.pathname);
    admin.show();
  },
});

// "/#kiosk" starts the kiosk directly, for example from a browser in kiosk mode at login.
function startFromHash() {
  $('#admin').hidden = true;
  kiosk.launch({ fullscreen: false }).catch((err) => {
    document.body.append(Object.assign(document.createElement('div'), { className: 'toast', textContent: err.message }));
    admin.show();
  });
}
addEventListener('hashchange', () => {
  if (location.hash === '#kiosk' && $('#kiosk').hidden) startFromHash();
});

if (location.hash === '#kiosk') startFromHash();
else admin.show();
