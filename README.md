# Outage Desk

A live map of power and internet outages for the office, with your client
sites on it. It polls the utilities' own outage feeds, puts every outage on a
zoomable map of Canada, and flags any client site that is inside an outage,
near one, or in a province whose internet connectivity has dropped.

## What it covers today

Power, live (18 feeds, read the way each utility's own outage map reads them):

| Province | Utilities with a live feed |
| --- | --- |
| British Columbia | BC Hydro, FortisBC |
| Alberta | ATCO Electric, FortisAlberta, ENMAX (Calgary), EPCOR (Edmonton) |
| Saskatchewan | SaskPower (by service region, no customer counts), Saskatoon Light & Power |
| Manitoba | Manitoba Hydro |
| Ontario | Hydro One, Toronto Hydro, Alectra, Hydro Ottawa |
| New Brunswick | NB Power |
| Nova Scotia | Nova Scotia Power |
| Prince Edward Island | Maritime Electric |
| Newfoundland and Labrador | Newfoundland Power, NL Hydro |

Not covered: municipal and small utilities that publish no live map (Lethbridge,
Red Deer, Medicine Hat, Saint John Energy, Summerside, the other ~50 Ontario
distributors…; the **Sources** panel lists them), Quebec and the territories.
A client site served by one of those shows "Power not monitored".

Internet:

- **Province-wide drops** from [IODA](https://ioda.inetintel.cc.gatech.edu/country/CA) (Georgia Tech).
- **Provider networks:** IODA's per-network signals for Bell, Bell MTS, Bell
  Aliant, Rogers, Shaw, Telus, SaskTel, Eastlink, Cogeco, Xplore, TekSavvy,
  Distributel and Starlink. A client whose provider's network drops is flagged.
  These are national network signals, so they can't tell which town is affected.
- **Provider outage pages, per client address:** each client's ISP is checked
  against that provider's own public outage page every 5 minutes:
  - **Telus:** national feed, every notice it publishes (Internet, TV, Home
    Phone, 911, mobility), drawn as the affected area and matched by location.
    Only notices that list Internet mark a client down; others show as nearby.
  - **Rogers / Shaw:** per-province notices naming the city and
    neighbourhoods, matched by name and by distance to the neighbourhood
  - **TekSavvy:** its public outage map, matched by location
  - **SaskTel:** its reported-outages list, matched by city

  Bell checks addresses behind a CAPTCHA, which the dashboard does not get
  around, and Eastlink, Cogeco and Xplore publish no public map. Clients with
  those providers rely on the network signals instead.

  Every provider notice appears on the map (violet for Internet, grey-violet
  for phone/TV only, amber for planned work) and under **Outages → Internet**.
  The "internet outages" count adds unplanned provider notices that affect
  Internet to the IODA network drops.
- **Who serves a spot:** the federal [National Broadband Map](https://ised-isde.canada.ca/app/scr/sittibc/web/bbmap?lang=eng#!/map)
  (ISED), in ~25 km² hexagons.

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

Click **+ Add client**, then either search an address or click the map to drop
a pin (drag it to adjust). The dashboard then looks up:

- **Address** for the pin (OpenStreetMap / Nominatim).
- **Power utility.** It checks published service-area boundaries first
  (Ontario's distributor map, FortisBC, Saskatoon L&P, Newfoundland Power), then
  municipal utilities by city, then the province's main utility. Alberta
  publishes no ATCO/Fortis boundary, so there it is labelled a best guess. You can
  always pick another utility from the list.
- **Internet providers** that serve that hexagon, from the National Broadband
  Map, with their technologies. Pick the client's ISP, or choose **Other**.

CSV import still works: a header row with `name`, `lat`, `lon`; optional
`address`, `notes`, `radius_km`, `utility` (an id such as `enmax`,
`hydroone`) and `isp`. **Export** downloads the current list.

Each site gets one status:

| Status | Meaning |
| --- | --- |
| Inside an outage | The site is within a published outage area |
| Outage nearby | An outage (or planned work underway) is within the site's alert radius (default 3 km) |
| Internet disruption | Its provider's network, or its whole province, shows a connectivity drop |
| Planned work coming | Planned work within the radius in the next 7 days |
| No outages nearby | Covered, and nothing nearby |
| Power not monitored | Its utility (or province) has no live feed |

## Map layers

**Layers** in the left dock turns on:

- utility service areas, with the main utility named in each province
- internet providers in view: zoom to a city or region, and a card lists the
  providers found across the visible area, from the broadband map
- province-wide internet drops, client sites and their name labels

Turn on **Alerts** in the top bar to get a tone and a desktop notice when a site
changes status or an outage over 1,000 customers starts. Alerts are per browser.

Set `EDIT_TOKEN` in `compose.yaml` (or the environment) to require a code to
add, change or remove sites. Viewing never needs it.

## How fresh is it

The server polls in the background whether or not anyone has the page open:
live outages every 2 minutes, planned-work schedules every 15 minutes, IODA
every 5 minutes (Kubra-based maps every 3). Pages refresh every 30 seconds. End-to-end lag is the
utility's own update time plus up to 2 minutes.

The **feeds** chip in the top bar counts live feeds; the **Sources** panel shows each one:

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

Outage times are shown in the outage's own province time (MT, CT, ET, AT, NT).
Alberta has been on UTC−6 all year since March 2026; that rule is built into
the code rather than read from the machine's time-zone database, which may
predate the change.

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

Utilities live in `server/sources/alberta.js` and `server/sources/canada.js`
(descriptors whose feeds return normalized records; see `server/records.js` and
`server/records-canada.js`). Many utilities use Kubra's storm centre: for those,
`kubraV2()` in `server/sources/kubra.js` needs only the storm-centre and view ids
from the utility's map. Add the utility to `server/utilities.js` too, so client
sites can name it. Hydro-Québec publishes an official feed, but under a
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
- Ontario distributor boundaries: Ontario Energy Board via data.ontario.ca,
  Open Government Licence – Ontario. Downloaded by the server and refreshed weekly.
- Internet providers: ISED National Broadband Map (Open Government Licence – Canada
  for the published data). Looked up per point and cached 30 days.
- Addresses: © OpenStreetMap contributors via Nominatim, used under its usage
  policy (at most one lookup a second, cached, attributed in the add-client panel).
- Map library: MapLibre GL JS (BSD-3-Clause). Fonts: IBM Plex Sans Condensed
  and Rajdhani (both OFL).

## Development

Node 22+, no dependencies. `npm test` runs the suite; `npm run demo` starts the
server with sample data on port 8080.
