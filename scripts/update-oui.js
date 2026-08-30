#!/usr/bin/env node
'use strict';

// Fetches the IEEE MAC vendor registry into data/oui.json for development runs.
// The app itself can do the same from Settings, writing into its userData folder.

const path = require('path');
const oui = require('../src/main/oui.js');

const dest = path.join(__dirname, '..', 'data', 'oui.json');

console.log(`Downloading ${oui.OUI_URL} ...`);
oui
  .download(dest)
  .then(({ entries }) => console.log(`Saved ${entries} vendor prefixes to ${dest}`))
  .catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
