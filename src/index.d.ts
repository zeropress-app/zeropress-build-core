import type { PreviewDataV05 } from '@zeropress/preview-data-validator';
import type { ThemeManifest } from '@zeropress/theme-validator';

export interface ThemePackage {
  metadata: ThemeManifest & {
    thumbnail?: string;
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
  favicon?: {
    icon?: string;
    svg?: string;
    png?: string;
    apple_touch_icon?: string;
  };
  generateSpecialFiles?: boolean;
  generateRobotsTxt?: boolean;
  writeManifest?: boolean;
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
  previewData: PreviewDataV05;
  themePackage: ThemePackage;
  writer: BuildWriter;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;

export function buildSiteFromThemeDir(input: {
  previewData: PreviewDataV05;
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
