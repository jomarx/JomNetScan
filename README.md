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
- **Flags new arrivals** — anything you haven't named yet is badged **New** and
  sorted to the top. Optional desktop notification when one turns up.
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

## Vendor names

MAC-to-manufacturer lookup needs the public IEEE OUI registry, which isn't
bundled — no guessed data ships in this repo. Grab it either way:

- In the app: **Settings → Download vendor database** (~4 MB, saved to your
  user profile).
- On the command line: `npm run update-oui`.

Until then the Vendor column stays blank, except for randomized MACs, which are
detected from the address itself — modern phones rotate these, which is why the
same handset can reappear as a "new" device.

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

## Known limits

- **Windows only.** The scan shells out to `ping`, `arp`, `route`, and
  `nbtstat` with Windows argument syntax.
- **Same-subnet only.** ARP doesn't cross a router, so guest networks and
  separate VLANs won't show up.
- **Sleeping devices look offline.** A phone with its screen off often won't
  answer a ping. Devices are marked offline, never deleted.
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

## Layout

```
src/main/net.js       ping sweep, ARP, route and name lookups
src/main/scanner.js   orchestrates one scan, emits progress
src/main/store.js     devices.json + settings.json, atomic writes
src/main/oui.js       MAC vendor lookup and IEEE registry download
src/main/discover.js  mDNS and SSDP name discovery
src/main/main.js      window, tray, notifications, IPC
src/preload/          the narrow API the UI is allowed to call
src/renderer/         the UI (plain HTML/CSS/JS, no framework)
```

The UI is plain HTML, CSS and JavaScript — no framework, no build step. The one
runtime dependency is `multicast-dns`, used for the mDNS half of discovery;
hand-rolling a DNS packet parser wasn't worth the bug risk. Everything else —
the ping sweep, ARP parsing, SSDP, the OUI download — is Node standard library.
