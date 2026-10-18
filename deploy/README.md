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

The app needs no other change; it already reads `X-Forwarded-For` for its
login rate limiting.

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
