# Git Lab — interaktywna nauka Gita

Aplikacja webowa (czysty JavaScript, bez zależności i bez etapu budowania), która pozwala ćwiczyć obsługę repozytorium Git w przeglądarce. Repozytorium, pliki i terminal są symulowane lokalnie — nic nie jest wysyłane na serwer.

## Uruchomienie

Wymagany jest Node.js (do serwera statycznego) albo dowolny inny serwer HTTP.

```bash
npm start
```

Następnie otwórz <http://localhost:4173>.

Alternatywnie:

```bash
python3 -m http.server 8080
```

i otwórz <http://localhost:8080>.

> Nie otwieraj `index.html` bezpośrednio z dysku. Przeglądarki blokują wtedy wczytywanie plików JSON z katalogu `exercises/`.

## Jak korzystać

- **Lewy panel** — lista ćwiczeń i postęp.
- **Środek** — opis ćwiczenia, lista zadań i wskazówki.
- **Prawy panel** — terminal Git, edytor plików i historia commitów.
- **Resetuj** w nagłówku przywraca bieżące ćwiczenie do stanu początkowego.
- Stan każdego ćwiczenia zapisuje się w `localStorage`, więc odświeżenie strony nie kasuje postępu.
- Ukończenie ćwiczenia odznacza się automatycznie, gdy wszystkie zadania są spełnione.

### Obsługiwane komendy Git

`init`, `status`, `add`, `commit` (także `--amend`), `log`, `diff`, `show`, `branch`, `checkout`, `switch`, `merge`, `reset`, `restore`, `rm`, `mv`, `tag`, `remote`, `push`, `pull`, `fetch`, `config`.

Dodatkowo dostępne są komendy plikowe: `ls`, `cat`, `touch`, `edit`, `echo`, `rm`, `mv`, `pwd` oraz `clear`. Pełną listę wyświetla `help` i `git help`.

Symulator obsługuje lokalne repozytorium oraz **podstawowe operacje zdalne** (`remote`, `push`, `pull`, `fetch`) w całości wewnątrz przeglądarki. Zdalne repozytorium jest symulowane — żadne dane nie są wysyłane do sieci. `clone`, `stash`, `rebase`, `revert` i `cherry-pick` nie są zaimplementowane.

### Kurs

Katalog `exercises/` zawiera pełny kurs podstawowej obsługi Gita:

1. Pierwszy commit — konfiguracja autora, `init`, `add`, `commit`, `log`.
2. Status i selektywne dodawanie — `status`, wybiórcze `add`, dwa commity.
3. Historia i różnice — `diff`, `log`, `show`.
4. Cofanie zmian — `restore`, `restore --staged`.
5. Poprawka ostatniego commita — `commit --amend`.
6. Gałęzie — `branch`, `switch`, commit na gałęzi.
7. Scalanie fast-forward — `merge`.
8. Rozwiązywanie konfliktów — merge z konfliktem, `add`, commit scalający.
9. Pliki ignorowane — `.gitignore`, wzorce `*.log` i `node_modules/`.
10. Usuwanie i przenoszenie plików — `rm`, `mv`.
11. Cofanie commitów — `reset --hard`, `HEAD~1`.
12. Tagi wersji — `tag`, oznaczanie starszych commitów.
13. Zdalne repozytorium — `remote`, `pull`, commit, `push`.

## Dodawanie własnych ćwiczeń

Wszystkie ćwiczenia znajdują się w katalogu [`exercises/`](exercises/). Aby dodać nowe:

1. Utwórz plik JSON, np. `exercises/02-galezie.json`.
2. Dopisz jego nazwę do listy w `exercises/index.json`.
3. Odśwież stronę.

```json
{
  "exercises": [
    "01-pierwszy-commit.json",
    "02-galezie.json"
  ]
}
```

Kolejność na liście jest kolejnością wyświetlania w aplikacji.

### Format pliku ćwiczenia

```json
{
  "id": "02-galezie",
  "title": "Gałęzie i scalanie",
  "level": "Średniozaawansowany",
  "estimatedMinutes": 15,
  "summary": "Krótki opis widoczny pod tytułem.",
  "description": "## Cel\n\nOpis w Markdownie. Możesz używać **pogrubienia**, `kodu` i bloków kodu.",
  "initialFiles": {
    "README.md": "# Projekt\n"
  },
  "setupCommands": [
    "git init",
    "git add README.md",
    "git commit -m \"Initial commit\""
  ],
  "tasks": [
    {
      "label": "Utworzono gałąź feature",
      "check": { "type": "branchExists", "name": "feature" }
    },
    {
      "label": "Zmiany z feature są w gałęzi main",
      "check": { "type": "commitHasFile", "path": "README.md" }
    }
  ],
  "hints": [
    "Utwórz gałąź: `git branch feature`.",
    "Przełącz się: `git checkout feature`."
  ]
}
```

### Pola

| Pole | Wymagane | Opis |
| --- | --- | --- |
| `id` | tak | Unikalny identyfikator używany w `localStorage`. |
| `title` | tak | Tytuł ćwiczenia. |
| `tasks` | tak | Lista zadań z polami `label` i `check`. |
| `level` | nie | Etykieta poziomu, domyślnie „Ćwiczenie”. |
| `estimatedMinutes` | nie | Szacowany czas w minutach. |
| `summary` | nie | Krótki opis pod tytułem. |
| `description` | nie | Treść w Markdownie. |
| `hints` | nie | Lista wskazówek (Markdown). |
| `initialFiles` | nie | Pliki startowe: obiekt `ścieżka → zawartość`. |
| `setupCommands` | nie | Komendy wykonane po cichu przy pierwszym uruchomieniu ćwiczenia. |

### Warunki (`check`)

Pojedyncze zadanie może mieć jeden warunek albo tablicę warunków (wszystkie muszą być spełnione). Każdy warunek można też zaprzeczyć przez `{ "not": { ... } }`.

| Typ | Pola | Sprawdza |
| --- | --- | --- |
| `initialized` | — | Czy istnieje repozytorium Git. |
| `fileExists` | `path`, opcjonalnie `tracked` | Czy plik istnieje w katalogu roboczym. |
| `fileContent` | `path` oraz `contains`, `equals`, `regex` lub `notContains` | Zawartość pliku. |
| `fileTracked` | `path` | Czy plik występuje w indeksie lub historii. |
| `staged` | `path` | Czy plik jest w poczekalni. |
| `unstaged` | `path` | Czy plik ma niezatwierdzone zmiany. |
| `ignored` | `path` | Czy plik jest ignorowany przez `.gitignore`. |
| `clean` | opcjonalnie `includeUntracked: false` | Czy drzewo robocze jest czyste. |
| `commitCount` | `min`, `max` lub `exact`; opcjonalnie `ref`, `all` | Liczba commitów osiągalnych z refa. |
| `commitHasFile` | `path`, opcjonalnie `ref` lub `scope: "history"` | Czy plik jest w drzewie wskazanego refa (domyślnie HEAD). |
| `commitMessage` | `pattern`; opcjonalnie `last: false`, `ref` | Komunikat ostatniego commita (lub dowolnego). |
| `mergeCommit` | opcjonalnie `ref`, `all` | Czy istnieje commit scalający. |
| `branchExists` | `name`, opcjonalnie `requireCommit` | Czy gałąź istnieje. |
| `currentBranch` | `name` | Czy bieżąca gałąź ma podaną nazwę. |
| `detachedHead` | — | Czy HEAD jest odłączony. |
| `commandUsed` | `pattern`, opcjonalnie `min` | Czy użytkownik wykonał pasującą komendę. |
| `tagExists` | `name` | Czy tag istnieje. |
| `tagAt` | `name`, opcjonalnie `ref` | Czy tag wskazuje na commit wskazany przez `ref` (domyślnie HEAD). |
| `remoteExists` | `name`, opcjonalnie `urlContains` | Czy zdalne repozytorium jest skonfigurowane. |
| `remoteBranchAt` | `remote`, `branch`, opcjonalnie `ref` | Czy zdalna gałąź wskazuje na commit wskazany przez `ref`. |
| `configValue` | `key`, opcjonalnie `value` | Czy w konfiguracji Git ustawiono klucz (i ewentualnie wartość). |

W polach `pattern` i `contains` można podać zwykły fragment tekstu albo wyrażenie regularne w formie `/wzorzec/flags`, np. `/init|pierwszy/i`.

### Wskazówki do autora

- W `setupCommands` możesz użyć dowolnej obsługiwanej komendy, także `echo tekst > plik`.
- Wzorce `.gitignore` obsługują komentarze (`#`), negację (`!`), końcowy `/`, `*`, `**`, `?` oraz wzorce zakotwiczone na początku (`/katalog`).
- Warunki sprawdzają **stan końcowy**, a nie kolejność wykonywania. Jeśli chcesz wymusić konkretną komendę, użyj `commandUsed`.
- Ćwiczenie jest zaliczane, gdy wszystkie zadania są spełnione. Użytkownik może wrócić do niego później — postęp zostanie zapisany.
- Pliki z ćwiczeniami są ładowane przez `fetch`, więc po zmianie odśwież stronę.

## Struktura projektu

```
.
├── index.html          # szkielet aplikacji
├── server.js           # mały serwer statyczny (bez zależności)
├── css/styles.css      # motyw ciemny/jasny i układ
├── exercises/
│   ├── index.json      # manifest ćwiczeń
│   └── 01-pierwszy-commit.json … 13-zdalne-repozytorium.json
└── js/
    ├── app.js          # start aplikacji
    ├── ui.js           # widoki, edytor, modal, postęp
    ├── terminal.js     # terminal i historia komend
    ├── commands.js     # parser komend i powłoka
    ├── git.js          # symulator repozytorium Git
    ├── fs.js           # wirtualny system plików
    ├── diff.js         # generowanie diffów
    ├── exercises.js    # ładowanie i ocena ćwiczeń
    └── utils.js        # Markdown, dopasowywanie wzorców, pomocniki
```

## Ograniczenia symulatora

- Wszystko dzieje się w pamięci przeglądarki i jest zapisywane w `localStorage`.
- Zdalne repozytoria (`origin` itd.) są symulowane lokalnie — nie ma prawdziwej komunikacji sieciowej, `clone` ani uwierzytelniania.
- `git pull` obsługuje fast-forward i „już aktualne”; przy rozbieżnych historiach trzeba scalić zmiany ręcznie.
- Brak hooków, `stash`, `rebase` i operacji na plikach binarnych.
- Scalanie obsługuje fast-forward i podstawowe scalanie trójstronne z konfliktami.
- SHA commitów są uproszczone (40 znaków hex), ale nie są prawdziwymi skrótami SHA-1.
- Aplikacja jest przeznaczona do nauki podstaw i średniozaawansowanych operacji lokalnych oraz prostego obiegu ze zdalnym repozytorium.
