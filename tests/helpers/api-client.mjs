export function createApiClient({ model = 'test-model' } = {}) {
  const tokenFor = new Map();
  const turnNo = new Map();

  async function agentToken(base) {
    if (!tokenFor.has(base)) {
      const response = await fetch(base + '/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      tokenFor.set(base, (await response.json()).token);
    }
    return tokenFor.get(base);
  }

  function countTurn(identity, route, body) {
    if (!body || typeof body !== 'object' || body.turn !== undefined) return [body, null];
    if (route !== '/api/entries' && route !== '/api/progress' && route !== '/api/pin/edit') return [body, null];
    const next = body.kind === 'question' ? (turnNo.get(identity) || 0) + 1 : Math.max(turnNo.get(identity) || 0, 1);
    return [{ ...body, turn: next }, next];
  }

  function keepTurn(identity, route, at, status, data) {
    if (route === '/api/reset' && status < 300) turnNo.clear();
    if (at !== null && status < 300 && !data.deduplicated) turnNo.set(identity, at);
  }

  async function request(base, method, route, body, headers = {}) {
    const token = headers['X-Ineedbetterui-Agent'] || (route === '/api/agents' ? '' : await agentToken(base));
    const identity = token ? { 'X-Ineedbetterui-Agent': token } : {};
    const [payload, at] = countTurn(token, route, body);
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...identity, ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const data = await response.json();
    keepTurn(token, route, at, response.status, data);
    return { status: response.status, data };
  }

  return { request };
}
