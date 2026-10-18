# Running JomNetScan on an Ubuntu server

The web build is the same scanner as the desktop app with an HTTP front end
instead of an Electron window. It runs as an unprivileged systemd service and
needs no root, no `setcap` and no container.

## Why a server is worth it

The desktop app only knows what it saw while your laptop was awake. A service
scans on its own schedule, so "a device you've never seen joined the network"
is something you find out about when it happens rather than next time you
happen to open the app.

## Install

Node 18 or newer, and git:

```bash
sudo apt install -y nodejs npm git
```

Fetch it and install the one runtime dependency:

```bash
sudo git clone https://github.com/jomarx/JomNetScan.git /opt/jomnetscan
cd /opt/jomnetscan
sudo npm install --omit=dev
```

**While the web build is still on the `web-server` branch**, add
`--branch web-server` to that clone — a plain clone gets the default branch,
which has no `src/web/` and will not start. Once the branch is merged this
note stops applying; check whether `src/web/server.js` exists before going
looking for a problem.

Optionally fetch the vendor database now, so manufacturer names are there from
the first scan (you can also do this later from Settings):

```bash
sudo npm run update-oui
```

Create the service account. `--system` and no shell, because nothing should
ever log in as it:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin jomnetscan
sudo chown -R root:root /opt/jomnetscan
```

The code stays root-owned and read-only to the service. Everything it writes
goes to `/var/lib/jomnetscan`, which systemd creates.

## Configure

```bash
sudo mkdir -p /etc/jomnetscan
sudo tee /etc/jomnetscan/env >/dev/null <<'EOF'
JOMNETSCAN_PASSWORD=pick-something-here
# JOMNETSCAN_PORT=8099
# JOMNETSCAN_BIND=0.0.0.0
EOF
sudo chmod 600 /etc/jomnetscan/env
```

**Check the port is free before you commit to it** — 8099 is the default
because it's unusual, not because it's reserved:

```bash
sudo ss -lntp | grep 8099
```

If `JOMNETSCAN_PASSWORD` is unset the server generates a random one on every
start and prints it to the journal. That's deliberate: the service is never
accidentally open to the whole LAN. It does mean sessions won't survive a
restart, so set one.

## Start it

```bash
sudo cp /opt/jomnetscan/deploy/jomnetscan.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jomnetscan
sudo systemctl status jomnetscan
journalctl -u jomnetscan -f
```

Then open `http://<server>:8099` from anything on the LAN.

## A word on the password and plain HTTP

This is HTTP. The password crosses your LAN in the clear, and so does
everything the app shows. On a home network you control that's a reasonable
trade for not running a certificate authority — but it is a trade, and you
should know you're making it.

If you'd rather not, bind to localhost and put a reverse proxy with TLS in
front:

```
JOMNETSCAN_BIND=127.0.0.1
```

The app needs no other change. It reads `X-Forwarded-For` for its login rate
limiting **only when the connection came from loopback** — i.e. from a proxy
on the same box, which is the one place that header can be trusted. A proxy on
a different host would connect from a real address, so its clients would share
one lockout bucket; run the proxy on the same machine as the service. And if
you leave the service bound to `0.0.0.0` as well as proxying it, the direct
port is still there with no TLS — bind to `127.0.0.1` so the proxy is the only
way in.

Do not expose this to the internet. A list of every device on your network,
behind one shared password, is not something to put on a public port.

**`0.0.0.0` is wider than "the LAN" if the box is on a VPN.** On a machine
running Tailscale, binding to all interfaces also publishes the service on the
tailnet address — anyone on your tailnet, including a device you've shared it
with, can reach it. That's authenticated and not public, so it may be exactly
what you want, but it isn't what "LAN-only" sounds like. To keep it to the
wired LAN, bind to the specific address instead:

```
JOMNETSCAN_BIND=192.168.68.16
```

Check what you actually published with `ss -lntp | grep 8099`.

### HTTPS over Tailscale, the easy way

If the box is already on Tailscale, `tailscale serve` gives you a real
Let's Encrypt certificate and an HTTPS address with no reverse proxy to
configure. It's the cleanest way to get the password off the wire, and it's
tailnet-only — not public.

First enable **MagicDNS** and **HTTPS Certificates** in the tailnet admin
console (the DNS page). Then:

```bash
sudo tailscale serve --bg --https=8444 http://127.0.0.1:8099
tailscale serve status
#   https://<host>.<tailnet>.ts.net:8444 (tailnet only)
#   |-- / proxy http://127.0.0.1:8099
```

To undo it:

```bash
sudo tailscale serve --https=8444 off
```

Worth knowing:

- **The first HTTPS request after setup takes ~30 seconds** while Tailscale
  fetches the certificate. After that it renews itself.
- **Pick an HTTPS port that isn't the app's own.** `--https=8099` collides with
  the service if it binds `0.0.0.0`, because `tailscaled` wants the tailnet IP
  on that port too. `8444`, or `443` if nothing else holds it, is clean.
- **`--bg` makes it survive reboots** and `tailscaled` restarts.
- The proxy connects from loopback, so the login lockout works correctly per
  tailnet client through it — but only on the fix shipped here; make sure the
  box is running it (`clientIp` loopback-only). With this, you can also set
  `JOMNETSCAN_BIND=127.0.0.1` and the serve target stays `http://127.0.0.1:8099`
  unchanged, so nothing on the LAN can reach it and the tailnet HTTPS address is
  the only way in.
- This is `serve`, which is tailnet-only. **Funnel** is the separate feature
  that puts it on the public internet — don't; "do not expose this" above means
  Funnel too.

## Telegram alerts

Two values, and the second one is the part people get stuck on.

1. **Bot token.** Message [@BotFather](https://t.me/BotFather) on Telegram,
   send `/newbot`, follow the prompts. It replies with a token that looks like
   `123456789:AAH...`.
2. **Chat id.** Send your new bot any message — it can't message you first.
   Then open, in a browser:

   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```

   and read `message.chat.id` out of the JSON. For a direct chat it's a
   positive number; for a group it's negative, and the bot has to have been
   added to the group.

Paste both into **Settings → Alerts**, then hit **Send test message**. The
token is stored in `/var/lib/jomnetscan/settings.json` and is never sent back
to the browser in full once saved — the field shows a mask afterwards, and
submitting the mask leaves the stored value alone.

For a webhook instead, put an [ntfy](https://ntfy.sh) topic URL in the webhook
field and leave the format on *ntfy*. Self-hosting ntfy on the same box gets
you phone alerts with nothing leaving your network, which the Telegram route
can't offer.

Alerts respect the **Notify me when a new device appears** switch. With it off,
nothing is sent anywhere.

## What it costs to run

Measured on t610buntu2, a /24 with about 45 known devices, scanning on the
default interval: **11m46s of CPU over 5h49m wall** — roughly 3% of one core —
and a **87.7 MB** memory peak. Almost all of the CPU is spawning `ping`, in
bursts during a sweep rather than steadily.

That's small enough for a Pi or a shared box. If you're putting this somewhere
tighter, the scan interval is the knob that matters, not the concurrency.

## Keeping it up to date automatically

Two halves, because the service is deliberately unprivileged and its checkout is
root-owned: the service can *see* that an update exists but can't *apply* one.

**Seeing it.** The running service checks its git remote once an hour, read-only
(`git ls-remote`, no write to the repo). When the deployed branch is behind,
**Settings** shows an amber line saying so. That's it on the service side — it
never touches its own code.

**Applying it.** A separate root timer does the pull and restart. It's opt-in:

```bash
sudo cp /opt/jomnetscan/deploy/jomnetscan-update.service /etc/systemd/system/
sudo cp /opt/jomnetscan/deploy/jomnetscan-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jomnetscan-update.timer
```

Every hour it fetches, and **only if the remote is ahead** fast-forwards,
`npm install --omit=dev`, and restarts the service. It tracks whatever branch is
checked out, so it keeps working after you move from `web-server` to `main`
without editing anything. A fast-forward is the whole safety: if you've made
local commits, or the history diverged, it stops and leaves the running service
untouched rather than rewriting anything.

**It never restarts in the middle of something.** While a scan, port scan, ping
graph or vendor download is running, the service keeps a flag file at
`/var/lib/jomnetscan/busy` naming what's in flight. The update waits for it to
clear — before pulling, and again just before restarting, since a scheduled
scan can start while `npm install` runs — for up to 15 minutes each time
(`JOMNETSCAN_UPDATE_WAIT`, in seconds). If it's still busy after that it gives
up until the next hour; if the code was already pulled by then, the next run
does the owed restart even though it finds nothing new to fetch. A flag left by
a stopped service is ignored, and it uses `try-restart`, so a service you
stopped on purpose stays stopped.

Check it by hand, or watch it:

```bash
sudo /opt/jomnetscan/deploy/jomnetscan-update.sh   # run once now
systemctl list-timers jomnetscan-update.timer      # when it next fires
journalctl -u jomnetscan-update.service            # what it did last time
```

A restart still drops every open browser's live connection for a moment; they
reconnect on their own. If you'd rather pick your moment, skip the timer and run
the script by hand when the amber line appears — or stay with the manual
[Updating](#updating) steps below, which are the same thing without the
automation (and without the wait for idle).

**Installing the timer on a box running an older build:** update by hand once
first. The busy flag comes from the service, so a service from before it existed
never writes one, and the timer's first update would restart it without waiting.

If you don't want automatic updates at all, just don't install the timer. The
hourly in-UI check is still there and still only reads; nothing updates until
you run the script.

## If something doesn't work

**No devices found, or every device shows offline.** Check `ping` works as the
service user. The usual cause is a restrictive `ping_group_range` combined with
`NoNewPrivileges=true` in the unit:

```bash
sysctl net.ipv4.ping_group_range      # Ubuntu default is "0	2147483647"
sudo -u jomnetscan ping -c1 -W1 192.168.1.1
```

If the sysctl has been narrowed, either widen it or add
`AmbientCapabilities=CAP_NET_RAW` to the unit.

**No announced names.** Check what already holds the mDNS port:

```bash
sudo ss -lunp | grep 5353
```

`multicast-dns` binds with `SO_REUSEADDR` so two listeners usually coexist. If
they don't, discovery degrades to "no announced names" rather than failing the
scan — the devices still appear, they just need naming by hand, and reverse DNS
and NetBIOS still name some of them.

On t610buntu2 this is what happens, and the holder is not avahi (which is
inactive) but **Home Assistant** — its zeroconf, in a host-network container,
holding `*:5353`. Nothing announced a name there; `nmblookup` still found the
Windows boxes. If you want announced names on a box that also runs Home
Assistant, you'd have to give one of them its own network namespace, which is
a bigger change than the names are worth.

**Only some devices appear.** ARP doesn't cross a router, so the server only
sees its own subnet. If the server is on Ethernet and your laptop is on a
different VLAN or a guest SSID, the two will legitimately disagree about what's
on "the network".

**The update line shows an error, or never appears.** The in-UI check shells
out to `git`. If git isn't installed, or `/opt/jomnetscan` isn't a checkout (you
deployed from a tarball), the line hides itself — that's expected, and the
auto-update timer won't work either; update by replacing the files. If it shows
a "couldn't check" error, run `sudo -u jomnetscan git -C /opt/jomnetscan ls-remote origin`
by hand to see why — usually no network, or a private repo the service user
can't read.

**Scans feel slow.** The defaults — 64 pings in flight, 1 second each — were
measured against Windows, where spawning a process is expensive. Linux forks
far more cheaply, so there is probably headroom. Time a scan in the journal,
then try raising the concurrency in Settings and time it again. Raise it only
as far as the measurement justifies: past a point the ping processes starve
each other and *fewer* devices answer, which looks like devices leaving the
network rather than like a tuning mistake.

## Updating

```bash
cd /opt/jomnetscan
sudo git pull
sudo npm install --omit=dev
sudo systemctl restart jomnetscan
```

Your device list, names and settings live in `/var/lib/jomnetscan` and are not
touched by an update.
