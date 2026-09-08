// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- These regression tests run against actual browser controls.
/// <reference lib="dom" />
/* eslint-disable unicorn/isolated-functions -- document is the browser global inside page.evaluate. */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import puppeteer, {type Browser, type Page} from 'puppeteer';
import {configureClalLoginDelivery} from './login.js';

// Opt in with the container's pinned Chrome; these tests never contact Clal.
describe.runIf(process.env.CLAL_BROWSER_TEST === '1')('Clal hidden Material controls', () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
		page = await browser.newPage();
	});
	afterAll(async () => browser?.close());

	async function fixture(selected: boolean) {
		await page.setContent(`
			<style>input { position:absolute; clip:rect(0,0,0,0); width:1px; height:1px; }</style>
			<label for="voice">הודעה קולית</label><input id="voice" name="delivery" type="radio" ${selected ? '' : 'checked'}>
			<label for="sms">סמס</label><input id="sms" name="delivery" type="radio" ${selected ? 'checked' : ''}>
			<label for="consent">Consent</label><input id="consent" type="checkbox" ${selected ? 'checked' : ''}>
		`);
	}

	it('preserves already selected SMS and consent without toggling either', async () => {
		await fixture(true);
		await page.evaluate(() => {
			for (const input of document.querySelectorAll('input')) {
				input.addEventListener('click', () => {
					input.dataset.clicked = 'true';
				});
			}
		});
		await configureClalLoginDelivery(page);
		expect(await page.$$eval('input:checked', elements => elements.map(element => element.id))).toEqual(['sms', 'consent']);
		expect(await page.$$('[data-clicked]')).toHaveLength(0);
	});

	it('selects SMS by its label when it is not first and enables unselected consent', async () => {
		await fixture(false);
		await configureClalLoginDelivery(page);
		expect(await page.$$eval('input:checked', elements => elements.map(element => element.id))).toEqual(['sms', 'consent']);
	});

	it('rejects an ambiguous form before changing any input', async () => {
		await fixture(false);
		await page.evaluate(() => {
			const input = document.createElement('input');
			input.type = 'checkbox';
			document.body.append(input);
		});
		await expect(configureClalLoginDelivery(page)).rejects.toThrow('INVALID_RESPONSE');
		expect(await page.$$eval('input:checked', elements => elements.map(element => element.id))).toEqual(['voice']);
	});
});
