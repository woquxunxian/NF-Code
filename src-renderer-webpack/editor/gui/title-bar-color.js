/**
 * Reports the editor's theme to the main process so that the window frame, the window
 * buttons drawn over the menu bar, and native UI like context menus can follow it.
 *
 * The GUI writes the resolved theme colors as CSS custom properties on <html> shortly
 * after it mounts, so the color is read from there rather than from the redux store,
 * which also means this keeps working when the theme is changed at runtime.
 */

const ACCENTS = {
  red: '#ff4c4c',
  purple: '#855cd6',
  blue: '#4c97ff'
};

// Where the menu bar gets its background from, in the order the themes define it:
// light uses the accent color, dark uses a flat gray.
const MENU_BAR_COLORS = [
  '--menu-bar-background',
  '--looks-secondary'
];

const FALLBACK = ACCENTS.red;

// Height of the editor's menu bar, which is what the window buttons are sized for.
const MENU_BAR_HEIGHT = 48;

// scratch-gui replaces the menu bar with its own stage menu bar while the stage is
// maximized; that bar is a little shorter, so the window buttons have to shrink with it.
const STAGE_MENU_HEIGHT = 44;

let stageFullscreen = false;

/**
 * Resolves a CSS variable on <html>, following nested var() references the way the GUI's
 * own evaluateCSS does. Custom properties declared inline are not substituted by the
 * browser, so "--menu-bar-background: var(--looks-secondary)" has to be chased by hand.
 * @param {string} name including the leading --
 * @param {number} depth
 * @returns {string} a CSS color, or an empty string
 */
const resolveVariable = (name, depth = 0) => {
  if (depth > 5) {
    return '';
  }

  const value = document.documentElement.style.getPropertyValue(name).trim();
  const reference = /^var\(\s*(--[^,)\s]+)\s*\)$/.exec(value);
  if (!reference) {
    return value;
  }

  return resolveVariable(reference[1], depth + 1);
};

const readColor = () => {
  for (const name of MENU_BAR_COLORS) {
    const color = resolveVariable(name);
    if (color) {
      return color;
    }
  }
  return FALLBACK;
};

const readIsDark = () => {
  const value = resolveVariable('--color-scheme');
  if (value) {
    return value === 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

/**
 * The color the window frame and the window buttons should use. In fullscreen the top bar
 * is scratch-gui's stage menu bar, which uses its own background color rather than the
 * menu bar's.
 * @returns {string}
 */
const readFrameColor = () => {
  if (stageFullscreen) {
    const fullscreenAccent = resolveVariable('--fullscreen-accent');
    if (fullscreenAccent) {
      return fullscreenAccent;
    }
  }
  return readColor();
};

const readFrameHeight = () => (stageFullscreen ? STAGE_MENU_HEIGHT : MENU_BAR_HEIGHT);

/**
 * The system window buttons are laid out in device independent pixels while the menu bar
 * is laid out in CSS pixels, so the width has to be converted before it can be used as
 * padding.
 * @param {number} dips
 * @returns {number} CSS pixels
 */
const toCssPixels = (dips) => Math.round(dips / (window.devicePixelRatio || 1));

/**
 * The buttons are not drawn at all on platforms that keep the whole native frame.
 * @param {number} width in device independent pixels
 */
const applyWindowControlsWidth = (width) => {
  const reserved = (typeof width === 'number' && width > 0) ? toCssPixels(width) : 0;
  document.documentElement.style.setProperty('--tw-window-controls-width', `${reserved}px`);
};

let lastReported = null;

const update = () => {
  const color = readFrameColor();
  const isDark = readIsDark();
  const height = readFrameHeight();

  if (lastReported && lastReported.color === color && lastReported.isDark === isDark && lastReported.height === height) {
    return;
  }
  lastReported = {
    color,
    isDark,
    height
  };

  if (window.EditorPreload && window.EditorPreload.setTitleBarColor) {
    window.EditorPreload.setTitleBarColor(color, isDark, height);
  }
};

/**
 * Called by the desktop HOC when the stage enters or leaves fullscreen, where the top bar
 * is the stage menu bar rather than the menu bar.
 * @param {boolean} value
 */
const setStageFullscreen = (value) => {
  const next = !!value;
  if (next === stageFullscreen) {
    return;
  }
  stageFullscreen = next;
  update();
};

const refreshWindowControlsWidth = async () => {
  if (!window.EditorPreload || !window.EditorPreload.getWindowControlsWidth) {
    return;
  }
  applyWindowControlsWidth(await window.EditorPreload.getWindowControlsWidth());
};

const initialize = () => {
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style']
  });

  window.addEventListener('tw-window-controls-width', (event) => {
    applyWindowControlsWidth(event.detail);
  });

  // Entering or leaving fullscreen changes whether the buttons exist at all
  window.addEventListener('resize', () => {
    refreshWindowControlsWidth();
  });

  update();
  refreshWindowControlsWidth();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, {once: true});
} else {
  initialize();
}

export {
  setStageFullscreen
};
