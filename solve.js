// site-generator-speed: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the answer makefun-site 1.0.0 returns for one
// case's input { site, templates, files }: the output tree of the site build,
// byte for byte. Dependency-free, stdlib only, Node 22+.
//
// Speed strategy (measured against the reference on the practice set):
// - Markdown is rendered in one fused pass over the body: no token arrays,
//   no per-line regex battery, no per-character escapeHtml call. Inline
//   markup is resolved on index ranges of the source string, and plain runs
//   are pushed as slices.
// - HTML escaping and slug generation take a fast path when the text is
//   plain ASCII, and slugs / long dates are memoised within one case.
// - Front matter is parsed by scanning lines in place, without splitting
//   the whole source into an array and joining the body back.
// - Templates are rendered by an interpreter over the parsed node tree
//   that writes into an array (joined once) and reuses one scope object
//   per loop execution instead of one per element.
// - Word counting for reading time is a manual scan, not a regex.
//
// The code below is the reference's semantics, reimplemented. Where the
// reference README and its code differ, the code wins; every rule here was
// checked against the reference code, not just its README.

/** The HTML escape table: & < > " ' and nothing else. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
/** The characters a backslash escapes in inline Markdown. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a UTF-16 code unit is JavaScript whitespace (\s). */
function isWS(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0x85 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
  );
}

/**
 * `s` with & < > " ' escaped. Fast path: the string is returned untouched
 * when it holds none of them.
 */
function escapeStr(s) {
  if (!ESC_TEST.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const rep = ESCAPES[s[i]];
    if (rep !== undefined) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text` (memoised within the case by `memo`): NFKD, combining
 * marks dropped, A-Z lowered, every run of characters other than a-z and 0-9
 * one "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), "untitled" when nothing is left.
 */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone (memoised within the case). */
function longDate(date, memo) {
  const hit = memo.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  memo.set(date, out);
  return out;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Whether `code` is a lower-case letter or underscore (a front-matter key character). */
function isKeyChar(code) {
  return (code >= 97 && code <= 122) || code === 95;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const okShape =
        raw.length === 10 &&
        raw.charCodeAt(4) === 45 &&
        raw.charCodeAt(7) === 45 &&
        digit4(raw, 0) &&
        digit2(raw, 5) &&
        digit2(raw, 8);
      const y = okShape ? Number(raw.slice(0, 4)) : 0;
      const mo = okShape ? Number(raw.slice(5, 7)) : 0;
      const d = okShape ? Number(raw.slice(8, 10)) : 0;
      if (!okShape || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function digit4(s, at) {
  for (let k = 0; k < 4; k++) {
    const c = s.charCodeAt(at + k);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function digit2(s, at) {
  const a = s.charCodeAt(at);
  const b = s.charCodeAt(at + 1);
  return a >= 48 && a <= 57 && b >= 48 && b <= 57;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are scanned in
 * place; the body is the slice after the closing "---" line.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line first: a line exactly "---" after the first.
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 2;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const closeLineNo = lineNo;
  const data = {};
  pos = firstNl === -1 ? text.length : firstNl + 1;
  lineNo = 2;
  while (lineNo < closeLineNo) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    let j = pos;
    let blank = true;
    while (j < end) {
      const c = text.charCodeAt(j);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
      j++;
    }
    if (!blank && text.charCodeAt(pos) !== 35) {
      // A "key: value" line: key of a-z and _, a colon, one space, the value.
      let k = pos;
      while (k < end && isKeyChar(text.charCodeAt(k))) k++;
      if (k === pos || k >= end || text.charCodeAt(k) !== 58) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = text.slice(pos, k);
      k++;
      let raw;
      if (k === end) raw = '';
      else if (text.charCodeAt(k) === 32) raw = text.slice(k + 1, end);
      else return { error: `line ${lineNo} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c !== 32 && c !== 9) break;
        rEnd--;
      }
      raw = raw.slice(0, rEnd);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown
//
// A fused single-pass renderer: the body is scanned line by line on index
// ranges (no split into a line array, no token array), and inline markup is
// resolved on ranges of the source string, writing into an array that is
// joined once. Every rule mirrors the reference's lex + renderMarkdown.

/** A line's [start, end) with spaces and tabs stripped at both ends. */
function trimRange(s, a, b) {
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return [a, b];
}

/** Whether the line [a, b) is blank (spaces and tabs only). */
function lineBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language ("" when none), or null when not a fence open. */
function fenceLang(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether the line [a, b) closes a fence: ``` then spaces or tabs only. */
function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, textStart, textEnd }, or null (a heading's text is never empty). */
function headingInfo(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 35) i++;
  const depth = i - a;
  if (depth === 0 || depth > 6) return null;
  if (i >= b) return null;
  let c = s.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < b) {
    c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  let end = b;
  while (end > i) {
    c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  if (end === i) return null;
  return { depth, textStart: i, textEnd: end };
}

/** Whether the line [a, b) is a thematic break: --- or *** then spaces or tabs only. */
function isHR(s, a, b) {
  if (b - a < 3) return false;
  const c = s.charCodeAt(a);
  if (c !== 45 && c !== 42) return false;
  if (s.charCodeAt(a + 1) !== c || s.charCodeAt(a + 2) !== c) return false;
  for (let i = a + 3; i < b; i++) {
    const cc = s.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A list-marker line: { ordered, start, textStart } or null. */
function listInfo(s, a, b) {
  const c0 = s.charCodeAt(a);
  if ((c0 === 45 || c0 === 42) && b - a >= 2 && s.charCodeAt(a + 1) === 32) {
    return { ordered: false, start: 1, textStart: a + 2 };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = a;
    let num = 0;
    let digits = 0;
    while (i < b && digits < 10) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      num = num * 10 + (c - 48);
      digits++;
      i++;
    }
    if (digits >= 1 && digits <= 9 && i + 1 < b && s.charCodeAt(i) === 46 && s.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: num, textStart: i + 2 };
    }
  }
  return null;
}

/** Whether the line [a, b) continues a list item: two or more spaces, then a non-space. */
function isContinued(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 32) i++;
  if (i - a < 2 || i >= b) return false;
  return !isWS(s.charCodeAt(i));
}

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_TEST = /\s/;

/** `s[a..b)` rendered inline into `out`; `env.link(target)` resolves a link's href.
 * Plain runs are pushed as slices: the scan below handles every HTML-special
 * character (& < > " ') itself, so a run never holds one. */
function inline(s, a, b, env, out) {
  let i = a;
  let run = a;
  const flush = (to) => {
    if (to > run) out.push(s.slice(run, to));
  };
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        flush(i);
        out.push('<code>', escapeStr(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inline(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inline(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      const m = k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= b ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_TEST.test(target)) {
        flush(i);
        out.push('<a href="', escapeStr(env.link(target)), '">');
        inline(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      flush(i);
      out.push(ESCAPES[s[i]]);
      i++;
      run = i;
      continue;
    }
    i++;
  }
  flush(b);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(cx, src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const nl = src.indexOf('\n', i);
    const end = nl === -1 ? n : nl;
    const next = nl === -1 ? n : nl + 1;
    // An empty line is blank. Otherwise the first character decides what
    // the line can be: space/tab blank or paragraph; ` fence or paragraph;
    // # heading or paragraph; -/* break, bullet or paragraph; > quote;
    // digit ordered list or paragraph; anything else paragraph only.
    if (end === i) {
      i = next;
      continue;
    }
    const c0 = src.charCodeAt(i);
    if (c0 === 32 || c0 === 9) {
      if (lineBlank(src, i, end)) {
        i = next;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(src, i, end);
      if (lang !== null) {
        const lines = [];
        i = next;
        while (i < n) {
          const nl2 = src.indexOf('\n', i);
          const end2 = nl2 === -1 ? n : nl2;
          if (fenceClose(src, i, end2)) {
            i = nl2 === -1 ? n : nl2 + 1;
            break;
          }
          lines.push(src.slice(i, end2));
          i = nl2 === -1 ? n : nl2 + 1;
        }
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        let code = `<pre><code${cls}>`;
        for (const l of lines) code += `${escapeStr(l)}\n`;
        code += '</code></pre>';
        blocks.push(code);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingInfo(src, i, end);
      if (h !== null) {
        const text = src.slice(h.textStart, h.textEnd);
        const id = uniqueSlug(slugify(text, cx.slugMemo), ids);
        const out = [];
        inline(src, h.textStart, h.textEnd, env, out);
        const html = out.join('');
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i = next;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(src, i, end)) {
        blocks.push('<hr>');
        i = next;
        continue;
      }
      const li = listInfo(src, i, end);
      if (li !== null) {
        const isOrdered = li.ordered;
        const start = li.start;
        const items = [];
        while (i < n) {
          const nl2 = src.indexOf('\n', i);
          const end2 = nl2 === -1 ? n : nl2;
          const m = listInfo(src, i, end2);
          if (m !== null && m.ordered === isOrdered) {
            const [ta, tb] = trimRange(src, m.textStart, end2);
            items.push([src.slice(ta, tb)]);
            i = nl2 === -1 ? n : nl2 + 1;
          } else if (isContinued(src, i, end2)) {
            const [ta, tb] = trimRange(src, i, end2);
            items[items.length - 1].push(src.slice(ta, tb));
            i = nl2 === -1 ? n : nl2 + 1;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        let html = `${open}\n`;
        for (const parts of items) {
          const text = parts.join('\n');
          const out = [];
          inline(text, 0, text.length, env, out);
          html += `<li>${out.join('')}</li>\n`;
        }
        html += `</${tag}>`;
        blocks.push(html);
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n) {
        const nl2 = src.indexOf('\n', i);
        const end2 = nl2 === -1 ? n : nl2;
        if (src.charCodeAt(i) !== 62) break;
        let a = i + 1;
        if (a < end2 && src.charCodeAt(a) === 32) a++;
        const [ta, tb] = trimRange(src, a, end2);
        if (tb > ta) parts.push(src.slice(ta, tb));
        i = nl2 === -1 ? n : nl2 + 1;
      }
      if (parts.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const text = parts.join('\n');
        const out = [];
        inline(text, 0, text.length, env, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>`);
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const li = listInfo(src, i, end);
      if (li !== null) {
        const start = li.start;
        const items = [];
        while (i < n) {
          const nl2 = src.indexOf('\n', i);
          const end2 = nl2 === -1 ? n : nl2;
          const m = listInfo(src, i, end2);
          if (m !== null && m.ordered) {
            const [ta, tb] = trimRange(src, m.textStart, end2);
            items.push([src.slice(ta, tb)]);
            i = nl2 === -1 ? n : nl2 + 1;
          } else if (isContinued(src, i, end2)) {
            const [ta, tb] = trimRange(src, i, end2);
            items[items.length - 1].push(src.slice(ta, tb));
            i = nl2 === -1 ? n : nl2 + 1;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (const parts of items) {
          const text = parts.join('\n');
          const out = [];
          inline(text, 0, text.length, env, out);
          html += `<li>${out.join('')}</li>\n`;
        }
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break. A quote, list or digit line does
    // not end one, so only space/tab, `, #, - and * lines are checked.
    const [ta, tb] = trimRange(src, i, end);
    const parts = [src.slice(ta, tb)];
    i = next;
    while (i < n) {
      const nl2 = src.indexOf('\n', i);
      const end2 = nl2 === -1 ? n : nl2;
      if (end2 === i) break;
      const c2 = src.charCodeAt(i);
      if (c2 === 32 || c2 === 9) {
        if (lineBlank(src, i, end2)) break;
      } else if (c2 === 96) {
        if (fenceLang(src, i, end2) !== null) break;
      } else if (c2 === 35) {
        if (headingInfo(src, i, end2) !== null) break;
      } else if (c2 === 45 || c2 === 42) {
        if (isHR(src, i, end2)) break;
      }
      const [pa, pb] = trimRange(src, i, end2);
      parts.push(src.slice(pa, pb));
      i = nl2 === -1 ? n : nl2 + 1;
    }
    const text = parts.join('\n');
    const out = [];
    inline(text, 0, text.length, env, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates
//
// The dialect: {{ path }} escaped, {{{ path }}} raw, {% for x in path %},
// {% if [not] path %} with optional {% else %}, {% include "name" %} at most
// 8 deep, and a {% %} tag alone on its line takes the whole line with it.
// Templates parse once into a node tree; rendering walks the tree in a chain
// of scopes, writing into an array that is joined once at the end.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` holds only spaces and tabs. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out`. `ctx` holds the
 * parsed templates, the HTML escape and the include depth. A loop reuses one
 * scope object for all of its elements: nothing a template can do keeps a
 * reference to it past its element's render.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The whitespace a body can hold: space, tab, LF, VT, FF, CR, and the
    // non-ASCII whitespace set; anything else starts or continues a word.
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWS(c))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const cx = {
    slugMemo: new Map(),
    dateMemo: new Map(),
    templates: new Map(),
    report: [],
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    resolveCache: new Map(),
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    base: input.site.base_url.replace(/\/+$/, ''),
    input,
  };
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      cx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      cx.report.push(err.message);
    }
  }
  readSources(cx);
  frontMatter(cx);
  permalinks(cx);
  markdown(cx);
  collections(cx);
  tags(cx);
  layouts(cx);
  report(cx);
  return cx.output;
}

/** 1. The sources, in code-unit order of their paths; a source that is not .md is static. */
function readSources(cx) {
  const files = [...cx.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      cx.sources.push({ path: f.path, text: content });
    } else cx.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(cx) {
  const kept = [];
  for (const s of cx.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      cx.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      cx.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      cx.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!cx.templates.has(layout)) {
      cx.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      cx.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  cx.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(cx) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of cx.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cx.slugMemo), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${cx.base}/${s.outDir}/`;
    cx.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(cx) {
  const staticPaths = new Set(cx.statics.map((f) => f.path));
  for (const s of cx.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path = null;
        if (rel !== '') {
          const key = `${dir}\n${rel}`;
          if (cx.resolveCache.has(key)) path = cx.resolveCache.get(key);
          else {
            path = resolvePath(dir, rel);
            cx.resolveCache.set(key, path);
          }
        }
        if (path !== null && cx.bySource.has(path)) return `${cx.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${cx.base}/${path}${frag}`;
        cx.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(cx, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(cx) {
  const posts = cx.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  cx.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(cx) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name, cx.slugMemo);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of cx.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, cx.slugMemo);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${cx.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of cx.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, cx.slugMemo);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  cx.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (cx, s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateMemo),
      };

/** A tag as templates read it (its posts as cards). */
const tagOf = (cx, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cx.cards.get(p)) });

/** A post's card, as lists show it. */
function cardOf(cx, s) {
  const hit = s.card;
  if (hit !== undefined) return hit;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateMemo),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
function pageOf(cx, s) {
  return {
    ...cardOf(cx, s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(cx, s.newer ?? null),
    older: linkOf(cx, s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(cx) {
  cx.cards = new Map(cx.posts.map((p) => [p, cardOf(cx, p)]));
  const site = { title: cx.input.site.title, base_url: cx.base };
  const allTags = cx.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = cx.posts.slice(0, cx.input.site.recent).map((p) => cx.cards.get(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates: cx.templates, escape: escapeStr };
  const render = (name, vars) => {
    const nodes = cx.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of cx.sources) cx.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(cx, s) });
  const per = cx.input.site.per_page;
  const pages = Math.max(1, Math.ceil(cx.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${cx.base}/` : `${cx.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: cx.posts.slice((k - 1) * per, k * per).map((p) => cx.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) cx.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of cx.tags) {
    const html = render('tag', { tag: tagOf(cx, t) });
    if (html !== null) cx.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) cx.output['tags/index.html'] = tagsHtml;
  for (const f of cx.statics) {
    if (Object.hasOwn(cx.output, f.path)) cx.report.push(`shadowed ${f.path}: a built page has its path`);
    else cx.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(cx) {
  const lines = [...cx.report, ...cx.broken].sort(byCodeUnits);
  const pages = cx.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${cx.posts.length} posts, ${cx.tags.length} tags and ${cx.statics.length} static files`);
  cx.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}
