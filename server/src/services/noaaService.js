import axios from 'axios';

// NOAA Coral Reef Watch 5km near-real-time ERDDAP griddap dataset.
// Dataset landing page:
// https://coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW.html
//
// Variables used by ReefWatch:
// - CRW_SST: CoralTemp sea surface temperature
// - CRW_SSTANOMALY: sea surface temperature anomaly
// - CRW_DHW: Degree Heating Weeks
// - CRW_BAA_7D_MAX: maximum 7-day Bleaching Alert Area
//
// NOAA currently redirects this dataset to the PacIOOS ERDDAP mirror:
// https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.html
const NOAA_ERDDAP_BASE_URL = process.env.NOAA_BASE_URL || 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';
const NOAA_DHW_DATASET_ID = 'NOAA_DHW';
const NOAA_SOURCE_LABEL = 'NOAA Coral Reef Watch 5km ERDDAP NOAA_DHW';

const noaaClient = axios.create({
  baseURL: NOAA_ERDDAP_BASE_URL,
  timeout: 20000,
  maxRedirects: 5,
});

const reefLocations = [
  {
    id: 'raja-ampat',
    name: 'Raja Ampat',
    region: 'West Papua',
    country: 'Indonesia',
    lat: -0.5897,
    lng: 130.3261,
  },
  {
    id: 'caribbean-coral-belt',
    name: 'Caribbean Coral Belt',
    region: 'Caribbean Sea',
    country: 'Multi-country',
    lat: 17.3578,
    lng: -87.532,
  },
  {
    id: 'great-barrier-reef-sector-4',
    name: 'Great Barrier Reef - Sector 4',
    region: 'Coral Sea',
    country: 'Australia',
    lat: -18.2871,
    lng: 147.6992,
  },
  {
    id: 'maldives-reef-system',
    name: 'Maldives Reef System',
    region: 'Indian Ocean',
    country: 'Maldives',
    lat: 3.2028,
    lng: 73.2207,
  },
  {
    id: 'red-sea-coral',
    name: 'Red Sea Coral',
    region: 'Red Sea',
    country: 'Egypt / Saudi Arabia',
    lat: 22.2855,
    lng: 37.2397,
  },
  {
    id: 'florida-keys-reef',
    name: 'Florida Keys Reef',
    region: 'Florida Keys',
    country: 'United States',
    lat: 24.5551,
    lng: -81.78,
  },
  {
    id: 'coral-triangle',
    name: 'Coral Triangle',
    region: 'Southeast Asia',
    country: 'Indonesia',
    lat: -8.3405,
    lng: 115.092,
  },
  {
    id: 'new-caledonia-barrier-reef',
    name: 'New Caledonia Barrier Reef',
    region: 'South Pacific',
    country: 'New Caledonia',
    lat: -22.2735,
    lng: 166.458,
  },
];

const alertAreaLabels = {
  0: 'No Stress',
  1: 'Bleaching Watch',
  2: 'Bleaching Warning',
  3: 'Alert Level 1',
  4: 'Alert Level 2',
};

const toNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, digits = 2) => {
  if (value === null || value === undefined) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const parseSingleRowCsv = (csv) => {
  const lines = csv.trim().split('\n');

  if (lines.length < 3) {
    throw new Error('NOAA ERDDAP response did not include a data row');
  }

  const headers = lines[0].split(',');
  const values = lines[2].split(',');

  return headers.reduce((row, header, index) => ({
    ...row,
    [header]: values[index],
  }), {});
};

const getBleachingAlertLevel = (alertArea) => {
  if (alertArea === null || alertArea === undefined) return 'Unavailable';
  return alertAreaLabels[Math.round(alertArea)] || `Alert Area ${alertArea}`;
};

const calculateRisk = (degreeHeatingWeeks, alertArea) => {
  const dhw = degreeHeatingWeeks ?? 0;
  const alert = alertArea ?? 0;

  if (dhw >= 8 || alert >= 4) {
    return {
      riskScore: Math.max(80, Math.min(100, Math.round(dhw * 10))),
      status: 'critical',
    };
  }

  if (dhw >= 4 || alert >= 2) {
    return {
      riskScore: Math.max(45, Math.min(79, Math.round(dhw * 10))),
      status: 'warning',
    };
  }

  return {
    riskScore: Math.max(0, Math.min(29, Math.round(dhw * 10))),
    status: 'safe',
  };
};

const buildLatestPointQuery = ({ lat, lng }) => {
  const point = `[(last)][(${lat})][(${lng})]`;
  const variables = [
    `CRW_SST${point}`,
    `CRW_SSTANOMALY${point}`,
    `CRW_DHW${point}`,
    `CRW_BAA_7D_MAX${point}`,
  ];

  return `/${NOAA_DHW_DATASET_ID}.csv?${variables.join(',')}`;
};

const fallbackReef = (reef, error) => ({
  ...reef,
  seaSurfaceTemp: null,
  tempAnomaly: null,
  degreeHeatingWeeks: null,
  bleachingAlertLevel: 'Unavailable',
  riskScore: 0,
  status: 'safe',
  lastUpdated: new Date().toISOString(),
  source: 'fallback',
  error: error.message,
});

async function fetchReefFromNoaa(reef) {
  const query = buildLatestPointQuery(reef);
  const response = await noaaClient.get(query);
  const row = parseSingleRowCsv(response.data);

  const seaSurfaceTemp = round(toNumber(row.CRW_SST));
  const tempAnomaly = round(toNumber(row.CRW_SSTANOMALY));
  const degreeHeatingWeeks = round(toNumber(row.CRW_DHW));
  const alertArea = toNumber(row.CRW_BAA_7D_MAX);

  if (
    seaSurfaceTemp === null
    && tempAnomaly === null
    && degreeHeatingWeeks === null
    && alertArea === null
  ) {
    throw new Error('NOAA returned no data for the nearest grid cell');
  }

  const risk = calculateRisk(degreeHeatingWeeks, alertArea);

  return {
    ...reef,
    seaSurfaceTemp,
    tempAnomaly,
    degreeHeatingWeeks,
    bleachingAlertLevel: getBleachingAlertLevel(alertArea),
    riskScore: risk.riskScore,
    status: risk.status,
    lastUpdated: row.time || new Date().toISOString(),
    source: NOAA_SOURCE_LABEL,
  };
}

export async function fetchReefConditions() {
  const reefs = await Promise.all(reefLocations.map(async (reef) => {
    try {
      const liveReef = await fetchReefFromNoaa(reef);
      console.log(`[noaa] success ${reef.id}`, {
        time: liveReef.lastUpdated,
        sst: liveReef.seaSurfaceTemp,
        anomaly: liveReef.tempAnomaly,
        dhw: liveReef.degreeHeatingWeeks,
        alert: liveReef.bleachingAlertLevel,
      });
      return liveReef;
    } catch (error) {
      console.error(`[noaa] failure ${reef.id}`, error.message);
      return fallbackReef(reef, error);
    }
  }));

  return reefs;
}
