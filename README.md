# Outage Desk

A live map of power and internet outages for the office, with your client
sites on it. It polls the utilities' own outage feeds, puts every outage on a
zoomable map of Canada, and flags any client site that is inside an outage,
near one, or in a province whose internet connectivity has dropped.

## What it covers today

| Power, Alberta | Feed | Shape on the map |
| --- | --- | --- |
| ATCO Electric (north and east-central) | ATCO's outage-map database (Firestore) | Outage area + pin |
| FortisAlberta (rural and towns, central and south) | Fortis's outage-map API | Outage area + pin |
| ENMAX Power (Calgary) | ENMAX's outage-map API | Pin + named communities |
| EPCOR (Edmonton) | EPCOR's public ArcGIS layer | Neighbourhood areas |

**Not covered in Alberta** (no live feed is published): Red Deer, Lethbridge
and Medicine Hat city utilities, the rural electrification associations (EQUS,
Battle River…) and a few town utilities. Other provinces have no power feed yet
and are darkened on the map.

**Internet, all provinces:** province-level connectivity drops from
[IODA](https://ioda.inetintel.cc.gatech.edu/country/CA) (Georgia Tech). It
tells you "connectivity in Manitoba dropped", never which town or provider.

## Run it

On any machine with Docker (Docker Desktop on Windows is fine):

```sh
git clone https://github.com/dzee3/outage.git
cd outage
docker compose up -d --build
```

Open `http://<that-computer's-name>:8080` from any PC on the office network.
The wall-screen view is `http://<name>:8080/tv`.

To update later: `git pull` then `docker compose up -d --build`.

To try it with sample data and no network: `DEMO=1 docker compose up -d --build`
(or `npm run demo` with Node 22+). Demo data shows a "Demo data" badge.

## Client sites

Add sites in the **Clients** tab: either click **Add a site** and click the map,
or import a CSV. The CSV needs a header row with `name`, `lat` and `lon`;
`address`, `notes` and `radius_km` are optional. See
`fixtures/sample-sites.csv`. **Export CSV** downloads the current list.

Each site gets one status:

| Status | Meaning |
| --- | --- |
| Inside an outage | The site is within a published outage area |
| Outage nearby | An outage (or planned work underway) is within the site's alert radius (default 3 km) |
| Internet disruption in province | IODA reports a province-wide connectivity drop |
| Planned work coming | Planned work within the radius in the next 7 days |
| No outages nearby | Covered, and nothing nearby |
| Power not monitored here | No power feed for that province yet |

Turn on **Alerts** in the top bar to get a tone and a desktop notice when a site
changes status or an outage over 1,000 customers starts. Alerts are per browser.

Set `EDIT_TOKEN` in `compose.yaml` (or the environment) to require a code to
add, change or remove sites. Viewing never needs it.

## How fresh is it

The server polls in the background whether or not anyone has the page open:
live outages every 2 minutes, planned-work schedules every 15 minutes, IODA
every 5 minutes. Pages refresh every 30 seconds. End-to-end lag is the
utility's own update time plus up to 2 minutes.

The lamps in the top bar show each feed:

- **Green, live:** the last poll worked.
- **Amber, stale:** the last poll failed. Its last good outages stay on the map
  for up to 30 minutes, marked stale.
- **Red, down:** nothing good for 30 minutes (or ever). Its outages are removed
  rather than shown as current. The **Sources** tab shows the error.

None of the utility feeds is a documented public API; they are what each
utility's own map uses, so one may change without notice. A red lamp is the
signal. If ENMAX or Fortis is red with `HTTP 403` from the start, that utility
is refusing server requests and needs a headless-browser fetch instead.

## Data kept

Everything lives in the `outage-data` Docker volume (`/data` in the container):
`sites.json` (your client list, never sent anywhere), `events.jsonl` (outage
started/restored and site status changes) and `history.jsonl` (customers out per
utility every 5 minutes, kept 7 days). Back it up with
`docker run --rm -v outage_outage-data:/data -v "$PWD":/backup busybox tar czf /backup/outage-data.tgz /data`.

## Times

Outage times are shown in Alberta time (MT). Alberta has been on UTC−6 all year
since March 2026; that rule is built into the code rather than read from the
machine's time-zone database, which may predate the change.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | |
| `POLL_SECONDS` | `60` | How often the poll loop wakes (each feed keeps its own interval) |
| `EDIT_TOKEN` | empty | Code required to change client sites |
| `INTERNET` | `on` | `off` hides the IODA layer |
| `DEMO` | `0` | `1` replays sample data |

## Adding a province

Write `server/sources/<province>.js` returning source descriptors like
`server/sources/alberta.js` (each with feeds that return normalized records; see
`server/records.js`), register it in `server/index.js` and add the province to
`coverage`. Hydro-Québec publishes an official feed, but under a
non-commercial licence (CC BY-NC 4.0).

## Data and licences

- Outage data belongs to each utility and is read from their public outage maps.
- Internet data: IODA, Georgia Tech Research Corporation. Its responses say
  "all rights reserved" and it publishes no other terms; questions go to
  ioda-info@cc.gatech.edu. Set `INTERNET=off` to drop it.
- Basemap: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, data ©
  OpenStreetMap contributors. Free, no key, commercial use allowed. If it is
  unreachable the map falls back to province outlines and keeps working.
- Province outlines: Natural Earth (public domain).
- Map library: MapLibre GL JS (BSD-3-Clause). Font: IBM Plex Sans Condensed (OFL).

## Development

Node 22+, no dependencies. `npm test` runs the suite; `npm run demo` starts the
server with sample data on port 8080.
