import './style.css';
import './styles/ui-v2.css';

/*
 * Lazy entry point.
 *
 * The home screen is static HTML, so it can be interactive long before the
 * chart engine exists.  Phaser + the game code (~2.3 MB gzipped) is pulled in
 * on the first sign of intent — a pointer-down on the title screen, keyboard
 * focus, or a 1.2 s idle window — and a click that lands before the module is
 * ready is replayed once it is.
 */

let ready = false;
let loading = false;
let queuedActionId: string | null = null;

function replayQueuedAction(): void {
  const id = queuedActionId;
  queuedActionId = null;
  if (!id) return;
  document.getElementById(id)?.click();
}

function ensureBoot(): void {
  if (loading || ready) return;
  loading = true;
  import('./boot')
    .then((module) => {
      module.boot();
      ready = true;
      replayQueuedAction();
    })
    .catch((error) => {
      loading = false;
      console.error('Unable to start the weather chart.', error);
    });
}

const home = document.getElementById('home-screen');
home?.addEventListener('pointerdown', ensureBoot, { capture: true, once: true });
home?.addEventListener('focusin', ensureBoot, { capture: true, once: true });

// A click that arrives while the engine is still downloading is held instead
// of being swallowed by the not-yet-bound button.
document.addEventListener(
  'click',
  (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>('#home-screen button');
    if (!button || ready) return;
    event.preventDefault();
    event.stopPropagation();
    queuedActionId = button.id;
    ensureBoot();
  },
  true,
);

// Deep links (?level=12) skip the title screen, so they cannot wait for idle.
if (new URLSearchParams(window.location.search).has('level')) {
  ensureBoot();
} else if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(() => ensureBoot(), { timeout: 1200 });
} else {
  globalThis.setTimeout(ensureBoot, 1200);
}
