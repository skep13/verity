'use strict';
/**
 * Weather, via Open-Meteo.
 *
 * This is the one tool that genuinely cannot work offline — a forecast is a fact
 * about the world right now, so it has to come off the network. Open-Meteo needs
 * no API key and no account, which keeps setup to nothing. When there is no
 * connection we say so plainly rather than guessing.
 */

const { load } = require('../config');

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather interpretation codes.
const CONDITIONS = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'freezing fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'heavy drizzle',
  56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'light snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

const OFFLINE = {
  available: false,
  error:
    'Could not reach the weather service — this Mac appears to be offline. ' +
    'Weather is live data, so it cannot be answered from the offline archive. Tell the user a connection is needed.',
};

function describe(code) {
  return CONDITIONS[code] || 'unknown conditions';
}

async function geocode(place) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) return null;
  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    label: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
  };
}

async function weather({ location, days = 1 }) {
  const cfg = load();

  // Fall back to the saved home location before giving up, so "what's the
  // weather" works without naming a place every time.
  const requested = location || cfg.homeLocation || '';

  let place;
  try {
    if (requested) {
      place = await geocode(requested);
      if (!place) return { available: true, found: false, note: `Could not find a place called "${requested}".` };
    } else if (cfg.location.latitude != null && cfg.location.longitude != null) {
      place = {
        latitude: cfg.location.latitude,
        longitude: cfg.location.longitude,
        label: cfg.location.label || 'your saved location',
      };
    } else {
      return {
        available: true,
        found: false,
        note: 'No location was given and none is saved in settings. Ask the user which place they mean, and suggest they save it in Settings so you stop having to ask.',
      };
    }

    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: String(Math.min(Math.max(Number(days) || 1, 1), 7)),
    });

    const res = await fetch(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Forecast failed (${res.status})`);
    const data = await res.json();

    const c = data.current || {};
    const units = data.current_units || {};
    const out = {
      available: true,
      found: true,
      location: place.label,
      current: {
        temperature: `${Math.round(c.temperature_2m)}${units.temperature_2m || '°C'}`,
        feelsLike: `${Math.round(c.apparent_temperature)}${units.apparent_temperature || '°C'}`,
        conditions: describe(c.weather_code),
        humidity: `${c.relative_humidity_2m}%`,
        wind: `${Math.round(c.wind_speed_10m)} ${units.wind_speed_10m || 'km/h'}`,
      },
    };

    const d = data.daily;
    if (d?.time?.length) {
      out.forecast = d.time.map((date, i) => ({
        date,
        conditions: describe(d.weather_code[i]),
        high: `${Math.round(d.temperature_2m_max[i])}°`,
        low: `${Math.round(d.temperature_2m_min[i])}°`,
        chanceOfRain: d.precipitation_probability_max?.[i] != null ? `${d.precipitation_probability_max[i]}%` : null,
      }));
    }
    return out;
  } catch (err) {
    // Distinguish "no network" from a genuine API fault, since the first is
    // expected on a machine designed to run offline.
    if (err.name === 'TimeoutError' || /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(err.message)) {
      return OFFLINE;
    }
    return { available: false, error: err.message };
  }
}

function datetime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

module.exports = { weather, datetime, geocode };
