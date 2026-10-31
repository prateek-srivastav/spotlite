// Answers from Wolfram|Alpha, for questions Wikipedia and Wikidata can't answer:
// "10 usd in inr", "distance from delhi to mumbai", "who wrote harry potter".
// Optional: it only runs with the user's own AppID (free from developer.wolframalpha.com).
// The result list uses the Short Answers API (one line, one call); the Quick Look
// card fetches the Full Results API only when it is opened, to spare the quota.

import Gio from "gi://Gio";

const SHORT = "https://api.wolframalpha.com/v1/result";
const FULL = "https://api.wolframalpha.com/v2/query";
const NO_ANSWER = [501, 400]; // Wolfram|Alpha understood nothing it could answer briefly
const BAD_APPID = [401, 403];

const enc = encodeURIComponent;

// the two APIs spell it differently: Short Answers "imperial", Full Results "nonmetric"
function units(ctx, api) {
  if (ctx.settings.get_string("temperature-unit") !== "fahrenheit")
    return "metric";
  return api === FULL ? "nonmetric" : "imperial";
}

async function details(ctx, appid, text, short) {
  const fallback = { title: short, subtitle: "Wolfram|Alpha", body: [{ type: "meta", text: `“${text}”` }], action: "Open in Wolfram|Alpha" };
  let data;
  try {
    data = await ctx.net.getJson(`${FULL}?appid=${enc(appid)}&input=${enc(text)}&output=json&format=plaintext&units=${units(ctx, FULL)}`, null);
  } catch {
    return fallback;
  }
  const pods = data?.queryresult?.pods ?? [];
  if (!pods.length)
    return fallback;
  const input = pods.find(p => p.id === "Input")?.subpods?.[0]?.plaintext;
  const body = [{ type: "heading", text: short }];
  for (const pod of pods) {
    if (pod.id === "Input")
      continue;
    const lines = (pod.subpods ?? []).map(sp => sp.plaintext).filter(Boolean);
    if (!lines.length)
      continue;
    body.push({ type: "meta", text: pod.title });
    // Wolfram|Alpha writes tables as "a | b" rows; keep them aligned
    for (const line of lines)
      body.push(line.includes(" | ") ? { type: "mono", text: line } : { type: "paragraph", text: line });
  }
  // text only: Wolfram|Alpha's images are mostly rendered charts and maps (GIFs) that
  // St can't show, which left an empty picture frame at the top of the card
  return { title: input ?? text, subtitle: "Wolfram|Alpha", body, action: "Open in Wolfram|Alpha" };
}

/** A Top Hit with Wolfram|Alpha's short answer to `text`, or [] without an AppID or an answer. */
export async function wolfram(ctx, text, cancellable) {
  const appid = ctx.settings.get_string("wolfram-appid").trim();
  if (!appid)
    return [];
  let short;
  try {
    short = await ctx.net.getText(`${SHORT}?appid=${enc(appid)}&units=${units(ctx, SHORT)}&i=${enc(text)}`, cancellable);
  } catch (e) {
    if (cancellable?.is_cancelled())
      throw e;
    if (BAD_APPID.includes(e.status))
      ctx.warnOnce("Spotlite: Wolfram|Alpha rejected the AppID set in the preferences");
    else if (!NO_ANSWER.includes(e.status))
      console.warn(`Spotlite: Wolfram|Alpha: ${e.message}`);
    return [];
  }
  // "rupee952.69  (Indian rupees)": a unit word glued to the number, doubled spaces
  short = short?.trim().replace(/^(\p{Ll}+)(\d)/u, "$1 $2").replace(/\s{2,}/g, " ");
  if (!short)
    return [];
  const icon = Gio.ThemedIcon.new("dialog-information-symbolic");
  const subtitle = `Wolfram|Alpha · “${text}”`;
  return [{
    group: "Answer",
    answer: true,
    title: short,
    subtitle,
    icon,
    url: `https://www.wolframalpha.com/input?i=${enc(text)}`,
    key: `wolfram:${text.toLowerCase()}`,
    rich: { subtitle, text: "", sentence: short.length > 48 },
    preview: async () => ({ icon, ...(await details(ctx, appid, text, short)) }),
  }];
}
