# JomNetScan

A small Windows desktop app for keeping an eye on your home network. It finds
everything talking on your LAN, lets you give each thing a name, and tells you
when something shows up that you haven't named yet.

Think Fing, minus the account, the cloud, and the upsell.

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
  desktop notification when one appears.
- **Runs quietly** — rescans on a timer, lives in the system tray.
- **Keeps your data local** — one JSON file in your user profile. Discovery and
  scanning stay on your LAN; the only thing that reaches the internet is the
  optional vendor-database download, and only when you ask for it.

## Running it

```bash
npm install
npm start
```

If Electron's binary doesn't download during install (npm may block the
postinstall script), run `node node_modules/electron/install.js` once.

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

Expiry runs in the main process — on startup, after every scan, and on a
one-minute tick so badges still age out with auto-scan switched off. The window
lives in one constant (`NEW_BADGE_MS` in `src/main/store.js`) that the UI is
handed in its state, so the badge, the **Unnamed / new** count and the tray
tooltip can't drift apart.

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
  `src/main/ports.js` if you want to add to it.

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
3. Parse `arp -a` for IP/MAC pairs, dropping multicast and broadcast rows.
4. Read `route print` for the default gateway so the router gets labelled.
5. Resolve names via reverse DNS, falling back to `nbtstat` for the Windows
   boxes and printers a home router won't have DNS entries for.

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

- **Windows only.** The scan shells out to `ping`, `arp`, `route`, and
  `nbtstat` with Windows argument syntax.
- **Same-subnet only.** ARP doesn't cross a router, so guest networks and
  separate VLANs won't show up.
- **Sleeping devices look offline.** A phone with its screen off often won't
  answer a ping. Devices are marked offline, never deleted.
- **"Online" can lag reality by a minute or two.** Presence comes from the ARP
  cache, because plenty of hosts drop ICMP and demanding a ping reply would
  hide them. Windows keeps ARP entries for a short while after a device leaves,
  so a departed device can linger. A **hollow** status dot means exactly that:
  seen in the ARP table, but it never answered a ping this scan. A solid dot
  means it replied.
- **Randomized MACs.** Phones that rotate their MAC per network will appear as
  a new device when they rotate. There's no fix for this from outside the
  device; the app at least labels them so you know what you're looking at.
- **Announcements are a minority.** Only devices that speak mDNS or UPnP get a
  name for free, and only while they're awake — a TV that's off announces
  nothing. Rescan later and it fills in.

## Where your data lives

`%APPDATA%\JomNetScan\` — `devices.json`, `settings.json`, and the downloaded
`oui.json`. **Settings → Open data folder** takes you there. Deleting
`devices.json` resets the app; everything is then "new" again.

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

```
src/main/net.js       ping sweep, ARP, route and name lookups
src/main/scanner.js   orchestrates one scan, emits progress
src/main/store.js     devices.json + settings.json, atomic writes
src/main/oui.js       MAC vendor lookup and IEEE registry download
src/main/discover.js  mDNS and SSDP name discovery
src/main/main.js      window, tray, notifications, IPC
src/assets/           generated tray and window icons
src/preload/          the narrow API the UI is allowed to call
src/renderer/         the UI (plain HTML/CSS/JS, no framework)
```

The UI is plain HTML, CSS and JavaScript — no framework, no build step. The one
runtime dependency is `multicast-dns`, used for the mDNS half of discovery;
hand-rolling a DNS packet parser wasn't worth the bug risk. Everything else —
the ping sweep, ARP parsing, SSDP, the OUI download — is Node standard library.
