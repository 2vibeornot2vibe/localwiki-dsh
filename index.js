/**
 * localwiki-dsh: search and read local Kiwix wiki collections as plain text.
 * Registers `wiki_books`, `wiki_search`, `wiki_read`, and `wiki_image`.
 * @module @local/localwiki-dsh
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { mergeResults, parseArticle, parseCatalog, parseSearchResults, parseSuggestions, svgToText } from './localwiki.js'

export const name = 'localwiki-dsh'
export const inject = ['tools', 'attachments']

/** Deployment limits; none of them are model arguments. */
export const Config = z.object({
  kiwixBaseUrl: z.string().default('http://127.0.0.1:8080'),
  searchLimit: z.number().default(10),
  maxChars: z.number().default(8000),
  maxImageList: z.number().default(8),
  maxLinks: z.number().default(20),
  maxImageBytes: z.number().default(8 * 1024 * 1024),
  maxSvgBytes: z.number().default(400000),
  requestTimeoutMs: z.number().default(20000),
})

/** Article parses kept in memory so section reads do not refetch the page. */
const ARTICLE_CACHE_SIZE = 20

/**
 * Encode an article path for the Kiwix content endpoint while preserving
 * subpage slashes. MediaWiki titles use underscores, so whitespace is rewritten
 * rather than percent-encoded: Kiwix serves `Artemis_II` and 404s on
 * `Artemis%20II`.
 * @param path - article path as returned by search or a link.
 * @returns a URL-safe path segment sequence.
 */
function encodePath(path) {
  return String(path).replace(/\s+/g, '_').split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

/** Reject values that could escape the configured Kiwix host. */
function assertSafeBook(book) {
  if (typeof book !== 'string' || book.trim() === '' || book.includes('/') || book.includes('?')) {
    throw new Error('book must be a single ZIM name from wiki_books or wiki_search')
  }
  return book
}

function assertSafePath(path) {
  const clean = String(path).trim().replace(/^\/+/, '')
  if (clean === '') throw new Error('path must be a non-empty article path')
  if (/^https?:/i.test(clean)) throw new Error('path must be an article path, not a URL')
  return clean
}

/**
 * Find a meta-refresh redirect target, which Kiwix uses for soft redirects
 * that are not HTTP 302s.
 * @param html - the page HTML.
 * @param url - the page URL, used to resolve a relative target.
 * @returns the absolute target URL, or null when the page is not a redirect.
 */
function redirectTarget(html, url) {
  const meta = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*>/i)
  if (!meta) return null
  const target = (meta[0].match(/content=["']\s*0;\s*URL=['"]?([^'">]+)['"]?/i) ?? [])[1]
  if (!target) return null
  try { return new URL(target, url).href } catch { return null }
}

export function apply(ctx, config) {
  const base = config.kiwixBaseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error(`localwiki-dsh: kiwixBaseUrl must be an http(s) URL, got ${config.kiwixBaseUrl}`)

  const articles = new Map()
  let books = null
  let booksFetchedAt = 0
  const BOOKS_TTL_MS = 5 * 60 * 1000

  async function getText(url, signal) {
    const response = await fetch(url, { signal })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const title = (body.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1]?.trim()
      const summary = title || body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      throw new Error(`Kiwix returned HTTP ${response.status} for ${url}${summary ? `: ${summary}` : ''}`)
    }
    return response
  }

  async function getBooks(signal) {
    if (books && Date.now() - booksFetchedAt < BOOKS_TTL_MS) return books
    const text = await (await getText(`${base}/catalog/v2/entries?count=-1`, signal)).text()
    books = parseCatalog(text)
    booksFetchedAt = Date.now()
    return books
  }

  /**
   * Fetch and parse one article, following both HTTP and meta-refresh
   * redirects, and cache the result.
   */
  async function getArticle(book, path, signal) {
    // Cache on the encoded form so "Artemis II" and "Artemis_II" share one entry.
    const key = `${book}|${encodePath(path)}`
    const cached = articles.get(key)
    if (cached) return cached

    let url = `${base}/content/${encodeURIComponent(book)}/${encodePath(path)}`
    let html = await (await getText(url, signal)).text()
    let redirectedFrom = ''
    for (let hop = 0; hop < 3; hop += 1) {
      const target = redirectTarget(html, url)
      if (target === null || target === url) break
      redirectedFrom = url
      url = target
      html = await (await getText(url, signal)).text()
    }

    const article = parseArticle(html, url)
    if (redirectedFrom !== '') article.redirectFrom = redirectedFrom
    if (articles.size >= ARTICLE_CACHE_SIZE) articles.delete(articles.keys().next().value)
    articles.set(key, article)
    return article
  }

  /** Compact image list for the model, capped by configuration. */
  function imageList(article, indexes) {
    return indexes.slice(0, config.maxImageList).map((index) => ({
      index,
      alt: article.images[index - 1].alt,
      kind: article.images[index - 1].mediaType ? 'raster' : 'vector',
    }))
  }

  /** Compact link list for the model, capped by configuration. */
  function linkList(links) {
    return links.slice(0, config.maxLinks).map((link) => ({ title: link.title, path: link.path, kind: link.kind }))
  }

  ctx.tools.register(defineTool({
    name: 'wiki_books',
    description: 'List the wiki collections available on the local Kiwix server, with the `book` names used by the other tools.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          books: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, title: { type: 'string' }, language: { type: 'string' }, articles: { type: 'integer' } }, additionalProperties: false } },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.books.length === 0
          ? 'No collections are loaded on the Kiwix server.'
          : value.books.map((book) => `- ${book.name} — ${book.title} (${book.language}, ${book.articles} articles)`).join('\n'),
      }],
    },
    presentationMeta: (_args, value) => ({ count: value.books.length }),
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return { books: await getBooks(exec.signal) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Search the local wiki. Title matches are ranked before full-text matches. Returns `book` and `path` for wiki_read.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search terms.' },
      book: { type: 'string', description: 'ZIM name from wiki_books. Omit to search every book.' },
      limit: { type: 'integer', description: `Maximum results (default ${config.searchLimit}).` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: { book: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' }, match: { type: 'string' }, snippet: { type: 'string' } },
              additionalProperties: false,
            },
          },
          hint: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          ...value.results.map((result, index) => `${index + 1}. ${result.title} [${result.match}] — book: ${result.book}, path: ${result.path}${result.snippet ? `\n   ${result.snippet}` : ''}`),
          value.hint ? value.hint : '',
        ].filter(Boolean).join('\n'),
      }],
    },
    presentationMeta: (_args, value) => ({ query: value.query, count: value.results.length }),
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Titles use spaces; article paths use underscores. Normalising the query
      // makes a pasted path such as "Rust_(programming_language)" searchable.
      const query = args.query.trim().replace(/_/g, ' ').replace(/\s+/g, ' ')
      const limit = Math.max(1, Math.min(args.limit ?? config.searchLimit, 25))
      const allBooks = await getBooks(exec.signal)
      const books = args.book ? [assertSafeBook(args.book)] : allBooks.map((book) => book.name)
      const perBook = Math.max(1, Math.ceil(limit / books.length))

      // Full-text search across two books in different languages is refused by
      // Kiwix, so each book is searched in parallel and the results merged.
      const settled = await Promise.all(books.map(async (book) => {
        let failure = ''
        const suggestions = await fetch(`${base}/suggest?content=${encodeURIComponent(book)}&term=${encodeURIComponent(query)}&count=${perBook}`, { signal: exec.signal })
          .then((response) => response.text())
          .then((text) => { try { return JSON.parse(text) } catch { return [] } })
          .catch((error) => { failure = error.message; return [] })
        const xml = await getText(`${base}/search?pattern=${encodeURIComponent(query)}&books.name=${encodeURIComponent(book)}&format=xml&pageLength=${perBook}`, exec.signal)
          .then((response) => response.text())
          .catch((error) => { failure = error.message; return '' })
        return { book, failure, titleMatches: parseSuggestions(suggestions, book), textMatches: parseSearchResults(xml, book) }
      }))

      const titleMatches = settled.flatMap((entry) => entry.titleMatches)
      const textMatches = settled.flatMap((entry) => entry.textMatches)
      const results = mergeResults(query, titleMatches, textMatches, limit)
      const emptyBooks = settled.filter((entry) => entry.titleMatches.length === 0 && entry.textMatches.length === 0)

      let hint = ''
      if (results.length === 0) {
        if (args.book && emptyBooks.length === 1 && emptyBooks[0].failure) {
          throw new Error(`Cannot search "${args.book}": ${emptyBooks[0].failure}`)
        }
        hint = args.book
          ? `No matches in ${args.book}. Try a shorter query, or call wiki_books to see the other collections.`
          : 'No matches in any collection. Try a shorter or different query.'
      } else if (!args.book && emptyBooks.length > 0) {
        hint = `Collections with no matches: ${emptyBooks.map((entry) => entry.book).join(', ')}.`
      }

      return { query, results, hint }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_read',
    description: 'Read a wiki article as plain text. Without `section` it returns the introduction and the list of sections; with `section` it returns that section only. Use `offset` to continue a truncated section.',
    parameters: {
      book: { type: 'string', required: true, description: 'ZIM name from wiki_search results.' },
      path: { type: 'string', required: true, description: 'Article path from wiki_search results, or a link target from wiki_read. A trailing "#Heading" selects that section.' },
      section: { type: 'string', description: 'Section heading to read, e.g. "History". Use "references" for the citation list.' },
      offset: { type: 'integer', description: 'Character offset into the section; use nextOffset from a previous call.' },
      limit: { type: 'integer', description: `Maximum characters to return (default ${config.maxChars}).` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          section: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          nextOffset: { type: 'integer' },
          outline: { type: 'array', items: { type: 'object', properties: { section: { type: 'string' }, chars: { type: 'integer' } }, additionalProperties: false } },
          images: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, alt: { type: 'string' }, kind: { type: 'string' } }, additionalProperties: false } },
          imageCount: { type: 'integer' },
          links: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, path: { type: 'string' }, kind: { type: 'string' } }, additionalProperties: false } },
          referenceCount: { type: 'integer' },
          redirectFrom: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderArticle(value) }],
    },
    presentationMeta: (_args, value) => ({ title: value.title, book: value.book, path: value.path, section: value.section, truncated: value.truncated }),
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const book = assertSafeBook(args.book)
      const rawPath = assertSafePath(args.path)
      // A path carrying an anchor ("Systemd#Basic_systemctl_usage") names a
      // section as well as the article.
      const [cleanPath, fragment] = rawPath.split('#')
      const article = await getArticle(book, cleanPath, exec.signal)

      let body = article.lead
      let imageIndexes = article.leadImageIndexes
      let links = article.leadLinks
      let outline = article.sections.map((section) => ({ section: section.heading, chars: section.text.length }))
      let resolvedSection = ''
      const wanted = args.section ?? fragment ?? ''

      if (wanted) {
        if (/^(references|citations|notes)$/i.test(wanted.trim())) {
          resolvedSection = 'References'
          body = article.references.map((reference, index) => `${index + 1}. ${reference}`).join('\n')
          imageIndexes = []
          links = []
          outline = []
        } else {
          const needle = wanted.trim().toLowerCase().replace(/_/g, ' ')
          const section = article.sections.find((candidate) => candidate.heading.toLowerCase() === needle)
            ?? article.sections
              .filter((candidate) => candidate.heading.toLowerCase().includes(needle))
              .sort((left, right) => left.heading.length - right.heading.length)[0]
          if (!section) {
            return {
              book, path: cleanPath, title: article.title, section: '', text: '', truncated: false, nextOffset: 0,
              outline, images: [], imageCount: 0, links: [], referenceCount: article.references.length,
              ...(article.redirectFrom ? { redirectFrom: article.redirectFrom } : {}),
              error: `No section matching "${wanted}". Available: ${article.sections.map((candidate) => candidate.heading).join(', ') || 'none'}`,
            }
          }
          resolvedSection = section.heading
          body = section.text
          imageIndexes = section.imageIndexes
          links = section.links
          outline = section.children.map((child) => ({ section: child.heading, chars: child.chars }))
        }
      }

      const limit = Math.max(200, Math.min(args.limit ?? config.maxChars, 40000))
      const offset = Math.max(0, args.offset ?? 0)
      const images = imageList(article, imageIndexes)
      const followed = linkList(links)

      if (offset >= body.length) {
        return {
          book, path: cleanPath, title: article.title, section: resolvedSection, text: '', truncated: false, nextOffset: 0,
          outline, images, imageCount: imageIndexes.length, links: followed, referenceCount: article.references.length,
          ...(article.redirectFrom ? { redirectFrom: article.redirectFrom } : {}),
          error: `offset ${offset} is past the end of this ${body.length}-character section.`,
        }
      }
      const slice = body.slice(offset, offset + limit)
      const truncated = offset + slice.length < body.length

      return {
        book,
        path: cleanPath,
        title: article.title,
        section: resolvedSection,
        text: slice,
        truncated,
        nextOffset: truncated ? offset + slice.length : 0,
        outline,
        images,
        imageCount: imageIndexes.length,
        links: followed,
        referenceCount: article.references.length,
        ...(article.redirectFrom ? { redirectFrom: article.redirectFrom } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_image',
    description: 'Fetch one image from an article and return it as an image the model can see. Raster images are attached directly; a genuine SVG is returned as text, either its full source or a summary of it.',
    parameters: {
      book: { type: 'string', required: true, description: 'ZIM name from wiki_search or wiki_read.' },
      path: { type: 'string', required: true, description: 'Article path containing the image.' },
      image: { type: 'integer', required: true, description: '1-based image index from the `Images:` list of wiki_read.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          book: { type: 'string' },
          path: { type: 'string' },
          index: { type: 'integer' },
          alt: { type: 'string' },
          url: { type: 'string' },
          kind: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          attachment: { type: 'object', additionalProperties: true },
          description: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => value.attachment
        ? [{ type: 'text', text: `${value.alt || 'image'} (${value.width}x${value.height}, ${value.bytes} bytes)` }, { type: 'image', attachment: value.attachment }]
        : [{ type: 'text', text: `${value.alt || 'image'}\n${value.description}` }],
    },
    presentationMeta: (_args, value) => ({ title: value.alt || 'Wiki image', kind: value.kind, bytes: value.bytes }),
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const book = assertSafeBook(args.book)
      const path = assertSafePath(args.path)
      const article = await getArticle(book, path, exec.signal)
      const image = article.images[args.image - 1]
      if (!image) {
        throw new Error(`Image ${args.image} not found in ${book}/${path}. This article has ${article.images.length} images.`)
      }

      const response = await fetch(image.url, { signal: exec.signal })
      if (!response.ok) throw new Error(`Kiwix returned HTTP ${response.status} for ${image.url}`)

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const identity = { book, path, index: args.image, alt: image.alt, url: image.url, width: image.width, height: image.height }
      const attach = async (data, mediaType, kind) => {
        try {
          const attachment = await ctx.attachments.saveImage({ data, mediaType, name: image.alt || 'wiki image' })
          return { ...identity, kind, bytes: attachment.bytes, width: attachment.width, height: attachment.height, attachment, description: '' }
        } catch (error) {
          return { ...identity, kind, bytes: data.byteLength, description: `The image could not be attached to this session: ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      // Kiwix re-encodes raster images as WebP whatever the ZIM extension says,
      // so the response header decides the attachment type. A genuine SVG has no
      // raster from Kiwix; the Harness attachment service admits only rasters,
      // so the source itself is handed to the model when it is small enough to
      // be read, and summarised when it is not.
      if (contentType === 'image/svg+xml' || contentType === 'text/xml' || contentType === 'application/xml') {
        const source = await response.text()
        const summary = svgToText(source)
        if (source.length <= config.maxSvgBytes) {
          return { ...identity, kind: 'vector', bytes: source.length, description: `${summary}\n\nSVG source:\n${source}` }
        }
        return {
          ...identity, kind: 'vector', bytes: source.length,
          description: `${summary}\n(SVG source is ${source.length} bytes, above the ${config.maxSvgBytes} limit, so only the summary is shown.)`,
        }
      }

      const mediaType = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/webp': 'image/webp', 'image/gif': 'image/gif' }[contentType]
      if (!mediaType) {
        return { ...identity, kind: 'unsupported', bytes: 0, description: `Kiwix served ${contentType || 'unknown content type'}, which cannot be displayed as an image.` }
      }

      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength > config.maxImageBytes) {
        return { ...identity, kind: 'raster', bytes: data.byteLength, description: `Image is ${data.byteLength} bytes, above the ${config.maxImageBytes} byte limit this plugin attaches.` }
      }

      return attach(data, mediaType, 'raster')
    },
  }))
}

/**
 * Model-facing rendering of a wiki_read result: the body first, then the
 * navigation aids the agent needs to continue.
 * @param value - the canonical wiki_read value.
 * @returns the text the model sees.
 */
function renderArticle(value) {
  const parts = []
  if (value.redirectFrom) parts.push(`(Redirected from ${value.redirectFrom})`)
  parts.push(value.section ? `${value.title} — section: ${value.section}` : value.title)
  parts.push(value.text || '(no text in this section)')
  if (value.truncated) parts.push(`… section truncated; continue with offset=${value.nextOffset}.`)
  if (value.outline.length) {
    const shown = value.outline.slice(0, 60)
    const rest = value.outline.length - shown.length
    parts.push(`Sections: ${shown.map((entry) => `${entry.section} (${entry.chars})`).join(', ')}${rest > 0 ? ` … ${rest} more` : ''}`)
  }
  if (value.images.length) parts.push(`Images: ${value.images.map((image) => `${image.index}. ${image.alt || 'untitled'} [${image.kind}]`).join(', ')}${value.imageCount > value.images.length ? ` (+${value.imageCount - value.images.length} more)` : ''}`)
  if (value.links.length) parts.push(`Links: ${value.links.map((link) => `${link.title} → ${link.path}`).join(', ')}`)
  if (value.referenceCount && !value.section) parts.push(`${value.referenceCount} references available with section="references".`)
  if (value.error) parts.push(value.error)
  return parts.join('\n\n')
}
