import type { PreviewDataV07 } from '@zeropress/preview-data-validator';
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
    icon_dark?: string;
    svg?: string;
    png?: string;
    apple_touch_icon?: string;
  };
  sitemapStylesheetHref?: string;
  generateFeed?: boolean;
  generateRobotsTxt?: boolean;
  reservedOutputPaths?: readonly string[];
}

export interface DisabledThemeCommentsContext {
  enabled: false;
}

export interface ThemeCommentsThreadingContext {
  enabled: boolean;
  max_depth: number;
}

export interface ZeroPressThemeCommentsContext {
  enabled: true;
  target_type: 'post' | 'page';
  target_public_id: number;
  provider: 'zeropress';
  api_base_url: string;
  per_page: number;
  order: 'asc' | 'desc';
  threading: ThemeCommentsThreadingContext;
  request_token: string;
}

export interface WordPressThemeCommentsContext {
  enabled: true;
  target_type: 'post' | 'page';
  target_public_id: number;
  provider: 'wordpress';
  api_base_url: string;
  per_page: number;
  order: 'asc' | 'desc';
  threading: ThemeCommentsThreadingContext;
  request_token?: never;
}

export type ThemeCommentsContext =
  | DisabledThemeCommentsContext
  | ZeroPressThemeCommentsContext
  | WordPressThemeCommentsContext;

export interface BuildSummaryFile {
  path: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface BuildWarning {
  code: 'MENU_MAX_DEPTH_EXCEEDED';
  message: string;
  menuId: string;
  maxDepth: number;
  actualDepth: number;
  omittedItems: number;
}

export interface BuildSiteResult {
  files: BuildSummaryFile[];
  warnings: BuildWarning[];
}

export function buildSite(input: {
  previewData: PreviewDataV07;
  themePackage: ThemePackage;
  writer: BuildWriter;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;

export function buildSiteFromThemeDir(input: {
  previewData: PreviewDataV07;
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
