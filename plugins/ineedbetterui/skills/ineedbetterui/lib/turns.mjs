export function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must not be empty.`);
  return value;
}

export function enforceResponseLimit(value, maxResponseChars) {
  if (maxResponseChars === 0) return;
  const count = Array.from(value).length;
  if (count > maxResponseChars) {
    const error = new Error(`A reply can be at most ${maxResponseChars} characters (this one has ${count}). Split or rewrite it; do not cut it off.`);
    error.maxResponseChars = maxResponseChars;
    error.length = count;
    throw error;
  }
}

export function readTurnNo(body) {
  if (!Number.isInteger(body.turn) || body.turn < 1) {
    throw new Error("turn must be a whole number from 1: the position of the user's message you are recording, counted in the conversation in front of you. Send it with every write of this turn.");
  }
  return body.turn;
}

export function checkQuestionTurn(no, last) {
  if (last === undefined) return;
  if (no <= last) {
    throw statusError(409, `You already recorded turn ${no}; you are at turn ${last}. Number the user's messages as they come: the next one is turn ${last + 1}.`);
  }
  if (no > last + 1) {
    const missing = [];
    for (let n = last + 1; n < no; n += 1) missing.push(n);
    const which = missing.length === 1
      ? `Turn ${missing[0]} of this conversation was`
      : `Turns ${missing.slice(0, -1).join(', ')} and ${missing.at(-1)} of this conversation were`;
    throw statusError(409, `${which} never recorded, so turn ${no} was not recorded either. You still have those messages in front of you: record turn ${last + 1} now, with the reply you gave to it, and work forward from there.`);
  }
}

export function checkOpenTurn(no, open) {
  if (open === null || open === no) return;
  throw statusError(409, `This is turn ${open}, not turn ${no}. You did not record turn ${open === no - 1 ? no : open + 1}'s message. Record it as a question first; the messages are still in front of you.`);
}

export function refuseFinal(body) {
  if (body.final !== undefined) throw new Error('final is no longer used: recording your reply closes the turn. One question takes one reply.');
}

export function applyPatch(current, body, where, refetch) {
  if (typeof body.old !== 'string' || !body.old) throw new Error(`old must be a non-empty string copied exactly from ${where}.`);
  if (typeof body.new !== 'string') throw new Error('new must be a string (it may be empty to delete old).');
  const count = current.split(body.old).length - 1;
  if (count === 0) throw new Error(`old was not found in ${where}; copy it exactly, or ${refetch}.`);
  if (count > 1) throw new Error(`old occurs ${count} times in ${where}; include more surrounding text so it occurs once.`);
  return current.replace(body.old, () => body.new);
}
