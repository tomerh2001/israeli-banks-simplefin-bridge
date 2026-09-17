#!/usr/bin/env bash
set -euo pipefail

# No host data, provider access, credentials, or application entrypoint.
docker run --rm -i --network none --shm-size 256m --entrypoint node "${1:?image is required}" --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import puppeteer, {PUPPETEER_REVISIONS} from 'puppeteer';

// The isolated CI container has no sandbox capability or untrusted page input.
const browser = await puppeteer.launch({args: ['--no-sandbox', '--disable-setuid-sandbox']});
try {
  assert.equal((await browser.version()).split('/').at(-1), PUPPETEER_REVISIONS.chrome);
  const page = await browser.newPage();
  await page.setContent('<main><h1>Offline browser check</h1></main>');
  assert.equal(await page.$eval('h1', (element) => element.textContent), 'Offline browser check');
  console.log('Bundled Chrome and Puppeteer passed the offline DOM check.');
} finally {
  await browser.close();
}
NODE
