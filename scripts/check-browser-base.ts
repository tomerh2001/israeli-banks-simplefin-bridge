import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line import-x/no-extraneous-dependencies -- Deliberately check the scraper's resolved transitive driver.
const {version} = require('puppeteer/package.json') as {version: string};

const dockerfile = readFileSync('Dockerfile', 'utf8');
const baseVersion = /^FROM ghcr\.io\/puppeteer\/puppeteer:(?<version>\S+) AS base$/m.exec(dockerfile)?.groups?.version;
assert.equal(baseVersion, version, `Docker browser base (${baseVersion}) must match installed Puppeteer (${version}); update the Dockerfile and lockfile together.`);
console.log(`Verified browser base and Puppeteer both use ${version}`);
