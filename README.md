# LocalWiki-DSH: Offline wiki (Kiwix) search and reading for DeepSeek Harness

A Cordis Host plugin that gives the agent four tools over a local **kiwix-serve**
server and whatever ZIM collections it is serving:

| Tool | What it does |
|---|---|
| `wiki_books` | List the collections on the server and their names. |
| `wiki_search` | Search every collection; title hits are ranked above full-text hits. |
| `wiki_read` | Read an article as plain text - the lead plus an outline, or one section, or `section="references"`. |
| `wiki_image` | Fetch one numbered image from an article and hand it to the model as an actual image. |

## Design

- **Token efficient.** `wiki_read` without `section` returns the lead and a size
  outline of every section, so the agent reads only the part it needs. With
  `section` it returns that section's text plus the sizes of its subsections, and
  `offset` continues a truncated section.
- **Structural parsing, no dependencies.** `localwiki.js` contains a small
  tolerant HTML/XML scanner and the MediaWiki extractor. Sections, infoboxes,
  tables, citations and images are handled by walking the DOM, not by regex
  guesswork. The only imports are the Harness's own `@deepseek-ai/dsh-tools` and
  `@deepseek-ai/schemastery`, declared as `peerDependencies` so the running
  Harness supplies them and the plugin shares its tool and schema instances.
- **Images inline.** `wiki_image` attaches the image to the conversation. Genuine
  SVGs cannot be attached, so their source or a summary is returned as text.
- **Links followable.** Each read ends with the internal links in that section, so
  the agent can hop to another article with the same tools.
- **References.** `section="references"` returns the citation list with the markers
  the prose uses (`[7]`, `[a]`) and the source URLs.
- **Redirects.** Soft redirects (meta-refresh pages) are followed, up to three
  hops, and the original URL is reported.

## Install

**You can ask an agent to set this up for you.**

For configuring the Kiwix server, refer to the README of [lmstudio-localwiki](https://github.com/2vibeornot2vibe/lmstudio-localwiki).

Clone this repo into `.dsh/plugins`, then go to Plugins → Add plugin → Enter plugin's absolute path → Install → Enable now

## Configuration

The settings live in the patch row the bundle inserts, in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `kiwixBaseUrl` | `http://127.0.0.1:8080` | Where kiwix-serve listens. |
| `searchLimit` | 10 | Results per collection. |
| `maxChars` | 8000 | Characters returned per read. |
| `maxImageList` | 8 | Images listed per read. |
| `maxLinks` | 20 | Links listed per read. |
| `maxImageBytes` | 8388608 | Largest image the plugin will attach. |
| `maxSvgBytes` | 400000 | Above this, an SVG is summarised instead of returned as source. |
| `requestTimeoutMs` | 20000 | Per-request timeout. |

## Credits

This tool is vibe'd by **Qwen3.8-Flash-Next** (deployed via Strata) in DSH.

**Disclaimer:** This is just a for-fun weekend project and should **NOT** be used in production environments. This tool is provided "as is" with **NO WARRANTY**.

Feedbacks and contributions to this project are welcome! :D

## License

This tool is released under the [GPLv3 license](https://www.gnu.org/licenses/gpl-3.0.html).
