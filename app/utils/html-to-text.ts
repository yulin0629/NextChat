const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

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

const DROP_OPEN = /<!--|<(script|style|noscript|svg|template|iframe|head)\b/g;

// Drops comments and non-text blocks in one forward pass, so cost stays linear
// even for pages full of unclosed tags; an unclosed block runs to the end.
function dropBlocks(html: string) {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    DROP_OPEN.lastIndex = i;
    const m = DROP_OPEN.exec(lower);
    if (!m) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, m.index) + " ";
    const close = m[1] ? `</${m[1]}` : "-->";
    const end = lower.indexOf(close, m.index + m[0].length);
    if (end < 0) break;
    const gt = m[1] ? lower.indexOf(">", end) : end + 2;
    i = gt < 0 ? html.length : gt + 1;
  }
  return out;
}

function pageTitle(html: string) {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  const start = open < 0 ? -1 : lower.indexOf(">", open);
  const end = start < 0 ? -1 : lower.indexOf("</title", start);
  return end < 0 ? "" : decodeEntities(html.slice(start + 1, end)).trim();
}

// debt: ceiling: tag stripping, no layout or JS rendering; upgrade: a real
// HTML parser if pages come back as menus or empty text.
export function htmlToText(html: string) {
  const text = decodeEntities(
    dropBlocks(html)
      .replace(
        /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^<>]*>/gi,
        "\n",
      )
      .replace(/<[^<>]*>/g, " "),
  )
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  return { title: pageTitle(html), text };
}
