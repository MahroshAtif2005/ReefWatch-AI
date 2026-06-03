import axios from 'axios';
import { getSetting, getStationReadings, setSetting } from '../db/database.js';

const NOAA_STATIONS_JSON_URL = 'https://coralreefwatch.noaa.gov/vs/gauges/regions/global.json';
const NOAA_STATIONS_GEOJSON_FALLBACK_URL = 'https://coralreefwatch.noaa.gov/product/vs/vs_polygons.json';
const STATION_SOURCE = 'NOAA Virtual Station List';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DB_STATION_LIST_KEY = 'cached_station_list';

const FALLBACK_VIRTUAL_STATIONS = [
  // Hawaii
  { name: 'Hawaii (Big Island, Hilo)', lat: 19.73, lng: -155.09 },
  { name: 'Maui Reefs', lat: 20.73, lng: -156.40 },
  { name: 'Oahu Reefs', lat: 21.30, lng: -157.83 },
  { name: 'Kaneohe Bay', lat: 21.44, lng: -157.79 },
  { name: 'Kauai Reefs', lat: 22.07, lng: -159.50 },
  // Florida Keys
  { name: 'Molasses Reef', lat: 25.01, lng: -80.38 },
  { name: 'Tennessee Reef', lat: 24.75, lng: -80.95 },
  { name: 'Sombrero Key', lat: 24.63, lng: -81.11 },
  { name: 'Looe Key', lat: 24.55, lng: -81.40 },
  { name: 'Sand Key', lat: 24.46, lng: -81.88 },
  { name: 'Dry Tortugas', lat: 24.63, lng: -82.85 },
  { name: 'Hen and Chickens Reef', lat: 25.16, lng: -80.55 },
  // Caribbean
  { name: 'Buck Island (USVI)', lat: 17.78, lng: -64.62 },
  { name: 'St John (USVI)', lat: 18.33, lng: -64.72 },
  { name: 'La Parguera (Puerto Rico)', lat: 17.97, lng: -67.05 },
  { name: 'Navassa Island', lat: 18.40, lng: -75.01 },
  { name: 'Grand Cayman', lat: 19.30, lng: -81.38 },
  { name: 'Belize Barrier Reef', lat: 16.83, lng: -87.80 },
  { name: 'Bermuda', lat: 32.32, lng: -64.72 },
  { name: 'Flower Garden Banks', lat: 27.91, lng: -93.60 },
  // Pacific
  { name: 'American Samoa (Ofu)', lat: -14.18, lng: -169.65 },
  { name: 'Guam (Tumon Bay)', lat: 13.52, lng: 144.79 },
  { name: 'Wake Island', lat: 19.30, lng: 166.62 },
  { name: 'Johnston Atoll', lat: 16.73, lng: -169.52 },
  { name: 'Palmyra Atoll', lat: 5.88, lng: -162.09 },
  { name: 'Jarvis Island', lat: -0.37, lng: -160.02 },
  { name: 'Kingman Reef', lat: 6.40, lng: -162.40 },
  { name: 'Christmas Island (Kiribati)', lat: 1.87, lng: -157.48 },
  // Great Barrier Reef
  { name: 'GBR Far North', lat: -12.36, lng: 143.61 },
  { name: 'GBR Cairns Sector', lat: -17.00, lng: 146.30 },
  { name: 'GBR Townsville', lat: -19.00, lng: 146.85 },
  { name: 'GBR Swain Reefs', lat: -22.00, lng: 152.30 },
  { name: 'GBR Capricorn Group', lat: -23.44, lng: 152.00 },
  { name: 'Coral Sea (Osprey Reef)', lat: -13.88, lng: 146.57 },
  // Indian Ocean
  { name: 'Chagos Archipelago', lat: -6.00, lng: 71.50 },
  { name: 'Seychelles', lat: -4.68, lng: 55.49 },
  { name: 'Maldives (North)', lat: 4.18, lng: 73.51 },
  { name: 'Maldives (South)', lat: -0.69, lng: 73.16 },
  { name: 'Reunion Island', lat: -21.11, lng: 55.53 },
  // Red Sea
  { name: 'Red Sea (Central)', lat: 24.00, lng: 38.00 },
  { name: 'Gulf of Aqaba', lat: 29.00, lng: 34.90 },
  // Coral Triangle
  { name: 'Raja Ampat', lat: -0.50, lng: 130.50 },
  { name: 'Bunaken (Sulawesi)', lat: 1.62, lng: 124.75 },
  { name: 'Wakatobi', lat: -5.40, lng: 123.60 },
  { name: 'Komodo', lat: -8.60, lng: 119.50 },
  { name: 'Tubbataha Reef', lat: 8.93, lng: 119.79 },
  // Pacific Islands
  { name: 'New Caledonia', lat: -22.27, lng: 166.46 },
  { name: 'Fiji (Beqa Lagoon)', lat: -18.27, lng: 177.90 },
  { name: 'Palau', lat: 7.34, lng: 134.47 },
  { name: 'Micronesia (Pohnpei)', lat: 6.85, lng: 158.22 },
];

let stationCache = {
  stations: null,
  expiresAt: 0,
  fetchedAt: null,
};

const enrichedCache = new Map();

export function setEnrichedStationData(stationId, data) {
  enrichedCache.set(stationId, data);
}

// Called once at startup from index.js to restore NOAA risk colors from DB
export function hydrateEnrichedCacheFromDb() {
  try {
    const readings = getStationReadings();
    let hydrated = 0;
    for (const reading of readings) {
      const key = reading.stationId || reading.id;
      if (key && !enrichedCache.has(key)) {
        enrichedCache.set(key, reading);
        hydrated += 1;
      }
    }
    if (hydrated > 0) {
      console.log(`[stations] hydrated ${hydrated} enriched readings from DB`);
    }
  } catch (err) {
    console.warn('[stations] enriched cache hydration skipped:', err.message);
  }
}

function mergeEnrichedData(stations) {
  if (enrichedCache.size === 0) return stations;
  return stations.map((s) => {
    const enriched = enrichedCache.get(s.id);
    return enriched ? { ...s, ...enriched } : s;
  });
}

// Persist a successful station list to DB so Cloud Run restarts don't regress to 53 stations
async function saveStationListToDb(stations) {
  try {
    await setSetting(DB_STATION_LIST_KEY, JSON.stringify(stations));
  } catch {
    // Non-critical
  }
}

// Load a previously cached station list from DB (used when NOAA is unreachable)
async function loadStationListFromDb() {
  try {
    const cached = await getSetting(DB_STATION_LIST_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed) && parsed.length > 0) {
      console.log(`[stations] serving ${parsed.length} stations from DB settings cache`);
      return parsed;
    }
  } catch {
    // Corrupt or missing
  }
  return null;
}

const stationClient = axios.create({
  timeout: 35000,
  maxRedirects: 5,
});

const slugify = (value) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeStation = ({ id, name, lat, lng }) => ({
  id: id || `station-${slugify(name)}-${lat}-${lng}`,
  name,
  lat,
  lng,
  type: 'station',
  status: 'station',
  source: STATION_SOURCE,
});

const normalizeUnknownJson = (payload) => {
  const rawStations = Array.isArray(payload)
    ? payload
    : payload.stations || payload.features || payload.data || [];

  return rawStations
    .map((station, index) => {
      if (station.type === 'Feature') {
        const [lng, lat] = station.geometry?.coordinates || [];
        return {
          id: station.id || `station-${index}`,
          name: station.properties?.name,
          lat: toNumber(lat),
          lng: toNumber(lng),
        };
      }

      return {
        id: station.id || station.station_id || station.stationId || `station-${index}`,
        name: station.name || station.station_name || station.label,
        lat: toNumber(station.lat ?? station.latitude),
        lng: toNumber(station.lng ?? station.lon ?? station.longitude),
      };
    })
    .filter((station) => station.name && station.lat !== null && station.lng !== null)
    .map(normalizeStation);
};

const normalizeGeoJsonStations = (payload) => {
  const seen = new Set();

  return (payload.features || [])
    .filter((feature) => feature.geometry?.type === 'Point')
    .map((feature) => {
      const [lng, lat] = feature.geometry.coordinates || [];
      return {
        name: feature.properties?.name,
        lat: toNumber(lat),
        lng: toNumber(lng),
      };
    })
    .filter((station) => station.name && station.lat !== null && station.lng !== null)
    .filter((station) => {
      const key = `${station.name}:${station.lat}:${station.lng}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((station) => normalizeStation({
      ...station,
      id: `station-${slugify(station.name)}`,
    }));
};

const FALLBACK_STATION_SOURCE = 'NOAA Virtual Station (offline cache)';

function buildFallbackStations() {
  return FALLBACK_VIRTUAL_STATIONS.map((s) => normalizeStation({
    ...s,
    id: `station-fallback-${slugify(s.name)}`,
  })).map((s) => ({ ...s, source: FALLBACK_STATION_SOURCE }));
}

async function fetchStationsFromNoaa() {
  try {
    console.log(`[stations] fetching ${NOAA_STATIONS_JSON_URL}`);
    const response = await stationClient.get(NOAA_STATIONS_JSON_URL);
    const stations = normalizeUnknownJson(response.data);

    if (stations.length === 0) {
      throw new Error('NOAA station JSON returned no station records');
    }

    saveStationListToDb(stations); // persist for next restart
    return stations;
  } catch (primaryError) {
    console.warn(`[stations] primary station list failed: ${primaryError.message}`);

    try {
      console.log(`[stations] fetching fallback ${NOAA_STATIONS_GEOJSON_FALLBACK_URL}`);
      const response = await stationClient.get(NOAA_STATIONS_GEOJSON_FALLBACK_URL);
      const stations = normalizeGeoJsonStations(response.data);

      if (stations.length === 0) {
        throw new Error('NOAA fallback GeoJSON returned no station records');
      }

      saveStationListToDb(stations);
      return stations;
    } catch (fallbackError) {
      console.warn(`[stations] fallback GeoJSON also failed: ${fallbackError.message}`);

      // Try DB-persisted list from a previous successful fetch before using hardcoded 53
      const dbStations = await loadStationListFromDb();
      if (dbStations) return dbStations;

      console.log('[stations] serving built-in offline station list (53 stations)');
      return buildFallbackStations();
    }
  }
}

export async function fetchVirtualStations() {
  const now = Date.now();

  if (stationCache.stations && stationCache.expiresAt > now) {
    console.log(`[stations] serving ${stationCache.stations.length} stations from cache`);
    return mergeEnrichedData(stationCache.stations);
  }

  // DB-first: respond immediately on container restart; refresh NOAA in background
  const dbStations = await loadStationListFromDb();
  if (dbStations) {
    stationCache = {
      stations: dbStations,
      expiresAt: now + CACHE_TTL_MS,
      fetchedAt: new Date().toISOString(),
    };
    console.log(`[stations] serving ${dbStations.length} stations from DB; NOAA refresh in background`);
    fetchStationsFromNoaa().then((fresh) => {
      stationCache = {
        stations: fresh,
        expiresAt: Date.now() + CACHE_TTL_MS,
        fetchedAt: new Date().toISOString(),
      };
      console.log(`[stations] background NOAA refresh complete: ${fresh.length} stations`);
    }).catch(() => {});
    return mergeEnrichedData(dbStations);
  }

  // First-ever start with no DB cache: must wait for NOAA
  const stations = await fetchStationsFromNoaa();
  stationCache = {
    stations,
    expiresAt: now + CACHE_TTL_MS,
    fetchedAt: new Date().toISOString(),
  };

  console.log(`[stations] fetched and cached ${stations.length} stations for 24 hours`);
  return mergeEnrichedData(stations);
}
