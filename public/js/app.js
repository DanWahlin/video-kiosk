import { $, loadUiIcons } from './dom.js';
import { createAdmin } from './admin.js';
import { createKiosk } from './kiosk.js';

await loadUiIcons();

const admin = createAdmin({ onLaunch: () => kiosk.launch({ fullscreen: true }) });
const kiosk = createKiosk({
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
