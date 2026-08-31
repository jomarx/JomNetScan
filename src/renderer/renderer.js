'use strict';

const api = window.jomnet;

let state = { devices: [], settings: {}, interfaces: [], scanning: false, oui: { entries: 0 } };
let filter = 'all';
let query = '';
let selectedId = null;
// key null = the default grouping (new first, then online, then address).
let sort = { key: null, dir: 1 };

const $ = (id) => document.getElementById(id);

function displayName(device) {
  // A name the device announced beats a reverse-DNS hostname, which beats a
  // bare manufacturer. Anything the user typed wins outright.
  return device.name || device.discoveredName || device.hostname || device.vendor || device.ip;
}

/** How long this device has been on the list, in ms. */
function newAgeMs(device) {
  const firstSeen = Date.parse(device.firstSeen);
  return Number.isFinite(firstSeen) ? Date.now() - firstSeen : Infinity;
}

function newWindowMs() {
  // The main process owns this value; fall back only if state hasn't arrived.
  return state.newBadgeMs || 60 * 60 * 1000;
}

function isNew(device) {
  if (device.acknowledged) return false;
  // Applied here as well as in the main process so the badge goes at the right
  // minute rather than waiting for the next state push.
  return newAgeMs(device) < newWindowMs();
}

/** "New · 12m" - counts up to the point the badge retires itself. */
function newBadgeLabel(device) {
  const minutes = Math.floor(newAgeMs(device) / 60000);
  return minutes < 1 ? 'New · now' : `New · ${minutes}m`;
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function absoluteTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '-';
}

function ipSortKey(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/** Something online is "just seen", so it sorts ahead of every timestamp. */
function recency(device) {
  if (device.online) return Infinity;
  const t = Date.parse(device.lastSeen);
  return Number.isNaN(t) ? 0 : t;
}

function sortText(device, key) {
  if (key === 'device') return displayName(device);
  if (key === 'mac') return device.mac || '';
  if (key === 'vendor') return device.vendor || '';
  return '';
}

function compareBy(key, a, b) {
  if (key === 'ip') return ipSortKey(a.ip) - ipSortKey(b.ip);
  if (key === 'lastSeen') return recency(b) - recency(a);
  return sortText(a, key).localeCompare(sortText(b, key), undefined, {
    sensitivity: 'base',
    numeric: true, // so "Device 2" comes before "Device 10"
  });
}

/**
 * A device with no MAC or no vendor belongs at the bottom either way round -
 * flipping the direction shouldn't promote a column of blanks to the top.
 */
function blanksLast(key, a, b) {
  if (key !== 'mac' && key !== 'vendor') return 0;
  const x = sortText(a, key);
  const y = sortText(b, key);
  if (!x === !y) return 0;
  return x ? -1 : 1;
}

function visibleDevices() {
  const q = query.trim().toLowerCase();
  return state.devices
    .filter((d) => {
      if (filter === 'new' && !isNew(d)) return false;
      if (filter === 'online' && !d.online) return false;
      if (filter === 'offline' && d.online) return false;
      if (!q) return true;
      return [d.name, d.discoveredName, d.hostname, d.vendor, d.ip, d.mac, d.notes]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      if (sort.key) {
        const blank = blanksLast(sort.key, a, b);
        if (blank) return blank;
        const result = compareBy(sort.key, a, b) * sort.dir;
        // Ties fall back to address order so the list never jitters.
        return result || ipSortKey(a.ip) - ipSortKey(b.ip);
      }
      // Default: new devices first, then whatever is online, then by address.
      if (isNew(a) !== isNew(b)) return isNew(a) ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return ipSortKey(a.ip) - ipSortKey(b.ip);
    });
}

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (ch) => map[ch]);
}

/** Devices that announced a name the user hasn't overridden with one of their own. */
function adoptable() {
  return state.devices.filter((d) => d.discoveredName && !d.name);
}

function renderAdoptAll() {
  const pending = adoptable();
  const btn = $('adoptAllBtn');
  btn.hidden = pending.length === 0;
  btn.textContent = pending.length === 1
    ? 'Adopt 1 announced name'
    : `Adopt ${pending.length} announced names`;
}

function renderSortHeaders() {
  for (const th of document.querySelectorAll('#headRow th[data-sort]')) {
    if (th.dataset.sort === sort.key) th.dataset.dir = String(sort.dir);
    else delete th.dataset.dir;
  }
}

function renderStats() {
  const total = state.devices.length;
  const online = state.devices.filter((d) => d.online).length;
  const fresh = state.devices.filter(isNew).length;
  const cards = [
    { label: 'Online now', value: online, cls: '' },
    { label: 'Known devices', value: total, cls: '' },
    { label: 'Unnamed / new', value: fresh, cls: fresh ? 'is-new' : '' },
  ];
  $('stats').innerHTML = cards
    .map((c) => `<div class="stat ${c.cls}"><b>${c.value}</b><span>${c.label}</span></div>`)
    .join('');
}

function renderRows() {
  const devices = visibleDevices();
  const tbody = $('rows');
  tbody.replaceChildren();

  for (const device of devices) {
    const tr = document.createElement('tr');
    tr.dataset.id = device.id;
    if (device.id === selectedId) tr.classList.add('selected');

    const tags = [];
    if (isNew(device)) tags.push(`<span class="badge new" title="First seen ${absoluteTime(device.firstSeen)}">${escapeHtml(newBadgeLabel(device))}</span>`);
    if (device.isGateway) tags.push('<span class="badge tag">Router</span>');
    if (device.isSelf) tags.push('<span class="badge tag">This PC</span>');
    if (device.randomizedMac) tags.push('<span class="badge tag">Random MAC</span>');
    if (!device.name && device.discoveredName) tags.push('<span class="badge tag">Announced</span>');

    // Don't echo the announced name underneath itself once it has been adopted.
    const announcedDiffers = device.discoveredName && device.discoveredName !== device.name;
    const secondary = device.notes
      || (device.name ? (announcedDiffers ? device.discoveredName : device.hostname) : '')
      || (device.discoveredName ? device.hostname : '')
      || '';
    const nameClass = device.name ? 'name' : 'name unnamed';

    tr.innerHTML = `
      <td><span class="dot ${device.online ? 'on' : ''}${device.online && !device.respondedToPing ? ' weak' : ''}" title="${device.online ? (device.respondedToPing ? 'Replied to ping' : 'Seen in the ARP table, no ping reply') : 'Offline'}"></span></td>
      <td>
        <div class="${nameClass}">${escapeHtml(displayName(device))}${tags.join('')}</div>
        ${secondary ? `<div class="sub">${escapeHtml(secondary)}</div>` : ''}
      </td>
      <td class="mono">${escapeHtml(device.ip)}</td>
      <td class="mono">${escapeHtml(device.mac || '-')}</td>
      <td class="sub">${escapeHtml(device.vendor || '-')}</td>
      <td class="sub">${device.online ? 'Online' : relativeTime(device.lastSeen)}</td>
    `;
    tr.addEventListener('click', () => select(device.id));
    tbody.appendChild(tr);
  }

  const empty = $('empty');
  if (!devices.length) {
    empty.hidden = false;
    empty.textContent = state.devices.length
      ? 'Nothing matches that filter.'
      : 'No devices yet. Hit "Scan now" to look around your network.';
  } else {
    empty.hidden = true;
  }
}

function renderDetail() {
  const panel = $('detail');
  const device = state.devices.find((d) => d.id === selectedId);
  if (!device) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('detailTitle').textContent = displayName(device);
  $('detailSub').textContent = `${device.ip} - ${device.online ? 'online' : `last seen ${relativeTime(device.lastSeen)}`}`;
  // Never overwrite the box someone is typing in. A scan finishing in the
  // background re-renders this panel, and that used to wipe an unsaved name.
  const editing = (el) => el === document.activeElement;
  if (!editing($('nameInput'))) $('nameInput').value = device.name || '';
  if (!editing($('notesInput'))) $('notesInput').value = device.notes || '';

  const adoptOne = $('adoptOneBtn');
  const announced = device.discoveredName;
  adoptOne.hidden = !announced || announced === device.name;
  if (announced) adoptOne.textContent = `Use announced name: "${announced}"`;

  const facts = [
    ['MAC address', device.mac || 'not available'],
    ['Announced name', device.discoveredName || '-'],
    ['Hostname', device.hostname || '-'],
    ['Vendor', device.vendor || '-'],
    ['MAC type', device.randomizedMac ? 'Randomized (private address)' : 'Hardware address'],
    ['First seen', absoluteTime(device.firstSeen)],
    ['Last seen', absoluteTime(device.lastSeen)],
    ['Status', device.online ? 'Online' : 'Offline'],
    ['Reachability', device.respondedToPing ? 'Replied to ping' : 'Seen in the ARP table only'],
  ];
  $('facts').innerHTML = facts
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('');
}

function renderStatus() {
  const status = $('status');
  $('scanBtn').disabled = state.scanning;
  $('scanBtn').textContent = state.scanning ? 'Scanning...' : 'Scan now';

  const nets = state.interfaces.filter((i) => i.scannable);
  $('subnet').textContent = nets.length
    ? nets.map((i) => `${i.name} - ${i.cidr}`).join('   |   ')
    : 'No scannable network found';

  if (state.scanError) {
    status.className = 'status error';
    status.textContent = state.scanError;
    return;
  }
  status.className = 'status';
  if (state.scanning) {
    status.textContent = 'Scanning the network...';
  } else if (state.lastScan) {
    const { count, newCount } = state.lastScan;
    status.textContent = `${count} found ${relativeTime(state.lastScan.at)}${newCount ? ` - ${newCount} new` : ''}`;
    $('progressBar').style.width = '0%';
  } else {
    status.textContent = 'Ready';
  }
}

function renderSettings() {
  const s = state.settings;
  // A background scan pushes fresh state every few minutes, and this runs on
  // every push. Rewriting the control the user is currently editing would
  // throw away half-typed input, so leave the focused one alone.
  const editing = (el) => el === document.activeElement;
  const setChecked = (id, value) => { const el = $(id); if (!editing(el)) el.checked = value; };

  setChecked('setAutoScan', !!s.autoScan);
  setChecked('setNotify', !!s.notifyOnNew);
  setChecked('setNetbios', !!s.useNetbios);
  setChecked('setDiscover', s.discoverNames !== false);
  setChecked('setTray', !!s.minimizeToTray);
  if (!editing($('setInterval'))) $('setInterval').value = s.intervalMinutes;

  const select = $('setInterface');
  const scannable = state.interfaces.filter((i) => i.scannable);
  const options = ['<option value="">All networks (auto)</option>'].concat(
    scannable.map((i) => `<option value="${escapeHtml(i.name)}">${escapeHtml(`${i.name} - ${i.cidr}`)}</option>`),
  );
  // Keep a pinned adapter listed even while it is unplugged, otherwise the
  // dropdown quietly reads "All networks (auto)" and the real setting is
  // invisible - the value simply fails to match any option.
  if (s.interfaceName && !scannable.some((i) => i.name === s.interfaceName)) {
    options.push(`<option value="${escapeHtml(s.interfaceName)}">${escapeHtml(`${s.interfaceName} - not connected`)}</option>`);
  }
  const markup = options.join('');
  if (!editing(select)) {
    if (select.innerHTML !== markup) select.innerHTML = markup;
    select.value = s.interfaceName || '';
  }

  const entries = (state.oui && state.oui.entries) || 0;
  $('ouiStatus').textContent = entries
    ? `${entries.toLocaleString()} vendor prefixes loaded.`
    : 'Not downloaded yet - vendors will show as blank.';
}

function render() {
  renderStats();
  renderSortHeaders();
  renderAdoptAll();
  renderRows();
  renderDetail();
  renderStatus();
  renderSettings();
}

function select(id) {
  selectedId = id;
  render();
}

function applyState(next) {
  state = next;
  render();
}

// --- events ---

$('scanBtn').addEventListener('click', () => api.scan().then(applyState));

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  renderRows();
});

$('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const c of $('filters').children) c.classList.toggle('active', c === chip);
  renderRows();
});

$('adoptAllBtn').addEventListener('click', async () => {
  applyState(await api.adoptAnnounced(adoptable().map((d) => d.id)));
});

$('adoptOneBtn').addEventListener('click', async () => {
  const device = state.devices.find((d) => d.id === selectedId);
  if (!device || !device.discoveredName) return;
  applyState(await api.rename(device.id, device.discoveredName));
});

$('headRow').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  // Third click on the same column returns to the default grouping, so the
  // "new devices first" view stays reachable without a separate reset control.
  if (sort.key !== key) sort = { key, dir: 1 };
  else if (sort.dir === 1) sort = { key, dir: -1 };
  else sort = { key: null, dir: 1 };
  renderRows();
  renderSortHeaders();
});

$('detailClose').addEventListener('click', () => select(null));

$('saveBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  // Read both fields before awaiting anything. Every main-process call pushes
  // fresh state back, which re-renders this panel - so a value read after an
  // await is whatever the re-render just put there, not what was typed.
  const id = selectedId;
  const name = $('nameInput').value;
  const notes = $('notesInput').value;
  applyState(await api.save(id, name, notes));
});

$('forgetBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  const id = selectedId;
  selectedId = null;
  applyState(await api.forget(id));
});

$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveBtn').click();
});

$('settingsBtn').addEventListener('click', () => { $('settingsModal').hidden = false; });
$('settingsClose').addEventListener('click', () => { $('settingsModal').hidden = true; });
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) $('settingsModal').hidden = true;
});

function bindSetting(elementId, key, read) {
  $(elementId).addEventListener('change', async () => {
    applyState(await api.updateSettings({ [key]: read($(elementId)) }));
  });
}
bindSetting('setAutoScan', 'autoScan', (el) => el.checked);
bindSetting('setNotify', 'notifyOnNew', (el) => el.checked);
bindSetting('setNetbios', 'useNetbios', (el) => el.checked);
bindSetting('setDiscover', 'discoverNames', (el) => el.checked);
bindSetting('setTray', 'minimizeToTray', (el) => el.checked);
bindSetting('setInterval', 'intervalMinutes', (el) => Math.max(1, Number(el.value) || 5));
bindSetting('setInterface', 'interfaceName', (el) => el.value || null);

$('ouiBtn').addEventListener('click', async () => {
  const btn = $('ouiBtn');
  btn.disabled = true;
  btn.textContent = 'Downloading...';
  const result = await api.downloadOui();
  btn.disabled = false;
  btn.textContent = 'Download vendor database';
  $('ouiStatus').textContent = result.ok
    ? `${result.entries.toLocaleString()} vendor prefixes loaded.`
    : `Download failed: ${result.error}`;
  applyState(await api.getState());
});

$('dataBtn').addEventListener('click', () => api.openDataFolder());

api.onProgress(({ phase, done, total }) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  const labels = { ping: 'Pinging the subnet', arp: 'Reading the ARP table', names: 'Resolving names', discover: 'Listening for announcements' };
  $('status').className = 'status';
  $('status').textContent = `${labels[phase] || phase} ${done}/${total}`;
});

api.onState(applyState);
api.getState().then(applyState);

// Keep the "3 min ago" column and the New badge's age counter honest between
// scans - the badge count also drops on its own as badges age out.
setInterval(() => {
  if (state.scanning) return;
  renderRows();
  renderStats();
}, 30000);
