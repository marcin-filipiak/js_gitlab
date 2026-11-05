import { GitError } from './git.js';
import { VirtualFS } from './fs.js';
import { tokenize } from './utils.js';

const line = (text, type = 'plain') => ({ text, type });

const GIT_COMMANDS = [
  ['init', 'utwórz nowe repozytorium'],
  ['status', 'pokaż stan plików i poczekalni'],
  ['add <plik>', 'dodaj zmiany do poczekalni (git add . / -A / -u)'],
  ['commit -m "opis"', 'zapisz zmiany z poczekalni (--amend)'],
  ['log', 'pokaż historię commitów (--oneline, --all)'],
  ['diff', 'pokaż różnice (--staged)'],
  ['show <ref>', 'pokaż commit i jego zmiany'],
  ['branch', 'lista gałęzi (git branch -d / -m)'],
  ['checkout <ref>', 'przełącz gałąź lub commit (git checkout -b)'],
  ['switch <ref>', 'przełącz gałąź (git switch -c)'],
  ['merge <gałąź>', 'scal gałąź (git merge --abort)'],
  ['reset --hard <ref>', 'przesuń HEAD (--soft / --mixed / --hard)'],
  ['restore <plik>', 'przywróć plik (--staged)'],
  ['rm <plik>', 'usuń plik z repozytorium (--cached)'],
  ['mv <z> <na>', 'przenieś plik i zaktualizuj indeks'],
  ['tag', 'lista tagów (git tag nazwa [ref])'],
  ['remote', 'zdalne repozytoria (add / remove / -v)'],
  ['push', 'wyślij commity do zdalnego repozytorium'],
  ['pull', 'pobierz i scal zmiany z zdalnego repozytorium'],
  ['fetch', 'pobierz informacje o zdalnych gałęziach'],
  ['config', 'odczytaj lub ustaw konfigurację (user.name)']
];

export class CommandRunner {
  constructor({ fs, git, onEdit = null }) {
    this.fs = fs;
    this.git = git;
    this.onEdit = onEdit;
  }

  run(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return { lines: [], ok: true };

    let tokens;
    try {
      tokens = tokenize(input);
    } catch (error) {
      return { lines: [line(error.message, 'error')], ok: false };
    }

    const [command, ...args] = tokens;
    try {
      switch (command) {
        case 'git':
          return { lines: this.runGit(args), ok: true };
        case 'help':
          return { lines: this.help(), ok: true };
        case 'clear':
          return { lines: [], clear: true, ok: true };
        case 'pwd':
          return { lines: [line('/repo', 'plain')], ok: true };
        case 'ls':
          return { lines: this.ls(args), ok: true };
        case 'cat':
          return { lines: this.cat(args), ok: true };
        case 'touch':
          return { lines: this.touch(args), ok: true };
        case 'edit':
          return { lines: this.edit(args), ok: true };
        case 'echo':
          return { lines: this.echo(args, tokens), ok: true };
        case 'rm':
          return { lines: this.shellRm(args), ok: true };
        case 'mv':
          return { lines: this.shellMv(args), ok: true };
        case 'whoami':
          return { lines: [line('student', 'plain')], ok: true };
        case 'date':
          return { lines: [line(new Date().toLocaleString('pl-PL'), 'plain')], ok: true };
        default:
          throw new Error(
            `Nieznana komenda: "${command}". Wpisz "help", aby zobaczyć dostępne komendy.`
          );
      }
    } catch (error) {
      return { lines: [line(error.message, 'error')], ok: false };
    }
  }

  runGit(args) {
    if (!args.length) {
      throw new GitError('Użycie: git <komenda>. Wpisz "git help", aby zobaczyć listę komend.');
    }

    const [subcommand, ...rest] = args;

    if (subcommand === 'help') return this.gitHelp();
    if (subcommand === '--version' || subcommand === 'version') {
      return [line('git wersja 2.43.0 (symulator Git Lab)', 'muted')];
    }

    switch (subcommand) {
      case 'init': {
        let branch = 'main';
        for (let i = 0; i < rest.length; i += 1) {
          if (rest[i] === '-b' || rest[i] === '--initial-branch') {
            branch = rest[i + 1] ?? 'main';
            i += 1;
          } else if (rest[i].startsWith('--initial-branch=')) {
            branch = rest[i].split('=')[1];
          }
        }
        return this.git.init(branch);
      }
      case 'status':
        return this.git.status();
      case 'add':
        return this.git.add(rest);
      case 'commit':
        return this.commit(rest);
      case 'log':
        return this.git.log(rest);
      case 'diff':
        return this.git.diff(rest);
      case 'show':
        return this.git.show(rest);
      case 'branch':
        return this.git.branch(rest);
      case 'checkout':
        return this.git.checkout(rest);
      case 'switch':
        return this.git.switchBranch(rest);
      case 'merge':
        return this.git.merge(rest);
      case 'reset':
        return this.git.reset(rest);
      case 'restore':
        return this.git.restore(rest);
      case 'rm':
        return this.git.rm(rest, { cached: rest.includes('--cached') });
      case 'mv':
        return this.git.mv(rest);
      case 'tag':
        return this.git.tag(rest);
      case 'config':
        return this.git.configCommand(rest);
      case 'remote':
        return this.git.remoteCommand(rest);
      case 'push':
        return this.git.push(rest);
      case 'pull':
        return this.git.pull(rest);
      case 'fetch':
        return this.git.fetch(rest);
      case 'clone':
        throw new GitError(
          'Klonowanie nie jest dostępne w tej piaskownicy. Utwórz repozytorium przez "git init" i połącz je ze zdalnym przez "git remote add origin <adres>".'
        );
      case 'stash':
        throw new GitError('Komenda "git stash" nie jest jeszcze obsługiwana w tej piaskownicy.');
      case 'revert':
      case 'cherry-pick':
      case 'rebase':
        throw new GitError(`Komenda "git ${subcommand}" nie jest jeszcze obsługiwana w tej piaskownicy.`);
      default:
        throw new GitError(
          `Nieznana komenda git: "${subcommand}". Wpisz "git help", aby zobaczyć obsługiwane komendy.`
        );
    }
  }

  commit(args) {
    let all = false;
    let allowEmpty = false;
    let amend = false;
    const messages = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-m' || arg === '--message') {
        if (i + 1 >= args.length) throw new GitError('Brak komunikatu po opcji -m.');
        messages.push(args[i + 1]);
        i += 1;
      } else if (arg.startsWith('--message=')) {
        messages.push(arg.slice('--message='.length));
      } else if (arg === '-a' || arg === '--all') {
        all = true;
      } else if (arg === '-am' || arg === '-ma') {
        all = true;
        if (i + 1 < args.length) {
          messages.push(args[i + 1]);
          i += 1;
        }
      } else if (arg === '--allow-empty') {
        allowEmpty = true;
      } else if (arg === '--amend') {
        amend = true;
      } else if (/^-m.+/.test(arg)) {
        messages.push(arg.slice(2));
      } else if (arg === '--no-edit' || arg === '-v' || arg === '--verbose') {
        continue;
      } else if (!arg.startsWith('-')) {
        throw new GitError(`Nieoczekiwany argument: "${arg}". Komunikat podaj po -m.`);
      }
    }

    if (all) this.git.stageTracked();

    if (amend) {
      return this.git.amend(messages.join('\n\n') || null, { allowEmpty: true });
    }

    if (!messages.length) {
      throw new GitError('Commit wymaga komunikatu. Użyj: git commit -m "opis zmian"');
    }

    return this.git.commit(messages.join('\n\n'), { allowEmpty });
  }

  ls(args) {
    const target = args.find((arg) => !arg.startsWith('-')) ?? '';
    const path = VirtualFS.normalize(target);

    if (path && this.fs.exists(path)) {
      return [line(path.split('/').pop(), 'plain')];
    }
    if (path && !this.fs.isDirectory(path)) {
      throw new Error(`Nie ma takiego katalogu: ${target}`);
    }

    const entries = this.fs.list(path);
    if (!entries.length) return [line('(pusty katalog)', 'muted')];

    return entries.map((entry) =>
      entry.type === 'dir'
        ? line(`${entry.name}/`, 'accent')
        : line(entry.name, 'plain')
    );
  }

  cat(args) {
    const target = args.find((arg) => !arg.startsWith('-'));
    if (!target) throw new Error('Użycie: cat <plik>');
    const content = this.fs.read(target);
    if (content === null) {
      if (this.fs.isDirectory(target)) throw new Error(`${target} jest katalogiem.`);
      throw new Error(`Nie ma takiego pliku: ${target}`);
    }
    return [line(content || '(pusty plik)', content ? 'plain' : 'muted')];
  }

  touch(args) {
    const target = args.find((arg) => !arg.startsWith('-'));
    if (!target) throw new Error('Użycie: touch <plik>');
    if (this.fs.exists(target)) return [line(`Plik już istnieje: ${target}`, 'muted')];
    const path = this.fs.write(target, '');
    return [line(`Utworzono pusty plik: ${path}`, 'success')];
  }

  edit(args) {
    const target = args.find((arg) => !arg.startsWith('-'));
    if (!target) throw new Error('Użycie: edit <plik>');
    if (!this.onEdit) throw new Error('Edytor nie jest dostępny.');
    const path = VirtualFS.normalize(target);
    this.onEdit(path);
    return [line(`Otwarto edytor pliku ${path}.`, 'muted')];
  }

  echo(args, tokens) {
    const redirectIndex = tokens.findIndex((token) => token === '>' || token === '>>');
    if (redirectIndex === -1) {
      return [line(args.join(' '), 'plain')];
    }
    const append = tokens[redirectIndex] === '>>';
    const contentParts = tokens.slice(1, redirectIndex);
    const target = tokens[redirectIndex + 1];
    if (!target) throw new Error('Brak nazwy pliku po znaku przekierowania.');
    const path = VirtualFS.normalize(target);
    const existing = append ? this.fs.read(path) ?? '' : '';
    const content = `${existing}${contentParts.join(' ')}\n`;
    this.fs.write(path, content);
    return [line(`${append ? 'Dopisano do' : 'Zapisano'}: ${path}`, 'success')];
  }

  shellRm(args) {
    const recursive = args.includes('-r') || args.includes('-R') || args.includes('--recursive');
    const targets = args.filter((arg) => !arg.startsWith('-'));
    if (!targets.length) throw new Error('Użycie: rm [-r] <plik>');

    const output = [];
    for (const target of targets) {
      const path = VirtualFS.normalize(target);
      if (this.fs.exists(path)) {
        this.fs.remove(path);
        output.push(line(`Usunięto plik: ${path}`, 'success'));
      } else if (this.fs.isDirectory(path)) {
        if (!recursive) throw new Error(`Katalog ${target} wymaga opcji -r.`);
        const count = this.fs.removeDirectory(path);
        output.push(line(`Usunięto katalog ${path} (${count} plików).`, 'success'));
      } else if (hasDirectoryPlaceholder(this.fs, path) && recursive) {
        output.push(line(`Katalog ${path} jest pusty.`, 'muted'));
      } else {
        throw new Error(`Nie ma takiego pliku: ${target}`);
      }
    }
    return output;
  }

  shellMv(args) {
    const targets = args.filter((arg) => !arg.startsWith('-'));
    if (targets.length !== 2) throw new Error('Użycie: mv <źródło> <cel>');
    let from = VirtualFS.normalize(targets[0]);
    let to = VirtualFS.normalize(targets[1]);
    if (!this.fs.exists(from)) throw new Error(`Nie ma takiego pliku: ${targets[0]}`);
    if (this.fs.isDirectory(to)) to = `${to}/${from.split('/').pop()}`;
    if (this.fs.exists(to)) throw new Error(`Plik docelowy już istnieje: ${to}`);
    this.fs.move(from, to);
    return [line(`Przeniesiono ${from} → ${to}`, 'success')];
  }

  help() {
    return [
      line('Dostępne komendy', 'heading'),
      line('', 'plain'),
      line('  git <komenda>       komendy Git (wpisz "git help")', 'plain'),
      line('  ls [katalog]        lista plików', 'plain'),
      line('  cat <plik>          pokaż zawartość pliku', 'plain'),
      line('  touch <plik>        utwórz pusty plik', 'plain'),
      line('  edit <plik>         otwórz edytor pliku', 'plain'),
      line('  echo tekst > plik   zapisz tekst do pliku', 'plain'),
      line('  rm [-r] <plik>      usuń plik lub katalog', 'plain'),
      line('  mv <z> <na>          przenieś lub zmień nazwę', 'plain'),
      line('  pwd                 pokaż katalog roboczy', 'plain'),
      line('  clear               wyczyść terminal', 'plain'),
      line('', 'plain'),
      line('Wskazówka: strzałki ↑/↓ przeglądają historię komend.', 'muted')
    ];
  }

  gitHelp() {
    const output = [line('Obsługiwane komendy Git', 'heading'), line('', 'plain')];
    for (const [command, description] of GIT_COMMANDS) {
      output.push(line(`  git ${command.padEnd(24)} ${description}`, 'plain'));
    }
    output.push(line('', 'plain'));
    output.push(line('Repozytorium i zdalne serwery są symulowane lokalnie w przeglądarce — bez połączenia z siecią.', 'muted'));
    return output;
  }
}

function hasDirectoryPlaceholder(fs, path) {
  const prefix = `${path}/`;
  return [...fs.files.keys()].some((file) => file.startsWith(prefix));
}
