export class MemoryWriter {
  constructor() {
    this.files = [];
  }

  async write(file) {
    this.files.push({
      path: normalizeOutputPath(file.path),
      content: file.content,
      contentType: file.contentType,
    });
  }

  getFiles() {
    return [...this.files];
  }
}

function normalizeOutputPath(filePath) {
  return String(filePath || '').replace(/^\/+/, '');
}
