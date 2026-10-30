// Definitions and Wikipedia. Each function returns result objects (see
// search.js for the shape) or [] when it has nothing.

const DISAMBIGUATION = "Topics referred to by the same term";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function stripHtml(fragment) {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      if (code[0] !== "#")
        return ENTITIES[code.toLowerCase()] ?? whole;
      return String.fromCodePoint(code[1].toLowerCase() === "x"
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
    })
    .trim();
}

function normalize(text) {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const query = params => Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

/** Wikipedia's "Did you mean" for `text` (good for names and places), or null. */
export async function spellingSuggestion(net, lang, text, cancellable) {
  const data = await net.getJson(`https://${lang}.wikipedia.org/w/api.php?${query({
    action: "query", format: "json", formatversion: "2", list: "search", srlimit: "1",
    srinfo: "suggestion", srprop: "", srsearch: text,
  })}`, cancellable);
  const suggestion = data?.query?.searchinfo?.suggestion;
  return suggestion && normalize(suggestion) !== normalize(text) ? suggestion : null;
}

// Wiktionary's fuzzy title match: the closest real word to a misspelt one ("serendipty")
async function closestWord(net, word, cancellable) {
  const data = await net.getJson(`https://en.wiktionary.org/w/api.php?${query({
    action: "opensearch", format: "json", limit: "5", profile: "fuzzy", namespace: "0", search: word,
  })}`, cancellable);
  return (data?.[1] ?? []).find(w => !/\s/.test(w) && w.toLowerCase() !== word.toLowerCase()) ?? null;
}

async function fromDictionaryApi(net, word, cancellable) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const entries = await net.getJson(url, cancellable, { quick: true }) ?? [];
  const meanings = [];
  let phonetic = "";
  for (const entry of entries) {
    phonetic ||= entry.phonetic ?? "";
    for (const meaning of entry.meanings ?? []) {
      for (const d of meaning.definitions ?? [])
        meanings.push({ pos: meaning.partOfSpeech ?? "", text: d.definition, example: d.example });
    }
  }
  return { meanings, phonetic };
}

// Knows far more words than dictionaryapi.dev (which has no "run"), but returns HTML.
async function fromWiktionary(net, word, cancellable) {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
  const data = await net.getJson(url, cancellable) ?? {};
  const meanings = [];
  for (const entry of data.en ?? []) {
    const pos = (entry.partOfSpeech ?? "").toLowerCase();
    if (pos === "symbol") // ISO language codes and the like
      continue;
    for (const d of entry.definitions ?? []) {
      // nested senses come as extra lines; the first is the sense itself
      const text = stripHtml(d.definition ?? "").split("\n")[0].trim();
      if (text) {
        const example = d.examples?.length ? stripHtml(d.examples[0]) : null;
        meanings.push({ pos, text, example });
      }
    }
  }
  return meanings;
}

export async function dictionary(ctx, word, cancellable) {
  const found = await define(ctx, word, cancellable);
  if (found.length)
    return found;
  // not a word: try the closest one ("serendipty" -> serendipity)
  const closest = await closestWord(ctx.net, word, cancellable);
  if (!closest)
    return [];
  return (await define(ctx, closest, cancellable)).map(r => ({ ...r, fix: [word, closest] }));
}

async function define(ctx, word, cancellable) {
  let meanings = [], phonetic = "", source = "dictionaryapi";
  try {
    ({ meanings, phonetic } = await fromDictionaryApi(ctx.net, word, cancellable));
  } catch (e) {
    if (cancellable.is_cancelled())
      throw e;
    // it times out or 502s now and then; Wiktionary covers it
  }
  if (!meanings.length) {
    source = "wiktionary";
    meanings = await fromWiktionary(ctx.net, word, cancellable);
  }
  if (!meanings.length && word !== word.toLowerCase())
    meanings = await fromWiktionary(ctx.net, word.toLowerCase(), cancellable);
  if (!meanings.length)
    return [];

  const body = [];
  let lastPos = null, n = 0;
  for (const m of meanings.slice(0, 30)) {
    if (m.pos !== lastPos) {
      body.push({ type: "heading", text: m.pos });
      lastPos = m.pos;
      n = 0;
    }
    body.push({ type: "definition", n: ++n, text: m.text, example: m.example });
  }
  const title = word[0].toUpperCase() + word.slice(1);
  const first = meanings[0];
  return [{
    group: "Definition",
    title,
    subtitle: `${first.pos} · ${first.text}`,
    icon: ctx.icons.dictionary,
    url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word.toLowerCase())}`,
    key: `def:${word.toLowerCase()}`,
    // dictionaryapi.dev only has everyday English words, so its answer is a strong one
    source,
    rich: {
      subtitle: [phonetic, first.pos].filter(Boolean).join("  ·  "),
      text: meanings.slice(0, 2).map((m, i) => `${i + 1}. ${m.text}`).join("\n"),
    },
    preview: {
      title,
      subtitle: [phonetic, first.pos].filter(Boolean).join(" · "),
      icon: ctx.icons.dictionary,
      body,
      action: "Open in Wiktionary",
    },
  }];
}

export async function wikipedia(ctx, term, cancellable) {
  const found = await articles(ctx, term, cancellable);
  if (found.some(r => r.goodMatch))
    return found;
  // nothing clearly matches what was typed: try Wikipedia's own spelling ("taj mahl")
  const suggestion = await ctx.suggest(term, cancellable);
  if (!suggestion)
    return found;
  // when the typed text matched nothing well, the corrected search is the better guess
  // even without an exact title ("eifel tower hight" -> Eiffel Tower, not Ford Motor Company)
  const corrected = await articles(ctx, suggestion, cancellable);
  return corrected.length ? corrected.map(r => ({ ...r, fix: [term, suggestion] })) : found;
}

async function articles(ctx, term, cancellable) {
  const lang = ctx.wikipediaLanguage;
  const params = Object.entries({
    action: "query", format: "json", formatversion: "2", redirects: "1",
    generator: "search", gsrsearch: term, gsrlimit: "3", gsrnamespace: "0",
    prop: "extracts|pageimages|description|info", inprop: "url",
    exintro: "1", explaintext: "1", exlimit: "3", piprop: "thumbnail", pithumbsize: "800",
  }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); // GJS has no URLSearchParams
  const data = await ctx.net.getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, cancellable) ?? {};
  const pages = (data.query?.pages ?? []).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  const words = term.toLowerCase().split(/\s+/);
  const asked = normalize(term);
  const redirectedFrom = new Map((data.query?.redirects ?? []).map(r => [r.to, normalize(r.from)]));
  const results = [];
  for (const page of pages) {
    const extract = (page.extract ?? "").trim();
    const description = page.description ?? "";
    if (!extract || description === DISAMBIGUATION)
      continue;
    // beyond the first hit, only keep pages whose title has every word typed
    if (results.length && !words.every(w => page.title.toLowerCase().includes(w)))
      continue;
    const sentences = extract.split(/(?<=[.!?])\s/);
    const firstSentence = sentences[0];
    const thumb = page.thumbnail?.source ?? null;
    const title = normalize(page.title);
    // the first hit counts as the answer when its title is what was typed: "taj mahal" ->
    // Taj Mahal, "einstein" -> Albert Einstein, or a redirect from exactly the query
    const goodMatch = results.length === 0 && (title === asked ||
      normalize(page.title.replace(/\s*\(.*\)$/, "")) === asked ||
      asked.split(" ").every(w => title.split(" ").includes(w)) ||
      redirectedFrom.get(page.title) === asked);
    let snippet = "";
    for (const s of sentences) {
      if (snippet && snippet.length + s.length > 260)
        break;
      snippet = snippet ? `${snippet} ${s}` : s;
    }
    results.push({
      group: "Wikipedia",
      title: page.title,
      subtitle: description || firstSentence,
      icon: ctx.icons.wikipedia,
      thumb,
      url: page.fullurl,
      key: `wiki:${page.title}`,
      goodMatch,
      rich: { subtitle: description, text: snippet.length > 300 ? `${snippet.slice(0, 297)}…` : snippet },
      preview: {
        title: page.title,
        subtitle: description,
        icon: ctx.icons.wikipedia,
        image: thumb,
        body: extract.split("\n").filter(p => p.trim()).map(text => ({ type: "paragraph", text })),
        action: "Open in Wikipedia",
      },
    });
    if (results.length === 2)
      break;
  }
  return results;
}
