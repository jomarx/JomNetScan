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
- **Flags new arrivals** — anything you haven't named yet is badged **New** and
  sorted to the top. Optional desktop notification when one turns up.
- **Runs quietly** — rescans on a timer, lives in the system tray.
- **Keeps your data local** — one JSON file in your user profile. Nothing leaves
  the machine except the optional vendor-database download.

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

## How the scan works

1. Read the local IPv4 interfaces and work out each subnet from its netmask.
   Anything wider than a /22 is skipped as too slow to sweep politely.
2. Ping every host address in parallel. The replies barely matter — the point is
   to populate the ARP cache.
3. Parse `arp -a` for IP/MAC pairs, dropping multicast and broadcast rows.
4. Read `route print` for the default gateway so the router gets labelled.
5. Resolve names via reverse DNS, falling back to `nbtstat` for the Windows
   boxes and printers a home router won't have DNS entries for.

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
src/main/main.js      window, tray, notifications, IPC
src/preload/          the narrow API the UI is allowed to call
src/renderer/         the UI (plain HTML/CSS/JS, no framework)
```
