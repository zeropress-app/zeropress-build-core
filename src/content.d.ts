export type DocumentType = 'html' | 'markdown' | 'plaintext';

export interface ContentHeading {
  level: number;
  id: string;
  title: string;
  href: string;
}

export interface RenderedDocument {
  html: string;
  toc: ContentHeading[];
}

/** Render a body using the same sanitization and code highlighting as site builds. */
export function renderDocument(content: string, documentType?: DocumentType): RenderedDocument;
export function renderDocumentContent(content: string, documentType?: DocumentType): string;
