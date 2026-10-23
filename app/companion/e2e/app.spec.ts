import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const state = { apiVersion: 1, version: '3.9.2', host: 'Fixture PC', platform: 'linux', pcControl: true, controlPinRequired: true, active: [], pending: [] as { id: string; text: string; kind: string }[] };
  await page.route('**/bridge/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/bridge', ''), body = route.request().postDataJSON() || {};
    requests.push({ path, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/login') return json(body.pin === '123456' ? { token: 'fixture-token' } : { detail: 'Wrong PIN' }, body.pin === '123456' ? 200 : 401);
    if (route.request().headers()['x-bridge-token'] !== 'fixture-token') return json({ detail: 'Unauthorized' }, 401);
    if (path === '/api/status') return json({ version: '3.9.2', model: 'Fixture local model', whatsapp: 'not connected', stats: {} });
    if (path === '/api/app/state') return json(state);
    if (path === '/api/files') return json({ downloads: [{ name: 'Fixture notes.txt', path: '/fixture/notes.txt', size: 1024 }], shared: [] });
    if (path === '/api/screen') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+juxkAAAAASUVORK5CYII=', 'base64') });
    if (path === '/api/app/approval') { state.pending = []; return json({ ok: true, text: 'The exact fixture action was approved.' }); }
    if (path === '/api/key' || path === '/api/type') return json(body.pin === '5678' ? { ok: true } : { detail: 'PC control PIN required' }, body.pin === '5678' ? 200 : 403);
    if (path === '/api/solve') return json({ ok: true, text: 'Fixture attachment received.' });
    if (path === '/api/chat') return json({ ok: true, text: body.text === '/stop' ? 'Fixture stop requested.' : `**A clear answer.**\n\nYou asked: ${body.text}\n\n- A useful first step\n- A considered next step` });
    return json({ ok: true });
  });
  return { requests, state };
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect PC', exact: true }).click();
  await page.getByLabel('PC bridge address').fill('https://fixture-pc.example');
  await page.getByLabel('Dashboard PIN').fill('123456');
  await page.getByRole('button', { name: 'Connect my PC', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PC connected', exact: true })).toBeVisible();
}
const go = (page: Page, name: string) => page.getByRole('navigation', { name: /Workspace|Mobile navigation/ }).getByRole('button', { name, exact: true }).filter({ visible: true }).click();

test('clean offline shell has no gradients, horizontal overflow, fake status or external font/model requests', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  const external: string[] = []; page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:5173') && !r.url().startsWith('ws://127.0.0.1:5173')) external.push(r.url()); });
  await page.goto('/'); await expect(page.getByRole('heading', { name: /Think clearly/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => [...document.querySelectorAll('.app-shell *')].some((e) => /gradient\(/i.test(getComputedStyle(e).backgroundImage)))).toBe(false);
  expect(errors).toEqual([]); expect(external).toEqual([]); await expect(page.getByRole('button', { name: 'Connect PC', exact: true })).toBeVisible();
});
test('theme and all five functional pages work and fit each phone orientation', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Switch to dark theme' }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const [nav, heading] of [['PC control', 'A little closer.'], ['Tasks', 'Room to focus.'], ['Files', 'Bring it together.'], ['Settings', 'On your terms.']]) {
    await go(page, nav); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Light theme', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
test('searchable capabilities only draft; disconnected sends never run or silently queue PC actions', async ({ page }) => {
  const f = await fixture(page); await page.goto('/'); await page.getByRole('button', { name: 'Explore commands', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search commands' }).fill('/panic'); await page.getByRole('button', { name: /^\/panic/ }).click();
  await expect(page.getByRole('textbox', { name: 'Message Observer' })).toHaveValue('/panic '); expect(f.requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); expect(f.requests).toHaveLength(0);
});
test('pairing, chat, history and files use real API contracts with header credentials only', async ({ page }) => {
  const f = await fixture(page); await page.goto('/'); await connect(page);
  await page.getByRole('textbox', { name: 'Message Observer' }).fill('/calc 2 + 2'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('A clear answer.', { exact: true })).toBeVisible(); expect(f.requests.some((r) => r.path === '/api/chat' && r.body.text === '/calc 2 + 2')).toBe(true);
  await expect(page.locator('script').filter({ hasText: 'fixture-token' })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).some((v) => v.includes('fixture-token') || v.includes('123456')))).toBe(false);
  await go(page, 'Files'); await expect(page.getByText('Fixture notes.txt', { exact: true })).toBeVisible();
});
test('bound approvals send the reviewed ID, never generic /yes or an automatic approval', async ({ page }) => {
  const f = await fixture(page); f.state.pending = [{ id: 'a'.repeat(64), text: 'Remove ONLY the disposable fixture.', kind: 'safety' }];
  await page.goto('/'); await connect(page); await go(page, 'Tasks'); await expect(page.getByText('Remove ONLY the disposable fixture.', { exact: true })).toBeVisible();
  expect(f.requests.filter((r) => r.path === '/api/app/approval')).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve this action', exact: true }).click(); await expect.poll(() => f.requests.some((r) => r.path === '/api/app/approval')).toBe(true);
  const request = f.requests.find((r) => r.path === '/api/app/approval'); expect(request?.body).toEqual({ id: 'a'.repeat(64), approve: true });
});
test('manual PC input is opt-in, sends the control PIN, and screen polling stops on leaving the page', async ({ page }) => {
  const f = await fixture(page); await page.goto('/'); await connect(page); await go(page, 'PC control');
  await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeDisabled(); await page.getByLabel('Enable manual PC input').check(); await page.getByLabel('PC control PIN').fill('5678');
  await page.getByRole('button', { name: 'Enter', exact: true }).click(); await expect.poll(() => f.requests.filter((r) => r.path === '/api/key').length).toBe(1);
  expect(f.requests.find((r) => r.path === '/api/key')?.body).toEqual({ key: 'Return', pin: '5678' });
  await page.getByRole('button', { name: 'Start screen preview' }).click(); await expect(page.getByAltText('Latest screenshot from your connected PC')).toBeVisible();
  await go(page, 'Chat'); const captures = f.requests.filter((r) => r.path === '/api/screen').length; await page.waitForTimeout(2700); expect(f.requests.filter((r) => r.path === '/api/screen').length).toBe(captures);
});
test('upload connects to the solver with exact file bytes and no input permission escalation', async ({ page }) => {
  const f = await fixture(page); await page.goto('/'); await connect(page);
  await page.getByLabel('Choose attachment').setInputFiles({ name: 'question.txt', mimeType: 'text/plain', buffer: Buffer.from('what is 2+2?') });
  await expect(page.locator('.attachment-preview')).toContainText('question.txt'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Fixture attachment received.', { exact: true })).toBeVisible(); expect(f.requests.find((r) => r.path === '/api/solve')?.body.imageBase64).toBe(Buffer.from('what is 2+2?').toString('base64'));
});
test('unpair clears the local session and history, and never replays old requests', async ({ page }) => {
  const f = await fixture(page); await page.goto('/'); await connect(page); await page.getByLabel('Message Observer').fill('private fixture phrase'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.getByText('A clear answer.', { exact: true })).toBeVisible();
  await go(page, 'Settings'); await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect & clear', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect PC', exact: true })).toBeVisible(); await go(page, 'Chat'); await expect(page.getByRole('heading', { name: /Think clearly/ })).toBeVisible();
  await page.waitForTimeout(650); expect(await page.evaluate(() => Object.values(localStorage).some((v) => v.includes('private fixture phrase')))).toBe(false);
  expect(f.requests.filter((r) => r.path === '/api/chat' && r.body.text === 'private fixture phrase')).toHaveLength(1);
});

test('PC tool selection leaves Direct AI in a fresh thread and never forwards tool commands to a cloud model', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = []; (window as unknown as { fixtureCalls: string[] }).fixtureCalls = calls;
    window.ObserverAndroid = { postMessage: (raw) => { const p = JSON.parse(raw); calls.push(p.method); let data: unknown = true;
      if (p.method === 'readState') data = JSON.stringify({ preferences: { chatMode: 'cloud' }, activeId: 'cloud-fixture', conversations: [{ id: 'cloud-fixture', mode: 'cloud', title: 'Cloud fixture', messages: [] }] });
      if (p.method === 'restore') data = null;
      if (p.method === 'cloudStatus') data = { configured: true, provider: 'fixture', model: 'fixture' };
      setTimeout(() => window.dispatchEvent(new CustomEvent('observer-native-result', { detail: { id: p.id, ok: true, data } })), 0);
    } };
  });
  await page.goto('/'); await expect(page.locator('.model-chip')).toContainText('Direct AI');
  await page.getByRole('button', { name: 'Explore commands', exact: true }).click(); await page.getByLabel('Search commands').fill('/shades'); await page.getByRole('button', { name: /^\/shades/ }).click();
  await expect(page.locator('.model-chip')).not.toContainText('Direct AI'); await expect(page.getByLabel('Message Observer')).toHaveValue('/shades ');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { fixtureCalls: string[] }).fixtureCalls.filter((m) => m === 'cloudChat'))).toEqual([]);
});
