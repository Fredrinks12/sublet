import { CONTRACT, EXPLORER, accessKeys, accountState, listUnit, openPocket, pocket, rent, rentForeign, rpc, view } from './chain.js';
import { connectWallet, hasWallet, payToken, signClaim, transferLog } from './evm.js';
import { loginScript, newSshKey } from './keys.js';
import attacks from './attacks.json';

const MPC = 'v1.signer-prod.testnet';
const TOKENS = { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6 } };
const REFUSALS = {
  E_OCCUPIED: 'Someone else is renting this machine. Try again when it is vacant.',
  E_BUSY: 'Another key for this machine is being cut. Try again in a moment.',
  E_PAUSED: 'The owner has paused this machine.',
  E_NOT_ALLOWED: 'The owner only lets to named accounts.',
  E_UNDERPAID: 'That payment does not cover one tick.',
};

const $ = (id) => document.getElementById(id);

/**
 * Builds DOM from data. Listings are written by strangers and stored on-chain, so they are always
 * inserted as text, never as HTML. This page can hold a private key.
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return node;
}

const trim = (n) => Number(n.toFixed(6)).toString();
const near = (yocto) => trim(Number(yocto / 10n ** 18n) / 1e6);
const clock = (seconds) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(seconds * 1000);
const nowSecs = () => Math.floor(Date.now() / 1000);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function duration(seconds) {
  if (seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return `${seconds} seconds`;
}

function foreignPrice(rent) {
  const token = TOKENS[rent.token];
  if (!token) return { amount: rent.amount_per_tick, symbol: 'raw units' };
  return { amount: trim(Number(rent.amount_per_tick) / 10 ** token.decimals), symbol: token.symbol };
}

function prices(unit) {
  const per = duration(unit.terms.tick_secs);
  const list = [];
  const yocto = BigInt(unit.terms.near_per_tick);
  if (yocto > 0n) list.push(`${near(yocto)} NEAR`);
  for (const rent of unit.terms.foreign) {
    const { amount, symbol } = foreignPrice(rent);
    list.push(`${amount} ${symbol} on ${rent.chain}`);
  }
  if (!list.length) return `Free, ${per} at a time`;
  return `${list.join(', or ')}, per ${per}`;
}

const isVacant = (unit) => Number(unit.occupied_until) <= nowSecs();

function adFor(unit) {
  const vacant = isVacant(unit) && !unit.paused;
  const status = unit.paused
    ? 'Paused by the owner'
    : vacant
      ? 'Vacant now'
      : `Occupied until ${clock(Number(unit.occupied_until))}`;
  return el(
    'article',
    { class: 'ad' },
    el('h3', {}, unit.terms.title),
    unit.terms.blurb ? el('p', { class: 'blurb' }, unit.terms.blurb) : null,
    el('p', { class: 'price' }, prices(unit)),
    el('p', { class: `status ${vacant ? 'vacant' : 'occupied'}` }, status),
    el('p', { class: 'stats' }, `${plural(Number(unit.leases), 'lease')}, ${plural(Number(unit.renewals), 'renewal')}.${unit.terms.command ? ' One fixed command.' : ' Full shell.'}`),
    el(
      'footer',
      {},
      el('span', { class: 'ref' }, unit.id),
      el('button', { class: 'btn', type: 'button', onclick: () => openRent(unit) }, 'Rent'),
    ),
  );
}

async function loadUnits() {
  const box = $('ads');
  try {
    const units = await view('list_units', { limit: 60 });
    box.replaceChildren(...(units.length ? units.map(adFor) : [el('p', { class: 'ads-empty' }, 'Nothing to let yet. Be the first.')]));
    const vacant = units.filter((u) => isVacant(u) && !u.paused).length;
    $('vacant-count').textContent = `${plural(vacant, 'machine')} vacant now`;
    return units;
  } catch {
    box.replaceChildren(el('p', { class: 'ads-empty' }, 'Could not read the contract just now.'));
    $('vacant-count').textContent = 'Apply within';
    return [];
  }
}

// ---- Live checks -------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b64Tail(line) {
  return atob(line.trim().split(/\s+/)[1]).slice(-32);
}

function b58ToBinary(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c));
  const hex = n.toString(16).padStart(64, '0');
  return String.fromCharCode(...hex.match(/../g).map((b) => parseInt(b, 16)));
}

function addCheck(state, title, detail) {
  $('checks').append(
    el(
      'li',
      {},
      el('span', { class: `mark ${state === 'PASS' ? 'pass' : 'warn'}` }, state),
      el('div', {}, el('b', {}, title), el('small', {}, detail)),
    ),
  );
}

async function runChecks(units) {
  try {
    const keys = await accessKeys(CONTRACT);
    addCheck(
      keys.length === 0 ? 'PASS' : 'NOTE',
      'Nobody holds a key to the contract',
      keys.length === 0
        ? 'The account has zero access keys. Nobody can change its code or sign as it.'
        : `${keys.length === 1 ? '1 key still exists' : `${keys.length} keys still exist`} on this deployment, so its rules could be changed.`,
    );
    const about = await view('about');
    addCheck(about.build === 'release' ? 'PASS' : 'NOTE', 'This is the release build', `Version ${about.version}, build ${about.build}.`);
    const chains = await view('get_available_foreign_chains', {}, MPC);
    addCheck('PASS', 'The MPC network can read other chains', `${chains.length} chains right now: ${chains.join(', ')}.`);
    const unit = units.find((u) => u.ca_public_key);
    if (unit) {
      const derived = await view('derived_public_key', { path: `unit/${unit.owner}/${unit.id}`, predecessor: CONTRACT, domain_id: about.sign_domain }, MPC);
      const same = b58ToBinary(derived.replace('ed25519:', '')) === b64Tail(unit.ca_public_key);
      addCheck(same ? 'PASS' : 'NOTE', 'Only this contract can use a machine\'s key', `${MPC} derives the key for ${unit.id} from this contract's account. No other account can ask for it.`);
    }
    const state = await accountState(CONTRACT);
    addCheck('PASS', 'The code on chain has a public fingerprint', `Code hash ${state.code_hash}`);
  } catch {
    addCheck('NOTE', 'A check could not finish', 'A public RPC did not answer. Reload to try again.');
  }
}

async function loadLedger() {
  const list = $('ledger');
  try {
    const leases = await view('recent_leases', { limit: 9 });
    if (!leases.length) {
      list.replaceChildren(el('li', {}, el('span', {}), el('span', { class: 'who' }, 'No keys cut yet.'), el('span', {})));
      return;
    }
    list.replaceChildren(
      ...leases.map((lease) =>
        el(
          'li',
          {},
          el('span', { class: 'id' }, `#${lease.id}`),
          el('span', { class: 'who', title: lease.tenant }, `${lease.unit}, to ${lease.tenant}`),
          el('span', { class: 'state' }, lease.status === 'Issued' && Number(lease.valid_before) > nowSecs() ? 'Live' : lease.status),
        ),
      ),
    );
  } catch {
    list.replaceChildren();
  }
}

function renderAttacks() {
  $('attacks').replaceChildren(
    ...attacks.map((a) =>
      el(
        'tr',
        {},
        el('td', {}, a.attack),
        el('td', {}, a.tx ? el('a', { href: EXPLORER + a.tx, target: '_blank', rel: 'noopener' }, a.result) : a.result),
      ),
    ),
  );
}

// ---- Renting -----------------------------------------------------------------------------------

function rentMethods(unit) {
  const methods = [];
  const yocto = BigInt(unit.terms.near_per_tick);
  methods.push({
    kind: 'near',
    label: yocto > 0n ? 'NEAR' : 'Free',
    detail: 'A free testnet account is opened for you in this browser.',
    total: (ticks) => (yocto > 0n ? `${near(yocto * BigInt(ticks))} NEAR` : 'Nothing'),
  });
  for (const rent of unit.terms.foreign) {
    const { amount, symbol } = foreignPrice(rent);
    methods.push({
      kind: 'foreign',
      rent,
      label: `${symbol} on ${rent.chain}`,
      detail: hasWallet() ? `Sent straight to the owner. The contract reads ${rent.chain}.` : 'Needs a browser wallet such as MetaMask.',
      disabled: !hasWallet(),
      total: (ticks) => `${trim(Number(amount) * ticks)} ${symbol}`,
    });
  }
  return methods;
}

function openRent(unit) {
  const dialog = $('rent');
  const methods = rentMethods(unit);
  let method = methods.find((m) => !m.disabled) ?? methods[0];
  const slider = el('input', { type: 'range', min: 1, max: unit.terms.max_ticks, value: 1, id: 'ticks', 'aria-label': 'Length of the lease in ticks' });
  const length = el('span', {});
  const total = el('span', {});
  const refresh = () => {
    const ticks = Number(slider.value);
    length.textContent = duration(ticks * unit.terms.tick_secs);
    total.textContent = method.total(ticks);
  };
  slider.addEventListener('input', refresh);
  const options = methods.map((m, i) =>
    el(
      'label',
      {},
      el('input', {
        type: 'radio',
        name: 'pay',
        ...(m === method ? { checked: '' } : {}),
        ...(m.disabled ? { disabled: '' } : {}),
        onchange: () => {
          method = methods[i];
          refresh();
        },
      }),
      el('span', {}, el('b', {}, m.label), el('small', {}, m.detail)),
    ),
  );
  const start = el('button', { class: 'btn go', type: 'button' }, 'Rent this machine');
  start.addEventListener('click', () => runLease(unit, Number(slider.value), method));
  refresh();
  $('rent-body').replaceChildren(
    el('h2', { id: 'rent-title' }, unit.terms.title),
    el('p', { class: 'sub' }, `${unit.terms.principal}@${unit.terms.host}, port ${unit.terms.port}`),
    el('div', { class: 'field' }, el('label', { for: 'ticks' }, 'How long'), slider, el('p', { class: 'total' }, length, total)),
    el('div', { class: 'field' }, el('span', { class: 'legend' }, 'Pay with'), el('div', { class: 'pay-with' }, options)),
    start,
    el('p', { class: 'note' }, 'Your SSH key is made in this page and never leaves it. The contract only sees the public half.'),
  );
  dialog.showModal();
}

function progress(labels) {
  const items = labels.map((label) => el('li', {}, label));
  const list = el('ol', { class: 'progress' }, items);
  return {
    list,
    at(index) {
      items.forEach((item, i) => {
        item.className = i < index ? 'done' : i === index ? 'active' : '';
      });
    },
  };
}

async function runLease(unit, ticks, method) {
  const needsPocket = !pocket();
  const labels = [
    ...(needsPocket ? ['Opening a free testnet account'] : []),
    ...(method.kind === 'foreign'
      ? ['Connecting your wallet', `Sending rent to the owner on ${method.rent.chain}`, 'Signing your claim', `MPC network reading ${method.rent.chain}`]
      : ['Contract checking your rent']),
    'MPC network signing your key',
  ];
  const steps = progress(labels);
  let step = 0;
  const next = () => steps.at((step += 1));
  const signing = labels.length - 1;
  const proof = el('p', { class: 'proof' });
  $('rent-body').replaceChildren(el('h2', { id: 'rent-title' }, 'Cutting your key'), el('p', { class: 'sub' }, unit.terms.title), steps.list, proof);
  steps.at(0);
  const onLog = (line) => {
    if (line.includes('"payment_verified"') || line.includes('"sign"') || line.startsWith('sign:')) steps.at(signing);
  };

  try {
    if (needsPocket) {
      await openPocket();
      next();
    }
    const key = newSshKey();
    let outcome;
    let paymentTx;
    if (method.kind === 'near') {
      steps.at(step);
      setTimeout(() => steps.at(signing), 1800);
      outcome = await rent(unit, ticks, key.publicLine, onLog);
    } else {
      const { rent: price } = method;
      const from = await connectWallet(price.chain);
      next();
      const amount = BigInt(price.amount_per_tick) * BigInt(ticks);
      const receipt = await payToken({ from, token: price.token, to: price.pay_to, amount });
      paymentTx = receipt.transactionHash;
      next();
      const log = transferLog(receipt, price.token, price.pay_to);
      const message = await view('claim_message', {
        unit_id: unit.id,
        ssh_key: key.publicLine,
        chain: price.chain,
        tx: log.transaction_hash,
        log_index: log.log_index,
      });
      const signature = await signClaim(from, message);
      next();
      outcome = await rentForeign(unit, price.chain, log, key.publicLine, signature, onLog);
    }
    const lease = outcome.value;
    if (!lease?.certificate) throw new Error('The network did not confirm this payment. It stays unspent, so you can claim it again.');
    showKey(unit, lease, key, outcome.hash, paymentTx);
    loadUnits();
    loadLedger();
  } catch (error) {
    $('rent-body').append(
      el('div', { class: 'errorbox' }, REFUSALS[error.code] ?? error.message ?? 'Something went wrong.'),
      error.hash ? el('p', { class: 'proof' }, el('a', { href: EXPLORER + error.hash, target: '_blank', rel: 'noopener' }, 'See the refusal on chain')) : null,
    );
  }
}

function showKey(unit, lease, key, hash, paymentTx) {
  const script = loginScript({ lease, unit, key });
  const end = Number(lease.valid_before);
  const left = el('p', { class: 'countdown' });
  const tick = () => {
    const seconds = end - nowSecs();
    left.textContent = seconds > 0 ? `This key stops working in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'This key has expired.';
    if (seconds > 0 && $('rent').open) setTimeout(tick, 1000);
  };
  tick();
  const copy = el('button', { class: 'btn go', type: 'button' }, 'Copy the login commands');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(script);
      copy.textContent = 'Copied. Paste into a terminal.';
    } catch {
      copy.textContent = 'Select the text above and copy it.';
    }
  });
  $('rent-body').replaceChildren(
    el('h2', { id: 'rent-title' }, 'Your key is cut'),
    left,
    el('p', { class: 'note' }, 'Paste this into a terminal. It saves your key and certificate, then logs you in with plain ssh.'),
    el('pre', { class: 'script', tabindex: '0' }, script),
    copy,
    el(
      'p',
      { class: 'proof' },
      paymentTx ? `Rent paid in ${paymentTx}. ` : null,
      el('a', { href: EXPLORER + hash, target: '_blank', rel: 'noopener' }, `Lease ${lease.id} on the public record`),
    ),
  );
}

// ---- Listing a machine -------------------------------------------------------------------------

const LISTING_REFUSALS = {
  E_BAD_UNIT_ID: 'Use 3 to 32 lowercase letters, digits or hyphens for the name.',
  E_UNIT_EXISTS: 'That name is taken. Choose another.',
  E_USER_ALREADY_LISTED: 'You already list this user on this server. Each Unix user can be one unit, so tenants never share it.',
  E_ROOT_NOT_ALLOWED: 'Tenants cannot log in as root. Create a user just for them.',
  E_BAD_PRINCIPAL: 'That Unix user name has characters the contract does not accept.',
  E_BAD_TICK: 'A tick must last between 30 seconds and a day.',
  E_BAD_ADDRESS: 'That does not look like a 0x address.',
};

function openListing() {
  const input = (name, attrs = {}) => el('input', { name, id: `list-${name}`, ...attrs });
  const row = (label, control, hint) =>
    el('div', { class: 'form-row' }, el('label', { for: control.id }, label), control, hint ? el('small', {}, hint) : null);
  const form = el(
    'form',
    { class: 'listing' },
    row('Name', input('id', { required: '', pattern: '[a-z0-9-]{3,32}', placeholder: 'helsinki-8c' }), 'Lowercase letters, digits and hyphens.'),
    row('Headline', input('title', { required: '', maxlength: 80, placeholder: 'Sunny 8-core, 32 GB, NVMe' })),
    row('Description', input('blurb', { maxlength: 280, placeholder: 'What a tenant gets, and any house rules.' })),
    el(
      'div',
      { class: 'form-pair' },
      row('Server address', input('host', { required: '', placeholder: '203.0.113.7' })),
      row('SSH port', input('port', { type: 'number', required: '', min: 1, max: 65535, value: 22 })),
    ),
    row('Unix user for tenants', input('principal', { required: '', value: 'tenant' }), 'Create one just for this. Never root, never your own login.'),
    el(
      'div',
      { class: 'form-pair' },
      row('Minutes per tick', input('minutes', { type: 'number', required: '', min: 1, max: 1440, value: 5 })),
      row('NEAR per tick', input('price', { required: '', inputmode: 'decimal', value: '0.05' })),
    ),
    row('Longest lease, in ticks', input('max', { type: 'number', required: '', min: 1, max: 1000, value: 12 })),
    el(
      'label',
      { class: 'form-check' },
      input('evict', { type: 'checkbox', checked: '' }),
      el('span', {}, 'This Unix user is kept for tenants, so every process it owns can be killed when a lease ends.'),
    ),
    el('button', { class: 'btn go', type: 'submit' }, 'List this machine'),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitListing(new FormData(form), form);
  });
  $('rent-body').replaceChildren(
    el('h2', { id: 'rent-title' }, 'List a machine'),
    el('p', { class: 'sub' }, 'Your terms go in the contract, where anyone can read them.'),
    form,
  );
  $('rent').showModal();
}

/** Turns a decimal NEAR amount into yocto without going through floating point. */
function toYocto(text) {
  const [whole, fraction = ''] = text.trim().split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 24) throw new Error('Enter the price as a number, such as 0.05.');
  return (BigInt(whole || '0') * 10n ** 24n + BigInt(fraction.padEnd(24, '0') || '0')).toString();
}

async function submitListing(data, form) {
  const button = form.querySelector('.btn.go');
  form.querySelector('.errorbox')?.remove();
  button.disabled = true;
  button.textContent = 'Listing, this takes a few seconds';
  const id = data.get('id');
  try {
    const terms = {
      title: data.get('title'),
      blurb: data.get('blurb') ?? '',
      host: data.get('host'),
      port: Number(data.get('port')),
      principal: data.get('principal'),
      command: null,
      evict_user: data.get('evict') === 'on',
      permit_pty: true,
      permit_port_forwarding: false,
      tick_secs: Number(data.get('minutes')) * 60,
      max_ticks: Number(data.get('max')),
      near_per_tick: toYocto(data.get('price')),
      foreign: [],
      allowlist: null,
      needs_approval: false,
    };
    await openPocket();
    await listUnit(id, terms);
    const unit = await view('get_unit', { id });
    showSetup(unit);
    loadUnits();
    $('pocket-status').textContent = `Your testnet account: ${pocket().accountId}`;
  } catch (error) {
    button.disabled = false;
    button.textContent = 'List this machine';
    button.before(el('div', { class: 'errorbox' }, LISTING_REFUSALS[error.code] ?? error.message ?? 'Something went wrong.'));
  }
}

function showSetup(unit) {
  const principal = unit.terms.principal;
  const script = [
    `sudo useradd -m -s /bin/bash ${principal}   # skip if the user exists`,
    `echo '${unit.ca_public_key}' | sudo tee /etc/ssh/sublet_ca.pub`,
    `echo 'TrustedUserCAKeys /etc/ssh/sublet_ca.pub' | sudo tee /etc/ssh/sshd_config.d/sublet.conf`,
    `sudo systemctl reload ssh`,
  ].join('\n');
  const copy = el('button', { class: 'btn go', type: 'button' }, 'Copy the server commands');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(script);
      copy.textContent = 'Copied. Run them on your server.';
    } catch {
      copy.textContent = 'Select the text above and copy it.';
    }
  });
  $('rent-body').replaceChildren(
    el('h2', { id: 'rent-title' }, `${unit.id} is listed`),
    el('p', { class: 'note' }, 'Run these on your server. Nothing is installed, and your own SSH access does not change.'),
    el('pre', { class: 'script', tabindex: '0' }, script),
    copy,
    el('p', { class: 'note' }, `You own this listing through a testnet account kept in this browser, ${pocket().accountId}.`),
  );
}

// ---- The replay --------------------------------------------------------------------------------

const REPLAY = [
  ['$ ssh tenant@debian-vm', '', 450],
  ['tenant@debian-vm: Permission denied (publickey,password).', 'bad', 1400],
  ['', '', 200],
  ['$ sublet rent debian-vm --ticks 2', '', 450],
  ['Lease 1 on debian-vm: Issued', 'good', 500],
  ['  valid until   2 minutes from now', 'dim', 200],
  ['  certificate   signed by the NEAR MPC network, read by nobody', 'dim', 1300],
  ['', '', 200],
  ['$ sublet ssh 1 -- "whoami; uname -sr"', '', 450],
  ['tenant', 'good', 200],
  ['Linux 6.12.115+deb13.1-amd64', 'good', 1400],
  ['', '', 200],
  ['$ sublet ssh 1 -- "sleep 100000"', '', 900],
  ['                 ... two minutes pass, the lease ends ...', 'dim', 1600],
  ['Connection to debian-vm closed by remote host.', 'bad', 1200],
  ['', '', 200],
  ['$ sublet ssh 1', '', 450],
  ['tenant@debian-vm: Permission denied (publickey,password).', 'bad', 5200],
];

/** Shows the whole transcript from the start, then lights it line by line. */
function runReplay() {
  const pre = $('terminal');
  const lines = REPLAY.map(([text, cls]) => el('span', { class: cls ? `${cls} line` : 'line' }, `${text}\n`));
  pre.replaceChildren(...lines);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let index = 0;
  const step = () => {
    if (index === lines.length) {
      index = 0;
      lines.forEach((line) => line.classList.add('unlit'));
    }
    lines[index].classList.remove('unlit');
    setTimeout(step, REPLAY[index][2]);
    index += 1;
  };
  lines.forEach((line) => line.classList.add('unlit'));
  step();
}

// ---- Day and night editions --------------------------------------------------------------------

function setUpEditions() {
  const root = document.documentElement;
  const button = $('edition');
  const key = 'sublet.edition';
  const prefersNight = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const isNight = () => (root.dataset.theme ? root.dataset.theme === 'dark' : prefersNight());
  const label = () => {
    button.textContent = isNight() ? 'Day edition' : 'Night edition';
  };
  let saved = new URLSearchParams(location.search).get('edition');
  try {
    saved ??= localStorage.getItem(key);
  } catch {
    // A remembered edition is only a convenience.
  }
  if (saved === 'day' || saved === 'night') root.dataset.theme = saved === 'day' ? 'light' : 'dark';
  label();
  button.addEventListener('click', () => {
    const night = !isNight();
    root.dataset.theme = night ? 'dark' : 'light';
    label();
    try {
      localStorage.setItem(key, night ? 'night' : 'day');
    } catch {
      // As above.
    }
  });
}

// ---- Start -------------------------------------------------------------------------------------

setUpEditions();
$('list-machine').addEventListener('click', openListing);
$('contract-name').textContent = CONTRACT;
$('today').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format();
if (pocket()) $('pocket-status').textContent = `Your testnet account: ${pocket().accountId}`;
renderAttacks();
runReplay();
loadLedger();
loadUnits().then(runChecks);
setInterval(() => {
  loadUnits();
  loadLedger();
}, 30_000);

// Checked by the launch script: the block height proves the page reached the network.
rpc('block', { finality: 'final' })
  .then((block) => document.documentElement.setAttribute('data-near-height', block.header.height))
  .catch(() => {});
