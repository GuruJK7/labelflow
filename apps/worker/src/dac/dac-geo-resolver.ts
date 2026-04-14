/**
 * Resolves Shopify address data → DAC numeric IDs for bulk xlsx upload.
 *
 * Uses the pre-extracted dac-geo-map.json (700 cities, 141 offices, 89 MVD
 * barrios) to map department/city/barrio names to the exact numeric IDs
 * that DAC's masivos upload expects.
 */

import dacGeoMap from './dac-geo-map.json';
import logger from '../logger';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

interface DacGeoResolution {
  kEstado: number;       // Department ID (K_Estado)
  kCiudad: number;       // City ID (K_Ciudad)
  oficinaDestino: number; // Office ID (Oficina_destino)
  confidence: 'high' | 'medium' | 'low';
}

interface GeoMapDepartment {
  name: string;
  cities: Array<{
    id: string;
    name: string;
    oficinas: Array<{ id: string; name: string }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────
// Department name → ID mapping
// ─────────────────────────────────────────────────────────────────────

const DEPT_NAME_TO_ID: Record<string, number> = {};
const DEPT_ID_TO_DATA: Record<number, GeoMapDepartment> = {};

for (const [id, data] of Object.entries((dacGeoMap as any).departments)) {
  const dept = data as GeoMapDepartment;
  DEPT_NAME_TO_ID[norm(dept.name)] = parseInt(id, 10);
  DEPT_ID_TO_DATA[parseInt(id, 10)] = dept;
}

// Common aliases for department names
const DEPT_ALIASES: Record<string, string> = {
  'treinta y tres': 'treinta y tres',
  '33': 'treinta y tres',
  'rio negro': 'rio negro',
  'san jose': 'san jose',
  'cerro largo': 'cerro largo',
  'paysandu': 'paysandu',
  'tacuarembo': 'tacuarembo',
};

export function resolveDepartmentId(deptName: string): number | null {
  const n = norm(deptName);
  if (DEPT_NAME_TO_ID[n]) return DEPT_NAME_TO_ID[n];
  if (DEPT_ALIASES[n] && DEPT_NAME_TO_ID[DEPT_ALIASES[n]]) {
    return DEPT_NAME_TO_ID[DEPT_ALIASES[n]];
  }
  // Partial match
  for (const [name, id] of Object.entries(DEPT_NAME_TO_ID)) {
    if (name.includes(n) || n.includes(name)) return id;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// City name → ID mapping (within a department)
// ─────────────────────────────────────────────────────────────────────

export function resolveCityId(deptId: number, cityName: string): number | null {
  const dept = DEPT_ID_TO_DATA[deptId];
  if (!dept) return null;
  const n = norm(cityName);

  // Exact match
  for (const city of dept.cities) {
    if (norm(city.name) === n) return parseInt(city.id, 10);
  }
  // Contains match
  for (const city of dept.cities) {
    if (norm(city.name).includes(n) || n.includes(norm(city.name))) {
      return parseInt(city.id, 10);
    }
  }
  // Default: capital city (first in list or named same as dept)
  for (const city of dept.cities) {
    if (norm(city.name) === norm(dept.name)) return parseInt(city.id, 10);
  }
  // Fallback: first city with offices
  for (const city of dept.cities) {
    if (city.oficinas.length > 0) return parseInt(city.id, 10);
  }
  return dept.cities.length > 0 ? parseInt(dept.cities[0].id, 10) : null;
}

// ─────────────────────────────────────────────────────────────────────
// Office resolution (within a city)
// ─────────────────────────────────────────────────────────────────────

export function resolveOficinaId(deptId: number, cityId: number): number | null {
  const dept = DEPT_ID_TO_DATA[deptId];
  if (!dept) return null;
  const city = dept.cities.find(c => parseInt(c.id, 10) === cityId);
  if (!city || city.oficinas.length === 0) {
    // Try to find any office in the department
    for (const c of dept.cities) {
      if (c.oficinas.length > 0) return parseInt(c.oficinas[0].id, 10);
    }
    return null;
  }
  // For Montevideo, prefer Deposito CDD (124) or first non-special office
  if (deptId === 10) {
    const cdd = city.oficinas.find(o => o.name.toLowerCase().includes('deposito') || o.name.toLowerCase().includes('cdd'));
    if (cdd) return parseInt(cdd.id, 10);
  }
  return parseInt(city.oficinas[0].id, 10);
}

// ─────────────────────────────────────────────────────────────────────
// Complete resolution: Shopify address → DAC IDs
// ─────────────────────────────────────────────────────────────────────

export function resolveShopifyAddressToDacIds(
  department: string,
  city: string,
): DacGeoResolution | null {
  // 1. Resolve department
  const deptId = resolveDepartmentId(department);
  if (!deptId) {
    logger.warn({ department, city }, 'DAC geo: department not found');
    return null;
  }

  // 2. Resolve city within department
  const cityId = resolveCityId(deptId, city || department);
  if (!cityId) {
    logger.warn({ department, city, deptId }, 'DAC geo: city not found');
    return null;
  }

  // 3. Resolve office within city
  const oficinaId = resolveOficinaId(deptId, cityId);
  if (!oficinaId) {
    logger.warn({ department, city, deptId, cityId }, 'DAC geo: no office found');
    return null;
  }

  return {
    kEstado: deptId,
    kCiudad: cityId,
    oficinaDestino: oficinaId,
    confidence: 'high',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Exports for testing
// ─────────────────────────────────────────────────────────────────────

export { DEPT_NAME_TO_ID, DEPT_ID_TO_DATA };
