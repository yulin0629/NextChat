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

const BLOCK_OPEN =
  /<!--|<(script|style|noscript|svg|template|iframe|head)(?=[\s/>])/gi;
const BLOCK_CLOSE: Record<string, RegExp> = {};
const BREAK_TAG = /^(?:br|\/(?:p|div|li|h[1-6]|tr|section|article))\b/i;

// Drops comments and non-text blocks in one forward pass, on the original string
// (lowercasing can change its length, e.g. "İ"). A block without an end tag stays,
// so only its tags are stripped later. Once an end tag is missing, later blocks of
// that kind are not searched again, which keeps pages of unclosed tags linear.
function dropBlocks(html: string) {
  const unclosed = new Set<string>();
  let out = "";
  let i = 0;
  let m: RegExpExecArray | null;
  BLOCK_OPEN.lastIndex = 0;
  while ((m = BLOCK_OPEN.exec(html))) {
    const start = m.index;
    const name = m[1]?.toLowerCase() ?? "--";
    let end = -1;
    if (name === "--" && html.startsWith(">", start + 4)) {
      end = start + 5; // "<!-->" is an empty comment
    } else if (name === "--" && html.startsWith("->", start + 4)) {
      end = start + 6; // so is "<!--->"
    } else if (!unclosed.has(name)) {
      const close = (BLOCK_CLOSE[name] ??=
        name === "--" ? /-->/g : new RegExp(`</${name}\\s*>`, "gi"));
      close.lastIndex = start + m[0].length;
      const c = close.exec(html);
      if (c) end = c.index + c[0].length;
      else unclosed.add(name);
    }
    if (end < 0) continue;
    out += html.slice(i, start) + " ";
    i = end;
    BLOCK_OPEN.lastIndex = end;
  }
  return out + html.slice(i);
}

// Same result as replacing /<[^>]+>/ (line breaks for block ends), in one pass.
function stripTags(html: string) {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    const gt = lt < 0 ? -1 : html.indexOf(">", lt + 1);
    if (gt < 0) break;
    if (gt === lt + 1) {
      out += html.slice(i, gt + 1);
    } else {
      const head = html.slice(lt + 1, Math.min(gt, lt + 12));
      out += html.slice(i, lt) + (BREAK_TAG.test(head) ? "\n" : " ");
    }
    i = gt + 1;
  }
  return out + html.slice(i);
}

function pageTitle(html: string) {
  const open = html.search(/<title\b/i);
  const start = open < 0 ? -1 : html.indexOf(">", open);
  if (start < 0) return "";
  const close = /<\/title\s*>/gi;
  close.lastIndex = start + 1;
  const end = close.exec(html)?.index ?? -1;
  return end < 0 ? "" : decodeEntities(html.slice(start + 1, end)).trim();
}

// debt: ceiling: tag stripping, no layout or JS rendering; upgrade: a real
// HTML parser if pages come back as menus or empty text.
export function htmlToText(html: string) {
  const text = decodeEntities(stripTags(dropBlocks(html)))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  return { title: pageTitle(html), text };
}
