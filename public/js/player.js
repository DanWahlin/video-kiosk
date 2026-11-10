import { $, formatTime, iconSvg } from './dom.js';

const HIDE_CONTROLS_MS = 3000;
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

// Full-screen video overlay with large, touch-friendly controls.
// onEnded() returns true when it starts the next video itself (loop playback).
export function createPlayer(root, { onClose, onCaptions, onEnded }) {
  const video = $('video', root);
  const toggle = $('.toggle', root);
  const bigPlay = $('.big-play', root);
  const seek = $('.seek', root);
  const fill = $('.seek-fill', root);
  const knob = $('.seek-knob', root);
  const now = $('.time-now', root);
  const total = $('.time-total', root);
  const cc = $('.cc', root);
  const ccBox = $('.captions', root);
  const error = $('.player-error', root);
  let hideTimer = 0;
  let errorTimer = 0;
  let raf = 0;
  let shown = { p: -1, now: '', total: '' }; // What the controls show, so draw() writes only changes
  let seeking = false;
  let open = false;
  let trackEl = null;
  let captionsOn = true;

  const isPlaying = () => !video.paused && !video.ended;

  const controlsShown = () => !root.classList.contains('controls-hidden');

  function showControls() {
    root.classList.remove('controls-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => isPlaying() && !seeking && root.classList.add('controls-hidden'), HIDE_CONTROLS_MS);
    startDrawing();
  }

  function syncButtons() {
    const playing = isPlaying();
    root.classList.toggle('is-playing', playing);
    $('.icon', toggle).innerHTML = playing ? PAUSE_SVG : iconSvg('play');
    toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    bigPlay.hidden = playing || !open;
  }

  // Updates the seek bar and times. Writes to the page only when a value changed.
  function draw() {
    const d = video.duration;
    const t = video.currentTime;
    const p = d > 0 ? Math.min(1, t / d) : 0;
    if (Math.abs(p - shown.p) > 0.0002) {
      shown.p = p;
      fill.style.width = `${p * 100}%`;
      knob.style.left = `${p * 100}%`;
      seek.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }
    const nowText = formatTime(t) || '0:00';
    const totalText = formatTime(d);
    if (nowText !== shown.now) now.textContent = shown.now = nowText;
    if (totalText !== shown.total) total.textContent = shown.total = totalText;
  }

  // Animates the seek bar only while the video plays and the controls show.
  function frame() {
    draw();
    raf = open && isPlaying() && controlsShown() ? requestAnimationFrame(frame) : 0;
  }
  function startDrawing() {
    if (!raf && open) raf = requestAnimationFrame(frame);
  }

  function play() {
    video.play().catch(() => syncButtons());
  }
  function togglePlay() {
    isPlaying() ? video.pause() : play();
    showControls();
  }

  // The kiosk draws the captions itself (the track stays "hidden"), so it controls their
  // place above the controls, their size, and when they clear.
  function renderCues() {
    ccBox.replaceChildren();
    const cues = trackEl?.track.activeCues;
    if (!captionsOn || !cues) return;
    for (const cue of cues) {
      const line = document.createElement('span');
      line.append(cue.getCueAsHTML());
      const row = document.createElement('div');
      row.append(line);
      ccBox.append(row);
    }
  }

  function setCaptions(on) {
    captionsOn = on;
    renderCues();
    cc.classList.toggle('is-off', !on);
    cc.setAttribute('aria-pressed', String(on));
    cc.setAttribute('aria-label', on ? 'Turn captions off' : 'Turn captions on');
    $('.cc-state', cc).textContent = on ? 'On' : 'Off';
  }

  function removeTrack() {
    trackEl?.remove();
    trackEl = null;
    ccBox.replaceChildren();
  }

  function openVideo(v, { captions }) {
    open = true;
    clearTimeout(errorTimer);
    error.hidden = true;
    // The video shows its own title, so the player names it only for screen readers.
    video.setAttribute('aria-label', v.title);
    removeTrack();
    cc.hidden = !v.captions;
    if (v.captions) {
      const el = Object.assign(document.createElement('track'), { kind: 'captions', src: v.captions, srclang: 'en', label: 'English' });
      video.append(el);
      el.track.mode = 'hidden';
      el.track.addEventListener('cuechange', () => el === trackEl && renderCues());
      trackEl = el;
    }
    video.src = v.src;
    root.hidden = false;
    shown = { p: -1, now: '', total: '' };
    setCaptions(captions);
    play();
    showControls();
    syncButtons();
  }

  function close(reason = 'closed') {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(hideTimer);
    clearTimeout(errorTimer);
    video.pause();
    removeTrack();
    video.removeAttribute('src');
    video.load();
    root.hidden = true;
    root.classList.remove('controls-hidden');
    onClose?.(reason);
  }

  // Tap the video: show the controls first; when they show, a tap plays or pauses.
  video.addEventListener('click', () => (root.classList.contains('controls-hidden') ? showControls() : togglePlay()));
  root.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && showControls());
  toggle.addEventListener('click', togglePlay);
  bigPlay.addEventListener('click', togglePlay);
  $('.close', root).addEventListener('click', () => close('closed'));
  cc.addEventListener('click', () => {
    setCaptions(!captionsOn);
    onCaptions?.(captionsOn);
    showControls();
  });
  video.addEventListener('play', () => {
    syncButtons();
    startDrawing();
  });
  // Seeking or loading while paused still updates the bar.
  for (const type of ['seeked', 'durationchange', 'loadedmetadata']) video.addEventListener(type, draw);
  video.addEventListener('pause', () => {
    syncButtons();
    showControls();
  });
  video.addEventListener('ended', () => onEnded?.() || close('ended'));
  video.addEventListener('error', () => {
    if (!open || !video.getAttribute('src')) return;
    error.textContent = 'This video cannot play. Going back to the list…';
    error.hidden = false;
    errorTimer = setTimeout(() => close('error'), 3000);
  });

  function seekTo(e) {
    const r = seek.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (video.duration > 0) video.currentTime = p * video.duration;
  }
  seek.addEventListener('pointerdown', (e) => {
    seeking = true;
    seek.setPointerCapture(e.pointerId);
    seekTo(e);
    showControls();
  });
  seek.addEventListener('pointermove', (e) => seeking && seekTo(e));
  seek.addEventListener('pointerup', () => {
    seeking = false;
    showControls();
  });
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') video.currentTime += 10;
    if (e.key === 'ArrowLeft') video.currentTime -= 10;
  });

  return {
    open: openVideo,
    setCaptionSize: (size) => (root.dataset.ccSize = size),
    close,
    togglePlay,
    get isOpen() {
      return open;
    },
    get isPlaying() {
      return open && isPlaying();
    },
  };
}
