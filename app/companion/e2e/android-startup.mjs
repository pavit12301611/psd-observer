// Retry only read-only attachment to a stale startup WebView target, before
// PIN transfer/job submission. Never retry an assertion, application crash,
// or any business operation. A crashed/restarted process must fail the smoke.
export function closedStartupTarget(error) {
  return /Target page, context or browser has been closed|WebView.*closed|Target closed/i.test(String(error?.message || error));
}
export async function attachStableStartup({ device, packageName, probe, sameProcess, attempts = 3, delay = (ms) => new Promise((r) => setTimeout(r, ms)), report = () => {} }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const view = await device.webView({ pkg: packageName, timeout: 40000 });
      const page = await view.page();
      await probe(page);
      return { page, reattachments: attempt };
    } catch (error) {
      if (!closedStartupTarget(error) || attempt + 1 >= attempts || !await sameProcess()) throw error;
      report(`Startup target closed with the same Android process; read-only reattachment ${attempt + 1}/${attempts - 1}. No credentials/actions were sent.`);
      await delay(300);
    }
  }
  throw new Error('Startup attachment attempts exhausted');
}
