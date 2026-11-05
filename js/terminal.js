export class Terminal {
  constructor(root, options = {}) {
    this.root = root;
    this.onCommand = options.onCommand ?? (() => ({ lines: [] }));
    this.getPrompt = options.getPrompt ?? (() => '$');
    this.afterCommand = options.afterCommand ?? null;
    this.lines = [];
    this.commandHistory = [];
    this.historyIndex = 0;
    this.draft = '';
    this.maxLines = 500;

    this.root.innerHTML = '';
    this.root.classList.add('terminal');

    this.output = document.createElement('div');
    this.output.className = 'terminal-output';
    this.output.setAttribute('aria-live', 'polite');

    this.form = document.createElement('form');
    this.form.className = 'terminal-input-row';

    this.promptEl = document.createElement('span');
    this.promptEl.className = 'term-prompt';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.autocapitalize = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Pole komendy terminala');
    this.input.placeholder = 'wpisz komendę, np. git status';

    this.form.append(this.promptEl, this.input);
    this.root.append(this.output, this.form);

    this.refreshPrompt();
    this.bindEvents();
    this.focus();
  }

  bindEvents() {
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });

    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.browseHistory(-1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.browseHistory(1);
      } else if (event.key === 'l' && event.ctrlKey) {
        event.preventDefault();
        this.clear();
        this.afterCommand?.();
      }
    });

    this.root.addEventListener('click', (event) => {
      if (!window.getSelection()?.toString() && event.target !== this.input) {
        this.focus();
      }
    });
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  refreshPrompt() {
    this.promptEl.textContent = this.getPrompt();
  }

  submit() {
    const command = this.input.value.trim();
    if (!command) return;

    const prompt = this.getPrompt();
    this.input.value = '';
    this.input.placeholder = 'wpisz komendę, np. git status';
    this.commandHistory.push(command);
    this.historyIndex = this.commandHistory.length;
    this.draft = '';

    this.appendLine({ prompt, text: command, type: 'command' });

    let result;
    try {
      result = this.onCommand(command);
    } catch (error) {
      result = { lines: [{ text: error.message, type: 'error' }], ok: false };
    }

    if (result?.clear) this.clear();

    for (const entry of result?.lines ?? []) {
      this.appendLine(typeof entry === 'string' ? { text: entry } : entry);
    }

    this.refreshPrompt();
    this.focus();
    this.afterCommand?.();
  }

  appendLine(entry, options = {}) {
    const normalized = {
      text: String(entry.text ?? ''),
      type: entry.type ?? 'plain'
    };
    if (entry.prompt) normalized.prompt = entry.prompt;

    this.lines.push(normalized);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.output.firstElementChild?.remove();
    }
    this.output.appendChild(this.renderLine(normalized));
    if (options.persist !== false) this.scrollToBottom();
  }

  renderLine(entry) {
    const element = document.createElement('div');
    element.className = `term-line term-line--${entry.type || 'plain'}`;
    if (entry.type === 'command') {
      const prompt = document.createElement('span');
      prompt.className = 'term-prompt';
      prompt.textContent = `${entry.prompt ?? '$'} `;
      const command = document.createElement('span');
      command.className = 'term-cmd';
      command.textContent = entry.text;
      element.append(prompt, command);
    } else {
      element.textContent = entry.text || '\u00a0';
    }
    return element;
  }

  addLines(entries) {
    for (const entry of entries) {
      this.appendLine(typeof entry === 'string' ? { text: entry } : entry);
    }
  }

  clear() {
    this.lines = [];
    this.output.innerHTML = '';
  }

  scrollToBottom() {
    this.output.scrollTop = this.output.scrollHeight;
  }

  restore(lines, commandHistory = []) {
    this.lines = [];
    this.output.innerHTML = '';
    for (const entry of Array.isArray(lines) ? lines : []) {
      this.appendLine(entry, { persist: false });
    }
    this.commandHistory = [...commandHistory];
    this.historyIndex = this.commandHistory.length;
    this.scrollToBottom();
  }

  getLines() {
    return this.lines.map((entry) => ({ ...entry }));
  }

  setCommandHistory(commands) {
    this.commandHistory = [...commands];
    this.historyIndex = this.commandHistory.length;
  }

  browseHistory(direction) {
    if (!this.commandHistory.length) return;
    if (this.historyIndex === this.commandHistory.length) {
      this.draft = this.input.value;
    }
    const next = Math.min(
      this.commandHistory.length,
      Math.max(0, this.historyIndex + direction)
    );
    this.historyIndex = next;
    if (next === this.commandHistory.length) {
      this.input.value = this.draft;
    } else {
      this.input.value = this.commandHistory[next];
    }
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }
}
