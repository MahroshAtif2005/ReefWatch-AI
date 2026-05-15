import axios from 'axios';

const NOAA_STATIONS_JSON_URL = 'https://coralreefwatch.noaa.gov/vs/gauges/regions/global.json';
const NOAA_STATIONS_GEOJSON_FALLBACK_URL = 'https://coralreefwatch.noaa.gov/product/vs/vs_polygons.json';
const STATION_SOURCE = 'NOAA Virtual Station List';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let stationCache = {
  stations: null,
  expiresAt: 0,
  fetchedAt: null,
};

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

async function fetchStationsFromNoaa() {
  try {
    console.log(`[stations] fetching ${NOAA_STATIONS_JSON_URL}`);
    const response = await stationClient.get(NOAA_STATIONS_JSON_URL);
    const stations = normalizeUnknownJson(response.data);

    if (stations.length === 0) {
      throw new Error('NOAA station JSON returned no station records');
    }

    return stations;
  } catch (error) {
    console.warn(`[stations] primary station list failed: ${error.message}`);
    console.log(`[stations] fetching fallback ${NOAA_STATIONS_GEOJSON_FALLBACK_URL}`);

    const response = await stationClient.get(NOAA_STATIONS_GEOJSON_FALLBACK_URL);
    const stations = normalizeGeoJsonStations(response.data);

    if (stations.length === 0) {
      throw new Error('NOAA fallback GeoJSON returned no station records');
    }

    return stations;
  }
}

export async function fetchVirtualStations() {
  const now = Date.now();

  if (stationCache.stations && stationCache.expiresAt > now) {
    console.log(`[stations] serving ${stationCache.stations.length} stations from cache`);
    return stationCache.stations;
  }

  const stations = await fetchStationsFromNoaa();
  stationCache = {
    stations,
    expiresAt: now + CACHE_TTL_MS,
    fetchedAt: new Date().toISOString(),
  };

  console.log(`[stations] fetched and cached ${stations.length} stations for 24 hours`);
  return stations;
}
