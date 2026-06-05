export const ACTIVE_IDS_KEY = 'reefwatch_active_reef_ids';

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
