// It's very important that all error-handling code here be as minimal and
// self contained as possible to ensure that the error handling does not
// itself have errors.

const {app, dialog} = require('electron');

const APP_NAME = '南风编程';
const stringifyError = (error) => (error && error.stack) ? error.stack : error;

if (process.env.TW_GENERATE_ICONS) {
  // Icon generation only needs an Electron main process; scripts/generate-icons.cjs starts
  // this file with the variable set. See that file for the details.
  const {generate} = require('../scripts/generate-icons.cjs');
  app.whenReady()
    .then(generate)
    .then(() => {
      app.exit(0);
    })
    .catch((error) => {
      console.error('Error generating icons:', stringifyError(error));
      app.exit(1);
    });
} else try {
  process.on('unhandledRejection', (error) => {
    console.error('Error in promise:', error);
    app.whenReady().then(() => {
      dialog.showMessageBoxSync({
        type: 'error',
        title: APP_NAME,
        message: `Error in promise: ${stringifyError(error)}`,
        noLink: true
      });
    });
  });

  require('./index');
} catch (error) {
  console.error('Error starting main process:', error);
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'error',
      title: APP_NAME,
      message: `Error starting main process: ${stringifyError(error)}`,
      noLink: true
    });
    app.exit(1);
  });
}
