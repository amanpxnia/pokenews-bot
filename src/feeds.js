// Fetches RSS/Atom feeds and normalizes items into a common shape.
const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const FEEDS_FILE = path.join(__dirname, '..', 'feeds.json');

const HEADERS = {
  // Reddit and some WordPress hosts reject requests without a real User-Agent.
  'User-Agent': 'Mozilla/5.0 (compatible; PokeNewsBot/1.0; +https://discord.com)',
  Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
};
const TIMEOUT_MS = 20000;
const RETRIES = 2; // extra attempts after a 429 / 5xx

const parser = new Parser({
  customFields: {
    item: [
      ['media:group', 'mediaGroup'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:content', 'mediaContent'],
      ['yt:videoId', 'ytVideoId'],
      ['source', 'source'], // Google News: the publisher's name
    ],
  },
});

function loadFeeds() {
  const feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  return feeds.filter((f) => f.enabled !== false);
}

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function attr(node, key) {
  // rss-parser exposes XML attributes under `$`
  if (!node) return undefined;
  const n = Array.isArray(node) ? node[0] : node;
  return n && n.$ ? n.$[key] : undefined;
}

/** Full-size Reddit image (i.redd.it) linked from a Reddit RSS post body, if any. */
function redditImage(html) {
  if (!html) return undefined;
  const m = html.match(/https:\/\/i\.redd\.it\/[^"'&\s<]+\.(?:jpe?g|png|gif|webp)/i);
  return m ? m[0] : undefined;
}

function findImage(item) {
  if (item.ytVideoId) return `https://i.ytimg.com/vi/${item.ytVideoId}/hqdefault.jpg`;
  const full = redditImage(item.content);
  if (full) return full; // better than Reddit's tiny thumbnail

  const group = item.mediaGroup;
  const groupThumb = group && group['media:thumbnail'];
  return (
    attr(groupThumb, 'url') ||
    attr(item.mediaThumbnail, 'url') ||
    attr(item.mediaContent, 'url') ||
    (item.enclosure && /^image\//.test(item.enclosure.type || 'image/') ? item.enclosure.url : undefined) ||
    firstImgSrc(item['content:encoded']) ||
    firstImgSrc(item.content)
  );
}

function firstImgSrc(html) {
  if (!html) return undefined;
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!m) return undefined;
  const src = m[1].replace(/&amp;/g, '&');
  // Skip tracking pixels / emoji
  if (/feedburner|pixel|emoji|gravatar/i.test(src)) return undefined;
  return src.startsWith('http') ? src : undefined;
}

function sourceName(item) {
  const src = item.source;
  if (!src) return undefined;
  return typeof src === 'string' ? src : src._;
}

function sourceUrl(item) {
  const src = item.source;
  return src && src.$ ? src.$.url : undefined;
}

/** True if the item's publisher matches one of the feed's "excludeSources" (name or domain). */
function isExcluded(feed, item) {
  const blocked = (feed.excludeSources || []).map((s) => s.toLowerCase());
  if (!blocked.length) return false;
  const name = (sourceName(item) || '').toLowerCase();
  const url = (sourceUrl(item) || '').toLowerCase();
  return blocked.some((b) => url.includes(b) || name.includes(b.replace(/\.(com|be)$/, '')));
}

/** True if the feed has "titleMustInclude" and the title contains none of those words. */
function isOffTopic(feed, title) {
  const words = feed.titleMustInclude;
  if (!words || !words.length) return false;
  const t = title.toLowerCase();
  return !words.some((w) => t.includes(w.toLowerCase()));
}

function summaryOf(item, title) {
  const group = item.mediaGroup;
  const ytDesc = group && group['media:description'] && group['media:description'][0];
  const raw = item.contentSnippet || ytDesc || stripHtml(item['content:encoded'] || item.content || item.summary || '');
  let text = stripHtml(typeof raw === 'string' ? raw : String(raw || ''));
  // Reddit's RSS body is mostly "submitted by /u/x [link] [comments]" boilerplate
  text = text.replace(/submitted by\s+\/u\/\S+.*$/i, '').trim();
  // Forum feeds (PokéBeach) end with "Click to expand... Continue reading..."
  text = text.replace(/\s*(Click to expand\.*|Continue reading\.*|Read more\.*)\s*/gi, ' ').trim();
  // No links in posts
  text = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  // Google News "summaries" just repeat the headline and publisher
  if (title && text.toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) return '';
  return truncate(text, 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= RETRIES) throw new Error(`Status code ${res.status}`);
    // Respect Retry-After if given (capped), otherwise back off 5s, 10s…
    const after = Number(res.headers.get('retry-after'));
    await sleep(Math.min(after > 0 ? after * 1000 : 5000 * (attempt + 1), 30000));
  }
}

/** Fetch one feed and return normalized items, newest first. */
async function fetchFeed(feed) {
  const parsed = await parser.parseString(await download(feed.url));
  const items = (parsed.items || []).filter((item) => !isExcluded(feed, item)).map((item) => {
    const link = item.link || (item.links && item.links[0] && item.links[0].href) || '';
    const publisher = sourceName(item);
    let title = stripHtml(item.title || 'Untitled');
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    return {
      id: item.guid || item.id || link || item.title,
      title: truncate(title, 256),
      link,
      summary: summaryOf(item, title),
      image: findImage(item),
      publisher,
      author: item.creator || item.author || undefined,
      date: item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : null,
    };
  });
  const relevant = items.filter((i) => !isOffTopic(feed, i.title));
  relevant.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  return relevant;
}

module.exports = { loadFeeds, fetchFeed, stripHtml, truncate };
