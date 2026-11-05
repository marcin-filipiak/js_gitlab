export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function plural(count, forms) {
  const n = Math.abs(count);
  if (n === 1) return forms[0];
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return forms[1];
  return forms[2];
}

export function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('pl-PL', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(timestamp);
  }
}

export function truncate(value, max = 80) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function matchesPattern(value, pattern) {
  if (pattern === undefined || pattern === null) return false;
  const text = String(value ?? '');
  if (typeof pattern === 'string' && pattern.length > 2 && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    if (lastSlash > 0) {
      try {
        const source = pattern.slice(1, lastSlash);
        const flags = pattern.slice(lastSlash + 1);
        return new RegExp(source, flags).test(text);
      } catch {
        // Fall through to a plain substring comparison.
      }
    }
  }
  return text.toLowerCase().includes(String(pattern).toLowerCase());
}

export function tokenize(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let started = false;

  for (const char of String(input)) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) throw new Error('Nie zamknięto cudzysłowu w komendzie.');
  if (escaped) current += '\\';
  if (started) tokens.push(current);
  return tokens;
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  const codeSpans = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const index = codeSpans.push(`<code>${code}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
  return text;
}

export function renderInline(value) {
  return inlineMarkdown(value);
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html += `<p>${inlineMarkdown(paragraph.join(' '))}</p>`;
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      flushParagraph();
      const language = line.trim().slice(3).trim();
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      const className = language ? ` class="language-${escapeHtml(language)}"` : '';
      html += `<pre><code${className}>${escapeHtml(buffer.join('\n'))}</code></pre>`;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 1, 5);
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      html += '<ul>';
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        html += `<li>${inlineMarkdown(lines[i].replace(/^[-*]\s+/, ''))}</li>`;
        i += 1;
      }
      html += '</ul>';
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      html += '<ol>';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        html += `<li>${inlineMarkdown(lines[i].replace(/^\d+\.\s+/, ''))}</li>`;
        i += 1;
      }
      html += '</ol>';
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const buffer = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html += `<blockquote><p>${inlineMarkdown(buffer.join(' '))}</p></blockquote>`;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph();
      html += '<hr>';
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph();
  return html;
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
