// Direct answers to questions, worked out from open data with no list of question
// patterns: "age of rihanna", "srk home", "who directed inception", "eiffel tower height".
//
//  1. What is it about? Every run of words in the query is tried as a Wikipedia
//     title, all in one request, so Wikipedia's redirects do the matching
//     ("srk" -> Shah Rukh Khan). The left-over words are the question.
//  2. Which fact? Wikidata's own property search maps the question words to
//     properties ("home" -> residence, "directed" -> director, "ceo" -> chief
//     executive officer); the subject's value for the first one it has is the answer.
//  3. Nothing structured? The sentence of the article that best matches the
//     question words (and the names Wikidata gave their properties) is the answer.
//
// The only fixed parts: English filler words, and age, which no source stores
// (it is today minus the date of birth).

import GLib from "gi://GLib";

const WIKIDATA = "https://www.wikidata.org/w/api.php";
// words that shape a question but never name its subject or the fact asked for
const FILLER = new Set(`a an the of in on at for to from by with about and or is are was were be been being
  am do does did has have had will would can could should what who whom whose which when where why how
  me my tell please give show find get know name named called much many there their its it this that`.split(/\s+/));
const AGE_WORDS = new Set(["age", "old", "aged"]); // computed from the date of birth (and death)
const DATE_OF_BIRTH = "P569", DATE_OF_DEATH = "P570", UNIT_SYMBOL = "P5061";
const MAX_SPAN = 4;

const isFiller = word => FILLER.has(word.toLowerCase());
const titleCase = text => text.replace(/(^|\s)(\p{L})/gu, (_m, s, c) => s + c.toUpperCase());
const stem = word => word.toLowerCase().replace(/(ing|ed|es|s)$/, "").slice(0, 6);

function query(params) {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// every run of up to MAX_SPAN words that doesn't start or end on a filler word
function spans(words) {
  const out = [];
  for (let len = Math.min(MAX_SPAN, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const run = words.slice(i, i + len);
      if (isFiller(run[0]) || isFiller(run[len - 1]))
        continue;
      out.push({ start: i, len, text: run.join(" ") });
    }
  }
  return out;
}

/** Which spans are Wikipedia articles: span text -> page (one request). */
async function resolveSpans(ctx, list, cancellable) {
  const asked = new Map(); // title variant -> span text
  for (const span of list) {
    const variants = [span.text, titleCase(span.text)];
    if (span.len === 1 && span.text.length <= 5)
      variants.push(span.text.toUpperCase()); // acronyms: srk -> SRK
    for (const v of variants)
      if (!asked.has(v) && asked.size < 50)
        asked.set(v, span.text);
  }
  if (!asked.size)
    return new Map();
  const url = `https://${ctx.wikipediaLanguage}.wikipedia.org/w/api.php?${query({
    action: "query", format: "json", formatversion: "2", redirects: "1",
    titles: [...asked.keys()].join("|"),
    prop: "pageprops|info|description|pageimages|extracts", ppprop: "wikibase_item|disambiguation",
    inprop: "url", exintro: "1", explaintext: "1", exlimit: "max", piprop: "thumbnail", pithumbsize: "800",
  })}`;
  const data = await ctx.net.getJson(url, cancellable);
  const q = data?.query ?? {};
  const follow = new Map([...(q.normalized ?? []), ...(q.redirects ?? [])].map(r => [r.from, r.to]));
  const pages = new Map((q.pages ?? []).filter(p => !p.missing && p.pageprops?.wikibase_item &&
    p.pageprops.disambiguation === undefined).map(p => [p.title, p]));
  const found = new Map();
  for (const [variant, text] of asked) {
    let title = variant;
    for (let hops = 0; follow.has(title) && hops < 3; hops++)
      title = follow.get(title);
    const page = pages.get(title);
    if (page && !found.has(text))
      found.set(text, page);
  }
  return found;
}

/** Wikidata properties whose label or alias matches `term`, best first. */
async function searchProperties(ctx, term, cancellable) {
  const data = await ctx.net.getJson(`${WIKIDATA}?${query({
    action: "wbsearchentities", format: "json", type: "property", limit: "7",
    language: ctx.wikipediaLanguage, uselang: ctx.wikipediaLanguage, search: term,
  })}`, cancellable);
  const low = term.toLowerCase();
  return (data?.search ?? []).map(p => {
    const text = (p.match?.text ?? "").toLowerCase();
    return {
      id: p.id, label: p.label ?? p.id, names: [p.label, p.match?.text, ...(p.aliases ?? [])].filter(Boolean),
      // an exact label or alias says far more than a prefix match ("france" -> "France ID")
      strength: text === low ? 1 : text.startsWith(`${low} `) ? 0.5 : 0.2,
    };
  });
}

function bestClaims(all) {
  const live = (all ?? []).filter(c => c.rank !== "deprecated" && c.mainsnak?.datavalue);
  const preferred = live.filter(c => c.rank === "preferred");
  if (preferred.length)
    return preferred;
  const current = live.filter(c => !c.qualifiers?.P582); // values that have ended: old capitals, ex-spouses
  const list = current.length ? current : live;
  // several dated values (population): the newest first
  const when = c => c.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? "";
  return list.some(c => when(c)) ? [...list].sort((a, b) => when(b).localeCompare(when(a))).slice(0, 1) : list;
}

async function claims(ctx, entity, property, cancellable) {
  const data = await ctx.net.getJson(`${WIKIDATA}?${query({
    action: "wbgetclaims", format: "json", entity, property,
  })}`, cancellable);
  return bestClaims(data?.claims?.[property]);
}

async function labels(ctx, ids, cancellable) {
  if (!ids.length)
    return {};
  const lang = ctx.wikipediaLanguage;
  const data = await ctx.net.getJson(`${WIKIDATA}?${query({
    action: "wbgetentities", format: "json", props: "labels", languages: `${lang}|en`, ids: ids.join("|"),
  })}`, cancellable);
  return Object.fromEntries(Object.entries(data?.entities ?? {}).map(([id, e]) =>
    [id, e.labels?.[lang]?.value ?? e.labels?.en?.value ?? id]));
}

function parseTime(value) {
  const m = value.time.match(/^([+-]\d+)-(\d\d)-(\d\d)/);
  return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]), precision: value.precision };
}

// in the desktop's own language and date style
function formatDate(t) {
  if (t.precision >= 11 && t.day)
    return GLib.DateTime.new_utc(t.year, t.month, t.day, 12, 0, 0).format("%-d %B %Y");
  if (t.precision === 10 && t.month)
    return GLib.DateTime.new_utc(t.year, t.month, 1, 12, 0, 0).format("%B %Y");
  return t.year < 0 ? `${-t.year} BCE` : `${t.year}`;
}

function yearsBetween(from, to) {
  let years = to.year - from.year;
  if (to.month < from.month || (to.month === from.month && to.day < from.day))
    years--;
  return years;
}

function formatNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12)
    return `${+(n / 1e12).toFixed(2)} trillion`;
  if (abs >= 1e9)
    return `${+(n / 1e9).toFixed(2)} billion`;
  if (abs >= 1e7)
    return `${+(n / 1e6).toFixed(1)} million`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const unitId = unit => unit?.match(/(Q\d+)$/)?.[1] ?? null;

/** Values of claims as text; units by their symbol from Wikidata ("metre" -> "m"). */
async function format(ctx, list, cancellable) {
  const raw = list.map(c => c.mainsnak.datavalue);
  const items = raw.filter(v => v.type === "wikibase-entityid").map(v => v.value.id);
  const units = [...new Set(raw.filter(v => v.type === "quantity").map(v => unitId(v.value.unit)).filter(Boolean))];
  const [names, symbols] = await Promise.all([
    labels(ctx, [...new Set([...items, ...units])], cancellable),
    Promise.all(units.map(u => claims(ctx, u, UNIT_SYMBOL, cancellable).then(c => [u, c[0]?.mainsnak.datavalue.value.text])))
      .then(Object.fromEntries),
  ]);
  return raw.map((v, i) => {
    if (v.type === "wikibase-entityid")
      return names[v.value.id] ?? v.value.id;
    if (v.type === "time")
      return formatDate(parseTime(v.value));
    if (v.type === "quantity") {
      const u = unitId(v.value.unit);
      const amount = formatNumber(parseFloat(v.value.amount));
      return u ? `${amount} ${symbols[u] ?? names[u]}` : amount;
    }
    if (v.type === "monolingualtext")
      return v.value.text;
    if (v.type === "globecoordinate")
      return `${v.value.latitude.toFixed(4)}, ${v.value.longitude.toFixed(4)}`;
    const year = list[i].qualifiers?.P585?.[0]?.datavalue?.value;
    return year ? `${v.value} (${parseTime(year).year})` : String(v.value);
  });
}

// The subject is the span that best splits the query into "about what" and "asking
// what": its own words count unless they exactly name a property ("india population"
// is India + population, not the article Demographics of India), and words left over
// count when they do. Ties go to the bigger article (India beats Independence).
function chooseSubject(words, resolved, strengthOf) {
  let best = null;
  for (const span of spans(words)) {
    const page = resolved.get(span.text);
    if (!page)
      continue;
    const own = words.slice(span.start, span.start + span.len).filter(w => !isFiller(w));
    const rest = words.filter((_w, i) => i < span.start || i >= span.start + span.len).filter(w => !isFiller(w));
    const score = own.reduce((sum, w) => sum + 2 * (1 - strengthOf(w)), 0) + rest.reduce((sum, w) => sum + strengthOf(w), 0);
    if (!best || score > best.score || (score === best.score && (page.length ?? 0) > (best.page.length ?? 0)))
      best = { span, page, rest, score };
  }
  return best;
}

async function searchSubject(ctx, text, words, cancellable) {
  const data = await ctx.net.getJson(`https://${ctx.wikipediaLanguage}.wikipedia.org/w/api.php?${query({
    action: "query", format: "json", formatversion: "2", list: "search", srlimit: "1", srsearch: text,
  })}`, cancellable);
  const title = data?.query?.search?.[0]?.title;
  if (!title)
    return null;
  const page = (await resolveSpans(ctx, [{ start: 0, len: 1, text: title }], cancellable)).get(title);
  if (!page)
    return null;
  const inTitle = new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  return { page, rest: words.filter(w => !isFiller(w) && !inTitle.has(w.toLowerCase())) };
}

// the best-matching sentence of the article, for questions Wikidata has no property for
async function bestSentence(ctx, page, terms, cancellable) {
  const data = await ctx.net.getJson(`https://${ctx.wikipediaLanguage}.wikipedia.org/w/api.php?${query({
    action: "query", format: "json", formatversion: "2", prop: "extracts", explaintext: "1", pageids: `${page.pageid}`,
  })}`, cancellable);
  const text = data?.query?.pages?.[0]?.extract ?? "";
  const stems = [...new Set(terms.flatMap(t => t.toLowerCase().split(/\W+/)).filter(w => w.length > 2 && !isFiller(w)).map(stem))];
  let best = null;
  text.split("\n").filter(line => line && !line.startsWith("=")).forEach((paragraph, p) => {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+(?=\p{Lu})/u)) {
      const own = new Set(sentence.toLowerCase().split(/\W+/).map(stem));
      const hits = stems.filter(s => own.has(s)).length;
      const score = hits - p * 0.01; // earlier paragraphs win ties
      if (hits && sentence.length < 400 && (!best || score > best.score))
        best = { sentence: sentence.trim(), score };
    }
  });
  return best?.sentence ?? null;
}

/** A Top Hit answering the question in `text`, or [] if there's no question or no answer;
 *  a misspelt question is retried with Wikipedia's spelling ("eifel tower hight"). */
export async function answer(ctx, text, cancellable) {
  const found = await answerFor(ctx, text, cancellable);
  if (found.topic || (found.length && !found[0].rich?.sentence))
    return found;
  const suggestion = await ctx.suggest(text, cancellable);
  if (!suggestion)
    return found;
  const corrected = await answerFor(ctx, suggestion, cancellable);
  if (corrected.topic)
    return corrected; // "taj mahl": a topic once spelt right
  return corrected.length ? corrected.map(r => ({ ...r, fix: [text, suggestion] })) : found;
}

async function answerFor(ctx, text, cancellable) {
  const words = text.replace(/[?!.,]+/g, " ").replace(/['’]s\b/g, "").split(/\s+/).filter(Boolean);
  if (words.length < 2)
    return [];
  const content = [...new Set(words.filter(w => !isFiller(w)).map(w => w.toLowerCase()))].slice(0, 6);
  // what each word might ask for: the word, its stem ("directed" -> direct -> director)
  // and the word with a following "by"/"of"... ("built by", "founded by")
  const lookups = content.map(w => {
    const i = words.findIndex(x => x.toLowerCase() === w);
    const next = words[i + 1]?.toLowerCase();
    const stemmed = w.replace(/(ed|ing)$/, "");
    return [w, ...(stemmed.length >= 4 && stemmed !== w ? [stemmed] : []), ...(next && isFiller(next) ? [`${w} ${next}`] : [])];
  });
  // which words are Wikipedia articles, and which name Wikidata properties: all at once
  const [resolved, ...propertyLists] = await Promise.all([
    resolveSpans(ctx, spans(words), cancellable),
    ...lookups.map(terms => AGE_WORDS.has(terms[0]) ? Promise.resolve([])
      : Promise.all(terms.map(t => searchProperties(ctx, t, cancellable)))
        .then(lists => lists.reverse().flat())), // phrase matches first, then the word, then its stem
  ]);
  const properties = new Map(content.map((w, i) => [w, propertyLists[i]]));
  const strengthOf = w => AGE_WORDS.has(w.toLowerCase()) ? 1
    : (properties.get(w.toLowerCase()) ?? []).some(p => p.strength === 1) ? 1 : 0;
  let subject = chooseSubject(words, resolved, strengthOf);
  // "tesla founder", "python creator": the name alone is ambiguous, so let Wikipedia's
  // search pick the article the whole query is most likely about
  if (!subject)
    subject = await searchSubject(ctx, text, words, cancellable);
  if (subject && !subject.rest.length)
    return Object.assign([], { topic: true }); // nothing asked about it: "taj mahal" is a topic
  if (!subject)
    return [];
  const { page, rest } = subject;
  const entity = page.pageprops.wikibase_item;
  const asked = rest.map(w => w.toLowerCase());

  let title = null, details = null;
  if (asked.some(w => AGE_WORDS.has(w))) {
    const [[born], [died], place] = await Promise.all([
      claims(ctx, entity, DATE_OF_BIRTH, cancellable),
      claims(ctx, entity, DATE_OF_DEATH, cancellable),
      claims(ctx, entity, "P19", cancellable).then(c => format(ctx, c.slice(0, 1), cancellable)),
    ]);
    if (born) {
      const b = parseTime(born.mainsnak.datavalue.value);
      const now = GLib.DateTime.new_now_local();
      if (died) {
        const d = parseTime(died.mainsnak.datavalue.value);
        title = `Died at ${yearsBetween(b, d)}`;
        details = `${formatDate(b)} – ${formatDate(d)}`;
      } else {
        title = `${yearsBetween(b, { year: now.get_year(), month: now.get_month(), day: now.get_day_of_month() })} years old`;
        details = `Born ${formatDate(b)}${place[0] ? ` in ${place[0]}` : ""}`;
      }
    }
  }

  // the properties the question words name, strongest matches first; the first one
  // the subject actually has a value for is the answer
  const candidates = asked.flatMap(w => properties.get(w) ?? [])
    .sort((a, b) => b.strength - a.strength)
    .filter((p, i, all) => all.findIndex(q => q.id === p.id) === i)
    .slice(0, 6);
  if (!title && candidates.length) {
    const found = await Promise.all(candidates.map(p => claims(ctx, entity, p.id, cancellable)));
    const hit = found.findIndex(list => list.length);
    if (hit >= 0) {
      const values = await format(ctx, found[hit].slice(0, 6), cancellable);
      title = values.length > 3 ? `${values.slice(0, 3).join(", ")} and ${values.length - 3} more` : values.join(", ");
      details = candidates[hit].label[0].toUpperCase() + candidates[hit].label.slice(1);
    }
  }

  let sentence = null;
  if (!title) {
    sentence = await bestSentence(ctx, page, [...asked, ...candidates.flatMap(p => p.names)], cancellable);
    if (!sentence)
      return [];
  }

  const extract = (page.extract ?? "").trim();
  const subtitle = title ? `${page.title} · ${details}` : `${page.title} · from Wikipedia`;
  let snippet = "";
  for (const s of extract.split("\n")[0].split(/(?<=[.!?])\s/)) {
    if (snippet && snippet.length + s.length > 260)
      break;
    snippet = snippet ? `${snippet} ${s}` : s;
  }
  return [{
    group: "Answer",
    answer: true,
    title: title ?? sentence,
    subtitle,
    icon: ctx.icons.wikipedia,
    thumb: page.thumbnail?.source ?? null,
    url: page.fullurl,
    key: `answer:${entity}:${asked.join(" ")}`,
    rich: title ? { subtitle, text: snippet } : { subtitle, text: "", sentence: true },
    preview: {
      title: page.title,
      subtitle: page.description ?? "",
      icon: ctx.icons.wikipedia,
      image: page.thumbnail?.source ?? null,
      body: [
        { type: "heading", text: title ? `${title}  ·  ${details}` : sentence },
        ...extract.split("\n").filter(p => p.trim()).map(t => ({ type: "paragraph", text: t })),
      ],
      action: "Open in Wikipedia",
    },
  }];
}
