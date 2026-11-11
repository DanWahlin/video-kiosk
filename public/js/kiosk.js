import { $, $$, h, icon, iconSvg, paintIcon, svgMask, formatTime, cssTriples, setTheme } from './dom.js';
import { Carousel } from './carousel.js';
import { folderCard } from './folder-card.js';
import { createPlayer } from './player.js';

const ATTRACT_AFTER_MS = 20_000;
const ATTRACT_STEP_MS = 6_000;
const CURSOR_HIDE_MS = 3_000;
const SETTINGS_HOLD_MS = 3_000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function createKiosk({ backend, onExit }) {
  const root = $('#kiosk');
  const home = $('#home');
  const folderScreen = $('#folder');
  const back = $('#back');
  const fsBtn = $('#fullscreen');
  const list = $('.video-list', folderScreen);
  const listWrap = $('.list-wrap', folderScreen);
  const listDots = $('.dots', folderScreen);
  const homeDots = $('.dots', home);

  let catalog = null;
  let folderIndex = -1;
  let currentRow = -1;
  let watched = new Set();
  // The viewer's choices for captions and sound; an idle reset restores the admin defaults.
  let captionsOn = true;
  let mutedOn = false;
  let lastInput = 0;
  let idleResetDone = false;
  let lastAttract = 0;
  let timer = 0;
  let listeners = null; // AbortController for the page-wide listeners while the kiosk runs

  const carousel = new Carousel($('.stage', home), $('.carousel', home), {
    onOpen: (i) => openFolder(i),
    onIndex: (i) => $$('button', homeDots).forEach((d, k) => d.classList.toggle('is-active', k === i)),
  });
  const player = createPlayer($('#player'), { onClose: onPlayerClosed, onCaptions: (on) => (captionsOn = on), onMuted: (on) => (mutedOn = on), onEnded: playNext, onError: skipFailed });

  $('.nav.prev', home).addEventListener('click', () => carousel.prev());
  $('.nav.next', home).addEventListener('click', () => carousel.next());
  back.addEventListener('click', () => goHome());
  $('.count', folderScreen).addEventListener('click', playAll);

  // ---- Loading ----
  async function load() {
    catalog = await backend.getCatalog();
    applyTheme(catalog.settings.theme);
    player.setCaptionSize(catalog.settings.captionSize);
    const lightTheme = catalog.settings.theme.endsWith('light');
    paintIcon($('.brand-icon', root), lightTheme && catalog.iconLight ? catalog.iconLight : catalog.icon);
    $('.brand-title', root).textContent = catalog.title;
    const sub = $('.brand-subtitle', root);
    sub.hidden = !catalog.subtitle;
    $('span', sub).textContent = catalog.subtitle;
    document.title = catalog.title;

    carousel.setCards(
      catalog.folders.map((f) => {
        const card = folderCard(f);
        card.setAttribute('role', 'option');
        card.setAttribute('aria-label', `${f.title}. ${f.description}`);
        return card;
      }),
    );
    homeDots.replaceChildren(
      ...catalog.folders.map((f, i) =>
        h('button', { type: 'button', role: 'tab', 'aria-label': f.title, onclick: () => carousel.go(i) }),
      ),
    );
    $$('button', homeDots)[carousel.index]?.classList.add('is-active');
    const multi = catalog.folders.length > 1;
    $$('.nav', home).forEach((b) => (b.hidden = !multi));
    homeDots.hidden = !multi;
  }

  function applyTheme(theme) {
    setTheme(theme);
    carousel.refreshColors();
  }

  // ---- Screens ----
  function transition(update) {
    if (!document.startViewTransition || reducedMotion.matches) {
      update();
      return null;
    }
    return document.startViewTransition(update);
  }

  function openFolder(i, { animate = true } = {}) {
    setUrl(i);
    const card = carousel.cards[i];
    const show = () => {
      card.style.viewTransitionName = '';
      // Center the opened folder, so Back returns to it.
      carousel.go(i, { instant: true });
      renderFolder(i);
      home.hidden = true;
      folderScreen.hidden = false;
      back.hidden = false;
    };
    if (!animate) return show();
    card.style.viewTransitionName = 'folder-hero';
    transition(show);
  }

  function goHome({ reset = false, animate = true } = {}) {
    setUrl(-1, -1, { replace: reset });
    if (player.isOpen) player.close('home');
    const wasFolder = !folderScreen.hidden;
    if (reset) {
      watched = new Set();
      captionsOn = catalog.settings.captions;
      mutedOn = catalog.settings.muteVideos;
      carousel.go(carousel.home, { instant: wasFolder });
    }
    if (!wasFolder) return;
    const center = carousel.cards[carousel.index];
    const show = () => {
      folderScreen.hidden = true;
      back.hidden = true;
      home.hidden = false;
      folderIndex = -1;
      if (center && animate && document.startViewTransition) center.style.viewTransitionName = 'folder-hero';
    };
    const vt = animate ? transition(show) : (show(), null);
    const clear = () => center && (center.style.viewTransitionName = '');
    vt ? vt.finished.finally(clear) : clear();
  }

  function renderFolder(i) {
    folderIndex = i;
    const folder = catalog.folders[i];
    const color = carousel.colorFor(i).join(' ');

    $('.crumbs', folderScreen).replaceChildren(
      h('button', { type: 'button', onclick: () => goHome() }, icon('home'), 'Home'),
      h('span', { class: 'sep' }, '/'),
      ...(folder.description
        ? [h('span', {}, folder.title), h('span', { class: 'sep' }, '/'), h('strong', {}, folder.description)]
        : [h('strong', {}, folder.title)]),
    );
    const n = folder.videos.length;
    $('.count-text', folderScreen).textContent = n === 1 ? 'Play 1 Video' : `Play all ${n} Videos`;

    const hero = $('.hero-slot', folderScreen);
    $('.fcard', hero)?.remove();
    const card = folderCard(folder);
    card.classList.add('is-center');
    card.style.setProperty('--c', color);
    card.style.setProperty('--focus', '1');
    hero.prepend(card);

    drawLinks(color);

    const fallbackMask = folder.icon.svg ? svgMask(folder.icon.svg) : svgMask(iconSvg('video'));
    list.replaceChildren(...folder.videos.map((v, vi) => videoRow(v, vi, fallbackMask)));
    markCurrent(0);
    listWrap.scrollTop = 0;
    folderScreen.classList.remove('screen-enter');
    void folderScreen.offsetWidth;
    folderScreen.classList.add('screen-enter');
    requestAnimationFrame(updateListDots);
  }

  function videoRow(v, vi, fallbackMask) {
    const thumb = h('div', { class: 'thumb' }, h('div', { class: 'fallback' }));
    thumb.querySelector('.fallback').style.setProperty('--mask', fallbackMask);
    if (v.thumbnail) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', src: v.thumbnail });
      img.addEventListener('load', () => img.classList.add('is-loaded'));
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    thumb.append(h('span', { class: 'play' }, icon('play')));
    if (v.duration) thumb.append(h('span', { class: 'dur' }, formatTime(v.duration)));
    if (watched.has(`${folderIndex}:${vi}`)) thumb.append(watchedBadge());
    return h(
      'li',
      {},
      h(
        'button',
        { class: 'vrow', type: 'button', 'data-index': vi, onclick: () => ((loopAll = false), playVideo(vi)) },
        thumb,
        h('div', { class: 'vtext' }, h('h3', {}, v.title), v.description ? h('p', {}, v.description) : null),
      ),
    );
  }

  const watchedBadge = () => h('span', { class: 'watched', html: iconSvg('check-circle-fill') });

  // Curved light lines from the folder card to the list.
  function drawLinks(color) {
    const svg = $('.links', folderScreen);
    const active = (cssTriples('--active')[0] ?? [34, 211, 238]).join(' ');
    const ys = [14, 38, 62, 86];
    const paths = ys.map((y) => `M0,50 C55,50 45,${y} 100,${y}`);
    svg.innerHTML = `
      <defs><linearGradient id="link-grad" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="rgb(${color})"/><stop offset="1" stop-color="rgb(${active})"/>
      </linearGradient></defs>
      ${paths.map((d) => `<path d="${d}" stroke="url(#link-grad)" stroke-opacity="0.55"/>`).join('')}
      ${paths.map((d, k) => `<path class="pulse" d="${d}" pathLength="100" stroke="rgb(${active})" style="animation-delay:${-k * 0.9}s"/>`).join('')}`;
  }

  function markCurrent(vi) {
    currentRow = vi;
    $$('.vrow', list).forEach((r, k) => r.classList.toggle('is-current', k === vi));
  }

  // ---- List paging dots ----
  function updateListDots() {
    const pages = Math.max(1, Math.ceil((listWrap.scrollHeight - 4) / listWrap.clientHeight));
    const page = Math.min(pages - 1, Math.round(listWrap.scrollTop / listWrap.clientHeight));
    if (listDots.children.length !== pages) {
      listDots.replaceChildren(
        ...Array.from({ length: pages }, (_, p) =>
          h('button', { type: 'button', 'aria-label': `Page ${p + 1}`, onclick: () => listWrap.scrollTo({ top: p * listWrap.clientHeight, behavior: 'smooth' }) }),
        ),
      );
    }
    listDots.style.visibility = pages > 1 ? 'visible' : 'hidden';
    $$('button', listDots).forEach((d, k) => d.classList.toggle('is-active', k === page));
  }
  let dotsQueued = false;
  listWrap.addEventListener(
    'scroll',
    () => {
      if (dotsQueued) return;
      dotsQueued = true;
      requestAnimationFrame(() => {
        dotsQueued = false;
        updateListDots();
      });
    },
    { passive: true },
  );
  new ResizeObserver(() => !folderScreen.hidden && updateListDots()).observe(listWrap);

  // ---- Playback ----
  function playVideo(vi, { replace = false } = {}) {
    setUrl(folderIndex, vi, { replace });
    markCurrent(vi);
    player.open(catalog.folders[folderIndex].videos[vi], { captions: captionsOn, muted: mutedOn });
  }

  // Loop playback: when a video ends, the next one in the folder plays, and after the
  // last video the first plays again, until a viewer selects Back. The "Loop video playback"
  // setting turns it on for every video; "Play all" turns it on until the player closes.
  let loopAll = false;
  const looping = () => (catalog.settings.loopPlayback || loopAll) && folderIndex >= 0;

  function playAll() {
    loopAll = true;
    failedInRow = 0;
    playVideo(0);
  }

  function playNext() {
    if (!looping()) return false;
    failedInRow = 0;
    markWatched(currentRow);
    playVideo((currentRow + 1) % catalog.folders[folderIndex].videos.length, { replace: true });
    return true;
  }

  // Loop playback: a video that cannot play is skipped. If all the videos in the folder fail
  // one after the other (for example, the network is down), wait longer before the next try.
  let failedInRow = 0;
  function skipFailed() {
    if (!looping()) return null;
    const count = catalog.folders[folderIndex].videos.length;
    failedInRow++;
    return {
      wait: failedInRow >= count ? 30_000 : 3000,
      next: () => playVideo((currentRow + 1) % count, { replace: true }),
    };
  }

  function markWatched(vi) {
    watched.add(`${folderIndex}:${vi}`);
    const row = $$('.vrow', list)[vi];
    if (row && !$('.watched', row)) $('.thumb', row).append(watchedBadge());
  }

  function onPlayerClosed(reason) {
    loopAll = false;
    if (reason === 'home' || reason === 'exit') return;
    noteInput(); // Watching counts as activity, so the idle timer starts again from here.
    if (folderIndex < 0) return;
    // Back in the player adds a history entry; a video that ends or fails replaces it.
    setUrl(folderIndex, -1, { replace: reason !== 'closed' });
    if (reason === 'ended') markWatched(currentRow);
    const row = $$('.vrow', list)[currentRow];
    row?.scrollIntoView({ block: 'nearest' });
    row?.focus({ preventScroll: true });
  }

  // ---- Links: #kiosk/<folder id>/<video id> ----
  // The URL follows the screen, so a link (or a browser reload) opens the same list or video.
  let following = false; // True while the kiosk follows a link, so it does not write the URL back.

  function setUrl(fi, vi = -1, { replace = false } = {}) {
    if (following || !listeners) return;
    const f = catalog.folders[fi];
    const hash = !f ? '#kiosk' : vi < 0 ? `#kiosk/${f.id}` : `#kiosk/${f.id}/${f.videos[vi].id}`;
    // On the static site, the link also names the catalog, so it opens the same videos anywhere.
    const search = catalog.catalogId ? `?catalog=${encodeURIComponent(catalog.catalogId)}` : location.search;
    const url = location.pathname + search + hash;
    if (url !== location.pathname + location.search + location.hash) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }

  // Shows the folder and video that the URL names. A part that is not in the catalog
  // falls back to the screen above it (the folder list, or the start screen).
  function followUrl() {
    const [, folderId, videoId] = location.hash.slice(1).split('/').map((part) => decodeURIComponent(part));
    const fi = catalog.folders.findIndex((f) => f.id === folderId);
    const vi = fi < 0 ? -1 : catalog.folders[fi].videos.findIndex((v) => v.id === videoId);
    following = true;
    try {
      if (fi < 0) goHome({ animate: false });
      else {
        if (folderIndex !== fi || folderScreen.hidden) openFolder(fi, { animate: false });
        if (vi >= 0 && !(player.isOpen && currentRow === vi)) (loopAll = false), playVideo(vi);
        else if (vi < 0 && player.isOpen) player.close('link');
      }
    } finally {
      following = false;
    }
    setUrl(fi, vi, { replace: true });
  }

  // ---- Idle, attract mode, cursor ----
  function noteInput() {
    lastInput = performance.now();
    idleResetDone = false;
    root.classList.remove('hide-cursor');
  }

  function idleTick() {
    const t = performance.now();
    if (player.shouldPlay) {
      lastInput = t; // Watching counts as activity. A video that a viewer paused does not.
      player.keepPlaying();
    }
    const idle = t - lastInput;
    root.classList.toggle('hide-cursor', idle > CURSOR_HIDE_MS);

    // One full reset per idle period: start screen, start folder, captions default, no watched marks.
    const limit = catalog.settings.idleSeconds * 1000;
    if (limit && idle >= limit && !idleResetDone) {
      idleResetDone = true;
      goHome({ reset: true });
      lastAttract = t;
    }

    const onHome = folderScreen.hidden && !player.isOpen;
    if (catalog.settings.attractMode && onHome && idle >= ATTRACT_AFTER_MS && t - lastAttract >= ATTRACT_STEP_MS) {
      lastAttract = t;
      carousel.next();
    }
  }

  function onKey(e) {
    // Esc only leaves full screen (the browser does that). Ctrl+Alt+S opens the settings.
    if (e.ctrlKey && e.altKey && e.code === 'KeyS') return exit();
    noteInput();
    if (player.isOpen) {
      if (e.key === ' ' || e.key === 'Enter') e.preventDefault(), player.togglePlay();
      if (e.key === 'Backspace') player.close('closed');
      return;
    }
    if (!folderScreen.hidden) {
      if (e.key === 'Backspace') goHome();
      return;
    }
    if (e.key === 'ArrowLeft') carousel.prev();
    if (e.key === 'ArrowRight') carousel.next();
    if (e.key === 'Enter' || e.key === ' ') e.preventDefault(), openFolder(carousel.index);
  }

  // ---- Full screen ----
  // A browser in kiosk mode fills the screen without the Fullscreen API, so check the size too.
  const isFullscreen = () =>
    !!document.fullscreenElement || (Math.abs(innerWidth - screen.width) < 2 && Math.abs(innerHeight - screen.height) < 2);
  // macOS shows its menu bar over full-screen pages (iPads also say "Mac", but have touch points).
  const isMac = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
  const syncFullscreen = () => {
    const full = isFullscreen();
    fsBtn.hidden = full;
    root.classList.toggle('mac-fullscreen', isMac && full);
  };
  const enterFullscreen = () => document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  fsBtn.addEventListener('click', enterFullscreen);
  $('#open-settings').addEventListener('click', () => exit());

  // ---- Hidden way to the settings: hold the logo or title for 3 seconds ----
  let holdTimer = 0;
  const brand = $('.brand', root);
  const endHold = () => {
    clearTimeout(holdTimer);
    brand.classList.remove('is-holding');
  };
  brand.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.brand-icon, .brand-title')) return;
    brand.classList.add('is-holding');
    holdTimer = setTimeout(() => {
      endHold();
      exit();
    }, SETTINGS_HOLD_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) brand.addEventListener(type, endHold);

  // ---- Start and stop ----
  async function launch({ fullscreen }) {
    // Must run first, while the click still counts as a user gesture.
    if (fullscreen) await enterFullscreen();
    try {
      await load();
    } catch (err) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      throw err;
    }
    folderScreen.hidden = true;
    back.hidden = true;
    home.hidden = false;
    root.hidden = false;
    carousel.measure();
    carousel.go(carousel.home, { instant: true });
    captionsOn = catalog.settings.captions;
    mutedOn = catalog.settings.muteVideos;
    lastInput = performance.now();
    idleResetDone = false;
    timer = setInterval(idleTick, 500);
    syncFullscreen();
    listeners = new AbortController();
    const { signal } = listeners;
    addEventListener('keydown', onKey, { signal });
    for (const type of ['pointerdown', 'pointermove', 'wheel']) addEventListener(type, noteInput, { capture: true, passive: true, signal });
    addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    addEventListener('resize', syncFullscreen, { signal });
    document.addEventListener('fullscreenchange', syncFullscreen, { signal });
    addEventListener('popstate', followUrl, { signal });
    followUrl();
  }

  function exit() {
    if (!listeners) return;
    listeners.abort();
    listeners = null;
    endHold();
    if (player.isOpen) player.close('exit');
    clearInterval(timer);
    root.hidden = true;
    root.classList.remove('hide-cursor');
    watched = new Set();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onExit?.();
  }

  return { launch, exit };
}
