// Object.create(null): names such as "constructor" must not hit Object's prototype
const ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  deg: "°",
  yen: "¥",
  euro: "€",
  pound: "£",
});

function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Elements whose content is never page text, skipped up to their end tag. Raw-text
// elements (script, style, textarea, title, ...) cannot hold tags; svg and template
// can, so an unclosed one skips only its start tag. A nested <svg> ends the skip early.
const SKIP = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
  "xmp",
  "svg",
  "template",
]);
const LINE_BREAK = new Set(
  ["br", "/p", "/div", "/li", "/tr", "/section", "/article", "/ul", "/ol"]
    .concat(["/table", "/blockquote", "/pre", "/header", "/footer", "/nav"])
    .concat(["/main", "/aside", "/dt", "/dd", "/figcaption"])
    .concat(["/h1", "/h2", "/h3", "/h4", "/h5", "/h6"]),
);
const HOLDS_TAGS = new Set(["svg", "template"]);
const END_TAG: Record<string, RegExp> = {};
const COMMENT_END = /--!?>/g;

const isAlpha = (c: number) => (c | 32) >= 97 && (c | 32) <= 122;
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);

// Index of the ">" that ends a tag whose name ends before `from`. Quoted attribute
// values may contain ">" and "<", as browsers allow. -1 when the input ends first.
function tagEnd(html: string, from: number) {
  for (let j = from; j < html.length; j++) {
    const c = html.charCodeAt(j);
    if (c === 62) return j;
    if (c !== 61) continue;
    let v = j + 1;
    while (v < html.length && isSpace(html.charCodeAt(v))) v++;
    const q = html[v];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, v + 1);
      if (close < 0) return -1;
      j = close;
    } else {
      // an unquoted value runs to whitespace or ">"; quotes inside it are plain text
      while (
        v < html.length &&
        !isSpace(html.charCodeAt(v)) &&
        html[v] !== ">"
      ) {
        v++;
      }
      j = v - 1;
    }
  }
  return -1;
}

// A small HTML tokenizer: one forward pass, so cost stays linear on any input. Where
// the input ends inside a tag, comment or raw-text element (a broken page, or our byte
// cap), the rest is dropped, as a browser would not show it as text either.
// debt: ceiling: no layout or JS rendering; upgrade: a real HTML parser if pages
// come back as menus or empty text.
export function htmlToText(html: string) {
  const parts: string[] = [];
  // names whose end tag no longer appears, so later start tags need no search
  const noEndTag = new Set<string>();
  let title = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    let end: number;
    if (html.startsWith("!--", lt + 1)) {
      // "<!-->" and "<!--->" are complete, empty comments
      if (html.startsWith(">", lt + 4)) end = lt + 4;
      else if (html.startsWith("->", lt + 4)) end = lt + 5;
      else {
        // "--!>" also ends a comment
        COMMENT_END.lastIndex = lt + 4;
        const close = COMMENT_END.exec(html);
        end = close ? close.index + close[0].length - 1 : -1;
      }
      if (end < 0) break;
      parts.push(" ");
      i = end + 1;
      continue;
    }
    const c = html.charCodeAt(lt + 1);
    const closing = c === 47;
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isAlpha(html.charCodeAt(nameStart))) {
      if (c === 33 || c === 63 || closing) {
        // <!doctype …>, <?xml …?>, "</ x>": skipped up to the next ">"
        end = html.indexOf(">", lt + 1);
        if (end < 0) break;
        i = end + 1;
      } else {
        // a "<" that starts no tag, as in "a < b", is text
        parts.push("<");
        i = lt + 1;
      }
      continue;
    }
    let k = nameStart;
    for (; k < html.length; k++) {
      const n = html.charCodeAt(k);
      if (isSpace(n) || n === 47 || n === 62) break;
    }
    const name = html.slice(nameStart, k).toLowerCase();
    end = tagEnd(html, k);
    if (end < 0) break;
    i = end + 1;
    const selfClosingSvg = name === "svg" && html.charCodeAt(end - 1) === 47;
    if (!closing && SKIP.has(name) && !selfClosingSvg && !noEndTag.has(name)) {
      const endTag = (END_TAG[name] ??= new RegExp(
        `</${name}(?=[\\s/>])`,
        "gi",
      ));
      endTag.lastIndex = i;
      const found = endTag.exec(html);
      if (!found) {
        if (!HOLDS_TAGS.has(name)) break;
        noEndTag.add(name);
        parts.push(" ");
        continue;
      }
      if (name === "title" && !title) {
        title = decodeEntities(html.slice(i, found.index)).trim();
      }
      const closeEnd = tagEnd(html, found.index + 2 + name.length);
      if (closeEnd < 0) break;
      parts.push(" ");
      i = closeEnd + 1;
      continue;
    }
    parts.push(LINE_BREAK.has(closing ? "/" + name : name) ? "\n" : " ");
  }
  // the patterns skip a lone " " or "\n", which is already collapsed: replacing each
  // one costs about 0.5 s on 2 MB of text
  const text = decodeEntities(parts.join(""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]{2,}|[\t\f\v ]/g, " ")
    .replace(/ +\n\s*|\n\s+/g, "\n")
    .trim();
  return { title, text };
}
