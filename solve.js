// Fast CSV reader: a drop-in for csv-reader 1.0.0 (make.fun's own reference).
// run(input) returns exactly csv-reader's answer {columns, rows, errors} for
// {text, header}, but reads the text with indexOf jumps and native split
// instead of one character at a time.
//
// Semantics (csv-reader 1.0.0, kept byte for byte):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled
//     ("" inside it is one quote; each CRLF or lone CR inside it reads as LF);
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside quotes
//     counted), row its record's index in rows, null for the header.
//
// Speed shape: most records are clean lines (no quote, no stray CR). Those
// go through one fast path — slice the line, native split on commas. Every
// scan in the fast path is bounded to the line, so total work stays linear
// even on a file with almost no quotes. Anything with a quote or a stray CR
// falls to the slow path, which parses one record with indexOf jumps (never
// one character at a time) and only touches characters around quotes, CRs
// and line breaks.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // The record being read: the line it starts on and its index in rows
  // (null while the header is being read). Error helpers read these.
  let recordLine = 1;
  let recordRow = null;
  // The field just read: its value, how it ended (COMMA, LINE_BREAK, END)
  // and, for a field read unquoted, how many characters were kept. The
  // field readers write these instead of returning a fresh object per field:
  // on quote-heavy input that allocation is the slow path's main cost.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr). Writes the field
  // into fValue/fEnded/fAdded; `added` counts the characters kept.
  function readUnquoted(value, added) {
    let v = value;
    let a = added;
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iL = text.indexOf('\n', pos);
      const iR = text.indexOf('\r', pos);
      let m = -1;
      let kind = 0; // 0 comma, 1 LF, 2 CR
      if (iC !== -1) {
        m = iC;
        kind = 0;
      }
      if (iL !== -1 && (m === -1 || iL < m)) {
        m = iL;
        kind = 1;
      }
      if (iR !== -1 && (m === -1 || iR < m)) {
        m = iR;
        kind = 2;
      }
      if (m === -1) {
        if (pos < n) {
          v += text.slice(pos, n);
          a += n - pos;
          pos = n;
        }
        fValue = v;
        fEnded = END;
        fAdded = a;
        return;
      }
      if (kind === 0) {
        v += text.slice(pos, m);
        a += m - pos;
        pos = m + 1;
        fValue = v;
        fEnded = COMMA;
        fAdded = a;
        return;
      }
      if (kind === 1) {
        v += text.slice(pos, m);
        a += m - pos;
        pos = m + 1;
        line += 1;
        fValue = v;
        fEnded = LINE_BREAK;
        fAdded = a;
        return;
      }
      if (text.charCodeAt(m + 1) === 10) {
        v += text.slice(pos, m);
        a += m - pos;
        pos = m + 2;
        line += 1;
        fValue = v;
        fEnded = LINE_BREAK;
        fAdded = a;
        return;
      }
      // Lone CR: dropped, error stays, reading goes on.
      v += text.slice(pos, m);
      a += m - pos;
      pos = m + 1;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let v = '';
    pos += 1;
    let closed = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q > pos) {
        const seg = text.slice(pos, q);
        if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
          v += seg;
        } else {
          // CRLF and a lone CR inside quotes are each one LF.
          const breaks = seg.match(/\r\n|\r|\n/g);
          if (breaks !== null) line += breaks.length;
          v += seg.replace(/\r\n?/g, '\n');
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        v += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"', 1);
      return;
    }
    if (pos >= n) {
      fValue = v;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = v;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(v, 0);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Finishes a record: first record sets the width (and is the header when
  // header is true); later records are padded or cut to it.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this physical line holds no quote and no stray CR.
    // A CR only as the CRLF terminator is stripped first; a CR anywhere
    // else (including a lone CR ending the text) sends the record to the
    // slow path, as does any quote.
    const le = text.indexOf('\n', pos);
    const hasLf = le !== -1;
    let end = hasLf ? le : n;
    if (hasLf && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
    if (end === pos) {
      // Empty line (cannot normally reach here: the skip loop above
      // consumes it); step past it all the same.
      pos = hasLf ? le + 1 : n;
      line += 1;
      continue;
    }
    const chunk = text.slice(pos, end);
    if (chunk.indexOf('"') === -1 && chunk.indexOf('\r') === -1) {
      finishRecord(chunk.split(','));
      pos = hasLf ? le + 1 : n;
      line += 1;
      continue;
    }

    // Slow path: one record, possibly spanning lines through quoted fields.
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('', 0);
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
