// What the suites that run inside the app share: each check's result is printed as it finishes, a check
// that never returns can't hang the run, and the process exits non-zero if anything failed.
const CHECK_TIMEOUT_MS = 180000;

module.exports = function harness(win, app) {
  const results = [];
  const js = code => win.webContents.executeJavaScript(`(async () => { ${code} })().catch(e => 'ERROR ' + e.stack)`);

  const record = (status, name, detail) => {
    const line = `${status} ${name}: ${detail}`;
    results.push({ status, line });
    console.log(line);
  };

  const finish = () => {
    const count = status => results.filter(r => r.status === status).length;
    const failed = results.filter(r => r.status === 'FAIL');
    console.log(`\n${count('PASS')} passed, ${count('SKIP')} skipped, ${failed.length} failed`);
    for (const r of failed) console.log(r.line);
    app.exit(failed.length ? 1 : 0);
  };

  // Past this point the page can't answer, so report what's known instead of timing out on the rest.
  win.webContents.on('render-process-gone', (_e, details) => {
    record('FAIL', 'the app window', `gone (${details.reason})`);
    finish();
  });

  // A check returns 'ok ...' to pass, 'ok skipped ...' when it couldn't run here, anything else to fail.
  const check = async (name, code) => {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(`timed out after ${CHECK_TIMEOUT_MS / 1000} s`), CHECK_TIMEOUT_MS); });
    const r = await Promise.race([js(code), timeout]).catch(err => 'ERROR ' + err.message);
    clearTimeout(timer);
    const text = typeof r === 'string' ? r : JSON.stringify(r);
    record(text.startsWith('ok skipped') ? 'SKIP' : text.startsWith('ok') ? 'PASS' : 'FAIL', name, text);
  };

  return { js, check, record, finish };
};
