import { VirtualFS } from './fs.js';
import { GitEngine } from './git.js';
import { CommandRunner } from './commands.js';
import { Terminal } from './terminal.js';
import { loadExercises, evaluateExercise, isExerciseComplete } from './exercises.js';
import {
  escapeHtml,
  renderMarkdown,
  renderInline,
  plural,
  formatDate,
  truncate
} from './utils.js';

const PROGRESS_KEY = 'gitlab.progress.v1';
const STATE_PREFIX = 'gitlab.state.v1.';

const GRAPH_COLORS = [
  'var(--accent)',
  'var(--teal)',
  'var(--blue)',
  'var(--violet)',
  'var(--yellow)',
  'var(--green)',
  'var(--red)'
];

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export class App {
  constructor() {
    this.dom = {
      loading: document.getElementById('loading'),
      brief: document.getElementById('brief-panel'),
      exerciseList: document.getElementById('exercise-list'),
      exerciseCount: document.getElementById('exercise-count'),
      progressText: document.getElementById('progress-text'),
      progressPercent: document.getElementById('progress-percent'),
      progressBar: document.getElementById('progress-bar'),
      reset: document.getElementById('reset-exercise'),
      themeToggle: document.getElementById('theme-toggle'),
      themeIcon: document.getElementById('theme-icon'),
      tabs: document.querySelector('.tabs'),
      terminalView: document.getElementById('view-terminal'),
      filesView: document.getElementById('view-files'),
      historyView: document.getElementById('view-history'),
      filesList: document.getElementById('files-list'),
      filesCount: document.getElementById('files-count'),
      newFile: document.getElementById('new-file'),
      historyList: document.getElementById('history-list'),
      historyNote: document.getElementById('history-note'),
      repoStatus: document.getElementById('repo-status'),
      modalRoot: document.getElementById('modal-root'),
      toastRoot: document.getElementById('toast-root')
    };

    this.progress = this.loadProgress();
    this.exercises = [];
    this.loadErrors = [];
    this.current = null;
    this.fs = null;
    this.git = null;
    this.runner = null;
    this.terminal = null;
    this.history = [];
    this.tasks = [];
    this.currentComplete = false;
    this.activeModal = null;
    this.storageWarningShown = false;
  }

  async init() {
    this.applyTheme(this.progress.theme);
    this.bindEvents();

    try {
      const { exercises, errors } = await loadExercises();
      this.exercises = exercises;
      this.loadErrors = errors;
      this.renderSidebar();

      const target =
        exercises.find((exercise) => exercise.id === this.progress.activeId) ?? exercises[0];
      this.selectExercise(target.id);

      if (errors.length) {
        console.error('Błędy wczytywania ćwiczeń:', errors);
        setTimeout(() => {
          this.toast(
            `Nie udało się wczytać ${errors.length} ${plural(errors.length, [
              'ćwiczenia',
              'ćwiczeń',
              'ćwiczeń'
            ])}: ${errors.map((error) => error.file).join(', ')}. Szczegóły znajdziesz w konsoli (F12).`,
            'error',
            7000
          );
        }, 500);
      }
    } catch (error) {
      console.error(error);
      this.showFatal(error);
    }

    this.hideLoading();
  }

  /* ---------- State ---------- */

  loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        completed: Array.isArray(parsed.completed) ? parsed.completed : [],
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        theme: parsed.theme === 'light' ? 'light' : 'dark'
      };
    } catch {
      return { completed: [], activeId: null, theme: 'dark' };
    }
  }

  saveProgress() {
    try {
      this.progress.activeId = this.current?.id ?? this.progress.activeId;
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(this.progress));
    } catch {
      // Ignore storage failures (for example in private mode).
    }
  }

  loadState(exerciseId) {
    try {
      const raw = localStorage.getItem(STATE_PREFIX + exerciseId);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || typeof state !== 'object') return null;
      return state;
    } catch {
      return null;
    }
  }

  saveState() {
    if (!this.current || !this.git || !this.fs) return;
    try {
      localStorage.setItem(
        STATE_PREFIX + this.current.id,
        JSON.stringify({
          version: 1,
          files: this.fs.snapshot(),
          git: this.git.toJSON(),
          history: this.history.slice(-300),
          terminalLines: this.terminal?.getLines() ?? [],
          savedAt: Date.now()
        })
      );
    } catch (error) {
      console.warn('Nie udało się zapisać stanu ćwiczenia:', error);
      if (!this.storageWarningShown) {
        this.storageWarningShown = true;
        this.toast('Nie udało się zapisać stanu w przeglądarce. Pamięć lokalna może być pełna.', 'error', 7000);
      }
    }
  }

  /* ---------- Exercise lifecycle ---------- */

  selectExercise(id, options = {}) {
    const exercise = this.exercises.find((item) => item.id === id);
    if (!exercise) return;
    if (!options.fresh && this.current?.id === id) return;

    if (this.current && this.current.id !== id) this.saveState();

    const saved = options.fresh ? null : this.loadState(exercise.id);
    this.current = exercise;
    this.fs = new VirtualFS(exercise.initialFiles);
    if (saved?.files) this.fs.load(saved.files);
    this.git = new GitEngine(this.fs, saved?.git ?? null);
    this.history = Array.isArray(saved?.history)
      ? saved.history
          .map((entry) =>
            typeof entry === 'string' ? { command: entry, ok: true } : entry
          )
          .filter((entry) => entry && typeof entry.command === 'string')
      : [];

    this.runner = new CommandRunner({
      fs: this.fs,
      git: this.git,
      onEdit: (path) => this.openFileEditor(path)
    });

    const setupErrors = [];
    if (!saved && exercise.setupCommands.length) {
      for (const command of exercise.setupCommands) {
        const result = this.runner.run(command);
        if (!result.ok) setupErrors.push(command);
      }
    }

    this.createTerminal(saved);
    this.tasks = evaluateExercise(exercise, {
      git: this.git,
      fs: this.fs,
      history: this.history
    });
    this.currentComplete = isExerciseComplete(this.tasks);

    if (this.currentComplete && !this.progress.completed.includes(exercise.id)) {
      this.progress.completed.push(exercise.id);
      this.saveProgress();
    }

    this.renderBrief();
    this.renderSidebar();
    this.refreshRepoUI({ celebrate: false });
    this.saveState();
    this.saveProgress();
    this.switchTab('terminal', { focus: true });

    if (setupErrors.length) {
      this.toast(
        `Nie udało się wykonać części konfiguracji ćwiczenia: ${setupErrors.join(', ')}`,
        'error',
        7000
      );
    }
  }

  createTerminal(saved) {
    this.terminal = new Terminal(this.dom.terminalView, {
      onCommand: (command) => this.handleCommand(command),
      getPrompt: () => this.prompt(),
      afterCommand: () => this.saveState()
    });

    if (saved && Array.isArray(saved.terminalLines) && saved.terminalLines.length) {
      this.terminal.restore(
        saved.terminalLines,
        this.history.map((entry) => entry.command)
      );
    } else {
      this.terminal.addLines([
        { text: `Git Lab — ${this.current.title}`, type: 'heading' },
        {
          text: 'Wpisz "help", aby zobaczyć dostępne komendy, albo "git help" dla komend Git.',
          type: 'muted'
        },
        { text: '', type: 'plain' }
      ]);
    }
  }

  prompt() {
    if (!this.git?.initialized) return 'student@gitlab:~/repo$';
    if (this.git.head?.type === 'detached') {
      return `student@gitlab:~/repo (HEAD ${this.git.headSha()?.slice(0, 7)}) $`;
    }
    return `student@gitlab:~/repo (${this.git.currentBranch()}) $`;
  }

  handleCommand(raw) {
    const result = this.runner.run(raw);
    this.history.push({ command: raw, ok: Boolean(result.ok) });
    if (this.history.length > 400) this.history.shift();
    this.refreshRepoUI({ celebrate: true });
    return result;
  }

  /* ---------- Progress & sidebar ---------- */

  renderSidebar() {
    this.dom.exerciseList.innerHTML = '';
    this.dom.exerciseCount.textContent = String(this.exercises.length);

    this.exercises.forEach((exercise, index) => {
      const done = this.progress.completed.includes(exercise.id);
      const active = this.current?.id === exercise.id;
      const button = el(
        'button',
        {
          className: `exercise-item${active ? ' is-active' : ''}${done ? ' is-done' : ''}`,
          type: 'button',
          title: exercise.title,
          onClick: () => this.selectExercise(exercise.id)
        },
        el('span', { className: 'exercise-num' }, done ? '✓' : String(index + 1).padStart(2, '0')),
        el(
          'span',
          { className: 'exercise-meta' },
          el('span', { className: 'exercise-title' }, exercise.title),
          el(
            'span',
            { className: 'exercise-sub' },
            `${exercise.level}${exercise.estimatedMinutes ? ` · ${exercise.estimatedMinutes} min` : ''}`
          )
        ),
        done ? el('span', { className: 'exercise-check', title: 'Ukończone' }, '✓') : null
      );
      this.dom.exerciseList.append(button);
    });

    this.updateProgressHeader();
  }

  updateProgressHeader() {
    const ids = new Set(this.exercises.map((exercise) => exercise.id));
    const completed = this.progress.completed.filter((id) => ids.has(id)).length;
    const total = this.exercises.length;
    const percent = total ? Math.round((completed / total) * 100) : 0;
    this.dom.progressText.textContent = `${completed} / ${total}`;
    this.dom.progressPercent.textContent = `${percent}%`;
    this.dom.progressBar.style.width = `${percent}%`;
  }

  /* ---------- Tabs ---------- */

  switchTab(name, options = {}) {
    const tab = this.dom.tabs.querySelector(`.tab[data-tab="${name}"]`);
    if (!tab) return;

    for (const button of this.dom.tabs.querySelectorAll('.tab')) {
      const active = button === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }

    const views = {
      terminal: this.dom.terminalView,
      files: this.dom.filesView,
      history: this.dom.historyView
    };
    for (const [viewName, view] of Object.entries(views)) {
      view.classList.toggle('is-active', viewName === name);
    }

    if (name === 'files') this.renderFiles();
    if (name === 'history') this.renderHistory();
    if (name === 'terminal' && options.focus !== false) this.terminal?.focus();
  }

  /* ---------- Theme, toast, fatal ---------- */

  applyTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = value;
    this.dom.themeIcon.textContent = value === 'dark' ? '☀' : '☾';
    this.dom.themeToggle.title = value === 'dark' ? 'Włącz jasny motyw' : 'Włącz ciemny motyw';
  }

  toggleTheme() {
    this.progress.theme = this.progress.theme === 'light' ? 'dark' : 'light';
    this.applyTheme(this.progress.theme);
    this.saveProgress();
  }

  toast(message, type = 'info', timeout = 4200) {
    const icons = { success: '✓', error: '!', info: 'i' };
    const node = el(
      'div',
      { className: `toast toast--${type}`, role: 'status' },
      el('span', { className: 'toast-icon' }, icons[type] ?? 'i'),
      el('span', {}, message)
    );
    node.addEventListener('click', () => node.remove());
    this.dom.toastRoot.append(node);

    while (this.dom.toastRoot.children.length > 4) {
      this.dom.toastRoot.firstElementChild?.remove();
    }
    setTimeout(() => node.remove(), timeout);
  }

  showFatal(error) {
    const message = error?.message ?? String(error);
    this.dom.brief.innerHTML = `
      <div class="brief-head">
        <div class="brief-eyebrow"><span class="level-badge">Błąd</span></div>
        <h1>Nie można uruchomić Git Lab</h1>
        <p class="brief-summary">Aplikacja nie mogła wczytać plików ćwiczeń.</p>
      </div>
      <div class="description">
        <p>${escapeHtml(message)}</p>
        <p>Uruchom lokalny serwer w katalogu projektu:</p>
        <pre><code>npm start</code></pre>
        <p>lub:</p>
        <pre><code>python3 -m http.server 8080</code></pre>
        <p>Następnie otwórz <code>http://localhost:4173</code> (dla <code>npm start</code>) lub <code>http://localhost:8080</code>.</p>
        <blockquote><p>Otwieranie pliku <code>index.html</code> bezpośrednio z dysku blokuje wczytywanie plików JSON przez przeglądarkę.</p></blockquote>
      </div>
    `;
    this.dom.reset.disabled = true;
    this.dom.newFile.disabled = true;
    this.updateProgressHeader();
  }

  hideLoading() {
    this.dom.loading.classList.add('is-hidden');
    setTimeout(() => {
      this.dom.loading.style.display = 'none';
    }, 320);
  }

  /* ---------- Events ---------- */

  bindEvents() {
    this.dom.themeToggle.addEventListener('click', () => this.toggleTheme());
    this.dom.reset.addEventListener('click', () => this.resetExercise());
    this.dom.newFile.addEventListener('click', () => this.openFileEditor('', { isNew: true }));

    this.dom.tabs.addEventListener('click', (event) => {
      const button = event.target.closest('.tab[data-tab]');
      if (button) this.switchTab(button.dataset.tab);
    });

    this.dom.filesList.addEventListener('click', (event) => {
      const row = event.target.closest('[data-file]');
      if (row) this.openFileEditor(row.dataset.file);
    });

    this.dom.historyList.addEventListener('click', (event) => {
      const row = event.target.closest('[data-sha]');
      if (row) this.showCommitDetail(row.dataset.sha);
    });

    window.addEventListener('beforeunload', () => this.saveState());
  }

  /* ---------- Refresh ---------- */

  refreshRepoUI(options = {}) {
    if (!this.current || !this.git) return;
    this.updateStatusBar();
    this.renderFiles();
    this.renderHistory();
    this.updateTasks({ celebrate: Boolean(options.celebrate) });
    this.updateProgressHeader();
  }

  updateStatusBar() {
    this.dom.repoStatus.innerHTML = '';

    if (!this.git.initialized) {
      this.dom.repoStatus.append(
        el(
          'span',
          { className: 'branch' },
          el('span', { className: 'dot empty' }),
          'brak repozytorium'
        ),
        el('span', { className: 'clean-label' }, 'git init')
      );
      return;
    }

    const status = this.git.getStatus();
    const changes =
      status.staged.length +
      status.unstaged.length +
      status.untracked.length +
      status.conflicts.length;
    const branchLabel = status.detached
      ? `HEAD ${status.headSha?.slice(0, 7) ?? ''}`
      : status.branch ?? 'main';

    this.dom.repoStatus.append(
      el(
        'span',
        { className: 'branch', title: status.detached ? 'Tryb odłączony' : 'Bieżąca gałąź' },
        el('span', { className: `dot ${changes ? 'dirty' : ''}` }),
        `⎇ ${branchLabel}`
      )
    );

    if (status.merge) {
      this.dom.repoStatus.append(el('span', { className: 'dirty-label' }, 'scalanie'));
    } else if (changes) {
      this.dom.repoStatus.append(
        el(
          'span',
          { className: 'dirty-label' },
          `${changes} ${plural(changes, ['zmiana', 'zmiany', 'zmian'])}`
        )
      );
    } else {
      this.dom.repoStatus.append(el('span', { className: 'clean-label' }, 'czysto'));
    }
  }

  renderFiles() {
    if (!this.current) return;
    const status = this.git.initialized
      ? this.git.getStatus()
      : { staged: [], unstaged: [], untracked: [], ignored: [], conflicts: [] };

    const staged = new Map(status.staged.map((entry) => [entry.path, entry.status]));
    const unstaged = new Map(status.unstaged.map((entry) => [entry.path, entry.status]));
    const untracked = new Set(status.untracked);
    const ignored = new Set(status.ignored ?? []);
    const conflicts = new Set(status.conflicts);

    const paths = new Set(this.fs.files.keys());
    if (this.git.initialized) {
      for (const path of Object.keys(this.git.index)) paths.add(path);
      for (const path of Object.keys(this.git.getHeadTree())) paths.add(path);
    }
    const sortedPaths = [...paths].sort((a, b) => a.localeCompare(b, 'pl'));

    this.dom.filesList.innerHTML = '';
    this.dom.filesCount.textContent = String(this.fs.files.size);

    if (!sortedPaths.length) {
      this.dom.filesList.append(
        el(
          'div',
          { className: 'empty-state' },
          el('strong', {}, 'Brak plików'),
          el('span', {}, 'Utwórz pierwszy plik przyciskiem „+ Nowy plik”'),
          el('span', {}, 'albo wpisz w terminalu: '),
          el('code', {}, 'touch README.md')
        )
      );
      return;
    }

    for (const path of sortedPaths) {
      const exists = this.fs.exists(path);
      const content = exists ? this.fs.read(path) : '';
      const badges = [];

      if (conflicts.has(path)) {
        badges.push(el('span', { className: 'file-badge file-badge--conflict', title: 'Konflikt scalania' }, '!'));
      }
      if (staged.has(path)) {
        const statusValue = staged.get(path);
        const letter = statusValue === 'added' ? 'A' : statusValue === 'deleted' ? 'D' : 'M';
        badges.push(
          el('span', {
            className: 'file-badge file-badge--staged',
            title: `W poczekalni: ${statusValue === 'added' ? 'nowy' : statusValue === 'deleted' ? 'usunięty' : 'zmodyfikowany'}`
          }, letter)
        );
      }
      if (unstaged.has(path)) {
        const statusValue = unstaged.get(path);
        badges.push(
          el('span', {
            className: 'file-badge file-badge--modified',
            title: `Niezatwierdzona zmiana: ${statusValue === 'deleted' ? 'usunięty' : 'zmodyfikowany'}`
          }, statusValue === 'deleted' ? 'D' : 'M')
        );
      } else if (ignored.has(path)) {
        badges.push(
          el('span', { className: 'file-badge file-badge--ignored', title: 'Plik ignorowany przez .gitignore' }, 'I')
        );
      } else if (untracked.has(path)) {
        badges.push(el('span', { className: 'file-badge file-badge--untracked', title: 'Plik nieśledzony' }, 'U'));
      }

      const base = path.split('/').pop() ?? path;
      const dotIndex = base.lastIndexOf('.');
      const extension = dotIndex > 0 ? base.slice(dotIndex + 1).slice(0, 3).toUpperCase() : 'FILE';

      const row = el(
        'button',
        {
          className: `file-row${exists ? '' : ' is-deleted'}`,
          type: 'button',
          dataset: { file: path },
          title: `${path} — kliknij, aby edytować`
        },
        el('span', { className: 'file-icon' }, extension || 'FILE'),
        el('span', { className: 'file-name' }, path),
        ...badges,
        el('span', { className: 'file-meta' }, exists ? formatBytes(content) : 'usunięty')
      );
      this.dom.filesList.append(row);
    }
  }

  renderHistory() {
    if (!this.current) return;
    this.dom.historyList.innerHTML = '';

    const commits = this.git.initialized ? this.git.getGraphCommits() : [];
    this.dom.historyNote.textContent = !this.git.initialized
      ? 'Zainicjalizuj repozytorium, aby zobaczyć historię.'
      : commits.length
        ? `${commits.length} ${plural(commits.length, ['commit', 'commity', 'commitów'])}`
        : 'Historia commitów pojawi się po pierwszym zatwierdzeniu.';

    if (!commits.length) {
      this.dom.historyList.append(
        el(
          'div',
          { className: 'empty-state' },
          el('strong', {}, this.git.initialized ? 'Brak commitów' : 'Brak repozytorium'),
          el('span', {}, this.git.initialized
            ? 'Dodaj plik przez git add, a następnie zapisz go przez git commit.'
            : 'Wpisz git init w terminalu, aby rozpocząć.')
        )
      );
      return;
    }

    const rows = assignLanes(commits);
    const maxLanes = Math.max(
      1,
      ...rows.map((row) => Math.max(row.before.length, row.after.length, row.lane + 1))
    );
    const graphWidth = maxLanes * 26;

    for (const row of rows) {
      const { commit } = row;
      const graph = el('div', { className: 'commit-graph' });
      graph.style.width = `${graphWidth}px`;
      graph.innerHTML = buildGraphSvg(row, maxLanes);

      const decorations = this.git.decorations(commit.sha).map((decoration) => {
        if (decoration.startsWith('HEAD -> ')) {
          return el('span', { className: 'head-chip' }, `HEAD → ${decoration.slice(8)}`);
        }
        if (decoration.startsWith('tag: ')) {
          return el('span', { className: 'tag-chip' }, decoration.slice(5));
        }
        return el('span', { className: 'branch-chip' }, decoration);
      });

      const line2 = el(
        'div',
        { className: 'commit-line2' },
        decorations.length ? el('span', { className: 'commit-decorations' }, ...decorations) : null,
        el('span', {}, formatDate(commit.timestamp)),
        commit.parents.length > 1 ? el('span', {}, '· scalenie') : null
      );

      const labels = el(
        'div',
        { className: 'commit-labels' },
        el(
          'div',
          { className: 'commit-line1' },
          el('span', { className: 'commit-subject' }, truncate(commit.message.split('\n')[0], 90)),
          el('span', { className: 'commit-sha' }, commit.sha.slice(0, 7))
        ),
        line2
      );

      const button = el(
        'button',
        {
          className: 'history-row',
          type: 'button',
          dataset: { sha: commit.sha },
          title: 'Zobacz szczegóły commita'
        },
        graph,
        labels
      );
      this.dom.historyList.append(button);
    }
  }

  renderBrief() {
    if (!this.current) return;
    const exercise = this.current;
    const done = this.tasks.filter((task) => task.ok).length;
    const total = this.tasks.length;

    const meta = [
      `<span class="level-badge">${escapeHtml(exercise.level)}</span>`,
      exercise.estimatedMinutes ? `<span>⏱ ${exercise.estimatedMinutes} min</span>` : '',
      `<span>${total} ${plural(total, ['zadanie', 'zadania', 'zadań'])}</span>`
    ].filter(Boolean).join('');

    const tasksHtml = this.tasks
      .map(
        (task) => `
          <div class="task${task.ok ? ' is-done' : ''}">
            <span class="task-icon" aria-hidden="true">✓</span>
            <span class="task-text">${renderInline(task.label)}</span>
          </div>`
      )
      .join('');

    const hintsHtml = exercise.hints
      .map(
        (hint, index) => `
          <details class="hint">
            <summary>Wskazówka ${index + 1}</summary>
            <div class="hint-body">${renderMarkdown(hint)}</div>
          </details>`
      )
      .join('');

    this.dom.brief.innerHTML = `
      <div class="brief-head">
        <div class="brief-eyebrow">${meta}</div>
        <h1>${escapeHtml(exercise.title)}</h1>
        ${exercise.summary ? `<p class="brief-summary">${escapeHtml(exercise.summary)}</p>` : ''}
      </div>
      ${exercise.description ? `<div class="description">${renderMarkdown(exercise.description)}</div>` : ''}
      <div class="section-title"><span>Zadania</span><span id="task-progress">${done}/${total}</span></div>
      <div class="task-list">${tasksHtml}</div>
      <div class="completion-banner"${this.currentComplete ? '' : ' hidden'}>
        <div class="banner-icon">✓</div>
        <div>
          <strong>Świetna robota!</strong>
          <p>Wszystkie zadania są zaliczone. Możesz przejść do kolejnego ćwiczenia.</p>
        </div>
      </div>
      ${exercise.hints.length ? `<div class="section-title"><span>Wskazówki</span><span>${exercise.hints.length}</span></div><div class="hints">${hintsHtml}</div>` : ''}
    `;

    this.dom.brief.scrollTop = 0;
    this.paintTasks();
  }

  paintTasks() {
    const taskNodes = this.dom.brief.querySelectorAll('.task');
    taskNodes.forEach((node, index) => {
      node.classList.toggle('is-done', Boolean(this.tasks[index]?.ok));
    });

    const progress = this.dom.brief.querySelector('#task-progress');
    if (progress) {
      const done = this.tasks.filter((task) => task.ok).length;
      progress.textContent = `${done}/${this.tasks.length}`;
    }

    const banner = this.dom.brief.querySelector('.completion-banner');
    if (banner) banner.hidden = !this.currentComplete;
  }

  updateTasks(options = {}) {
    if (!this.current) return;
    const wasComplete = this.currentComplete;
    this.tasks = evaluateExercise(this.current, {
      git: this.git,
      fs: this.fs,
      history: this.history
    });
    const complete = isExerciseComplete(this.tasks);
    this.currentComplete = complete;

    const completed = this.progress.completed;
    if (complete && !completed.includes(this.current.id)) {
      completed.push(this.current.id);
      this.saveProgress();
      this.renderSidebar();
    }

    if (complete && !wasComplete && options.celebrate) {
      this.toast(`Ćwiczenie „${this.current.title}” zostało ukończone!`, 'success', 5200);
    }

    this.paintTasks();
  }

  /* ---------- File editor ---------- */

  openFileEditor(rawPath, options = {}) {
    if (!this.current) return;
    const isNew = Boolean(options.isNew) || !rawPath;
    const path = VirtualFS.normalize(rawPath);
    const exists = Boolean(path) && this.fs.exists(path);
    const knownToGit = Boolean(path) && (
      Object.prototype.hasOwnProperty.call(this.git.index ?? {}, path) ||
      Object.prototype.hasOwnProperty.call(this.git.getHeadTree() ?? {}, path)
    );
    const deletedContent = path && !exists && knownToGit
      ? this.git.index?.[path] ?? this.git.getHeadTree()?.[path] ?? ''
      : '';
    const content = exists ? this.fs.read(path) : deletedContent;

    const body = el('div');
    let pathInput = null;

    if (isNew) {
      pathInput = el('input', {
        type: 'text',
        id: 'editor-path',
        placeholder: 'np. README.md',
        autocomplete: 'off',
        spellcheck: false
      });
      body.append(
        el(
          'div',
          { className: 'field' },
          el('label', { for: 'editor-path' }, 'Ścieżka pliku'),
          pathInput
        )
      );
    }

    const textarea = el('textarea', {
      id: 'editor-content',
      spellcheck: false,
      placeholder: 'Treść pliku…'
    });
    textarea.value = content;

    body.append(
      el(
        'div',
        { className: 'field' },
        el('label', { for: 'editor-content' }, 'Zawartość'),
        textarea
      ),
      el(
        'p',
        { className: 'modal-note' },
        isNew
          ? 'Nowy plik zostanie utworzony w katalogu roboczym /repo.'
          : exists
            ? 'Zapis zmieni plik w katalogu roboczym. Git zobaczy tę zmianę w statusie.'
            : knownToGit
              ? 'Plik został usunięty — zapis odtworzy go w katalogu roboczym.'
              : 'Plik nie istnieje — zapis utworzy go w katalogu roboczym.'
      )
    );

    let handle = null;

    const save = () => {
      const finalPath = VirtualFS.normalize(
        isNew ? (pathInput?.value ?? '').trim() : path
      );
      if (!finalPath) {
        this.toast('Podaj nazwę pliku.', 'error');
        pathInput?.focus();
        return;
      }
      if (this.fs.isDirectory(finalPath)) {
        this.toast(`„${finalPath}” jest katalogiem — podaj inną nazwę.`, 'error');
        return;
      }
      if (isNew && this.fs.exists(finalPath)) {
        this.toast(`Plik „${finalPath}” już istnieje.`, 'error');
        return;
      }

      this.fs.write(finalPath, textarea.value);
      handle?.close();
      this.toast(`Zapisano plik ${finalPath}.`, 'success');
      this.refreshRepoUI({ celebrate: true });
      this.saveState();
    };

    const footer = [];
    if (exists) {
      footer.push(
        el(
          'button',
          {
            className: 'btn btn-danger',
            type: 'button',
            onClick: async () => {
              const confirmed = await this.confirm({
                title: 'Usunąć plik?',
                message: `Plik „${path}” zostanie usunięty z katalogu roboczego. Jeśli był śledzony, Git zobaczy usunięcie.`,
                confirmLabel: 'Usuń plik',
                danger: true
              });
              if (!confirmed) return;
              this.fs.remove(path);
              handle?.close();
              this.toast(`Usunięto plik ${path}.`, 'info');
              this.refreshRepoUI({ celebrate: true });
              this.saveState();
            }
          },
          'Usuń'
        )
      );
    }
    footer.push(
      el('span', { className: 'spacer' }),
      el('button', { className: 'btn btn-ghost', type: 'button', onClick: () => handle?.close() }, 'Anuluj'),
      el('button', { className: 'btn btn-primary', type: 'button', onClick: save }, 'Zapisz plik')
    );

    handle = this.openModal({
      title: isNew ? 'Nowy plik' : path,
      body,
      footer
    });

    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        save();
      }
    });
  }

  /* ---------- Commit details ---------- */

  showCommitDetail(sha) {
    const details = this.git?.commitDetails(sha);
    if (!details) {
      this.toast('Nie udało się odczytać szczegółów commita.', 'error');
      return;
    }

    const { commit, diff } = details;
    const body = el('div');
    const meta = el('div', { className: 'commit-detail-meta' });
    const addMeta = (label, value) => {
      meta.append(el('div', {}, el('span', {}, label), el('span', {}, value)));
    };

    addMeta('SHA', commit.sha);
    addMeta('Autor', commit.author);
    addMeta('Data', formatDate(commit.timestamp));
    addMeta(
      'Rodzice',
      commit.parents.length ? commit.parents.map((parent) => parent.slice(0, 7)).join(', ') : 'brak (pierwszy commit)'
    );
    const decorations = this.git.decorations(commit.sha);
    if (decorations.length) addMeta('Etykiety', decorations.join(', '));

    body.append(meta);
    body.append(el('p', { className: 'commit-message' }, commit.message));

    const blocks = [];
    let current = null;
    for (const entry of diff) {
      if (entry.type === 'heading' && entry.text.startsWith('diff --git')) {
        current = { title: entry.text.replace(/^diff --git a\//, '').replace(/ b\/.*/, ''), lines: [] };
        blocks.push(current);
      } else if (current) {
        current.lines.push(entry);
      }
    }

    if (!blocks.length) {
      body.append(el('p', { className: 'modal-note' }, 'Ten commit nie zmienia żadnych plików względem rodzica.'));
    }

    for (const block of blocks) {
      const pre = el('pre', { className: 'diff-lines' });
      for (const entry of block.lines) {
        const className =
          entry.type === 'add'
            ? 'diff-line diff-line--add'
            : entry.type === 'del'
              ? 'diff-line diff-line--del'
              : entry.type === 'meta'
                ? 'diff-line diff-line--meta'
                : entry.type === 'hunk'
                  ? 'diff-line diff-line--hunk'
                  : 'diff-line';
        pre.append(el('span', { className }, entry.text || ' '));
      }
      body.append(
        el(
          'div',
          { className: 'diff-block' },
          el('div', { className: 'diff-head' }, block.title),
          pre
        )
      );
    }

    const handle = this.openModal({
      title: `Commit ${commit.sha.slice(0, 7)}`,
      body,
      footer: [
        el('button', { className: 'btn btn-ghost', type: 'button', onClick: () => handle.close() }, 'Zamknij')
      ]
    });
  }

  /* ---------- Reset ---------- */

  async resetExercise() {
    if (!this.current) return;
    const confirmed = await this.confirm({
      title: 'Zresetować ćwiczenie?',
      message: `Cały stan repozytorium i terminala dla ćwiczenia „${this.current.title}” zostanie usunięty. Postęp innych ćwiczeń pozostanie bez zmian.`,
      confirmLabel: 'Resetuj ćwiczenie',
      danger: true
    });
    if (!confirmed) return;

    const id = this.current.id;
    this.current = null;
    try {
      localStorage.removeItem(STATE_PREFIX + id);
    } catch {
      // Ignore storage failures.
    }
    this.progress.completed = this.progress.completed.filter((item) => item !== id);
    this.saveProgress();
    this.selectExercise(id, { fresh: true });
    this.toast('Ćwiczenie zostało zresetowane.', 'info');
  }

  /* ---------- Modal ---------- */

  openModal(options) {
    this.activeModal?.close();

    const overlay = el('div', { className: 'modal-overlay' });
    const modal = el('div', {
      className: `modal${options.small ? ' modal-small' : ''}`,
      role: 'dialog',
      'aria-modal': 'true'
    });
    const closeButton = el(
      'button',
      { className: 'modal-close', type: 'button', 'aria-label': 'Zamknij okno' },
      '×'
    );
    const head = el(
      'div',
      { className: 'modal-head' },
      el('div', { className: 'modal-title-wrap' }, el('h2', {}, options.title)),
      closeButton
    );
    const body = el('div', { className: 'modal-body' });
    if (options.body instanceof Node) body.append(options.body);
    else if (typeof options.body === 'string') body.innerHTML = options.body;

    modal.append(head, body);

    let footer = null;
    if (Array.isArray(options.footer) && options.footer.length) {
      footer = el('div', { className: 'modal-foot' }, ...options.footer);
      modal.append(footer);
    }

    overlay.append(modal);
    this.dom.modalRoot.append(overlay);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown);
      if (this.activeModal?.close === close) this.activeModal = null;
      options.onClose?.();
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };

    closeButton.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKeyDown);

    const handle = { close, modal, body, footer };
    this.activeModal = handle;

    requestAnimationFrame(() => {
      const focusable = modal.querySelector('input, textarea, .modal-foot .btn');
      focusable?.focus();
    });

    return handle;
  }

  confirm(options) {
    return new Promise((resolve) => {
      let settled = false;
      let handle = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        handle?.close();
        resolve(value);
      };

      handle = this.openModal({
        title: options.title,
        small: true,
        body: el('p', {}, options.message),
        footer: [
          el('button', { className: 'btn btn-ghost', type: 'button', onClick: () => finish(false) }, 'Anuluj'),
          el(
            'button',
            {
              className: `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`,
              type: 'button',
              onClick: () => finish(true)
            },
            options.confirmLabel ?? 'Potwierdź'
          )
        ],
        onClose: () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }
      });
    });
  }
}

function assignLanes(commits) {
  const lanes = [];
  const rows = [];

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) {
      lane = lanes.findIndex((value) => !value);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(commit.sha);
      } else {
        lanes[lane] = commit.sha;
      }
    }

    const before = [...lanes];
    lanes[lane] = commit.parents[0] ?? null;

    for (let index = 1; index < commit.parents.length; index += 1) {
      const parent = commit.parents[index];
      if (!parent || lanes.includes(parent)) continue;
      let free = lanes.findIndex((value, laneIndex) => !value && laneIndex !== lane);
      if (free === -1) {
        lanes.push(parent);
        free = lanes.length - 1;
      } else {
        lanes[free] = parent;
      }
    }

    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    const after = [...lanes];
    const parentLanes = {};
    for (const parent of commit.parents) {
      const index = after.indexOf(parent);
      if (index !== -1) parentLanes[parent] = index;
    }

    rows.push({ commit, lane, before, after, parentLanes });
  }

  return rows;
}

function buildGraphSvg(row, maxLanes) {
  const width = Math.max(1, maxLanes) * 26;
  const x = (lane) => lane * 26 + 13;
  const parts = [];

  for (let index = 0; index < row.after.length; index += 1) {
    if (!row.after[index]) continue;
    const startedAbove = Boolean(row.before[index]) || index === row.lane;
    parts.push(
      `<line x1="${x(index)}" y1="${startedAbove ? 0 : 25}" x2="${x(index)}" y2="50" stroke="${GRAPH_COLORS[index % GRAPH_COLORS.length]}" stroke-width="2" opacity="0.7" stroke-linecap="round"/>`
    );
  }

  for (let index = 0; index < row.before.length; index += 1) {
    if (row.before[index] && !row.after[index] && index !== row.lane) {
      parts.push(
        `<line x1="${x(index)}" y1="0" x2="${x(index)}" y2="25" stroke="${GRAPH_COLORS[index % GRAPH_COLORS.length]}" stroke-width="2" opacity="0.7" stroke-linecap="round"/>`
      );
    }
  }

  if (!row.after[row.lane]) {
    parts.push(
      `<line x1="${x(row.lane)}" y1="0" x2="${x(row.lane)}" y2="25" stroke="${GRAPH_COLORS[row.lane % GRAPH_COLORS.length]}" stroke-width="2" opacity="0.7" stroke-linecap="round"/>`
    );
  }

  for (let index = 0; index < row.commit.parents.length; index += 1) {
    const parent = row.commit.parents[index];
    const targetLane = row.parentLanes[parent];
    if (targetLane === undefined || targetLane === row.lane) continue;
    const color = GRAPH_COLORS[(index === 0 ? row.lane : targetLane) % GRAPH_COLORS.length];
    parts.push(
      `<path d="M ${x(row.lane)} 25 C ${x(row.lane)} 38, ${x(targetLane)} 38, ${x(targetLane)} 50" fill="none" stroke="${color}" stroke-width="2" opacity="0.7" stroke-linecap="round"/>`
    );
  }

  parts.push(
    `<circle cx="${x(row.lane)}" cy="25" r="5.5" fill="var(--surface)" stroke="${GRAPH_COLORS[row.lane % GRAPH_COLORS.length]}" stroke-width="2.5"/>`
  );

  return `<svg viewBox="0 0 ${width} 50" width="${width}" height="50" aria-hidden="true">${parts.join('')}</svg>`;
}

function formatBytes(content) {
  const length = new TextEncoder().encode(String(content ?? '')).length;
  if (length < 1024) return `${length} B`;
  return `${(length / 1024).toFixed(1)} KB`;
}
