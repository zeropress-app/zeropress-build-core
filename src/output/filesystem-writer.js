export class FilesystemWriter {
  constructor(options) {
    if (!options?.outDir) {
      throw new Error('FilesystemWriter requires outDir');
    }
    this.outDir = options.outDir;
  }

  async write(file) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const relativePath = String(file.path || '').replace(/^\/+/, '');
    const fullPath = path.join(this.outDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content);
  }

  async writeStream(file) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const fullPath = path.join(this.outDir, String(file.path || '').replace(/^\/+/, ''));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const handle = await fs.open(fullPath, 'w');
    try { for await (const part of file.content) await handle.writeFile(part); }
    finally { await handle.close(); }
  }

}
