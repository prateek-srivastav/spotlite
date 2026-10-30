// Weather answers from Open-Meteo (free, no key): "weather", "weather in paris",
// "delhi weather", "temperature tomorrow". A bare "weather" uses the home city from
// the preferences, or else the city in the system time zone (Asia/Kolkata ->
// Kolkata), so the location is never looked up from the IP address.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

// WMO weather codes -> words and an icon (Adwaita has a -night variant for the clear ones)
const CODES = [
  [[0], "Clear", "weather-clear", true],
  [[1], "Mainly clear", "weather-few-clouds", true],
  [[2], "Partly cloudy", "weather-few-clouds", true],
  [[3], "Overcast", "weather-overcast"],
  [[45, 48], "Fog", "weather-fog"],
  [[51, 53, 55, 56, 57], "Drizzle", "weather-showers-scattered"],
  [[61, 63, 66, 80, 81], "Rain", "weather-showers"],
  [[65, 67, 82], "Heavy rain", "weather-showers"],
  [[71, 73, 75, 77, 85, 86], "Snow", "weather-snow"],
  [[95, 96, 99], "Thunderstorm", "weather-storm"],
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORDS = "weather|temperature|forecast|temp";
const PATTERNS = [
  // "weather", "weather in delhi", "what's the weather in delhi tomorrow"
  new RegExp(`^(?:what(?:'s| is) the |how(?:'s| is) the )?(?:${WORDS})(?: (?:in|at|for) (.+?))?( today| now| tomorrow)?$`),
  // "delhi weather", "delhi weather tomorrow"
  new RegExp(`^(.+?) (?:${WORDS})( today| now| tomorrow)?$`),
];

function describe(code, isDay = true) {
  const [, text, icon, hasNight] = CODES.find(([codes]) => codes.includes(code)) ?? [[], "Unknown", "weather-severe-alert"];
  return { text, icon: `${icon}${hasNight && !isDay ? "-night" : ""}-symbolic` };
}

/** { place: string|null, tomorrow: bool } for a weather question, else null. */
export function parseWeather(text) {
  const q = text.toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ").trim();
  for (const pattern of PATTERNS) {
    const m = q.match(pattern);
    if (m)
      return { place: m[1] ?? null, tomorrow: (m[2] ?? "").trim() === "tomorrow" };
  }
  return null;
}

function homeCity(settings) {
  const set = settings.get_string("weather-location").trim();
  if (set)
    return set;
  const zone = GLib.TimeZone.new_local().get_identifier(); // "Europe/Paris"
  const city = zone.includes("/") ? zone.split("/").pop() : "";
  return city.replace(/_/g, " ") || null;
}

export async function weather(ctx, question, cancellable) {
  const place = question.place ?? homeCity(ctx.settings);
  if (!place)
    return [];
  const geocode = async name => (await ctx.net.getJson(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name)}`,
    cancellable))?.results?.[0];
  let where = await geocode(place), fix = null;
  if (!where) {
    // Open-Meteo needs the exact name: correct a misspelt city ("ghaziabd" -> ghaziabad)
    const suggestion = await ctx.suggest(place, cancellable);
    where = suggestion ? await geocode(suggestion) : null;
    fix = where ? [place, suggestion] : null;
  }
  if (!where)
    return [];
  const fahrenheit = ctx.settings.get_string("temperature-unit") === "fahrenheit";
  const params = [
    `latitude=${where.latitude}`, `longitude=${where.longitude}`, "timezone=auto", "forecast_days=6",
    "current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    "daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    fahrenheit ? "temperature_unit=fahrenheit&wind_speed_unit=mph" : "",
  ].filter(Boolean).join("&");
  const data = await ctx.net.getJson(`https://api.open-meteo.com/v1/forecast?${params}`, cancellable);
  if (!data?.current)
    return [];

  const deg = t => `${Math.round(t)}°`;
  const wind = fahrenheit ? "mph" : "km/h";
  const { current, daily } = data;
  const name = [where.name, where.country].filter(Boolean).join(", ");
  const days = daily.time.map((date, i) => {
    const weekday = DAYS[new Date(`${date}T12:00:00`).getDay()];
    return {
      label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekday,
      short: i === 0 ? "Today" : weekday,
      high: daily.temperature_2m_max[i], low: daily.temperature_2m_min[i],
      rain: daily.precipitation_probability_max?.[i], ...describe(daily.weather_code[i]),
    };
  });

  let title, subtitle, icon;
  if (question.tomorrow && days[1]) {
    const d = days[1];
    title = `${deg(d.high)} / ${deg(d.low)}  ${d.text}`;
    subtitle = `${name} · Tomorrow${d.rain != null ? ` · ${d.rain}% chance of rain` : ""}`;
    icon = d.icon;
  } else {
    const now = describe(current.weather_code, current.is_day === 1);
    title = `${deg(current.temperature_2m)}  ${now.text}`;
    subtitle = `${name} · Feels like ${deg(current.apparent_temperature)} · Humidity ${current.relative_humidity_2m}% · Wind ${Math.round(current.wind_speed_10m)} ${wind}`;
    icon = now.icon;
  }
  const outlook = days.slice(0, 5).map(d => `${d.short} ${deg(d.high)}/${deg(d.low)}`).join("   ");
  const gicon = Gio.ThemedIcon.new(icon);
  return [{
    group: "Answer",
    answer: true,
    title,
    subtitle,
    icon: gicon,
    url: ctx.webSearch(`weather ${where.name}`),
    key: `weather:${name}`,
    fix,
    rich: { subtitle, text: outlook },
    preview: {
      title: `Weather in ${where.name}`,
      subtitle: [where.admin1, where.country].filter(Boolean).join(", "),
      icon: gicon,
      body: [
        { type: "heading", text: title },
        { type: "meta", text: subtitle },
        ...days.map(d => ({
          type: "columns",
          cells: [d.label, `${deg(d.high)} / ${deg(d.low)}`, d.text, d.rain != null ? `rain ${d.rain}%` : ""],
        })),
        { type: "meta", text: "Forecast by Open-Meteo.com" },
      ],
      action: "Open Forecast",
    },
  }];
}
