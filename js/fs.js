export class VirtualFS {
  constructor(initialFiles = {}) {
    this.files = new Map();
    for (const [path, content] of Object.entries(initialFiles)) {
      this.write(path, content);
    }
  }

  static normalize(path) {
    const parts = String(path ?? '')
      .replace(/\\/g, '/')
      .split('/');
    const result = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        result.pop();
        continue;
      }
      result.push(part);
    }
    return result.join('/');
  }

  read(path) {
    const normalized = VirtualFS.normalize(path);
    return this.files.has(normalized) ? this.files.get(normalized) : null;
  }

  write(path, content) {
    const normalized = VirtualFS.normalize(path);
    if (!normalized) throw new Error('Nazwa pliku nie może być pusta.');
    this.files.set(normalized, String(content ?? ''));
    return normalized;
  }

  exists(path) {
    return this.files.has(VirtualFS.normalize(path));
  }

  remove(path) {
    return this.files.delete(VirtualFS.normalize(path));
  }

  removeDirectory(path) {
    const prefix = `${VirtualFS.normalize(path)}/`;
    let removed = 0;
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) {
        this.files.delete(file);
        removed += 1;
      }
    }
    return removed;
  }

  list(path = '') {
    const normalized = VirtualFS.normalize(path);
    const prefix = normalized ? `${normalized}/` : '';
    const entries = new Map();

    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest) continue;
      const [name, ...tail] = rest.split('/');
      const type = tail.length ? 'dir' : 'file';
      if (!entries.has(name) || type === 'dir') entries.set(name, type);
    }

    return [...entries.entries()]
      .map(([name, type]) => ({
        name,
        type,
        path: prefix ? `${prefix}${name}` : name
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'pl');
      });
  }

  paths(prefix = '') {
    const normalized = VirtualFS.normalize(prefix);
    const withSlash = normalized ? `${normalized}/` : '';
    return [...this.files.keys()]
      .filter((path) => path === normalized || path.startsWith(withSlash))
      .sort((a, b) => a.localeCompare(b, 'pl'));
  }

  isDirectory(path) {
    const normalized = VirtualFS.normalize(path);
    if (!normalized) return true;
    const prefix = `${normalized}/`;
    return [...this.files.keys()].some((file) => file.startsWith(prefix));
  }

  move(from, to) {
    const source = VirtualFS.normalize(from);
    const target = VirtualFS.normalize(to);
    if (!this.files.has(source)) return false;
    const content = this.files.get(source);
    this.files.delete(source);
    this.write(target, content);
    return true;
  }

  snapshot() {
    return Object.fromEntries(this.files);
  }

  load(snapshot = {}) {
    this.files = new Map(Object.entries(snapshot));
  }
}
