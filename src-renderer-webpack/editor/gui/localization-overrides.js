/**
 * A couple of menu labels that TurboWarp added are still untranslated in the Chinese
 * locales that ship with @turbowarp/scratch-l10n: gui.menuBar.settings and
 * gui.menuBar.language are literally the English strings in zh-cn and zh-tw.
 *
 * The GUI reads its react-intl messages from the editorMessages object, so overriding the
 * entries here fixes the labels without editing node_modules (which npm ci would revert).
 * This module must be imported after the GUI has loaded so that its own additional
 * translations are already merged in.
 */
import editorMessages from '@turbowarp/scratch-l10n/locales/editor-msgs';

const OVERRIDES = {
  'zh-cn': {
    'gui.menuBar.settings': '设置',
    'gui.menuBar.language': '语言'
  },
  'zh-tw': {
    'gui.menuBar.settings': '設定',
    'gui.menuBar.language': '語言'
  }
};

for (const [locale, messages] of Object.entries(OVERRIDES)) {
  if (editorMessages[locale]) {
    Object.assign(editorMessages[locale], messages);
  }
}
