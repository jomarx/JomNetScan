'use strict';

// One network layer, two implementations. Everything above this file -
// scanner.js and its callers - works the same on either.

const common = require('./common.js');

const IMPLEMENTATIONS = {
  win32: () => require('./windows.js'),
  linux: () => require('./linux.js'),
};

const pick = IMPLEMENTATIONS[process.platform];
if (!pick) {
  // Failing loudly at startup beats a scan that quietly finds nothing because
  // every shell-out used the wrong argument syntax.
  throw new Error(
    `JomNetScan has no network backend for "${process.platform}". `
    + 'Supported platforms are Windows and Linux.',
  );
}

module.exports = { ...common, ...pick() };
