import { randomBytes } from 'node:crypto';
import { pickName } from './names.mjs';

const AGENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const USER_NAME = 'user';

export function createAgentRegistry({ readProjectInfo, writeProjectInfo, nowIso }) {
  let lastSweepDay = null;

  function readAgents() {
    const agents = readProjectInfo()?.agents;
    return agents && typeof agents === 'object' ? agents : {};
  }

  function writeAgents(agents) {
    writeProjectInfo(undefined, agents);
  }

  function sweepAgents() {
    const today = new Date().toISOString().slice(0, 10);
    if (lastSweepDay === today) return;
    lastSweepDay = today;
    const agents = readAgents();
    const cutoff = Date.now() - AGENT_TTL_MS;
    const kept = Object.fromEntries(Object.entries(agents).filter(([, agent]) => Date.parse(agent?.lastSeenAt || '') >= cutoff));
    if (Object.keys(kept).length !== Object.keys(agents).length) writeAgents(kept);
  }

  function registerAgent(model) {
    sweepAgents();
    const agents = readAgents();
    const taken = new Set(Object.values(agents).map(agent => agent?.name));
    const name = pickName(model, taken);
    const token = randomBytes(18).toString('base64url');
    const time = nowIso();
    agents[token] = { name, model: String(model || '').slice(0, 80), createdAt: time, lastSeenAt: time };
    writeAgents(agents);
    return { agent: name, token };
  }

  function identify(req) {
    const sent = req.headers['x-ineedbetterui-agent'];
    if (typeof sent !== 'string' || !sent) return null;
    if (sent === USER_NAME) return USER_NAME;
    sweepAgents();
    const agents = readAgents();
    const agent = agents[sent];
    if (!agent?.name) return null;
    agent.lastSeenAt = nowIso();
    writeAgents(agents);
    return agent.name;
  }

  return { identify, registerAgent };
}
