# JomNetScan

A small app for keeping an eye on your home network. It finds everything
talking on your LAN, lets you give each thing a name, and tells you when
something shows up that you haven't named yet.

Think Fing, minus the account, the cloud, and the upsell.

It comes in two shapes, sharing one scanner and one UI:

- **A Windows desktop app.** `npm start`, or build an installer with
  `npm run dist`.
- **A web app for a Linux server.** `npm run serve`. Scans around the clock
  instead of only while your laptop is awake, is reachable from any browser on
  the LAN, and can push new-device alerts to your phone. Setup is in
  [deploy/README.md](deploy/README.md).

The desktop build is the one to use if you just want to look at your network
now and then. The server build is the one that notices things while you aren't
looking.

## What it does

- **Finds devices** — pings every address on your subnet, then reads the ARP
  table to see who answered. No admin rights, no packet capture, no drivers.
- **Names them** — click a device, type "Kitchen tablet", done. Names are keyed
  to the MAC address, so a device keeps its name across DHCP lease changes.
- **Asks the network for names** — devices that speak mDNS or UPnP already
  publish a name their owner chose. Those show up on their own, and one button
  adopts the lot.
- **Flags new arrivals** — a device that turns up is badged **New · 12m**,
  counting how long it has been on the list, and sorted to the top. Optional
  notification when one appears: a desktop toast, or on the server build a
  Telegram or ntfy message to your phone.
- **Runs quietly** — rescans on a timer. On the desktop it lives in the system
  tray; on the server it's a systemd service.
- **Keeps your data local** — a couple of JSON files on the machine it runs on.
  Discovery and scanning never leave your LAN. Two things can reach the
  internet, both off by default and both only because you switched them on: the
  vendor-database download, and phone alerts if you configure Telegram. See
  *What leaves your network* below.

## Running it

```bash
npm install
npm start
```

If Electron's binary doesn't download during install (npm may block the
postinstall script), run `node node_modules/electron/install.js` once.

To run the web build instead — on Linux, or on Windows for development:

```bash
JOMNETSCAN_PASSWORD=something npm run serve
```

Then open `http://localhost:8099`. Leave the password unset and the server
makes one up each time it starts and prints it to the log, so it is never
accidentally open to the whole LAN. For the real thing — a systemd unit, a
service account, phone alerts — see [deploy/README.md](deploy/README.md).

The web build needs no Electron and no build step: it serves the same
`src/renderer/` the desktop app loads.

To build a Windows installer and a portable `.exe` into `dist/`:

```bash
npm run dist
```

That produces `JomNetScan Setup <version>.exe` (installer, per-user, lets you
pick the directory) and `JomNetScan <version>.exe` (portable, run it from
anywhere). Both are about 80 MB — that is Electron, not this app. Neither is
code-signed, so SmartScreen will warn on first run.

**If the build stalls on "retrying 3 more times":** electron-builder unpacks a
signing toolchain that contains two macOS symlinks, and creating symlinks on
Windows needs a privilege a normal account doesn't have. The Windows half of
that archive extracts fine, so unpack it yourself once and the build will reuse
it:

```bash
node_modules/7zip-bin/win/x64/7za.exe x "$LOCALAPPDATA/electron-builder/Cache/winCodeSign/"*.7z -o"$LOCALAPPDATA/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0" -y
```

The two `.dylib` errors it prints are expected and harmless here.

## Vendor names

MAC-to-manufacturer lookup needs the public IEEE OUI registry, which isn't
bundled — no guessed data ships in this repo. Grab it either way:

- In the app: **Settings → Download vendor database** (~4 MB, saved to your
  user profile).
- On the command line: `npm run update-oui`.

Until then the Vendor column stays blank, except for randomized MACs, which are
detected from the address itself — modern phones rotate these, which is why the
same handset can reappear as a "new" device.

## The New badge

A device you haven't named is badged **New**, with a counter showing how long
it has been on the list — `New · now`, `New · 12m`, `New · 59m`. After an hour
the badge retires itself and the device becomes an ordinary row.

Naming it clears the badge immediately, whatever its age.

The hour is deliberate. A badge that never goes away stops being an alert: with
thirty permanently-flagged rows you learn to ignore the colour, and a device
that genuinely appeared five minutes ago looks exactly like one from last week.
The counter is there so you can tell those apart at a glance.

Expiry runs server-side — in the Electron main process or the web server, not
in the browser — on startup, after every scan, and on a one-minute tick so
badges still age out with auto-scan switched off. The window lives in one
constant (`NEW_BADGE_MS` in `src/core/store.js`) that the UI is handed in its
state, so the badge, the **Unnamed / new** count and the tray tooltip can't
drift apart.

## Pinging a device

Select a device and click **Ping this device**. It sends one ping a second and
draws the round-trip times as they arrive, with **min / avg / max / loss**
underneath. Click again to stop; it stops on its own after two minutes.

Dropped pings are drawn as red ticks along the bottom and break the line, so
packet loss looks like packet loss rather than like missing data. The vertical
scale never goes below 10 ms, otherwise an idle LAN renders as a mountain
range of sub-millisecond noise.

This is the tool for "the Wi-Fi feels bad" — a flat line near zero says the
link is fine, a sawtooth or a run of red ticks says it isn't.

Samples are live only. They're a diagnostic, not history, so they aren't
written to disk and they reset when you start a new run.

## Checking a device's open ports

Select a device and click **Scan for open ports**. It tries a TCP connect
against ~37 ports a home network actually runs something on — SSH, HTTP, SMB,
RTSP, MQTT, Chromecast, Plex, printer ports and so on — and lists whatever
answers, with what the port usually means. It takes a couple of seconds, and
the result is saved against the device so it's still there next time.

This is what tells you what a mystery box is *for*. A bare `Espressif Inc.` row
answering on 8123 is Home Assistant; one answering on 9100 is a print server; a
camera usually shows 554.

Deliberate limits:

- **On request only, one device at a time.** It is never part of a normal scan.
  Sweeping every port of every device on a timer is slow, noisy, and looks
  exactly like the thing an intrusion detector exists to complain about.
- **Only devices already in your list.** The scan is addressed by stored device
  id, so there is no way to point it at an arbitrary host from the UI.
- **Common ports, not all 65535.** The curated list is in
  `src/core/ports.js` if you want to add to it.

An open port is not by itself a problem — your router answering on 80 and 443
is just its admin page. It's worth a look when a device you can't account for
is listening for connections.

## Sorting and filtering

Click a column header to sort by it — **Device**, **IP address**, **MAC**,
**Vendor** or **Last seen**. Click again to reverse, and a third time to return
to the default grouping, which puts new devices first, then whatever is online,
then address order.

Addresses sort numerically rather than as text, so `.2` comes before `.10`.
Devices with no MAC or no known vendor sit at the bottom of those columns in
both directions — flipping the sort shouldn't promote a column of blanks to the
top. Anything online counts as "just seen" under **Last seen**.

The search box and the All / New / Online / Offline chips narrow the list; the
sort applies to whatever is left.

## Network log

**Network log** in the top bar shows what came online, what went offline and
what appeared for the first time, newest first, grouped by day with each
scan's changes on a timeline. Filter by kind or by name and IP. Click an entry
to open that device. An open log updates by itself when a scan lands.

The log is built from scans, so it's only as fine-grained as the scan
interval:

- A device that drops off and comes back between two scans never appears.
- A time is when the scan ran, not the moment the device came or went.
- When the app wasn't scanning for well over the interval (the laptop slept,
  the server restarted), the log shows a **No scans from … to …** marker.
  Whatever changed in that window is listed at the first scan after it, rather
  than pretending it happened then.
- The first scan of an empty list is one "starting point" entry, not a burst
  of arrivals.

Entries show the device's current name. A device you've since forgotten keeps
the name it had at the time. The log lives in `events.json` and keeps 30 days
(at most 20,000 entries). It isn't part of a backup.

## Automatic naming

Most devices will tell you their name if you listen. Every scan runs two
discoveries alongside the ping sweep, so they cost no extra time:

- **mDNS / Bonjour** — Apple gear, Chromecast and Google speakers, printers,
  NAS boxes, ESPHome nodes. Chromecast-family devices carry the name their owner
  actually picked in a TXT `fn` record, so you get "bedroom speaker" instead of
  `Google-Home-Mini-d342580c2f1317daa934ddbb1f730f6c`.
- **SSDP / UPnP** — smart TVs, routers, media servers. Each responder's device
  description is fetched and its `<friendlyName>` taken.

Discovered names appear on their own with an **Announced** badge. On their own
they do *not* count as naming the device — it stays flagged **New**, so
discovery never quietly silences the new-device alert. A name you type always
wins over a discovered one.

To make them stick, adopt them:

- **Adopt N announced names** in the toolbar takes every announced name for
  devices you haven't named. It only appears when there is something to adopt.
- **Use announced name: "…"** in the detail panel does one device.

Adopting is exactly the same as typing the name yourself, so those devices stop
being flagged New.

### Names that aren't names

Some services advertise an instance that is really an identifier — a Samsung
handset announces `nearby presence nsd e2c3cf16 3a26 4c08 a847`. Writing that
into your device list is worse than leaving the field blank, so labels that look
like identifiers are rejected: three or more hex tokens, or a punctuated UUID.

The threshold is three rather than two because model numbers are sometimes
accidentally hexadecimal — `Archer C24 AC750` would fail a stricter test.

A trailing serial is not an identifier, just clutter, so it gets trimmed rather
than rejected: where a Chromecast offers no TXT name to prefer,
`Google-Home-Mini-d342580c2f1317daa934ddbb1f730f6c` falls back to
`Google Home Mini`.

Announced names stored by earlier versions are re-checked against this filter at
startup and dropped if they fail, since a merge would otherwise keep a bad name
forever.

### Coverage

Expect this to cover the chatty half of a network at best. Cheap IoT plugs and
bulbs announce nothing and still need naming by hand. Switch it off under
**Settings → Listen for names devices announce**.

## How the scan works

1. Read the local IPv4 interfaces and work out each subnet from its netmask.
   Anything wider than a /22 is skipped as too slow to sweep politely.
2. Ping every host address in parallel. The replies barely matter — the point is
   to populate the ARP cache.
3. Read the ARP table for IP/MAC pairs, dropping multicast and broadcast rows.
4. Read the routing table for the default gateway so the router gets labelled.
5. Resolve names via reverse DNS, falling back to NetBIOS for the Windows boxes
   and printers a home router won't have DNS entries for.

Steps 2–5 are the only platform-specific code in the app, and they live in
`src/core/net/windows.js` and `src/core/net/linux.js`. Windows shells out to
`ping`, `arp -a`, `route print` and `nbtstat`; Linux to `ping`,
`ip -4 neigh show`, `ip -4 route show default` and `nmblookup`. `ip` is part of
iproute2 and is always there; `nmblookup` comes from `samba-common-bin` and
often isn't, so it's probed for once and skipped if missing rather than failing
254 times a sweep.

The mDNS and SSDP listening described under *Automatic naming* runs alongside
the sweep rather than after it, so it costs no extra wall time.

A full /24 takes roughly 20–35 seconds, most of it spent spawning `ping`
processes.

The sweep runs 64 pings at a time with a 1 second deadline. Pushing the
concurrency higher is a false economy: at 128 workers on a 500 ms deadline the
processes starve each other and only 3 of 35 live devices answered in time,
versus 33 at these settings — and the wider sweep was no faster. ARP still gets
populated either way, since the ARP request goes out before the ICMP echo, but
the reply is what distinguishes a live host from a stale cache entry.

If the interface pinned in Settings disappears — Wi-Fi switched off, laptop
docked — the scan falls back to whatever is connected rather than refusing to
run, and the dropdown keeps showing the pinned adapter marked *not connected*.

## Known limits

- **Windows and Linux only.** The desktop app is Windows; the web build is
  developed against Ubuntu. macOS would need a third `src/core/net/` module —
  BSD `ping` and `arp` take different arguments again.
- **Same-subnet only.** ARP doesn't cross a router, so guest networks and
  separate VLANs won't show up.
- **Sleeping devices look offline.** A phone with its screen off often won't
  answer a ping. Devices are marked offline, never deleted.
- **"Online" can lag reality by a minute or two.** Presence comes from the ARP
  cache, because plenty of hosts drop ICMP and demanding a ping reply would
  hide them. The cache keeps entries for a short while after a device leaves,
  so a departed device can linger. A **hollow** status dot is the app saying
  so: present in the table, but not confirmed this scan.
- **The hollow dot is trustworthy on Linux and not on Windows.** On Linux it
  comes from the kernel's own neighbour state — `ip neigh` reports `REACHABLE`
  for an entry confirmed in the last few seconds and `STALE` for one that is
  merely cached, which is exactly the distinction the dot exists to draw. On
  Windows there is no equivalent, so the dot falls back to "did this device
  answer a ping during this scan", and in the packaged build that answer is
  unreliable — devices that are plainly up still render hollow. Treat a hollow
  dot on Windows as "no information", not as "probably gone". Hovering a dot
  says which of the two you're looking at.
- **A brand-new device has to be confirmed before it's recorded, on Linux.**
  A stale neighbour entry for a device that left is indistinguishable from a
  device that arrived, if all you have is the entry — and on the first server
  install two of those turned up within ten minutes and would have been a
  phone alert for devices that never went anywhere. So a first sighting backed
  by nothing but a `STALE` row is skipped, and lands on a later scan once the
  kernel confirms it. Devices already in your list are never held back this
  way, and the rule is off on Windows, where an unconfirmed device is usually
  just a missed ping.
- **Randomized MACs.** Phones that rotate their MAC per network will appear as
  a new device when they rotate. There's no fix for this from outside the
  device; the app at least labels them so you know what you're looking at.
- **Announcements are a minority.** Only devices that speak mDNS or UPnP get a
  name for free, and only while they're awake — a TV that's off announces
  nothing. Rescan later and it fills in.

## What leaves your network

Nothing, unless you ask for it. Scanning, discovery and port checks are all
LAN-local, there is no account, no telemetry and no phone-home.

Two features are exceptions, and both are off until you turn them on:

- **The vendor database** — a one-off ~4 MB fetch from the IEEE, on the button
  press or `npm run update-oui`. It sends nothing about your network.
- **Telegram alerts** (web build) — this one is a real trade. Telegram learns
  that a new device joined your network, when, and whatever the alert text
  says. That is a reasonable price for an alert that reaches your phone, but
  it is a third party learning something about your house, so it is worth
  deciding deliberately rather than by default. A **webhook** pointed at an
  [ntfy](https://ntfy.sh) instance you host yourself gets you the same phone
  notification with nothing leaving the building.

## Where your data lives

Desktop: `%APPDATA%\JomNetScan\`. **Settings → Open data folder** takes you
there.

Web: `/var/lib/jomnetscan` under systemd, `.data/` beside the repo otherwise,
or wherever `JOMNETSCAN_DATA` points.

Either way it's `devices.json`, `settings.json`, the network log in
`events.json`, the downloaded `oui.json`, and on the web build a `secret` file used to sign session cookies. Deleting
`devices.json` resets the app; everything is then "new" again.

The two builds keep separate data. Pointing them at the same directory is not
supported — they'd both write `devices.json` with no coordination. To move
names and history between them, use a backup instead.

### Backup: export and import

**Settings → Backup** has **Export backup** and **Import backup**, in both
builds. The desktop app asks where to save or what to open. The web build
downloads `jomnetscan-backup-YYYY-MM-DD.json` and uploads the file you pick.

The file holds every device the app knows: its name, notes, first and last
seen, vendor and discovered names, and the last port scan. There's no separate
scan log. Those records *are* the history.

It holds the settings too, except the two secrets. The web build has an
**Export the Telegram token and webhook URL too** checkbox, off unless you tick
it. Either value lets whoever holds the file send alerts as you, and a backup
is exactly the kind of file that gets copied around and forgotten. Left off,
the file still carries the chat id and webhook format.

**Importing also restores settings** is ticked by default. Untick it to bring
in devices only. When settings are restored, anything that doesn't fit this
install is left as it was:

- The ping timeout and concurrency only move between installs of the same
  kind (desktop to desktop, server to server). They were tuned on that kind of
  machine.
- A network interface this machine doesn't have is kept as it was, and the
  status line says so.
- A blank token, chat id or webhook URL in the file never erases one set
  here, so a backup made without secrets keeps the ones you have.
- The desktop app ignores the alert settings, and the server ignores
  **Minimize to tray**.

An older backup with no settings in it imports its devices and leaves the
settings alone.

Importing devices merges; it never deletes anything:

- A device this install doesn't know is added as offline and isn't badged
  **New**, so importing doesn't set off alerts. The next scan marks the ones
  actually present online.
- For a device it does know, the file's name and notes win where the file has
  them. A blank in the file never erases a name or note here. Vendor and
  discovered names only fill blanks. First and last seen widen to cover both,
  and the newer port scan is kept.
- IP address and online state are left as this install last saw them.

Importing the same file twice changes nothing. A bare `devices.json` copied
out of either build's data folder imports too, so an existing install can be
moved without exporting first. The server caps an upload at 5 MB, which is
about 10,000 devices.

`settings.json` holds the Telegram bot token in plain text, which is why the
systemd unit sets `StateDirectoryMode=0700`. The token is never sent back to a
browser in full: the UI shows a mask, and saving the mask leaves the stored
value alone. The one exception is an export with the secrets box ticked, and
the server logs each one.

## The icon

Generated rather than committed as an opaque blob, so it can be adjusted by
editing numbers instead of opening an editor:

```bash
npm run make-icon
```

That writes `build/icon.ico` (16 through 256 px, for the exe and installer),
`src/assets/tray.png` (tray) and `src/assets/icon.png` (window icon for dev
runs). It uses no image libraries — a PNG is a header, a deflate stream and a
CRC, and an ICO is a table of PNGs.

At 20 px and below the design drops its inner ring and thickens what's left.
The full two-ring version turns to mush at 16 px, which is exactly the size the
taskbar and tray use.

## Layout

Two front ends over one core. Nothing in `src/core/` knows which one is
running it.

```
src/core/             no Electron, no HTTP — shared by both front ends
  net/index.js          picks a backend off process.platform
  net/common.js         interface enumeration, MAC/IP helpers, pooling
  net/windows.js        ping / arp -a / route print / nbtstat
  net/linux.js          ping / ip neigh / ip route / nmblookup
  scanner.js            orchestrates one scan, emits progress
  store.js              devices.json + settings.json, atomic writes
  oui.js                MAC vendor lookup and IEEE registry download
  discover.js           mDNS and SSDP name discovery
  ports.js              the curated port list and the TCP connect scan
  migrate.js            startup housekeeping both front ends need
  backup.js             export/import of devices and settings, and the merge
  eventlog.js           the network log: what each scan changed, events.json
src/desktop/          the Electron app
  main.js               window, tray, notifications, IPC
  preload.js            the narrow API the UI is allowed to call
src/web/              the server
  server.js             routes, SSE, static files
  auth.js               password check, signed session cookie
  notify.js             Telegram and webhook delivery, secret masking
  updater.js            hourly "are we behind?" check; passes on Update now
src/renderer/         the UI, served unchanged by both
  index.html styles.css renderer.js
  jomnet-http.js        fetch + EventSource shim; no-ops under Electron
src/assets/           generated tray and window icons
deploy/               systemd units (service, update on click or hourly) and install notes
```

The UI is plain HTML, CSS and JavaScript — no framework, no build step. It
talks to exactly one object, `window.jomnet`, which Electron's preload supplies
over IPC and `jomnet-http.js` supplies over HTTP. That one seam is the whole
reason there are two front ends and not two apps: `renderer.js` cannot tell
which it's running under, beyond a `platform` field it uses to hide three
controls that don't apply.

The one runtime dependency is `multicast-dns`, used for the mDNS half of
discovery; hand-rolling a DNS packet parser wasn't worth the bug risk.
Everything else — the ping sweep, ARP parsing, SSDP, the OUI download, the HTTP
server, the session cookies — is Node standard library.
