import { VirtualFS } from './fs.js';
import { unifiedDiff } from './diff.js';
import { formatDate, plural, truncate } from './utils.js';

const line = (text, type = 'plain') => ({ text, type });
const short = (sha) => (sha ? sha.slice(0, 7) : '');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function makeSha(seed) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i += 1) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const part = (value) => (value >>> 0).toString(16).padStart(8, '0');
  return `${part(h1)}${part(h2)}${part(h3)}${part(h4)}${(seed.length >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function conflictBlock(ours, theirs, branchName) {
  const left = ours ?? '';
  const right = theirs ?? '';
  const leftText = left && !left.endsWith('\n') ? `${left}\n` : left;
  const rightText = right && !right.endsWith('\n') ? `${right}\n` : right;
  return `<<<<<<< HEAD\n${leftText}=======\n${rightText}>>>>>>> ${branchName}\n`;
}

function globToRegexSource(glob) {
  let output = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          output += '(?:.*/)?';
          index += 2;
        } else {
          output += '.*';
          index += 1;
        }
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      output += `\\${char}`;
    } else {
      output += char;
    }
  }
  return output;
}

function parseIgnorePatterns(text) {
  const patterns = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line) continue;
    if (line.endsWith('/')) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;

    const hasSlash = line.includes('/');
    const source = globToRegexSource(line);
    const patternSource = hasSlash || anchored
      ? `^${source}(?:$|/)`
      : `(?:^|/)${source}(?:$|/)`;

    try {
      patterns.push({ negated, regex: new RegExp(patternSource) });
    } catch {
      // Pomiń niepoprawny wzorzec.
    }
  }
  return patterns;
}

export class GitError extends Error {}

export class GitEngine {
  constructor(fs, state = null) {
    this.fs = fs;
    this.resetState();
    if (state) this.load(state);
  }

  resetState() {
    this.initialized = false;
    this.commits = {};
    this.branches = {};
    this.tags = {};
    this.head = null;
    this.index = {};
    this.mergeState = null;
    this.remotes = {};
    this.seq = 0;
    this._ignoreCache = null;
    this.config = {
      'user.name': 'Student',
      'user.email': 'student@example.com'
    };
  }

  toJSON() {
    return {
      initialized: this.initialized,
      commits: this.commits,
      branches: this.branches,
      tags: this.tags,
      head: this.head,
      index: this.index,
      merge: this.mergeState,
      remotes: this.remotes,
      seq: this.seq,
      config: this.config
    };
  }

  load(state) {
    if (!state || typeof state !== 'object') return;
    this.initialized = Boolean(state.initialized);
    this.commits = state.commits ?? {};
    this.branches = state.branches ?? {};
    this.tags = state.tags ?? {};
    this.head = state.head ?? null;
    this.index = state.index ?? {};
    this.mergeState = state.merge ?? null;
    this.remotes = state.remotes ?? {};
    this.seq = Number(state.seq) || 0;
    this._ignoreCache = null;
    this.config = {
      'user.name': 'Student',
      'user.email': 'student@example.com',
      ...(state.config ?? {})
    };
  }

  ensureRepo() {
    if (!this.initialized) {
      throw new GitError('To nie jest repozytorium Git. Uruchom najpierw "git init".');
    }
  }

  headSha() {
    if (!this.head) return null;
    if (this.head.type === 'branch') return this.branches[this.head.name] ?? null;
    return this.head.sha ?? null;
  }

  currentBranch() {
    return this.head?.type === 'branch' ? this.head.name : null;
  }

  getCommit(sha) {
    return sha && this.commits[sha] ? this.commits[sha] : null;
  }

  getHeadCommit() {
    return this.getCommit(this.headSha());
  }

  getHeadTree() {
    return this.getHeadCommit()?.tree ?? {};
  }

  resolveRef(ref) {
    if (ref === undefined || ref === null || ref === '' || ref === 'HEAD' || ref === '@') {
      return this.headSha();
    }

    const suffixMatch = /^(.+?)((?:[~^]\d*)+)$/.exec(String(ref));
    if (suffixMatch) {
      let sha = this.resolveRef(suffixMatch[1]);
      const tokens = suffixMatch[2].match(/[~^]\d*/g) ?? [];
      for (const token of tokens) {
        const commit = this.getCommit(sha);
        if (!commit) {
          throw new GitError(`Nie można przejść do "${ref}" — brak commita w historii.`);
        }
        if (token.startsWith('~')) {
          const count = Number(token.slice(1) || 1);
          for (let i = 0; i < count; i += 1) {
            sha = this.getCommit(sha)?.parents[0] ?? null;
            if (!sha) throw new GitError(`Nie można przejść do "${ref}" — historia jest za krótka.`);
          }
        } else {
          const parentNumber = Number(token.slice(1) || 1);
          if (parentNumber === 0) throw new GitError('Odwołanie "^0" nie jest obsługiwane.');
          sha = this.getCommit(sha)?.parents[parentNumber - 1] ?? null;
          if (!sha) throw new GitError(`Nie można przejść do "${ref}" — brak takiego rodzica.`);
        }
      }
      return sha;
    }

    if (hasOwn(this.branches, ref)) return this.branches[ref];
    if (hasOwn(this.tags, ref)) return this.tags[ref];
    if (this.commits[ref]) return ref;

    const matches = Object.keys(this.commits).filter((sha) => sha.startsWith(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new GitError(`Odwołanie "${ref}" jest niejednoznaczne — pasuje kilka commitów.`);
    }
    throw new GitError(`Nie znaleziono odwołania "${ref}".`);
  }

  reachableFrom(shas) {
    const seen = new Set();
    const stack = [...shas].filter(Boolean);
    while (stack.length) {
      const sha = stack.pop();
      if (!sha || seen.has(sha) || !this.commits[sha]) continue;
      seen.add(sha);
      for (const parent of this.commits[sha].parents) stack.push(parent);
    }
    return [...seen].map((sha) => this.commits[sha]);
  }

  sortedReachable(shas) {
    return this.reachableFrom(shas).sort((a, b) => b.seq - a.seq);
  }

  isAncestor(ancestorSha, descendantSha) {
    if (!ancestorSha || !descendantSha) return false;
    if (ancestorSha === descendantSha) return true;
    return this.reachableFrom([descendantSha]).some((commit) => commit.sha === ancestorSha);
  }

  mergeBase(a, b) {
    const theirs = new Set(this.reachableFrom([b]).map((commit) => commit.sha));
    const common = this.reachableFrom([a])
      .filter((commit) => theirs.has(commit.sha))
      .sort((x, y) => y.seq - x.seq);
    return common[0]?.sha ?? null;
  }

  createCommit(message, parents, tree) {
    const timestamp = Date.now();
    const seq = this.seq + 1;
    this.seq = seq;
    const author = `${this.config['user.name']} <${this.config['user.email']}>`;
    const sha = makeSha(
      JSON.stringify({ message, parents, tree, timestamp, seq, author })
    );
    this.commits[sha] = {
      sha,
      message: String(message).trim(),
      parents,
      tree: { ...tree },
      timestamp,
      seq,
      author
    };
    return sha;
  }

  updateHeadReference(sha) {
    if (this.head?.type === 'branch') this.branches[this.head.name] = sha;
    else this.head = { type: 'detached', sha };
  }

  treeChanges(fromTree, toTree) {
    const paths = new Set([...Object.keys(fromTree), ...Object.keys(toTree)]);
    const changes = [];
    for (const path of [...paths].sort((a, b) => a.localeCompare(b, 'pl'))) {
      if (!hasOwn(fromTree, path)) changes.push({ path, status: 'added' });
      else if (!hasOwn(toTree, path)) changes.push({ path, status: 'deleted' });
      else if (fromTree[path] !== toTree[path]) changes.push({ path, status: 'modified' });
    }
    return changes;
  }

  treeHasChanges(fromTree, toTree) {
    return this.treeChanges(fromTree, toTree).length > 0;
  }

  applyTree(tree) {
    const tracked = new Set([...Object.keys(this.index), ...Object.keys(this.getHeadTree())]);
    for (const path of tracked) {
      if (!hasOwn(tree, path)) this.fs.remove(path);
    }
    for (const [path, content] of Object.entries(tree)) {
      this.fs.write(path, content);
    }
    this.index = { ...tree };
  }

  init(branchName = 'main') {
    if (this.initialized) {
      throw new GitError('Repozytorium już istnieje w /repo/. Użyj przycisku „Resetuj”, aby zacząć od nowa.');
    }
    const name = String(branchName || 'main').trim();
    if (!name || name.startsWith('-') || /[\s~^:?*[\\]/.test(name) || name.includes('..')) {
      throw new GitError(`"${name}" nie jest poprawną nazwą gałęzi.`);
    }
    this.initialized = true;
    this.branches = { [name]: null };
    this.tags = {};
    this.head = { type: 'branch', name };
    this.index = {};
    this.mergeState = null;
    return [
      line('Zainicjalizowano puste repozytorium Git w /repo/.', 'success'),
      line(`Domyślna gałąź: ${name}`, 'muted'),
      line(`Utwórz plik, dodaj go przez "git add", a następnie zapisz przez "git commit -m \"komunikat\"".`, 'muted')
    ];
  }

  ignorePatterns() {
    const text = this.fs.read('.gitignore') ?? '';
    if (!this._ignoreCache || this._ignoreCache.text !== text) {
      this._ignoreCache = { text, patterns: parseIgnorePatterns(text) };
    }
    return this._ignoreCache.patterns;
  }

  isIgnored(path) {
    const normalized = VirtualFS.normalize(path);
    if (!normalized) return false;
    let ignored = false;
    for (const pattern of this.ignorePatterns()) {
      if (pattern.regex.test(normalized)) ignored = !pattern.negated;
    }
    return ignored;
  }

  isIgnoredForAdd(path) {
    if (hasOwn(this.index, path) || hasOwn(this.getHeadTree(), path)) return false;
    return this.isIgnored(path);
  }

  getStatus() {
    const headTree = this.getHeadTree();
    const conflictSet = new Set(this.mergeState?.conflicts ?? []);
    const staged = [];
    const unstaged = [];
    const untracked = [];
    const ignored = [];

    if (this.initialized) {
      const paths = new Set([...Object.keys(this.index), ...Object.keys(headTree)]);
      for (const path of paths) {
        if (conflictSet.has(path)) continue;
        if (!hasOwn(this.index, path)) staged.push({ path, status: 'deleted' });
        else if (!hasOwn(headTree, path)) staged.push({ path, status: 'added' });
        else if (headTree[path] !== this.index[path]) staged.push({ path, status: 'modified' });
      }

      for (const path of Object.keys(this.index)) {
        if (conflictSet.has(path)) continue;
        const content = this.fs.read(path);
        if (content === null) unstaged.push({ path, status: 'deleted' });
        else if (content !== this.index[path]) unstaged.push({ path, status: 'modified' });
      }

      for (const path of this.fs.files.keys()) {
        if (!hasOwn(this.index, path) && !hasOwn(headTree, path)) {
          if (this.isIgnored(path)) ignored.push(path);
          else untracked.push(path);
        }
      }
    }

    const sortPaths = (list) => list.sort((a, b) => a.path.localeCompare(b.path, 'pl'));

    return {
      initialized: this.initialized,
      branch: this.currentBranch(),
      detached: this.head?.type === 'detached',
      headSha: this.headSha(),
      staged: sortPaths(staged),
      unstaged: sortPaths(unstaged),
      untracked: untracked.sort((a, b) => a.localeCompare(b, 'pl')),
      ignored: ignored.sort((a, b) => a.localeCompare(b, 'pl')),
      conflicts: [...conflictSet].sort((a, b) => a.localeCompare(b, 'pl')),
      merge: this.mergeState ? { name: this.mergeState.theirsName } : null,
      clean:
        this.initialized &&
        staged.length === 0 &&
        unstaged.length === 0 &&
        untracked.length === 0 &&
        conflictSet.size === 0
    };
  }

  status() {
    this.ensureRepo();
    const status = this.getStatus();
    const output = [];

    if (status.detached) {
      output.push(line(`HEAD odłączony na ${short(status.headSha)}`, 'warn'));
    } else {
      const suffix = status.headSha ? '' : ' (brak commitów)';
      output.push(line(`Na gałęzi ${status.branch}${suffix}`, 'accent'));
    }

    if (status.merge) {
      output.push(line(`Trwa scalanie gałęzi "${status.merge.name}" — rozwiąż konflikty i zatwierdź zmiany.`, 'warn'));
    }

    if (status.conflicts.length) {
      output.push(line('', 'plain'));
      output.push(line('Konflikty scalania (najpierw je rozwiąż):', 'error'));
      for (const path of status.conflicts) output.push(line(`  oba zmienione: ${path}`, 'error'));
    }

    if (status.staged.length) {
      output.push(line('', 'plain'));
      output.push(line('Zmiany do zatwierdzenia:', 'heading'));
      for (const entry of status.staged) {
        const label = entry.status === 'added' ? 'nowy plik' : entry.status === 'deleted' ? 'usunięty' : 'zmodyfikowany';
        output.push(line(`  ${label}: ${entry.path}`, 'success'));
      }
    }

    if (status.unstaged.length) {
      output.push(line('', 'plain'));
      output.push(line('Zmiany nieprzygotowane do zatwierdzenia:', 'heading'));
      for (const entry of status.unstaged) {
        const label = entry.status === 'deleted' ? 'usunięty' : 'zmodyfikowany';
        output.push(line(`  ${label}: ${entry.path}`, 'warn'));
      }
    }

    if (status.untracked.length) {
      output.push(line('', 'plain'));
      output.push(line('Pliki nieśledzone:', 'heading'));
      for (const path of status.untracked) output.push(line(`  ${path}`, 'muted'));
    }

    if (status.ignored.length) {
      output.push(line('', 'plain'));
      output.push(line('Pliki ignorowane przez .gitignore:', 'heading'));
      for (const path of status.ignored) output.push(line(`  ${path}`, 'muted'));
    }

    const hasChanges = status.staged.length || status.unstaged.length || status.untracked.length || status.conflicts.length;
    if (!hasChanges) {
      output.push(line('', 'plain'));
      output.push(line('Nic do zatwierdzenia, drzewo robocze jest czyste.', 'success'));
    } else {
      output.push(line('', 'plain'));
      if (status.staged.length) {
        output.push(line(`Użyj "git commit -m \"opis zmian\"", aby zatwierdzić zmiany z poczekalni.`, 'muted'));
      }
      if (status.unstaged.length || status.untracked.length) {
        output.push(line('Użyj "git add <plik>", aby przygotować zmiany do commita.', 'muted'));
      }
    }

    return output;
  }

  add(args) {
    this.ensureRepo();
    const flags = args.filter((arg) => arg.startsWith('-'));
    const rawPaths = args.filter((arg) => !arg.startsWith('-'));
    const updateOnly = flags.some((flag) => flag === '-u' || flag === '--update');
    const all = flags.some((flag) => flag === '-A' || flag === '--all') || rawPaths.includes('.');

    if (!rawPaths.length && !all && !updateOnly) {
      throw new GitError('Użycie: git add <plik> | git add . | git add -A | git add -u');
    }

    const before = new Map(Object.entries(this.index));
    const errors = [];
    const skipped = [];
    const force = flags.some((flag) => flag === '-f' || flag === '--force');

    const stageFile = (path) => {
      if (!force && this.isIgnoredForAdd(path)) {
        if (!skipped.includes(path)) skipped.push(path);
        return;
      }
      this.index[path] = this.fs.read(path);
    };

    if (all || updateOnly) {
      this.stageTracked();
      if (!updateOnly) {
        for (const path of this.fs.files.keys()) stageFile(path);
      }
    }

    for (const rawPath of rawPaths) {
      if (rawPath === '.') continue;
      const path = VirtualFS.normalize(rawPath);
      if (!path) continue;

      if (this.fs.exists(path)) {
        stageFile(path);
        continue;
      }

      const prefix = `${path}/`;
      const directoryFiles = [...this.fs.files.keys()].filter((file) => file.startsWith(prefix));
      const trackedInDirectory = Object.keys(this.index).filter((file) => file.startsWith(prefix));

      if (directoryFiles.length || trackedInDirectory.length) {
        for (const file of directoryFiles) stageFile(file);
        for (const file of trackedInDirectory) {
          if (!this.fs.exists(file)) delete this.index[file];
        }
        continue;
      }

      if (hasOwn(this.index, path) || hasOwn(this.getHeadTree(), path)) {
        delete this.index[path];
        continue;
      }

      errors.push(rawPath);
    }

    if (errors.length) {
      throw new GitError(`Ścieżka nie istnieje: ${errors.join(', ')}.`);
    }

    const added = [];
    const removed = [];
    for (const [path, content] of Object.entries(this.index)) {
      if (!before.has(path)) added.push(path);
      else if (before.get(path) !== content) added.push(path);
    }
    for (const path of before.keys()) {
      if (!hasOwn(this.index, path)) removed.push(path);
    }

    const output = [];
    for (const path of added) output.push(line(`Dodano do poczekalni: ${path}`, 'success'));
    for (const path of removed) output.push(line(`Przygotowano usunięcie: ${path}`, 'warn'));
    for (const path of skipped) {
      output.push(line(`Pominięto plik ignorowany przez .gitignore: ${path}`, 'warn'));
    }

    if (this.mergeState) {
      for (const path of [...added, ...removed]) {
        if (!this.mergeState.conflicts.includes(path)) continue;
        const content = this.index[path] ?? '';
        if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
          output.push(line(`Uwaga: ${path} nadal zawiera znaczniki konfliktu.`, 'warn'));
        } else {
          this.mergeState.conflicts = this.mergeState.conflicts.filter((item) => item !== path);
          output.push(line(`Konflikt rozwiązany: ${path}`, 'success'));
        }
      }
    }

    if (!output.length) {
      output.push(line('Nie ma nic do dodania — wszystkie zmiany są już w poczekalni.', 'muted'));
    }

    return output;
  }

  stageTracked() {
    for (const path of Object.keys(this.index)) {
      const content = this.fs.read(path);
      if (content === null) delete this.index[path];
      else this.index[path] = content;
    }
  }

  rm(args, options = {}) {
    this.ensureRepo();
    const cached = options.cached || args.includes('--cached');
    const rawPaths = args.filter((arg) => !arg.startsWith('-'));
    if (!rawPaths.length) throw new GitError('Użycie: git rm <plik> | git rm --cached <plik>');

    const output = [];
    for (const rawPath of rawPaths) {
      const path = VirtualFS.normalize(rawPath);
      const prefix = `${path}/`;
      const matches = Object.keys(this.index).filter(
        (file) => !path || file === path || file.startsWith(prefix)
      );
      if (!matches.length) {
        output.push(line(`Plik nie jest śledzony: ${rawPath}`, 'warn'));
        continue;
      }
      for (const file of matches) {
        delete this.index[file];
        if (!cached) this.fs.remove(file);
        output.push(line(`Usunięto: ${file}${cached ? ' (tylko z poczekalni)' : ''}`, 'success'));
      }
    }
    return output;
  }

  mv(args) {
    this.ensureRepo();
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (paths.length !== 2) throw new GitError('Użycie: git mv <źródło> <cel>');
    let from = VirtualFS.normalize(paths[0]);
    let to = VirtualFS.normalize(paths[1]);
    if (!this.fs.exists(from)) throw new GitError(`Plik nie istnieje: ${paths[0]}`);
    if (this.fs.isDirectory(to)) {
      to = `${to}/${from.split('/').pop()}`;
    }
    if (this.fs.exists(to)) throw new GitError(`Plik docelowy już istnieje: ${to}`);

    const wasTracked = hasOwn(this.index, from);
    this.fs.move(from, to);
    if (wasTracked) {
      this.index[to] = this.index[from];
      delete this.index[from];
    }
    return [line(`Przeniesiono ${from} → ${to}`, 'success')];
  }

  commit(message, options = {}) {
    this.ensureRepo();
    const text = String(message ?? '').trim();
    if (!text) {
      throw new GitError('Commit wymaga komunikatu. Użyj: git commit -m "opis zmian"');
    }
    if (this.mergeState?.conflicts?.length) {
      throw new GitError('Nie można zatwierdzić — najpierw rozwiąż konflikty i dodaj pliki przez "git add".');
    }

    const headSha = this.headSha();
    const headTree = this.getHeadTree();
    const isMerge = Boolean(this.mergeState);

    if (!isMerge && !options.allowEmpty && !this.treeHasChanges(headTree, this.index)) {
      throw new GitError('Brak zmian do zatwierdzenia. Dodaj pliki przez "git add" lub zmodyfikuj istniejące.');
    }

    const parents = headSha ? [headSha] : [];
    if (isMerge) parents.push(this.mergeState.theirsSha);
    const sha = this.createCommit(text, parents, this.index);
    this.updateHeadReference(sha);
    this.mergeState = null;

    const changed = this.treeChanges(headTree, this.index);
    const branchLabel = this.head?.type === 'branch' ? this.head.name : 'HEAD odłączony';
    return [
      line(`[${branchLabel} ${short(sha)}] ${truncate(text.split('\n')[0], 72)}`, 'success'),
      line(
        `${isMerge ? 'Scalanie zatwierdzone' : 'Commit zapisany'}: ${changed.length} ${plural(changed.length, [
          'zmiana',
          'zmiany',
          'zmian'
        ])} w drzewie.`,
        'muted'
      )
    ];
  }

  amend(message, options = {}) {
    this.ensureRepo();
    if (this.mergeState?.conflicts?.length) {
      throw new GitError('Nie można poprawić commita — najpierw rozwiąż konflikty scalania.');
    }
    const headSha = this.headSha();
    const previous = this.getCommit(headSha);
    if (!previous) {
      throw new GitError('Nie ma jeszcze żadnego commita do poprawienia.');
    }

    const text = String(message ?? '').trim() || previous.message;
    const tree = { ...this.index };
    if (
      !options.allowEmpty &&
      text === previous.message &&
      !this.treeHasChanges(previous.tree, tree)
    ) {
      throw new GitError(
        'Brak zmian do poprawienia. Dodaj zmiany przez "git add" albo podaj nowy komunikat.'
      );
    }

    const sha = this.createCommit(text, [...previous.parents], tree);
    this.updateHeadReference(sha);
    const branchLabel = this.head?.type === 'branch' ? this.head.name : 'HEAD odłączony';
    return [
      line(`[${branchLabel} ${short(sha)}] ${truncate(text.split('\n')[0], 72)}`, 'success'),
      line(`Poprawiono ostatni commit (poprzedni: ${short(headSha)}).`, 'muted')
    ];
  }

  log(args = []) {
    this.ensureRepo();
    let oneline = false;
    let all = false;
    let graph = false;
    let limit = Infinity;
    let ref = null;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--oneline') oneline = true;
      else if (arg === '--all') all = true;
      else if (arg === '--graph') graph = true;
      else if (arg === '--decorate') continue;
      else if (arg === '-n' || arg === '--max-count') {
        limit = Number(args[i + 1]) || Infinity;
        i += 1;
      } else if (/^-n\d+$/.test(arg)) limit = Number(arg.slice(2));
      else if (arg.startsWith('-')) continue;
      else ref = arg;
    }

    let starts;
    if (all) {
      starts = [
        ...Object.values(this.branches),
        ...Object.values(this.tags),
        this.head?.type === 'detached' ? this.head.sha : null
      ].filter(Boolean);
    } else {
      starts = [ref ? this.resolveRef(ref) : this.headSha()].filter(Boolean);
    }

    if (!starts.length) {
      const branch = this.currentBranch() ?? 'main';
      return [
        line(`Gałąź "${branch}" nie ma jeszcze żadnych commitów.`, 'muted'),
        line(`Wskazówka: dodaj pliki przez "git add" i zapisz je przez "git commit -m \"...\"".`, 'muted')
      ];
    }

    const commits = this.sortedReachable(starts).slice(0, limit);
    const output = [];

    for (const commit of commits) {
      const decorations = this.decorations(commit.sha);
      const decorationText = decorations.length ? ` (${decorations.join(', ')})` : '';
      const firstLine = commit.message.split('\n')[0];

      if (oneline) {
        output.push(
          line(`${graph ? '* ' : ''}${short(commit.sha)}${decorationText} ${firstLine}`, 'plain')
        );
        continue;
      }

      output.push(line(`commit ${commit.sha}${decorationText}`, 'accent'));
      output.push(line(`Author: ${commit.author}`, 'muted'));
      output.push(line(`Date:   ${formatDate(commit.timestamp)}`, 'muted'));
      output.push(line('', 'plain'));
      for (const messageLine of commit.message.split('\n')) {
        output.push(line(`    ${messageLine}`, 'plain'));
      }
      output.push(line('', 'plain'));
    }

    return output;
  }

  decorations(sha) {
    const parts = [];
    const branchesAtSha = Object.keys(this.branches).filter((name) => this.branches[name] === sha);
    const current = this.currentBranch();

    if (this.head?.type === 'detached' && this.head.sha === sha) parts.push('HEAD');
    if (current && branchesAtSha.includes(current)) {
      parts.push(`HEAD -> ${current}`);
    }
    for (const name of branchesAtSha) {
      if (name !== current) parts.push(name);
    }
    for (const [name, target] of Object.entries(this.tags)) {
      if (target === sha) parts.push(`tag: ${name}`);
    }
    return parts;
  }

  branchList(verbose = false) {
    const output = [];
    const current = this.currentBranch();
    const names = Object.keys(this.branches).sort((a, b) => a.localeCompare(b, 'pl'));
    if (!names.length) output.push(line('Brak gałęzi.', 'muted'));

    for (const name of names) {
      const sha = this.branches[name];
      const marker = name === current ? '*' : ' ';
      const suffix = sha
        ? verbose
          ? ` ${short(sha)} ${truncate(this.commits[sha]?.message?.split('\n')[0] ?? '', 50)}`
          : ''
        : ' (brak commitów)';
      output.push(line(`${marker} ${name}${suffix}`, name === current ? 'success' : 'plain'));
    }

    if (this.head?.type === 'detached') {
      output.push(line(`* HEAD odłączony na ${short(this.head.sha)}`, 'warn'));
    }
    return output;
  }

  branch(args = []) {
    this.ensureRepo();
    const deleteFlag = args.includes('-d') || args.includes('-D');
    const forceDelete = args.includes('-D');
    const renameFlag = args.includes('-m') || args.includes('-M');
    const verbose = args.includes('-v') || args.includes('--verbose');
    const showCurrent = args.includes('--show-current');
    const positional = args.filter((arg) => !arg.startsWith('-'));

    if (showCurrent) {
      return [line(this.currentBranch() ?? 'HEAD odłączony', 'plain')];
    }

    if (deleteFlag) {
      const name = positional[0];
      if (!name) throw new GitError('Użycie: git branch -d <nazwa>');
      if (!hasOwn(this.branches, name)) throw new GitError(`Gałąź "${name}" nie istnieje.`);
      if (name === this.currentBranch()) throw new GitError('Nie można usunąć gałęzi, na której jesteś.');
      const sha = this.branches[name];
      if (!forceDelete && sha && !this.isAncestor(sha, this.headSha())) {
        throw new GitError(
          `Gałąź "${name}" nie została scalona. Użyj "git branch -D ${name}", aby usunąć ją mimo to.`
        );
      }
      delete this.branches[name];
      return [line(`Usunięto gałąź "${name}"${sha ? ` (była na ${short(sha)})` : ''}.`, 'success')];
    }

    if (renameFlag) {
      const current = this.currentBranch();
      const oldName = positional.length >= 2 ? positional[0] : current;
      const newName = positional.length >= 2 ? positional[1] : positional[0];
      if (!oldName || !newName) throw new GitError('Użycie: git branch -m [stara] <nowa>');
      if (!hasOwn(this.branches, oldName)) throw new GitError(`Gałąź "${oldName}" nie istnieje.`);
      if (hasOwn(this.branches, newName)) throw new GitError(`Gałąź "${newName}" już istnieje.`);
      this.branches[newName] = this.branches[oldName];
      delete this.branches[oldName];
      if (this.head?.type === 'branch' && this.head.name === oldName) {
        this.head.name = newName;
      }
      return [line(`Zmieniono nazwę gałęzi "${oldName}" na "${newName}".`, 'success')];
    }

    if (!positional.length) return this.branchList(verbose);

    const name = positional[0];
    if (!name || name.startsWith('-') || /[\s~^:?*[\\]/.test(name) || name.includes('..')) {
      throw new GitError(`"${name}" nie jest poprawną nazwą gałęzi.`);
    }
    if (hasOwn(this.branches, name)) throw new GitError(`Gałąź "${name}" już istnieje.`);
    const headSha = this.headSha();
    if (!headSha) throw new GitError('Nie można utworzyć gałęzi bez żadnego commita.');
    this.branches[name] = headSha;
    return [line(`Utworzono gałąź "${name}" na ${short(headSha)}.`, 'success')];
  }

  checkout(args = []) {
    this.ensureRepo();
    let create = false;
    let force = false;
    let target = null;
    const positional = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-b' || arg === '-B' || arg === '-c') {
        create = true;
        target = args[i + 1];
        i += 1;
      } else if (arg === '-f' || arg === '--force') force = true;
      else if (arg === '--') {
        const files = args.slice(i + 1);
        return this.restore(files, { worktree: true });
      } else if (!arg.startsWith('-')) positional.push(arg);
    }

    if (!target) target = positional[0];
    if (!target) throw new GitError('Użycie: git checkout <gałąź|commit> | git checkout -b <nowa-gałąź>');

    if (create) {
      if (!target || target.startsWith('-') || /[\s~^:?*[\\]/.test(target) || target.includes('..')) {
        throw new GitError(`"${target}" nie jest poprawną nazwą gałęzi.`);
      }
      if (hasOwn(this.branches, target)) {
        throw new GitError(`Gałąź "${target}" już istnieje.`);
      }
      const headSha = this.headSha();
      if (!headSha) throw new GitError('Nie można utworzyć gałęzi bez żadnego commita.');
      this.branches[target] = headSha;
      this.head = { type: 'branch', name: target };
      return [line(`Przełączono na nową gałąź "${target}".`, 'success')];
    }

    if (hasOwn(this.branches, target)) {
      const targetSha = this.branches[target];
      if (!targetSha) throw new GitError(`Gałąź "${target}" nie ma jeszcze commitów.`);
      if (this.head?.type === 'branch' && this.head.name === target) {
        return [line(`Już jesteś na gałęzi "${target}".`, 'muted')];
      }
      this.assertCanSwitch(force);
      this.head = { type: 'branch', name: target };
      this.applyTree(this.commits[targetSha].tree);
      return [
        line(`Przełączono na gałąź "${target}".`, 'success'),
        line(`Drzewo robocze zaktualizowane do ${short(targetSha)}.`, 'muted')
      ];
    }

    let sha;
    try {
      sha = this.resolveRef(target);
    } catch {
      throw new GitError(`Nie znaleziono gałęzi ani commita "${target}".`);
    }
    if (!sha) throw new GitError(`Nie znaleziono gałęzi ani commita "${target}".`);
    this.assertCanSwitch(force);
    this.head = { type: 'detached', sha };
    this.applyTree(this.commits[sha].tree);
    return [
      line(`HEAD wskazuje teraz na ${short(sha)} (tryb odłączony).`, 'warn'),
      line(`Drzewo robocze zaktualizowane.`, 'muted')
    ];
  }

  assertCanSwitch(force) {
    if (this.mergeState) {
      throw new GitError('Trwa scalanie. Zakończ je lub przerwij przez "git merge --abort".');
    }
    if (force) return;
    const status = this.getStatus();
    if (status.staged.length || status.unstaged.length) {
      throw new GitError(
        'Masz niezatwierdzone zmiany. Zatwierdź je lub użyj "git checkout -f <gałąź>", aby je odrzucić.'
      );
    }
  }

  switchBranch(args = []) {
    const translated = args.map((arg) => (arg === '-c' ? '-b' : arg));
    return this.checkout(translated);
  }

  diff(args = []) {
    this.ensureRepo();
    const staged = args.includes('--staged') || args.includes('--cached');
    const rawPath = args.find((arg) => !arg.startsWith('-'));
    const pathFilter = rawPath ? VirtualFS.normalize(rawPath) : null;

    const oldTree = staged ? this.getHeadTree() : { ...this.index };
    const newTree = staged ? { ...this.index } : {};
    if (!staged) {
      for (const path of Object.keys(this.index)) {
        const content = this.fs.read(path);
        if (content !== null) newTree[path] = content;
      }
    }

    const output = this.buildDiffLines(oldTree, newTree, pathFilter);
    if (!output.length) {
      return [line(staged ? 'Brak zmian w poczekalni.' : 'Brak zmian w plikach śledzonych.', 'muted')];
    }
    return output;
  }

  buildDiffLines(oldTree, newTree, pathFilter = null) {
    const output = [];
    const paths = new Set([...Object.keys(oldTree), ...Object.keys(newTree)]);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b, 'pl'));

    for (const path of sorted) {
      if (pathFilter && path !== pathFilter && !path.startsWith(`${pathFilter}/`)) continue;
      const oldExists = hasOwn(oldTree, path);
      const newExists = hasOwn(newTree, path);
      const oldText = oldTree[path] ?? '';
      const newText = newTree[path] ?? '';

      if (oldText === newText) {
        if (oldExists === newExists) continue;
        output.push(line(`diff --git a/${path} b/${path}`, 'heading'));
        output.push(line(`${newExists ? 'nowy plik' : 'usunięty plik'}: ${path}`, 'muted'));
        output.push(line('', 'plain'));
        continue;
      }

      output.push(line(`diff --git a/${path} b/${path}`, 'heading'));
      const diff = unifiedDiff(oldText, newText, { path });
      for (const entry of diff) {
        if (entry.type === 'add') output.push(line(entry.text, 'add'));
        else if (entry.type === 'del') output.push(line(entry.text, 'del'));
        else if (entry.type === 'hunk') output.push(line(entry.text, 'meta'));
        else output.push(line(entry.text, 'muted'));
      }
      output.push(line('', 'plain'));
    }

    return output;
  }

  show(args = []) {
    this.ensureRepo();
    const ref = args.find((arg) => !arg.startsWith('-')) ?? 'HEAD';
    const sha = this.resolveRef(ref);
    const commit = this.getCommit(sha);
    if (!commit) throw new GitError(`Nie znaleziono commita "${ref}".`);
    const parentTree = commit.parents[0] ? this.commits[commit.parents[0]]?.tree ?? {} : {};

    const output = [
      line(`commit ${commit.sha}`, 'accent'),
      line(`Author: ${commit.author}`, 'muted'),
      line(`Date:   ${formatDate(commit.timestamp)}`, 'muted'),
      line('', 'plain')
    ];
    for (const messageLine of commit.message.split('\n')) {
      output.push(line(`    ${messageLine}`, 'plain'));
    }
    output.push(line('', 'plain'));
    output.push(...this.buildDiffLines(parentTree, commit.tree));
    return output;
  }

  reset(args = []) {
    this.ensureRepo();
    let mode = 'mixed';
    let ref = null;
    for (const arg of args) {
      if (arg === '--soft') mode = 'soft';
      else if (arg === '--mixed') mode = 'mixed';
      else if (arg === '--hard') mode = 'hard';
      else if (!arg.startsWith('-')) ref = arg;
    }

    const sha = this.resolveRef(ref ?? 'HEAD');
    if (!sha) throw new GitError('Nie można wykonać resetu — brak commitów.');
    const tree = this.commits[sha].tree;

    this.updateHeadReference(sha);
    this.mergeState = null;
    if (mode === 'soft') {
      // Only the branch pointer moves.
    } else if (mode === 'mixed') {
      this.index = { ...tree };
    } else {
      this.applyTree(tree);
    }

    const descriptions = {
      soft: 'wskaźnik gałęzi przesunięty, poczekalnia i pliki bez zmian',
      mixed: 'wskaźnik i poczekalnia zaktualizowane, pliki bez zmian',
      hard: 'wskaźnik, poczekalnia i pliki zaktualizowane'
    };

    return [
      line(`HEAD wskazuje teraz na ${short(sha)} (${mode}).`, 'success'),
      line(descriptions[mode], 'muted')
    ];
  }

  restore(args = [], options = {}) {
    this.ensureRepo();
    const staged = options.staged ?? args.includes('--staged') ?? false;
    const worktree = options.worktree ?? (!staged || args.includes('--worktree') || args.includes('-W'));
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (!paths.length) throw new GitError('Użycie: git restore [--staged] <plik>');

    const headTree = this.getHeadTree();
    const output = [];

    for (const rawPath of paths) {
      const path = VirtualFS.normalize(rawPath);
      const prefix = `${path}/`;
      const candidates = new Set();
      for (const file of [...Object.keys(this.index), ...Object.keys(headTree), ...this.fs.files.keys()]) {
        if (!path || file === path || file.startsWith(prefix)) candidates.add(file);
      }
      if (!candidates.size) {
        output.push(line(`Nie znaleziono ścieżki: ${rawPath}`, 'warn'));
        continue;
      }

      for (const file of candidates) {
        if (staged) {
          if (hasOwn(headTree, file)) this.index[file] = headTree[file];
          else delete this.index[file];
        }
        if (worktree) {
          const source = staged ? headTree[file] : this.index[file];
          if (source !== undefined) {
            this.fs.write(file, source);
          } else if (hasOwn(this.index, file) || hasOwn(headTree, file)) {
            this.fs.remove(file);
          } else {
            continue;
          }
        }
        output.push(line(`Przywrócono: ${file}`, 'success'));
      }
    }

    return output;
  }

  merge(args = []) {
    this.ensureRepo();
    if (args.includes('--abort')) {
      if (!this.mergeState) throw new GitError('Nie trwa żadne scalanie.');
      this.applyTree(this.getHeadTree());
      this.mergeState = null;
      return [line('Scalanie przerwane. Przywrócono stan sprzed scalania.', 'success')];
    }

    if (args.includes('--continue')) {
      if (!this.mergeState) throw new GitError('Nie trwa żadne scalanie.');
      if (this.mergeState.conflicts.length) {
        throw new GitError('Najpierw rozwiąż wszystkie konflikty i dodaj pliki przez "git add".');
      }
      return this.commit(this.mergeState.message ?? 'Merge commit');
    }

    const targetName = args.find((arg) => !arg.startsWith('-'));
    if (!targetName) throw new GitError('Użycie: git merge <gałąź>');
    if (this.mergeState) throw new GitError('Trwa już scalanie. Zakończ je lub użyj "git merge --abort".');
    if (!this.getStatus().clean) {
      throw new GitError('Zatwierdź lub usuń zmiany przed scalaniem — drzewo robocze musi być czyste.');
    }

    const targetSha = this.resolveRef(targetName);
    if (!targetSha) throw new GitError(`Nie znaleziono gałęzi ani commita "${targetName}".`);
    const headSha = this.headSha();
    if (!headSha) throw new GitError('Bieżąca gałąź nie ma jeszcze commitów.');

    if (targetSha === headSha || this.isAncestor(targetSha, headSha)) {
      return [line('Już aktualne — nie ma czego scalać.', 'muted')];
    }

    if (this.isAncestor(headSha, targetSha)) {
      this.updateHeadReference(targetSha);
      this.applyTree(this.commits[targetSha].tree);
      return [
        line('Szybkie przewijanie (fast-forward).', 'success'),
        line(`Wskaźnik przesunięty do ${short(targetSha)}.`, 'muted')
      ];
    }

    const baseSha = this.mergeBase(headSha, targetSha);
    if (!baseSha) throw new GitError('Historie są niepowiązane — scalanie nie jest możliwe.');

    const baseTree = this.commits[baseSha].tree;
    const oursTree = this.commits[headSha].tree;
    const theirsTree = this.commits[targetSha].tree;
    const result = {};
    const conflicts = [];

    const paths = new Set([
      ...Object.keys(baseTree),
      ...Object.keys(oursTree),
      ...Object.keys(theirsTree)
    ]);

    for (const path of paths) {
      const base = baseTree[path];
      const ours = oursTree[path];
      const theirs = theirsTree[path];

      if (ours === theirs) {
        if (ours !== undefined) result[path] = ours;
      } else if (ours === base) {
        if (theirs !== undefined) result[path] = theirs;
      } else if (theirs === base) {
        if (ours !== undefined) result[path] = ours;
      } else {
        conflicts.push(path);
        result[path] = conflictBlock(ours, theirs, targetName);
      }
    }

    this.applyTree(result);
    if (conflicts.length) {
      this.mergeState = {
        theirsSha: targetSha,
        theirsName: targetName,
        baseSha,
        conflicts: conflicts.sort((a, b) => a.localeCompare(b, 'pl')),
        message: `Merge branch '${targetName}'`
      };
      const output = [
        line(`Konflikt scalania w ${conflicts.length} ${plural(conflicts.length, ['pliku', 'plikach', 'plikach'])}:`, 'error')
      ];
      for (const path of this.mergeState.conflicts) output.push(line(`  ${path}`, 'error'));
      output.push(line('', 'plain'));
      output.push(line('Otwórz pliki, rozwiąż konflikty, a następnie użyj "git add <plik>".', 'muted'));
      output.push(line('Na końcu zatwierdź scalenie: git commit -m "Merge".', 'muted'));
      return output;
    }

    const message = `Merge branch '${targetName}'`;
    const sha = this.createCommit(message, [headSha, targetSha], result);
    this.updateHeadReference(sha);
    return [
      line(`Scalanie zakończone: ${short(sha)} (${message}).`, 'success'),
      line(`Zmienionych plików: ${this.treeChanges(oursTree, result).length}.`, 'muted')
    ];
  }

  tag(args = []) {
    this.ensureRepo();
    if (args.includes('-d')) {
      const name = args.find((arg) => !arg.startsWith('-') && arg !== 'd');
      if (!name) throw new GitError('Użycie: git tag -d <nazwa>');
      if (!hasOwn(this.tags, name)) throw new GitError(`Tag "${name}" nie istnieje.`);
      delete this.tags[name];
      return [line(`Usunięto tag "${name}".`, 'success')];
    }

    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (!positional.length) {
      const names = Object.keys(this.tags).sort((a, b) => a.localeCompare(b, 'pl'));
      if (!names.length) return [line('Brak tagów.', 'muted')];
      return names.map((name) => line(`${name} → ${short(this.tags[name])}`, 'plain'));
    }

    const name = positional[0];
    if (hasOwn(this.tags, name)) throw new GitError(`Tag "${name}" już istnieje.`);
    const ref = positional[1] ?? 'HEAD';
    const sha = this.resolveRef(ref);
    if (!sha) throw new GitError('Nie można utworzyć tagu bez commita.');
    this.tags[name] = sha;
    return [line(`Utworzono tag "${name}" na ${short(sha)}.`, 'success')];
  }

  remoteCommand(args = []) {
    this.ensureRepo();
    const [action, ...rest] = args;
    const positional = rest.filter((arg) => !arg.startsWith('-'));

    if (!action || action === '-v' || action === '--verbose') {
      const names = Object.keys(this.remotes).sort((a, b) => a.localeCompare(b, 'pl'));
      if (!names.length) return [line('Brak skonfigurowanych zdalnych repozytoriów.', 'muted')];
      return names.map((name) =>
        line(`${name}\t${this.remotes[name].url} (fetch)`, 'plain')
      );
    }

    if (action === 'add') {
      const [name, url] = positional;
      if (!name || !url) throw new GitError('Użycie: git remote add <nazwa> <adres>');
      if (hasOwn(this.remotes, name)) {
        throw new GitError(`Zdalne repozytorium "${name}" już istnieje.`);
      }
      this.remotes[name] = { url, branches: {} };
      return [line(`Dodano zdalne repozytorium "${name}" → ${url}`, 'success')];
    }

    if (action === 'remove' || action === 'rm') {
      const name = positional[0];
      if (!name) throw new GitError('Użycie: git remote remove <nazwa>');
      if (!hasOwn(this.remotes, name)) {
        throw new GitError(`Zdalne repozytorium "${name}" nie istnieje.`);
      }
      delete this.remotes[name];
      return [line(`Usunięto zdalne repozytorium "${name}".`, 'success')];
    }

    if (action === 'set-url') {
      const [name, url] = positional;
      if (!name || !url) throw new GitError('Użycie: git remote set-url <nazwa> <adres>');
      if (!hasOwn(this.remotes, name)) {
        throw new GitError(`Zdalne repozytorium "${name}" nie istnieje.`);
      }
      this.remotes[name].url = url;
      return [line(`Zmieniono adres "${name}" → ${url}`, 'success')];
    }

    if (action === 'show') {
      const name = positional[0];
      if (!name || !hasOwn(this.remotes, name)) {
        throw new GitError(`Zdalne repozytorium "${name ?? ''}" nie istnieje.`);
      }
      const remote = this.remotes[name];
      const output = [line(`* ${name}`, 'accent'), line(`  URL: ${remote.url}`, 'plain')];
      const branches = Object.entries(remote.branches);
      output.push(line('  Gałęzie zdalne:', 'heading'));
      if (!branches.length) output.push(line('    (brak — wykonaj git push)', 'muted'));
      for (const [branch, sha] of branches) output.push(line(`    ${branch} → ${short(sha)}`, 'plain'));
      return output;
    }

    throw new GitError(`Nieznana operacja "git remote ${action}".`);
  }

  push(args = []) {
    this.ensureRepo();
    const positional = args.filter((arg) => !arg.startsWith('-'));
    const remoteName = positional[0] ?? 'origin';
    const remote = this.remotes[remoteName];
    if (!remote) {
      throw new GitError(
        `Zdalne repozytorium "${remoteName}" nie istnieje. Dodaj je przez "git remote add ${remoteName} <adres>".`
      );
    }

    let localBranch = this.currentBranch();
    let remoteBranch = localBranch;
    if (positional[1]) {
      const [from, to] = positional[1].split(':');
      localBranch = from;
      remoteBranch = to || from;
    }

    if (!localBranch) throw new GitError('Jesteś w trybie odłączonym — wskaż gałąź do wypchnięcia.');
    if (!hasOwn(this.branches, localBranch)) {
      throw new GitError(`Gałąź "${localBranch}" nie istnieje.`);
    }
    const sha = this.branches[localBranch];
    if (!sha) throw new GitError(`Gałąź "${localBranch}" nie ma commitów do wypchnięcia.`);

    remote.branches[remoteBranch] = sha;
    return [
      line(`Wypchnięto ${localBranch} → ${remoteName}/${remoteBranch} (${short(sha)}).`, 'success')
    ];
  }

  fetch(args = []) {
    this.ensureRepo();
    const remoteName = args.find((arg) => !arg.startsWith('-')) ?? 'origin';
    const remote = this.remotes[remoteName];
    if (!remote) {
      throw new GitError(`Zdalne repozytorium "${remoteName}" nie istnieje.`);
    }
    const branches = Object.entries(remote.branches);
    if (!branches.length) {
      return [line(`Zdalne repozytorium "${remoteName}" nie ma jeszcze żadnych gałęzi.`, 'muted')];
    }
    return [
      line(`Pobrano informacje z "${remoteName}".`, 'success'),
      ...branches.map(([branch, sha]) => line(`  ${remoteName}/${branch} → ${short(sha)}`, 'muted')),
      line('Drzewo robocze nie zostało zmienione — użyj "git merge" lub "git pull".', 'muted')
    ];
  }

  pull(args = []) {
    this.ensureRepo();
    if (this.mergeState) {
      throw new GitError('Trwa scalanie. Zakończ je lub przerwij przez "git merge --abort".');
    }
    const positional = args.filter((arg) => !arg.startsWith('-'));
    const remoteName = positional[0] ?? 'origin';
    const remote = this.remotes[remoteName];
    if (!remote) {
      throw new GitError(`Zdalne repozytorium "${remoteName}" nie istnieje.`);
    }

    const remoteBranch = positional[1] ?? this.currentBranch();
    if (!this.currentBranch()) {
      throw new GitError('Nie można wykonać "git pull" w trybie odłączonym.');
    }
    if (!remoteBranch || !hasOwn(remote.branches, remoteBranch)) {
      throw new GitError(
        `Zdalne repozytorium "${remoteName}" nie ma gałęzi "${remoteBranch ?? ''}".`
      );
    }

    const remoteSha = remote.branches[remoteBranch];
    const headSha = this.headSha();

    if (!headSha) {
      this.updateHeadReference(remoteSha);
      this.applyTree(this.commits[remoteSha].tree);
      return [line(`Pobrano zmiany i ustawiono gałąź na ${short(remoteSha)}.`, 'success')];
    }

    if (remoteSha === headSha || this.isAncestor(remoteSha, headSha)) {
      return [line('Już aktualne — zdalna gałąź nie ma nowych commitów.', 'muted')];
    }

    const status = this.getStatus();
    if (status.staged.length || status.unstaged.length) {
      throw new GitError(
        'Masz niezatwierdzone zmiany. Zatwierdź je lub usuń przed wykonaniem "git pull".'
      );
    }

    if (this.isAncestor(headSha, remoteSha)) {
      this.updateHeadReference(remoteSha);
      this.applyTree(this.commits[remoteSha].tree);
      return [
        line(`Pobrano zmiany i szybko przewinięto gałąź "${remoteBranch}" do ${short(remoteSha)}.`, 'success'),
        line('Zdalne zmiany zostały scalone z katalogiem roboczym.', 'muted')
      ];
    }

    throw new GitError(
      'Historie lokalna i zdalna są rozbieżne. Scal je ręcznie przez "git pull" po wcześniejszym commicie lub użyj osobnej gałęzi.'
    );
  }

  configCommand(args = []) {
    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (args.includes('--list') || args.includes('-l')) {
      return Object.entries(this.config).map(([key, value]) => line(`${key}=${value}`, 'plain'));
    }
    if (!positional.length) throw new GitError('Użycie: git config <klucz> [wartość]');
    const key = positional[0];
    if (positional.length === 1) {
      if (!hasOwn(this.config, key)) throw new GitError(`Nie ustawiono wartości dla "${key}".`);
      return [line(this.config[key], 'plain')];
    }
    const value = positional.slice(1).join(' ');
    this.config[key] = value;
    return [line(`Ustawiono ${key} = ${value}`, 'success')];
  }

  getGraphCommits() {
    const tips = [
      ...Object.values(this.branches),
      ...Object.values(this.tags),
      this.head?.type === 'detached' ? this.head.sha : null
    ].filter(Boolean);
    return this.sortedReachable(tips);
  }

  commitDetails(sha) {
    const commit = this.getCommit(sha);
    if (!commit) return null;
    const parentTree = commit.parents[0] ? this.commits[commit.parents[0]]?.tree ?? {} : {};
    return {
      commit,
      diff: this.buildDiffLines(parentTree, commit.tree)
    };
  }
}
