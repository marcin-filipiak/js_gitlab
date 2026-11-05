import { matchesPattern } from './utils.js';

const CHECK_TYPES = new Set([
  'initialized',
  'fileExists',
  'fileContent',
  'fileTracked',
  'staged',
  'unstaged',
  'ignored',
  'clean',
  'commitCount',
  'commitHasFile',
  'commitMessage',
  'mergeCommit',
  'branchExists',
  'currentBranch',
  'detachedHead',
  'commandUsed',
  'tagExists',
  'tagAt',
  'remoteExists',
  'remoteBranchAt',
  'configValue'
]);

export async function loadExercises() {
  let manifestResponse;
  try {
    manifestResponse = await fetch('exercises/index.json', { cache: 'no-store' });
  } catch {
    throw new Error(
      'Nie udało się wczytać ćwiczeń. Otwórz aplikację przez lokalny serwer (npm start lub python3 -m http.server), a nie bezpośrednio z pliku.'
    );
  }

  if (!manifestResponse.ok) {
    throw new Error(
      `Nie udało się wczytać manifestu exercises/index.json (HTTP ${manifestResponse.status}).`
    );
  }

  const manifest = await manifestResponse.json();
  const files = Array.isArray(manifest) ? manifest : manifest.exercises;
  if (!Array.isArray(files) || !files.length) {
    throw new Error('Manifest exercises/index.json nie zawiera listy ćwiczeń.');
  }

  const exercises = [];
  const errors = [];
  const ids = new Set();

  for (const file of files) {
    try {
      const response = await fetch(`exercises/${file}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const exercise = normalizeExercise(data, file);
      if (ids.has(exercise.id)) {
        throw new Error(`Zduplikowany identyfikator ćwiczenia: "${exercise.id}".`);
      }
      ids.add(exercise.id);
      exercises.push(exercise);
    } catch (error) {
      errors.push({ file, message: error.message });
    }
  }

  if (!exercises.length) {
    throw new Error(
      `Nie udało się wczytać żadnego ćwiczenia. ${errors.map((error) => `${error.file}: ${error.message}`).join('; ')}`
    );
  }

  return { exercises, errors };
}

function normalizeExercise(data, file) {
  if (!data || typeof data !== 'object') throw new Error('Treść ćwiczenia musi być obiektem JSON.');
  if (!data.id || typeof data.id !== 'string') throw new Error('Brak pola "id".');
  if (!data.title || typeof data.title !== 'string') throw new Error('Brak pola "title".');
  if (!Array.isArray(data.tasks) || !data.tasks.length) {
    throw new Error('Ćwiczenie musi zawierać co najmniej jedno zadanie w polu "tasks".');
  }

  const tasks = data.tasks.map((task, index) => {
    if (!task || typeof task !== 'object') {
      throw new Error(`Zadanie #${index + 1} musi być obiektem.`);
    }
    if (!task.label || typeof task.label !== 'string') {
      throw new Error(`Zadanie #${index + 1} nie ma pola "label".`);
    }
    if (!task.check || typeof task.check !== 'object') {
      throw new Error(`Zadanie "${task.label}" nie ma pola "check".`);
    }
    validateCheck(task.check, task.label);
    return { label: task.label, check: task.check };
  });

  return {
    id: data.id,
    title: data.title,
    level: typeof data.level === 'string' ? data.level : 'Ćwiczenie',
    estimatedMinutes: Number(data.estimatedMinutes) || null,
    summary: typeof data.summary === 'string' ? data.summary : '',
    description: typeof data.description === 'string' ? data.description : '',
    tasks,
    hints: Array.isArray(data.hints) ? data.hints.filter((hint) => typeof hint === 'string') : [],
    initialFiles:
      data.initialFiles && typeof data.initialFiles === 'object' && !Array.isArray(data.initialFiles)
        ? Object.fromEntries(
            Object.entries(data.initialFiles).map(([path, content]) => [path, String(content ?? '')])
          )
        : {},
    setupCommands: Array.isArray(data.setupCommands)
      ? data.setupCommands.filter((command) => typeof command === 'string' && command.trim())
      : [],
    sourceFile: file
  };
}

function validateCheck(check, label) {
  if (Array.isArray(check)) {
    if (!check.length) throw new Error(`Zadanie "${label}" ma pustą listę warunków.`);
    for (const item of check) validateCheck(item, label);
    return;
  }
  if (check.not) {
    validateCheck(check.not, label);
    return;
  }
  if (!check.type || !CHECK_TYPES.has(check.type)) {
    throw new Error(
      `Zadanie "${label}" używa nieznanego warunku "${check.type ?? '(brak)'}".`
    );
  }
}

export function evaluateExercise(exercise, context) {
  return exercise.tasks.map((task) => ({
    label: task.label,
    ok: evaluateCheck(task.check, context)
  }));
}

export function isExerciseComplete(tasks) {
  return tasks.length > 0 && tasks.every((task) => task.ok);
}

function evaluateCheck(check, context) {
  if (Array.isArray(check)) return check.every((item) => evaluateCheck(item, context));
  if (!check || typeof check !== 'object') return false;
  if (check.not) return !evaluateCheck(check.not, context);

  const { git, fs, history } = context;

  switch (check.type) {
    case 'initialized':
      return Boolean(git.initialized);

    case 'fileExists': {
      if (!check.path) return false;
      if (fs.exists(check.path)) return true;
      return Boolean(check.tracked) && pathInGit(git, check.path);
    }

    case 'fileContent': {
      const content = fs.read(check.path);
      if (content === null) return false;
      if (check.equals !== undefined) return content === String(check.equals);
      if (check.regex !== undefined) {
        try {
          return new RegExp(check.regex, check.flags ?? '').test(content);
        } catch {
          return false;
        }
      }
      if (check.notContains !== undefined) {
        return !matchesPattern(content, check.notContains);
      }
      if (check.contains !== undefined) return matchesPattern(content, check.contains);
      return true;
    }

    case 'fileTracked': {
      if (!check.path) return false;
      return pathInGit(git, check.path);
    }

    case 'staged': {
      if (!check.path) return false;
      return hasPath(git.index, check.path);
    }

    case 'unstaged': {
      if (!check.path) return false;
      const status = git.getStatus();
      return status.unstaged.some(
        (entry) => entry.path === check.path || entry.path.startsWith(`${check.path}/`)
      );
    }

    case 'ignored': {
      if (!check.path) return false;
      return git.isIgnored(check.path);
    }

    case 'clean': {
      const status = git.getStatus();
      const includeUntracked = check.includeUntracked !== false;
      return (
        status.staged.length === 0 &&
        status.unstaged.length === 0 &&
        status.conflicts.length === 0 &&
        (!includeUntracked || status.untracked.length === 0)
      );
    }

    case 'commitCount': {
      const commits = commitsForCheck(git, check);
      const count = commits.length;
      if (check.exact !== undefined && count !== Number(check.exact)) return false;
      if (check.min !== undefined && count < Number(check.min)) return false;
      if (check.max !== undefined && count > Number(check.max)) return false;
      return true;
    }

    case 'commitHasFile': {
      if (!check.path) return false;
      if (check.scope === 'history') {
        return commitsForCheck(git, check).some((commit) =>
          hasPath(commit.tree, check.path)
        );
      }
      const tree = treeForRef(git, check.ref ?? 'HEAD');
      return tree ? hasPath(tree, check.path) : false;
    }

    case 'commitMessage': {
      if (check.pattern === undefined) return false;
      const commits = commitsForCheck(git, check).sort((a, b) => b.seq - a.seq);
      if (check.last !== false) {
        return commits.length > 0 && matchesPattern(commits[0].message, check.pattern);
      }
      return commits.some((commit) => matchesPattern(commit.message, check.pattern));
    }

    case 'mergeCommit': {
      return commitsForCheck(git, check).some((commit) => commit.parents.length > 1);
    }

    case 'branchExists':
      return Boolean(
        check.name &&
          Object.prototype.hasOwnProperty.call(git.branches, check.name) &&
          (check.requireCommit ? Boolean(git.branches[check.name]) : true)
      );

    case 'currentBranch':
      return git.currentBranch() === check.name;

    case 'detachedHead':
      return git.head?.type === 'detached';

    case 'commandUsed': {
      if (check.pattern === undefined) return false;
      const commands = (history ?? [])
        .filter(
          (entry) =>
            check.includeFailed ||
            typeof entry === 'string' ||
            entry.ok !== false
        )
        .map((entry) => (typeof entry === 'string' ? entry : entry.command));
      const matching = commands.filter((command) => matchesPattern(command, check.pattern));
      return matching.length >= (Number(check.min) || 1);
    }

    case 'tagExists':
      return Boolean(check.name && Object.prototype.hasOwnProperty.call(git.tags, check.name));

    case 'tagAt': {
      if (!check.name || !Object.prototype.hasOwnProperty.call(git.tags, check.name)) return false;
      try {
        const sha = git.resolveRef(check.ref ?? 'HEAD');
        return Boolean(sha) && git.tags[check.name] === sha;
      } catch {
        return false;
      }
    }

    case 'remoteExists': {
      if (!check.name || !hasOwn(git.remotes ?? {}, check.name)) return false;
      if (check.urlContains !== undefined) {
        const url = git.remotes[check.name].url ?? '';
        return matchesPattern(url, check.urlContains);
      }
      return true;
    }

    case 'remoteBranchAt': {
      if (!check.remote || !check.branch) return false;
      const remote = (git.remotes ?? {})[check.remote];
      if (!remote) return false;
      const remoteSha = remote.branches?.[check.branch];
      if (!remoteSha) return false;
      try {
        return remoteSha === git.resolveRef(check.ref ?? 'HEAD');
      } catch {
        return false;
      }
    }

    case 'configValue': {
      if (!check.key || !hasOwn(git.config ?? {}, check.key)) return false;
      if (check.value !== undefined) {
        return String(git.config[check.key]) === String(check.value);
      }
      return Boolean(git.config[check.key]);
    }

    default:
      return false;
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasPath(tree, path) {
  if (!tree) return false;
  if (Object.prototype.hasOwnProperty.call(tree, path)) return true;
  const prefix = `${path}/`;
  return Object.keys(tree).some((file) => file.startsWith(prefix));
}

function pathInGit(git, path) {
  return (
    hasPath(git.index, path) ||
    hasPath(git.getHeadTree(), path) ||
    git.getGraphCommits().some((commit) => hasPath(commit.tree, path))
  );
}

function treeForRef(git, ref) {
  try {
    const sha = git.resolveRef(ref);
    return git.getCommit(sha)?.tree ?? null;
  } catch {
    return null;
  }
}

function commitsForCheck(git, check) {
  if (check.all) {
    return git.getGraphCommits();
  }
  if (check.ref) {
    try {
      const sha = git.resolveRef(check.ref);
      return sha ? git.sortedReachable([sha]) : [];
    } catch {
      return [];
    }
  }
  const headSha = git.headSha();
  return headSha ? git.sortedReachable([headSha]) : [];
}
