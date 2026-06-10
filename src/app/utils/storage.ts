export const ACTIVE_IDS_KEY = 'reefwatch_active_reef_ids';
export const STATION_CATALOG_KEY = 'reefwatch_station_catalog';

export interface StationMeta {
  id: string;
  name: string;
  lat: number;
  lng: number;
  stationId?: string;
}

export function isStorageAvailable(): boolean {
  try {
    const key = '__rw_storage_test__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function getActiveReefIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVE_IDS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveActiveReefIds(ids: string[]): boolean {
  try {
    localStorage.setItem(ACTIVE_IDS_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

// Station catalog: persists metadata for custom-monitored stations so they can be
// re-registered with the backend after a Cloud Run restart wipes the ephemeral DB.
export function getStationCatalog(): Record<string, StationMeta> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATION_CATALOG_KEY) || '{}');
    return typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveStationToCatalog(station: StationMeta): void {
  try {
    const catalog = getStationCatalog();
    catalog[station.id] = station;
    localStorage.setItem(STATION_CATALOG_KEY, JSON.stringify(catalog));
  } catch {
    // storage unavailable — non-critical
  }
}

export function removeStationFromCatalog(id: string): void {
  try {
    const catalog = getStationCatalog();
    if (!catalog[id]) return;
    delete catalog[id];
    localStorage.setItem(STATION_CATALOG_KEY, JSON.stringify(catalog));
  } catch {
    // storage unavailable — non-critical
  }
}
