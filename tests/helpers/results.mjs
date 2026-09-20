export function createResults({ jsonDetails = false } = {}) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({
    name,
    ok: Boolean(ok),
    detail: jsonDetails && typeof detail !== 'string' ? JSON.stringify(detail) : detail
  });
  const finish = () => {
    for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.detail}`}`);
    const failed = results.filter(result => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  };
  return { check, finish, results };
}
