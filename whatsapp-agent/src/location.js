// location.js — Owner-Only Location Intelligence & Awareness for PSD_Ai.
//
// Gives the agent full location power FOR THE OWNER:
//   1. Live WhatsApp GPS Pin / Live Location support (saves exact lat/lon + reverse-geocodes address)
//   2. Manual place/city/coordinate setting (`/location set Dehradun` or `"meri location Dehradun hai"`)
//   3. Automatic IP + Timezone geolocation fallback (`ipwho.is` / `ipapi.co`)
//   4. Nearby places search (`/location near <cafe|hospital|atm|gym>`) via OpenStreetMap
//   5. Distance & Google Maps navigation links from owner's current location
//   6. Seamless integration with `/weather`, `/brief`, and owner AI system prompt
//
// STRICT PRIVACY FIREWALL:
//   - Location is 100% OWNER-ONLY (`ctx.isOwner === false` is strictly blocked).
//   - Non-owner guests never receive the owner's location, IP, coordinates, or city.

import * as mem from './memory.js';

const NOMINATIM_HEADERS = {
  'user-agent': 'PSD-Observer-WhatsApp-Agent/3.2 (Linux; Owner-Only Assistant)',
  accept: 'application/json',
};

const TZ_DEFAULT_CITIES = {
  'Asia/Kolkata': { city: 'Dehradun', region: 'Uttarakhand', country: 'India', countryCode: 'IN', lat: 30.3165, lon: 78.0322 },
  'Asia/Calcutta': { city: 'Dehradun', region: 'Uttarakhand', country: 'India', countryCode: 'IN', lat: 30.3165, lon: 78.0322 },
};

export function ensureLocationStore(store) {
  if (!store?.data) return null;
  if (!store.data.ownerLocation || typeof store.data.ownerLocation !== 'object') {
    store.data.ownerLocation = {
      enabled: true,
      city: '',
      region: '',
      country: '',
      countryCode: '',
      address: '',
      lat: null,
      lon: null,
      ip: '',
      timezone: '',
      source: '', // 'gps_pin' | 'manual' | 'memory' | 'ip_auto' | 'timezone'
      updatedTs: 0,
    };
  }
  if (store.data.ownerLocation.enabled === undefined) {
    store.data.ownerLocation.enabled = true;
  }
  return store.data.ownerLocation;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function reverseGeocode(lat, lon, timeoutMs = 6000) {
  const numLat = Number(lat);
  const numLon = Number(lon);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLon)) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(numLat)}&lon=${encodeURIComponent(numLon)}&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      headers: NOMINATIM_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data?.address ?? {};
    const city = addr.city || addr.town || addr.village || addr.municipality || addr.suburb || addr.county || addr.state_district || '';
    const region = addr.state || addr.region || '';
    const country = addr.country || '';
    const countryCode = (addr.country_code || '').toUpperCase();
    return {
      city,
      region,
      country,
      countryCode,
      address: data?.display_name || [city, region, country].filter(Boolean).join(', '),
      lat: numLat,
      lon: numLon,
    };
  } catch {
    return null;
  }
}

export async function geocodePlace(placeQuery, timeoutMs = 6000) {
  const q = String(placeQuery ?? '').trim();
  if (!q) return null;

  // Try 1: OpenStreetMap Nominatim (gives full address + street/suburb/city precision)
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: NOMINATIM_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const arr = await res.json();
      const top = arr?.[0];
      if (top && top.lat != null && top.lon != null) {
        const addr = top.address ?? {};
        const city = addr.city || addr.town || addr.village || addr.municipality || top.name || q;
        const region = addr.state || addr.region || '';
        const country = addr.country || '';
        const countryCode = (addr.country_code || '').toUpperCase();
        return {
          city,
          region,
          country,
          countryCode,
          address: top.display_name || [city, region, country].filter(Boolean).join(', '),
          lat: Number(top.lat),
          lon: Number(top.lon),
        };
      }
    }
  } catch { /* fall through */ }

  // Try 2: Open-Meteo Geocoding API
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const data = await res.json();
      const hit = data?.results?.[0];
      if (hit) {
        return {
          city: hit.name || q,
          region: hit.admin1 || '',
          country: hit.country || '',
          countryCode: (hit.country_code || '').toUpperCase(),
          address: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
          lat: Number(hit.latitude),
          lon: Number(hit.longitude),
        };
      }
    }
  } catch { /* fall through */ }

  return null;
}

export async function fetchIpLocation(timeoutMs = 4500) {
  // Try 1: ipwho.is (free, no key, fast JSON)
  try {
    const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const d = await res.json();
      if (d && d.success !== false && (d.city || d.latitude != null)) {
        return {
          city: d.city || '',
          region: d.region || '',
          country: d.country || '',
          countryCode: d.country_code || '',
          address: [d.city, d.region, d.country].filter(Boolean).join(', '),
          lat: Number.isFinite(Number(d.latitude)) ? Number(d.latitude) : null,
          lon: Number.isFinite(Number(d.longitude)) ? Number(d.longitude) : null,
          ip: d.ip || '',
          timezone: d.timezone?.id || '',
          source: 'ip_auto',
        };
      }
    }
  } catch { /* fall through */ }

  // Try 2: ipapi.co/json
  try {
    const res = await fetch('https://ipapi.co/json/', {
      headers: NOMINATIM_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const d = await res.json();
      if (d && (d.city || d.latitude != null)) {
        return {
          city: d.city || '',
          region: d.region || '',
          country: d.country_name || d.country || '',
          countryCode: d.country_code || '',
          address: [d.city, d.region, d.country_name || d.country].filter(Boolean).join(', '),
          lat: Number.isFinite(Number(d.latitude)) ? Number(d.latitude) : null,
          lon: Number.isFinite(Number(d.longitude)) ? Number(d.longitude) : null,
          ip: d.ip || '',
          timezone: d.timezone || '',
          source: 'ip_auto',
        };
      }
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Update the owner's stored location from coordinates (`{ lat, lon, name }`)
 * or a place/city string (`"Dehradun, Uttarakhand"` or `"30.3165, 78.0322"`).
 */
export async function setOwnerLocation(store, config = {}, input = {}, opts = {}) {
  const loc = ensureLocationStore(store);
  if (!loc) return { ok: false, reason: 'Store unavailable' };
  loc.enabled = true;

  // Case 1: Object with lat/lon (e.g. from WhatsApp location pin)
  if (input && typeof input === 'object' && input.lat != null && input.lon != null) {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false, reason: 'Invalid GPS coordinates.' };
    }
    const rev = opts.skipNetwork ? null : await reverseGeocode(lat, lon);
    loc.lat = lat;
    loc.lon = lon;
    loc.city = rev?.city || input.city || input.name || loc.city || '';
    loc.region = rev?.region || input.region || loc.region || '';
    loc.country = rev?.country || input.country || loc.country || '';
    loc.countryCode = rev?.countryCode || input.countryCode || loc.countryCode || '';
    loc.address = input.address || input.name || rev?.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    loc.timezone = config.timezone || loc.timezone || 'Asia/Kolkata';
    loc.source = input.source || 'gps_pin';
    loc.updatedTs = Date.now();
    if (loc.city) {
      mem.rememberFact(store, `location: ${[loc.city, loc.region].filter(Boolean).join(', ')}`);
    }
    store.save?.();
    return { ok: true, location: { ...loc } };
  }

  // Case 2: String input — either "lat, lon" or a place/city name
  const raw = String(typeof input === 'string' ? input : (input?.query ?? '')).trim();
  if (!raw) return { ok: false, reason: 'Please provide a city, address, or GPS coordinates (e.g. `/location set Dehradun`).' };

  const coordMatch = raw.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coordMatch) {
    return setOwnerLocation(
      store,
      config,
      { lat: Number(coordMatch[1]), lon: Number(coordMatch[2]), source: 'manual_coords' },
      opts,
    );
  }

  const geo = opts.skipNetwork ? null : await geocodePlace(raw);
  loc.city = geo?.city || raw.split(',')[0].trim();
  loc.region = geo?.region || raw.split(',')[1]?.trim() || '';
  loc.country = geo?.country || raw.split(',')[2]?.trim() || '';
  loc.countryCode = geo?.countryCode || '';
  loc.address = geo?.address || raw;
  loc.lat = geo?.lat ?? null;
  loc.lon = geo?.lon ?? null;
  loc.timezone = config.timezone || loc.timezone || 'Asia/Kolkata';
  loc.source = 'manual';
  loc.updatedTs = Date.now();

  mem.rememberFact(store, `location: ${loc.address}`);
  store.save?.();
  return { ok: true, location: { ...loc } };
}

/**
 * Get or auto-detect the owner's current location.
 * Priority:
 *   1. Saved `store.data.ownerLocation` (from WhatsApp GPS pin or `/location set`)
 *   2. Owner's saved memory fact (`factValues.location` / `factValues.city`)
 *   3. Live IP geolocation (`ipwho.is` / `ipapi.co`) when `allowNetwork !== false`
 *   4. Timezone fallback (`Asia/Kolkata` -> Dehradun, Uttarakhand, IN)
 */
export async function resolveOwnerLocation(store, config = {}, { forceRefresh = false, allowNetwork = true } = {}) {
  const loc = ensureLocationStore(store);
  if (loc && loc.enabled === false) {
    return { ok: false, disabled: true, reason: 'Location access is turned OFF (/location on to enable).' };
  }

  // 1. Existing fresh or manual/GPS location
  if (loc && !forceRefresh && (loc.city || (loc.lat != null && loc.lon != null))) {
    const isAutoStale = loc.source === 'ip_auto' && Date.now() - (loc.updatedTs || 0) > 6 * 3600_000;
    if (!isAutoStale) {
      return { ok: true, location: { ...loc } };
    }
  }

  // 2. Check owner's saved memory facts (e.g. "main Dehradun me rehta hoon")
  const memPlace = store?.data?.factValues?.location || store?.data?.factValues?.city || '';
  if (memPlace && !forceRefresh) {
    const geo = allowNetwork ? await geocodePlace(memPlace) : null;
    if (loc) {
      loc.city = geo?.city || memPlace;
      loc.region = geo?.region || '';
      loc.country = geo?.country || '';
      loc.countryCode = geo?.countryCode || '';
      loc.address = geo?.address || memPlace;
      loc.lat = geo?.lat ?? loc.lat;
      loc.lon = geo?.lon ?? loc.lon;
      loc.source = 'memory';
      loc.updatedTs = Date.now();
      store?.save?.();
      return { ok: true, location: { ...loc } };
    }
  }

  // 3. Auto-detect via IP geolocation
  if (allowNetwork && !config.dryRun) {
    const ipLoc = await fetchIpLocation();
    if (ipLoc && loc) {
      Object.assign(loc, ipLoc, { enabled: true, updatedTs: Date.now() });
      store?.save?.();
      return { ok: true, location: { ...loc } };
    }
  }

  // 4. Timezone fallback so the owner always has working location context even offline
  const tz = config.timezone || 'Asia/Kolkata';
  const fallback = TZ_DEFAULT_CITIES[tz] || TZ_DEFAULT_CITIES['Asia/Kolkata'];
  if (loc) {
    loc.city = loc.city || fallback.city;
    loc.region = loc.region || fallback.region;
    loc.country = loc.country || fallback.country;
    loc.countryCode = loc.countryCode || fallback.countryCode;
    loc.lat = loc.lat ?? fallback.lat;
    loc.lon = loc.lon ?? fallback.lon;
    loc.address = loc.address || `${loc.city}, ${loc.region}, ${loc.country}`;
    loc.timezone = tz;
    loc.source = loc.source || 'timezone';
    loc.updatedTs = loc.updatedTs || Date.now();
  }
  return { ok: true, location: loc ? { ...loc } : { ...fallback, timezone: tz, source: 'timezone' } };
}

/**
 * Search for nearby places around the owner's current location (e.g. "cafe", "atm", "hospital", "gym").
 */
export async function searchNearbyPlaces(store, config = {}, rawQuery = '', limit = 6) {
  const q = String(rawQuery ?? '').trim();
  if (!q) {
    return { ok: false, reason: 'Usage: `/location near <place type or name>` (e.g. `/location near cafe`, `/location near hospital`).' };
  }
  const resolved = await resolveOwnerLocation(store, config, { allowNetwork: true });
  if (!resolved.ok) return resolved;
  const loc = resolved.location;

  try {
    let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${Math.min(limit, 10)}`;
    if (loc.lat != null && loc.lon != null) {
      const delta = 0.08; // ~8km bounding box
      const viewbox = `${loc.lon - delta},${loc.lat + delta},${loc.lon + delta},${loc.lat - delta}`;
      url += `&viewbox=${encodeURIComponent(viewbox)}&bounded=1&q=${encodeURIComponent(q)}`;
    } else {
      url += `&q=${encodeURIComponent(`${q} near ${loc.city || loc.address}`)}`;
    }
    const res = await fetch(url, {
      headers: NOMINATIM_HEADERS,
      signal: AbortSignal.timeout(7000),
    });
    let items = res.ok ? await res.json() : [];
    // If bounded box was too tight, retry with "<query> in <city>"
    if ((!Array.isArray(items) || !items.length) && loc.city) {
      const fallbackUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${Math.min(limit, 10)}&q=${encodeURIComponent(`${q}, ${loc.city}`)}`;
      const res2 = await fetch(fallbackUrl, {
        headers: NOMINATIM_HEADERS,
        signal: AbortSignal.timeout(7000),
      });
      if (res2.ok) items = await res2.json();
    }

    if (!Array.isArray(items) || !items.length) {
      const mapsSearchUrl = loc.lat != null && loc.lon != null
        ? `https://www.google.com/maps/search/${encodeURIComponent(q)}/@${loc.lat},${loc.lon},14z`
        : `https://www.google.com/maps/search/${encodeURIComponent(`${q} near ${loc.city || ''}`)}`;
      return {
        ok: true,
        places: [],
        text: `📍 *Nearby Search: "${q}"* (around *${loc.city || loc.address}*)\nOpen directly on Google Maps:\n🔗 ${mapsSearchUrl}`,
      };
    }

    const places = items.slice(0, limit).map((item) => {
      const pLat = Number(item.lat);
      const pLon = Number(item.lon);
      const distKm = (loc.lat != null && loc.lon != null && Number.isFinite(pLat) && Number.isFinite(pLon))
        ? haversineKm(loc.lat, loc.lon, pLat, pLon)
        : null;
      const name = item.name || item.display_name?.split(',')[0] || q;
      const address = item.display_name || '';
      const mapsUrl = `https://maps.google.com/?q=${pLat},${pLon}`;
      return { name, address, lat: pLat, lon: pLon, distKm, mapsUrl };
    });

    if (places.some((p) => p.distKm != null)) {
      places.sort((a, b) => (a.distKm ?? 999) - (b.distKm ?? 999));
    }

    const lines = places.map((p, idx) => {
      const distTag = p.distKm != null ? ` _(${p.distKm < 1 ? `${Math.round(p.distKm * 1000)}m` : `${p.distKm.toFixed(1)} km`})_` : '';
      return `${idx + 1}. *${p.name}*${distTag}\n   📍 ${p.address.slice(0, 110)}\n   🗺️ ${p.mapsUrl}`;
    });

    return {
      ok: true,
      places,
      text: [
        `📍 *Nearby "${q}" around ${loc.city || loc.address}:*`,
        '',
        ...lines,
      ].join('\n'),
    };
  } catch (err) {
    return { ok: false, reason: `Nearby lookup failed: ${err.message}` };
  }
}

export function formatOwnerLocationCard(store, config = {}, locObj = null) {
  const stored = ensureLocationStore(store);
  if (stored && stored.enabled === false) {
    return '🔒 *Owner Location Access is OFF.*\nEnable anytime with `/location on` or `/location set <city>`.';
  }
  const loc = locObj || stored;
  if (!loc || (!loc.city && loc.lat == null)) {
    return '📍 Location abhi set nahi hai. Send a WhatsApp location pin, or run `/location set <city>` or `/location refresh`.';
  }
  const coords = loc.lat != null && loc.lon != null
    ? `${Number(loc.lat).toFixed(5)}, ${Number(loc.lon).toFixed(5)}`
    : 'not set';
  const mapsUrl = loc.lat != null && loc.lon != null
    ? `https://maps.google.com/?q=${loc.lat},${loc.lon}`
    : `https://www.google.com/maps/search/${encodeURIComponent(loc.address || loc.city)}`;
  const sourceLabel = ({
    gps_pin: '📲 WhatsApp GPS Pin (Exact)',
    manual_coords: '🧭 Manual Coordinates',
    manual: '✍️ Owner Saved Place',
    memory: '🧠 Owner Memory',
    ip_auto: '🌐 Network IP Geolocation',
    timezone: '🕐 Timezone Default',
  })[loc.source] || loc.source || 'auto';

  return [
    '📍 *Your Current Location (Owner-Only 🔒)*',
    `• *Place:* ${[loc.city, loc.region, loc.country].filter(Boolean).join(', ') || loc.address}`,
    loc.address ? `• *Address:* ${loc.address}` : null,
    `• *Coordinates:* \`${coords}\``,
    `• *Source:* ${sourceLabel}`,
    `• *Map:* ${mapsUrl}`,
    `• *Privacy:* 🔒 Locked to Owner (+${config.ownerNumber}) — never shared with guests`,
    '',
    '*Power Commands:*',
    '• `/location set <city or lat,lon>` — update your location (or just drop a WhatsApp 📍 Location Pin!)',
    '• `/location refresh` — re-detect live location from IP/network',
    '• `/location near <query>` — find nearby cafes, ATMs, hospitals, gyms',
    '• `/weather` — instant weather for your current location',
    '• `/location off` — disable location access',
  ].filter(Boolean).join('\n');
}

/**
 * Injected ONLY into the owner's system prompt (`src/ai.js`).
 * Never called for guests.
 */
export function formatLocationForOwnerPrompt(store, config = {}) {
  const loc = ensureLocationStore(store);
  if (!loc || loc.enabled === false) return '';
  const tz = config.timezone || 'Asia/Kolkata';
  const fallback = TZ_DEFAULT_CITIES[tz] || TZ_DEFAULT_CITIES['Asia/Kolkata'];
  const city = loc.city || store?.data?.factValues?.location || store?.data?.factValues?.city || fallback.city;
  const region = loc.region || (city === fallback.city ? fallback.region : '');
  const country = loc.country || (city === fallback.city ? fallback.country : 'India');
  const coords = loc.lat != null && loc.lon != null
    ? ` (GPS: ${Number(loc.lat).toFixed(4)}, ${Number(loc.lon).toFixed(4)})`
    : '';
  return `Owner's current location (STRICTLY PRIVATE TO OWNER): ${[city, region, country].filter(Boolean).join(', ')}${coords}. Use this automatically for local weather, nearby recommendations, time/commute, and context.`;
}
