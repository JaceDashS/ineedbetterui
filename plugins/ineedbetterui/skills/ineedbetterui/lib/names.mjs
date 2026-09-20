// Agent names. An agent registers with the model it runs as, and gets back a
// name like `claude-otter`: the model's family, then an animal nobody in this
// project is using. A number would be forgettable; an animal is not.

export const ANIMALS = [
  'otter', 'lynx', 'heron', 'marten', 'ibex', 'tapir', 'quokka', 'gecko',
  'raven', 'badger', 'osprey', 'civet', 'shrike', 'vole', 'puffin', 'dingo',
  'kudu', 'saiga', 'oryx', 'serval', 'caracal', 'fossa', 'numbat', 'pika',
  'bison', 'coati', 'dhole', 'egret', 'fennec', 'gaur', 'hoopoe', 'jerboa',
  'kite', 'loris', 'macaw', 'nyala', 'okapi', 'panther', 'quail', 'rhea',
  'sable', 'takin', 'urial', 'vicuna', 'wombat', 'yak', 'zebu', 'addax',
  'bongo', 'cuscus', 'douc', 'eider', 'falcon', 'genet', 'hyrax', 'indri',
  'jackal', 'kestrel', 'langur', 'margay', 'newt', 'onager', 'potto', 'quoll',
  'ratel', 'siskin', 'tanager', 'uakari', 'verdin', 'walrus', 'xerus', 'yapok',
  'zorilla', 'anoa', 'binturong', 'chital', 'desman', 'echidna', 'finch',
  'gharial', 'hamster', 'impala', 'junco', 'kiwi', 'lemur', 'mongoose',
  'nutria', 'oribi', 'pangolin', 'quetzal', 'reindeer', 'solenodon', 'tamarin',
  'urchin', 'viper', 'weasel', 'xenops', 'yabby', 'zebra', 'alpaca', 'beluga'
];

// The family an agent belongs to, taken from whatever model string it sends:
// `claude-opus-5` and `Claude Opus 5` both become `claude`.
export function modelFamily(model) {
  const first = String(model || '').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0];
  return first ? first.slice(0, 20) : 'agent';
}

// A name no one in `taken` holds. Animals are picked at random so two agents
// starting together are unlikely to queue up as first and second in a list;
// once they run out, the same animals come back with a number.
export function pickName(model, taken) {
  const family = modelFamily(model);
  const free = ANIMALS.filter(animal => !taken.has(`${family}-${animal}`));
  if (free.length) return `${family}-${free[Math.floor(Math.random() * free.length)]}`;
  for (let suffix = 2; ; suffix += 1) {
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const name = `${family}-${animal}-${suffix}`;
    if (!taken.has(name)) return name;
  }
}
