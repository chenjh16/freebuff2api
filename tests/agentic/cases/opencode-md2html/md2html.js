const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const renderInline = (s) => {
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[4] !== undefined) out += `<strong>${escapeHtml(m[4])}</strong>`;
    else out += `<a href="${escapeHtml(m[3])}">${escapeHtml(m[2])}</a>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(s.slice(last));
  return out;
};

function md2html(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let listOpen = false;
  let i = 0;

  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      closeList();
      out.push("<pre><code>");
      i++;
      const buf = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(escapeHtml(buf.join("\n")));
      out.push("</code></pre>");
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    const li = /^-\s+(.*)$/.exec(line);
    if (li) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${renderInline(li[1])}</li>`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    closeList();
    out.push(`<p>${renderInline(line)}</p>`);
    i++;
  }

  closeList();
  return out.join("\n");
}

export { md2html };
