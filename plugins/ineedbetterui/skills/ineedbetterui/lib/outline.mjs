const OUTLINE_STATUSES = ['pending', 'active', 'done'];

function isChildNo(no, parentNo) {
  return no.startsWith(parentNo + '-');
}

function outlineLeaves(items, parentNo) {
  return items.filter(item => isChildNo(item.no, parentNo));
}

function isLeaf(items, no) {
  return !items.some(item => isChildNo(item.no, no));
}

export function derivedOutline(items) {
  return items.map(item => {
    const children = outlineLeaves(items, item.no);
    if (!children.length) return { ...item };
    const leaves = children.filter(child => isLeaf(items, child.no));
    const status = leaves.some(child => child.status === 'active') ? 'active'
      : leaves.every(child => child.status === 'done') ? 'done'
      : 'pending';
    return { ...item, status };
  });
}

export function activeOutlineItem(items) {
  return derivedOutline(items).find(item => item.status === 'active' && isLeaf(items, item.no)) || null;
}

export function readOutlineInput(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty array of {no, title, type}.');
  const seen = new Set();
  return items.map((item, index) => {
    const at = `items[${index}]`;
    if (!item || typeof item !== 'object') throw new Error(`${at} must be an object.`);
    if (typeof item.no !== 'string' || !item.no.trim()) throw new Error(`${at}.no must be a string such as "2" or "2-1".`);
    if (typeof item.title !== 'string' || !item.title.trim()) throw new Error(`${at}.title must not be empty.`);
    if (item.type !== undefined && typeof item.type !== 'string') throw new Error(`${at}.type must be a string.`);
    if (item.status !== undefined) throw new Error(`${at} must not carry a status. Send it to PATCH /api/outline/status.`);
    const no = item.no.trim();
    if (seen.has(no)) throw new Error(`Two items share the number ${no}.`);
    seen.add(no);
    return { no, title: item.title.trim(), type: (item.type || '').trim(), status: 'pending' };
  });
}

export function mergeOutlineEdit(existing, incoming) {
  if (incoming.length < existing.length) {
    throw new Error(`The outline has ${existing.length} items and this leaves ${incoming.length}. Only the user can remove an item, on the page.`);
  }
  const before = new Map(existing.map(item => [item.no, item]));
  const kept = new Set(incoming.map(item => item.no));
  const lost = existing.filter(item => !kept.has(item.no) && item.status !== 'pending');
  if (lost.length) {
    throw new Error(`${lost.map(item => item.no).join(', ')} is not pending, so its number cannot change. Renumber only items that have not started.`);
  }
  return incoming.map(item => ({ ...item, status: before.get(item.no)?.status || 'pending' }));
}

export function stepOutlineStatus(items, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('items must be a non-empty array of {no, status}.');
  const next = items.map(item => ({ ...item }));
  const byNo = new Map(next.map(item => [item.no, item]));
  const touched = new Set();
  for (const [index, change] of changes.entries()) {
    const at = `items[${index}]`;
    if (!change || typeof change !== 'object') throw new Error(`${at} must be an object.`);
    const no = typeof change.no === 'string' ? change.no.trim() : '';
    const item = byNo.get(no);
    if (!item) throw new Error(`${no || at + '.no'} is not in the outline. Read it with GET /api/outline.`);
    if (touched.has(no)) throw new Error(`${no} appears twice in this request.`);
    touched.add(no);
    if (!isLeaf(items, no)) throw new Error(`${no} has sub-items, so its status follows them. Send the status of a sub-item instead.`);
    if (!OUTLINE_STATUSES.includes(change.status)) throw new Error(`${at}.status must be pending, active or done.`);
    const from = OUTLINE_STATUSES.indexOf(item.status);
    const to = OUTLINE_STATUSES.indexOf(change.status);
    if (Math.abs(to - from) > 1) throw new Error(`${no} is ${item.status} and can only become ${OUTLINE_STATUSES[from + (to > from ? 1 : -1)]}.`);
    item.status = change.status;
  }
  return next;
}
