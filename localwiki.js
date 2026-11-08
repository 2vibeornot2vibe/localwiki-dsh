/**
 * Kiwix/MediaWiki helpers: catalog parsing, search ranking, and article-to-text
 * extraction.
 *
 * The DOM is built here rather than pulled from a package: kiwix-serve pages are
 * well-formed enough that a tolerant tag scanner is sufficient, and shipping the
 * parser inline keeps the bundle dependency-free. Nodes are plain objects:
 *   { type: 'tag' | 'text', name, attribs, children, parent }
 *
 * @module @local/localwiki-dsh/localwiki
 */

/** Elements that never have children. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

/** Elements whose content is raw text rather than markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

/** Opening one of these ends the elements listed for it. */
const IMPLIED_CLOSE = new Map([
  ['p', new Set(['p'])],
  ['li', new Set(['li'])],
  ['tr', new Set(['tr', 'td', 'th'])],
  ['td', new Set(['td', 'th'])],
  ['th', new Set(['td', 'th'])],
  ['h1', new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])],
  ['h2', new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])],
  ['h3', new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])],
  ['h4', new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])],
  ['h5', new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])],
  ['h6', new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])],
])

/** Block-level elements that close an open `<p>`. */
const CLOSES_PARAGRAPH = new Set([
  'div', 'table', 'ul', 'ol', 'dl', 'section', 'figure', 'blockquote', 'form', 'hr', 'pre',
])

/**
 * Named entities Kiwix and MediaWiki emit. Parsoid writes every other character
 * as raw UTF-8 or a numeric reference, so this list only needs the names that
 * actually appear; an unknown name is left as written rather than guessed.
 */
const NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', minus: '−',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  deg: '°', copy: '©', reg: '®', trade: '™', plusmn: '±', micro: 'µ',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
}))

/**
 * Decode the character references Kiwix emits in text and attribute values.
 * @param value - raw text.
 * @returns decoded text.
 */
function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match
    }
    const named = NAMED_ENTITIES.get(body) ?? NAMED_ENTITIES.get(body.toLowerCase())
    return named === undefined ? match : named
  })
}

/** Create one node. */
function node(type, name = null, attribs = {}) {
  return { type, name, attribs, children: [], parent: null }
}

/**
 * Read a tag starting at {@link start}, honouring quoted attribute values that
 * contain `>`.
 * @param source - the document.
 * @param start - index of the `<`.
 * @returns `{ end, isClose, name, attribs, selfClose }`, or null when the `<` is
 *   not the start of a tag.
 */
function readTag(source, start) {
  let i = start + 1
  const isClose = source[i] === '/'
  if (isClose) i += 1
  const nameStart = i
  while (i < source.length && /[A-Za-z0-9:_-]/.test(source[i])) i += 1
  if (i === nameStart) return null
  const name = source.slice(nameStart, i).toLowerCase()

  const attribs = {}
  let selfClose = false
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (i >= source.length) break
    if (source[i] === '>') { i += 1; break }
    if (source[i] === '/') { selfClose = true; i += 1; continue }
    const attrStart = i
    while (i < source.length && !/[\s=/>]/.test(source[i])) i += 1
    const attrName = source.slice(attrStart, i).toLowerCase()
    if (attrName === '') { i += 1; continue }
    while (i < source.length && /\s/.test(source[i])) i += 1
    let value = ''
    if (source[i] === '=') {
      i += 1
      while (i < source.length && /\s/.test(source[i])) i += 1
      const quote = source[i]
      if (quote === '"' || quote === "'") {
        i += 1
        const valueStart = i
        while (i < source.length && source[i] !== quote) i += 1
        value = source.slice(valueStart, i)
        i += 1
      } else {
        const valueStart = i
        while (i < source.length && !/[\s>]/.test(source[i])) i += 1
        value = source.slice(valueStart, i)
      }
    }
    attribs[attrName] = decodeEntities(value)
  }
  return { end: i, isClose, name, attribs, selfClose }
}

/**
 * Scan a document into a node tree. Unbalanced tags are tolerated: a closing tag
 * with no matching open tag is ignored, and an unclosed element keeps whatever
 * followed it as its children.
 * @param source - HTML or XML text.
 * @param options - `{ xml: true }` treats every element as closable, which an
 *   Atom or RSS feed needs (`<link>text</link>` is not the HTML void element).
 * @returns the root node.
 */
function parseHtml(source, options = {}) {
  const xml = options.xml === true
  const root = node('root')
  const stack = [root]
  const addText = (text) => {
    if (text === '') return
    const top = stack[stack.length - 1]
    const last = top.children[top.children.length - 1]
    if (last !== undefined && last.type === 'text') last.data += text
    else {
      const child = node('text')
      child.data = decodeEntities(text)
      child.parent = top
      top.children.push(child)
    }
  }

  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) { addText(source.slice(i)); break }
    if (lt > i) addText(source.slice(i, lt))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      i = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }

    const tag = readTag(source, lt)
    if (tag === null) { addText('<'); i = lt + 1; continue }
    i = tag.end

    if (tag.isClose) {
      for (let s = stack.length - 1; s >= 1; s -= 1) {
        if (stack[s].name === tag.name) { stack.length = s; break }
      }
      continue
    }

    if (!xml) {
      const implied = IMPLIED_CLOSE.get(tag.name)
      if (implied !== undefined && stack[stack.length - 1].type === 'tag' && implied.has(stack[stack.length - 1].name)) stack.pop()
      if (stack[stack.length - 1].name === 'p' && CLOSES_PARAGRAPH.has(tag.name)) stack.pop()
    }

    const child = node('tag', tag.name, tag.attribs)
    child.parent = stack[stack.length - 1]
    stack[stack.length - 1].children.push(child)

    if (tag.selfClose || (!xml && VOID_ELEMENTS.has(tag.name))) continue

    if (!xml && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const close = source.toLowerCase().indexOf(`</${tag.name}`, i)
      const end = close === -1 ? source.length : close
      if (end > i) {
        const text = node('text')
        text.data = source.slice(i, end)
        text.parent = child
        child.children.push(text)
      }
      i = end
      continue
    }
    stack.push(child)
  }

  return root
}

/**
 * Parse one simple selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="value"]`,
 * `[attr*=value]`, in any combination. Class tests are compiled once per
 * selector rather than per node visited.
 */
function parseSimple(text) {
  const simple = { tag: null, classes: [], ids: [], attrs: [] }
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)|\.([A-Za-z0-9_-]+)|#([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:(\*?)=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) simple.tag = match[1].toLowerCase()
    else if (match[2] !== undefined) simple.classes.push(new RegExp(`(?:^|\\s)${match[2]}(?:\\s|$)`))
    else if (match[3] !== undefined) simple.ids.push(match[3])
    else {
      const value = match[6] ?? match[7] ?? match[8]
      simple.attrs.push({ name: match[4].toLowerCase(), op: match[5] === '*' ? '*=' : value === undefined ? '' : '=', value: value ?? '' })
    }
  }
  return simple
}

/** Whether {@link candidate} satisfies one simple selector. */
function matchesSimple(candidate, simple) {
  if (candidate.type !== 'tag') return false
  if (simple.tag !== null && candidate.name !== simple.tag) return false
  if (simple.classes.length > 0) {
    const classes = candidate.attribs.class
    if (classes === undefined) return false
    for (const pattern of simple.classes) if (!pattern.test(classes)) return false
  }
  for (const id of simple.ids) if (candidate.attribs.id !== id) return false
  for (const attr of simple.attrs) {
    const value = candidate.attribs[attr.name]
    if (value === undefined) return false
    if (attr.op === '*=' && !value.includes(attr.value)) return false
    if (attr.op === '=' && value !== attr.value) return false
  }
  return true
}

/** Visit every descendant of {@link start} in document order (pre-order DFS). */
function walk(start, visit) {
  const stack = start.children.slice().reverse()
  while (stack.length > 0) {
    const current = stack.pop()
    visit(current)
    for (let index = current.children.length - 1; index >= 0; index -= 1) stack.push(current.children[index])
  }
}

/** Whether {@link target} satisfies a descendant chain, e.g. `sup.reference a`. */
function matchesChain(target, chain, boundary) {
  if (!matchesSimple(target, chain[chain.length - 1])) return false
  let index = chain.length - 2
  let current = target.parent
  while (index >= 0) {
    let matched = false
    while (current !== null && current !== undefined && current !== boundary) {
      if (matchesSimple(current, chain[index])) { matched = true; current = current.parent; index -= 1; break }
      current = current.parent
    }
    if (!matched) return false
  }
  return true
}

/**
 * Collect nodes matching a comma-separated, descendant-only CSS selector in
 * document order.
 * @param start - the node to search within.
 * @param selector - e.g. `table.wikitable, sup.reference a`.
 * @returns matching nodes in document order.
 */
function queryAll(start, selector) {
  const chains = selector.split(',').map((part) => part.trim().split(/\s+/).filter(Boolean).map(parseSimple)).filter((chain) => chain.length > 0)
  const found = []
  walk(start, (candidate) => {
    for (const chain of chains) {
      if (matchesChain(candidate, chain, start)) { found.push(candidate); break }
    }
  })
  return found
}

/** The first node matching {@link selector}, or null. */
function queryFirst(start, selector) {
  return queryAll(start, selector)[0] ?? null
}

/** Detach {@link target} from its parent. */
function remove(target) {
  const parent = target.parent
  if (parent === null) return
  const index = parent.children.indexOf(target)
  if (index !== -1) parent.children.splice(index, 1)
  target.parent = null
}

/** Replace {@link target} with {@link replacement} in the tree. */
function replaceWith(target, replacement) {
  const parent = target.parent
  if (parent === null) return
  const index = parent.children.indexOf(target)
  if (index === -1) return
  replacement.parent = parent
  parent.children.splice(index, 1, replacement)
}

/** Append {@link child} to {@link parent}. */
function append(parent, child) {
  child.parent = parent
  parent.children.push(child)
}

/** Interface icons that Kiwix renders inside articles but that carry no content. */
const IMAGE_NOISE = /oojs_ui_icon|edit this on wikidata|wikimedia-commons-?logo|portal-?icon/i

/** Image extensions the Harness attachment service admits as rasters. */
const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * Elements that carry navigation or citation chrome rather than article prose.
 * ArchWiki's `archwiki-template-box` callouts are deliberately NOT listed: a
 * "Note" or "Warning" box is real content.
 */
const NOISE_SELECTORS = [
  'script', 'style', 'link', 'meta',
  '.mw-editsection', '.toc', '.navbox', '.sidebar', '.hatnote', '.reflist',
  '.mw-references-wrap', '.shortdescription', '.mbox', '.ambox', '.fmbox',
  '.archwiki-template-meta-related-articles',
  '.zim-footer', '.noprint', '.printfooter', '.catlinks', '.noexcerpt',
  '.navigation-not-searchable', '.mw-empty-elt',
]

/** Block elements that end a line in the flattened text. */
const BLOCK = new Set(['p', 'div', 'ul', 'ol', 'dl', 'table', 'figure', 'blockquote', 'section', 'caption'])

/** Namespaces that are maintenance or navigation, not articles. */
const NON_ARTICLE_NAMESPACE = /^(?:category|file|image|template|module|help|wikipedia|special|talk|mediawiki):/i

/**
 * Turn MathML into the LaTeX the source already carries, so equations survive
 * as readable text instead of a wall of tags.
 * @param alttext - the `alttext` attribute of a `<math>` element.
 * @returns a compact formula.
 */
function mathToText(alttext) {
  if (!alttext) return ''
  return alttext
    .replace(/^\{\s*\\displaystyle\s*/, '')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Flatten one node to plain text: lists become `- ` lines, fenced code keeps its
 * whitespace, numeric superscripts and subscripts become `^` and `_`, and
 * equations become their LaTeX.
 * @param target - a node from the parser above.
 * @returns the flattened text.
 */
function nodeText(target) {
  if (target === null || target === undefined) return ''
  if (target.type === 'text') return target.data ?? ''

  const name = target.name
  if (name === 'br') return '\n'
  if (name === 'img') return ''
  if (name === 'pre') {
    const code = target.children.map(nodeText).join('').replace(/\n+$/g, '')
    return `\n\`\`\`\n${code}\n\`\`\`\n`
  }
  if (name === 'math') return mathToText(target.attribs.alttext ?? '')
  if (name === 'sup' || name === 'sub') {
    const inner = target.children.map(nodeText).join('').trim()
    // `[1]` citation markers stay as they are; only bare numbers are renotated.
    if (/^[\d+\u2212-]+$/.test(inner)) return (name === 'sup' ? '^' : '_') + inner
    return inner
  }

  const inner = target.children.map(nodeText).join('')
  if (name === 'li') return `\n- ${inner.trim()}`
  if (BLOCK.has(name)) return `\n${inner}\n`
  return inner
}

/**
 * Normalize flattened text: collapse runs of spaces, keep paragraph breaks, and
 * leave fenced code and Markdown table rows intact.
 * @param text - raw flattened text.
 * @returns readable text.
 */
function normalizeText(text) {
  let inFence = false
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('```')) { inFence = !inFence; return trimmed }
      if (inFence) return line
      if (trimmed.startsWith('|')) return trimmed
      return trimmed.replace(/[ \t]+/g, ' ')
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Render infoboxes as `- label: value` lines so a fact box reads as prose. The
 * infobox's own pictures stay as real `<img>` nodes so `wiki_image` can still
 * reach them; only the layout is flattened.
 * @param root - the article body.
 */
function flattenInfoboxes(root) {
  for (const table of queryAll(root, 'table')) {
    const classes = table.attribs.class ?? ''
    if (!classes.includes('infobox') && !classes.includes('chinbox') && !classes.includes('chembox')) continue
    const rows = []
    for (const row of queryAll(table, 'tr')) {
      const cells = queryAll(row, 'th, td')
        .map((cell) => nodeText(cell).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      if (cells.length === 0) continue
      rows.push(cells.length === 1 ? `- ${cells[0]}` : `- ${cells[0]}: ${cells.slice(1).join(' ')}`)
    }
    const images = queryAll(table, 'img').map((image) => { remove(image); return image })
    if (rows.length === 0 && images.length === 0) {
      remove(table)
      continue
    }
    const flat = node('tag', 'div', { class: 'flat-infobox' })
    for (const image of images) append(flat, image)
    if (rows.length > 0) append(flat, { type: 'text', name: null, attribs: {}, children: [], parent: null, data: rows.join('\n') })
    replaceWith(table, flat)
  }
}

/**
 * Render `wikitable` tables as GitHub-flavoured Markdown. A table holding code
 * samples is left alone, because Markdown cells cannot keep fenced blocks.
 * @param root - the article body.
 */
function flattenWikitableTables(root) {
  for (const table of queryAll(root, 'table.wikitable')) {
    if (queryAll(table, 'pre').length > 0) continue
    const rows = queryAll(table, 'tr').map((row) => ({
      header: queryAll(row, 'th').length > 0,
      cells: queryAll(row, 'th, td').map((cell) =>
        nodeText(cell).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()),
    }))
    const width = Math.max(...rows.map((row) => row.cells.length), 0)
    if (width === 0) {
      remove(table)
      continue
    }
    const lines = []
    const caption = queryFirst(table, 'caption')
    const captionText = caption === null ? '' : nodeText(caption).replace(/\s+/g, ' ').trim()
    if (captionText) lines.push(captionText)
    let separatorEmitted = false
    for (const row of rows) {
      const cells = row.cells.slice(0, width)
      while (cells.length < width) cells.push('')
      lines.push(`| ${cells.join(' | ')} |`)
      if (row.header && !separatorEmitted) {
        lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
        separatorEmitted = true
      }
    }
    replaceWith(table, { type: 'text', name: null, attribs: {}, children: [], parent: null, data: lines.join('\n') })
  }
}

/** Walk up the tree to the nearest element named {@link name}. */
function findAncestor(target, name) {
  let current = target.parent
  while (current !== null && current !== undefined) {
    if (current.name === name) return current
    current = current.parent
  }
  return null
}

/**
 * Collect images in document order, numbered once for the whole article so
 * `wiki_image` can address one by index from any section.
 * @param scope - the node to search within.
 * @param baseUrl - the article URL after redirects.
 * @returns images with absolute URLs.
 */
function collectImages(scope, baseUrl) {
  const nodes = scope.type === 'tag' && scope.name === 'img' ? [scope, ...queryAll(scope, 'img')] : queryAll(scope, 'img')
  const images = []
  for (const img of nodes) {
    const source = img.attribs.src
    if (!source || source.startsWith('data:')) continue
    let url
    try { url = new URL(source, baseUrl).href } catch { continue }
    const extension = (url.split(/[?#]/)[0].split('.').pop() ?? '').toLowerCase()
    const width = Number(img.attribs.width ?? img.attribs['data-file-width'] ?? 0)
    const height = Number(img.attribs.height ?? img.attribs['data-file-height'] ?? 0)
    let alt = (img.attribs.alt ?? '').trim()
    // Interface chrome (Wikidata edit pencils, OOjs UI icons) is never content.
    if (IMAGE_NOISE.test(url) || IMAGE_NOISE.test(alt)) continue
    // Icon strips, flag glyphs, and portal badges carry no caption and are
    // almost never worth a model's context.
    if (!alt && width > 0 && width < 120) continue
    if (!alt) {
      const figure = findAncestor(img, 'figure')
      const caption = figure === null ? '' : queryAll(figure, 'figcaption')
        .map((child) => nodeText(child).replace(/\s+/g, ' ').trim())
        .join(' ')
      alt = caption || (url.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ')
    }
    images.push({ url, alt, width, height, mediaType: IMAGE_MEDIA_TYPES[extension] ?? null })
  }
  return images
}

/**
 * Collect the links in a scope so the agent can follow them.
 * @param scope - the node to search within.
 * @param baseUrl - the article URL after redirects.
 * @returns `{ title, path, kind }` links, deduplicated.
 */
function collectLinks(scope, baseUrl) {
  const links = []
  const seen = new Set()
  for (const anchor of queryAll(scope, 'a')) {
    const href = (anchor.attribs.href ?? '').trim()
    if (!href || href.startsWith('#')) continue
    const title = nodeText(anchor).replace(/\s+/g, ' ').trim()
    if (/^https?:/i.test(href)) {
      const key = `ext:${href}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ title: title || href, path: href, kind: 'external' })
      continue
    }
    let resolved
    try { resolved = new URL(href, baseUrl).pathname } catch { continue }
    const rawPath = resolved.replace(/^\/content\/[^/]+\//, '')
    let path
    try { path = decodeURIComponent(rawPath) } catch { path = rawPath }
    if (!path || NON_ARTICLE_NAMESPACE.test(path)) continue
    const key = `int:${path}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ title: title || path, path, kind: 'internal' })
  }
  return links
}

/**
 * Recover the real destination of a Kiwix link, which some server
 * configurations route through `/catch/external`.
 * @param href - the raw href attribute.
 * @returns an absolute URL, or the href unchanged when it is not external.
 */
function externalUrl(href) {
  const source = href.match(/\/catch\/external\?source=([^"]+)/)
  if (!source) return href
  try { return decodeURIComponent(source[1]) } catch { return source[1] }
}

/**
 * Map every citation target to the marker the prose actually shows, so lettered
 * footnotes and grouped notes stay addressable even when their `id` is not a
 * plain number.
 * @param root - the article body.
 * @returns `note id -> "[7]"` style markers.
 */
function referenceMarkers(root) {
  const markers = new Map()
  for (const anchor of queryAll(root, 'sup.reference a, .reference a')) {
    const href = (anchor.attribs.href ?? '').trim()
    if (!href.startsWith('#')) continue
    const id = href.slice(1)
    const text = nodeText(anchor).replace(/\s+/g, ' ').trim()
    if (text && !markers.has(id)) markers.set(id, text)
  }
  return markers
}

/**
 * Read the numbered reference list and remove it from the document so the body
 * does not repeat it. A notes list is left in place: it is prose, not citations.
 * @param root - the article body.
 * @returns reference lines in citation order.
 */
function extractReferences(root) {
  const lists = queryAll(root, 'ol.references')
  if (lists.length === 0) return []
  const markers = referenceMarkers(root)
  // The citation group comes first; a footnote group (lower-alpha) is listed
  // after it so both are addressable.
  const ordered = lists
    .filter((list) => (list.attribs['data-mw-group'] ?? '') === '')
    .concat(lists.filter((list) => (list.attribs['data-mw-group'] ?? '') !== ''))
  const references = []
  const seen = new Set()
  for (const list of ordered) {
    for (const item of queryAll(list, 'li')) {
      for (const backlink of queryAll(item, '.mw-cite-backlink')) remove(backlink)
      const id = item.attribs.id ?? ''
      const number = id.match(/^cite_note-(\d+)$/)?.[1]
      const urls = queryAll(item, 'a')
        .map((anchor) => externalUrl(anchor.attribs.href ?? ''))
        .filter((url) => /^https?:/i.test(url))
      const text = normalizeText(nodeText(item)).replace(/\s+/g, ' ')
        .replace(/^[-\u2013\u2014]\s+/, '').trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      // Some wikis render the same note list twice; the marker is what the
      // prose shows, and the fallback is the numeric id.
      const marker = markers.get(id) ?? (number === undefined ? '' : `[${number}]`)
      references.push(`${marker} ${text}${urls.length > 0 ? ` (${urls.join(' ')})` : ''}`.trim())
    }
    remove(list)
  }
  return references
}

/**
 * Reduce an SVG document to what a model can actually use: its title,
 * description, and rendered text runs.
 * @param svg - raw SVG source.
 * @param limit - maximum characters to keep.
 * @returns a compact textual description of the vector image.
 */
export function svgToText(svg, limit = 3000) {
  const doc = parseHtml(svg, { xml: true })
  const lines = []
  const title = nodeText(queryFirst(doc, 'title')).trim()
  const description = nodeText(queryFirst(doc, 'desc')).trim()
  const texts = queryAll(doc, 'text').map((target) => nodeText(target).replace(/\s+/g, ' ').trim()).filter(Boolean)
  const shapes = queryAll(doc, 'path, rect, circle, ellipse, polygon, polyline, line').length
  if (title) lines.push(`Title: ${title}`)
  if (description) lines.push(`Description: ${description}`)
  if (texts.length) lines.push(`Text in the image: ${texts.join(' · ')}`)
  lines.push(`${shapes} vector shapes.`)
  const joined = lines.join('\n')
  return joined.length > limit ? `${joined.slice(0, limit)}\n… (description truncated)` : joined
}

/**
 * Parse one Kiwix article page into a lead, a section list, an image list, and a
 * reference list.
 * @param html - the raw article HTML.
 * @param baseUrl - the final article URL after redirects.
 * @returns `{ title, lead, sections, images, references }` in document order.
 */
export function parseArticle(html, baseUrl) {
  const doc = parseHtml(html)
  const title = nodeText(queryFirst(doc, 'title')).trim()

  // Chrome that carries no prose at all.
  for (const target of queryAll(doc, 'script, style, link, meta')) remove(target)

  // References are pulled out before the wrapper that holds them is stripped.
  const references = extractReferences(doc)

  const body = queryFirst(doc, '.mw-parser-output') ?? queryFirst(doc, 'body') ?? doc

  for (const target of queryAll(doc, NOISE_SELECTORS.join(', '))) remove(target)
  for (const heading of queryAll(body, 'h1')) remove(heading)
  flattenInfoboxes(body)
  flattenWikitableTables(body)

  // Number images once for the whole article.
  const images = collectImages(body, baseUrl)
  const imageIndex = new Map()
  for (const [index, image] of images.entries()) imageIndex.set(image.url, index + 1)

  // Parsoid wraps each section in its own `<section>`, nested inside wrapper
  // divs. Flattening to a linear block list makes both layouts produce the same
  // section boundaries.
  const parts = []
  const isHeading = (target) => target.name !== undefined && /^h[2-6]$/.test(target.name)
  // `containsHeading` is asked for every child of every node, so the answer is
  // memoised bottom-up instead of rescanning the subtree each time.
  const headingCache = new Map()
  const containsHeading = (target) => {
    const cached = headingCache.get(target)
    if (cached !== undefined) return cached
    const result = isHeading(target) || target.children.some(containsHeading)
    headingCache.set(target, result)
    return result
  }
  const flatten = (target) => {
    for (const child of target.children) {
      if (isHeading(child)) {
        parts.push({ kind: 'heading', level: Number(child.name.slice(1)), heading: nodeText(child).replace(/\s+/g, ' ').trim(), node: child })
      } else if (child.type === 'text' && !(child.data ?? '').trim()) {
        continue
      } else if (containsHeading(child)) {
        flatten(child)
      } else {
        parts.push({ kind: 'content', node: child })
      }
    }
  }
  flatten(body)

  const firstHeading = parts.findIndex((part) => part.kind === 'heading')
  const leadParts = firstHeading === -1 ? parts : parts.slice(0, firstHeading)
  const lead = normalizeText(leadParts.map((part) => nodeText(part.node)).join('\n'))
  const leadImageIndexes = leadParts.flatMap((part) => collectImages(part.node, baseUrl).map((image) => imageIndex.get(image.url)))
  const leadLinks = leadParts.flatMap((part) => collectLinks(part.node, baseUrl))

  const sections = []
  for (let index = firstHeading === -1 ? parts.length : firstHeading; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.kind !== 'heading') continue
    let end = index + 1
    while (end < parts.length && (parts[end].kind === 'content' || parts[end].level > part.level)) end += 1
    const children = parts.slice(index + 1, end)
    const text = normalizeText(children.map((inner) => nodeText(inner.node)).join('\n'))
    const imageIndexes = [...new Set(children.flatMap((inner) =>
      collectImages(inner.node, baseUrl).map((image) => imageIndex.get(image.url))))]
    if (!text && imageIndexes.length === 0) continue
    sections.push({
      heading: part.heading,
      level: part.level,
      text,
      childHeadings: children.filter((inner) => inner.kind === 'heading').map((inner) => inner.heading),
      imageIndexes,
      links: children.flatMap((inner) => collectLinks(inner.node, baseUrl)),
    })
  }

  // Sizes are only known after every section has been built.
  const sizeOf = new Map(sections.map((section) => [section.heading, section.text.length]))
  for (const section of sections) {
    section.children = section.childHeadings.map((heading) => ({ heading, chars: sizeOf.get(heading) ?? 0 }))
    delete section.childHeadings
  }

  return { title, lead, leadImageIndexes, leadLinks, sections, images, references }
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether {@link text} contains {@link word} as a whole word. */
function hasWord(text, word) {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(text)
}

/**
 * Rank a title against the query. Exact beats a standalone prefix beats
 * whole-word coverage beats a loose substring hit.
 * @param title - article title.
 * @param query - the search terms.
 * @param rank - position within its own result list.
 * @returns a comparable score.
 */
export function titleScore(title, query, rank) {
  const normalizedTitle = title.toLowerCase().replace(/_/g, ' ').trim()
  const normalizedQuery = query.toLowerCase().replace(/_/g, ' ').trim()
  if (!normalizedQuery) return 0
  if (normalizedTitle === normalizedQuery) return 1000 - rank
  if (new RegExp(`^${escapeRegExp(normalizedQuery)}(?:[ (]|$)`).test(normalizedTitle)) return 900 - rank
  const tokens = normalizedQuery.split(/\s+/)
  if (tokens.every((token) => hasWord(normalizedTitle, token))) return 800 - rank
  if (tokens.some((token) => hasWord(normalizedTitle, token))) return 600 - rank
  if (normalizedTitle.includes(normalizedQuery)) return 300 - rank
  return 0
}

/**
 * Parse the OPDS catalog feed into the book keys Kiwix expects.
 * @param xml - the `/catalog/v2/entries` response.
 * @returns books with the ZIM name used by `/content` and `books.name`.
 */
export function parseCatalog(xml) {
  const doc = parseHtml(xml, { xml: true })
  const books = []
  for (const entry of queryAll(doc, 'entry')) {
    const link = queryAll(entry, 'link').find((candidate) => (candidate.attribs.href ?? '').startsWith('/content/'))
    const match = link === undefined ? null : link.attribs.href.match(/\/content\/([^"]+)/)
    if (!match) continue
    books.push({
      name: match[1],
      title: nodeText(queryFirst(entry, 'title')).trim(),
      language: nodeText(queryFirst(entry, 'language')).trim(),
      articles: Number(nodeText(queryFirst(entry, 'articleCount')).replace(/,/g, '') ?? 0),
    })
  }
  return books
}

/**
 * Parse the RSS search feed into result records.
 * @param xml - the `/search?...&format=xml` response.
 * @param book - the book the results came from.
 * @returns full-text matches in Kiwix's own ranking order.
 */
export function parseSearchResults(xml, book) {
  const doc = parseHtml(xml, { xml: true })
  const results = []
  for (const item of queryAll(doc, 'item')) {
    const link = nodeText(queryFirst(item, 'link')).trim()
    if (!link) continue
    const rawPath = link.replace(/^\/content\/[^/]+\//, '')
    let path
    try { path = decodeURIComponent(rawPath) } catch { path = rawPath }
    results.push({
      book,
      rank: results.length,
      title: nodeText(queryFirst(item, 'title')).trim(),
      path,
      snippet: normalizeText(nodeText(queryFirst(item, 'description'))).slice(0, 220),
    })
  }
  return results
}

/**
 * Parse the `/suggest` title index into candidate article paths.
 * @param json - the parsed suggestion array.
 * @param book - the book the suggestions came from.
 * @returns title matches, in index order.
 */
export function parseSuggestions(json, book) {
  if (!Array.isArray(json)) return []
  return json
    .filter((entry) => entry?.kind === 'path' && typeof entry.path === 'string' && typeof entry.value === 'string')
    // Kiwix's title index HTML-escapes both the title and the path, so an
    // apostrophe arrives as `Chang&apos;e_7` and would 404 if used verbatim.
    .map((entry, rank) => ({
      book,
      title: decodeEntities(entry.value).trim(),
      path: decodeEntities(entry.path).trim(),
      rank,
    }))
}

/**
 * Rank title matches above full-text matches, keeping the best score per path.
 * Only a strong title hit (exact, standalone prefix, or whole-word coverage) is
 * promoted; a loose substring in a title is not worth demoting Kiwix's own
 * full-text ranking.
 * @param query - the search terms.
 * @param titleMatches - suggestions from `/suggest`.
 * @param textMatches - results from `/search`.
 * @param limit - maximum results to return.
 * @returns ranked results with a `match` kind.
 */
export function mergeResults(query, titleMatches, textMatches, limit) {
  const best = new Map()
  const consider = (match, score, isTitle) => {
    const key = `${match.book}|${match.path}`
    const existing = best.get(key)
    if (!existing) {
      best.set(key, { ...match, score, match: isTitle ? 'title' : 'text' })
      return
    }
    if (score > existing.score) {
      best.set(key, { ...match, score, match: existing.match === 'title' || isTitle ? 'title' : 'text' })
    }
  }
  for (const match of titleMatches) {
    const score = titleScore(match.title, query, match.rank)
    consider(match, score >= 600 ? 1000 + score : score, true)
  }
  for (const match of textMatches) {
    const score = titleScore(match.title, query, match.rank ?? 0)
    consider(match, score >= 600 ? 1000 + score : 500 - (match.rank ?? 0), false)
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ score, rank, ...result }) => result)
}
