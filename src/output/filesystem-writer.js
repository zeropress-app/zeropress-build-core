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
}
