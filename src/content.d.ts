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

export type DataUriImageRemovalReason = 'disabled' | 'unsupported_format' | 'invalid_base64' | 'invalid_image';
export interface ContentRenderOptions {
  allowDataUriImages?: boolean;
  /** Called for removed img src/srcset URLs, with no payload. Never logs. */
  onDataUriImageRemoved?: (reason: DataUriImageRemovalReason) => void;
}

/** Render a body using the same sanitization and code highlighting as site builds. */
export function renderDocument(content: string, documentType?: DocumentType, options?: ContentRenderOptions): RenderedDocument;
export function renderDocumentContent(content: string, documentType?: DocumentType, options?: ContentRenderOptions): string;
