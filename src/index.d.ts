import type { PreviewDataV03 } from '@zeropress/preview-data-validator';

export interface ThemePackage {
  metadata: {
    name: string;
    version: string;
    author?: string | null;
    description?: string;
    thumbnail?: string;
    settings?: Record<string, unknown>;
    namespace?: string;
    slug?: string;
    license?: 'MIT' | 'Apache-2.0' | 'BSD-3-Clause' | 'GPL-3.0-only' | 'GPL-3.0-or-later';
    runtime?: '0.2';
  };
  templates: Map<string, string>;
  partials: Map<string, string>;
  assets: Map<string, Uint8Array>;
}

export interface BuildCoreFile {
  path: string;
  content: string | Uint8Array;
  contentType: string;
}

export interface BuildWriter {
  write(file: BuildCoreFile): Promise<void>;
}

export interface BuildOptions {
  assetHashing?: boolean;
  generateSpecialFiles?: boolean;
  injectHtmx?: boolean;
  writeManifest?: boolean;
}

export interface BuildSelection {
  posts: string[];
  indexRoutes: string[];
  archiveRoutes: string[];
  categoryRoutes: string[];
  tagRoutes: string[];
  includeAssets: boolean;
}

export interface BuildSummaryFile {
  path: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface BuildManifest {
  generatedAt: string;
  files: BuildSummaryFile[];
}

export interface BuildSiteResult {
  files: BuildSummaryFile[];
  manifest?: BuildManifest;
}

export function buildSite(input: {
  previewData: PreviewDataV03;
  themePackage: ThemePackage;
  writer: BuildWriter;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;

export function buildSelectedRoutes(input: {
  previewData: PreviewDataV03;
  themePackage: ThemePackage;
  writer: BuildWriter;
  selection: BuildSelection;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;

export function buildSiteFromThemeDir(input: {
  previewData: PreviewDataV03;
  themeDir: string;
  writer: BuildWriter;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;

export class MemoryWriter implements BuildWriter {
  constructor();
  write(file: BuildCoreFile): Promise<void>;
  getFiles(): BuildCoreFile[];
}

export class FilesystemWriter implements BuildWriter {
  constructor(options: { outDir: string });
  write(file: BuildCoreFile): Promise<void>;
}
