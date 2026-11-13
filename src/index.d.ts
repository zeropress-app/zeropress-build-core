import type { PreviewDataV07, PreviewDataSource, PreviewDataWorkStore } from '@zeropress/preview-data-validator';
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
  writeStream?(file: BuildCoreStreamFile): Promise<void>;
}

export interface BuildOptions {
  /** Allow validated PNG/JPEG/GIF/WebP Base64 body images. Defaults to false. */
  allowDataUriImages?: boolean;
  /** Aggregate removed body image URLs; defaults to allowDataUriImages. */
  reportDataUriImages?: boolean;
  /** Inclusive UTF-8 input-body maximum; omitted/null means no body-policy ceiling. */
  maxBodyBytes?: number | null;
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
  generateSearchIndex?: boolean;
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

export interface MenuDepthWarning {
  code: 'MENU_MAX_DEPTH_EXCEEDED';
  message: string;
  menuId: string;
  maxDepth: number;
  actualDepth: number;
  omittedItems: number;
}

export interface NativeSearchIndexLargeWarning {
  code: 'NATIVE_SEARCH_INDEX_LARGE';
  message: string;
  byteLength: number;
  recordCount: number;
}

export interface NativeSearchIndexSkippedWarning {
  code: 'NATIVE_SEARCH_INDEX_SKIPPED';
  message: string;
  reason: 'requested' | 'record_limit' | 'size_limit';
  recordCount: number;
}

export interface DataUriImagesRemovedWarning {
  code: 'DATA_URI_IMAGES_REMOVED';
  message: string;
  count: number;
  documentCount: number;
  reasons: Partial<Record<import('./content.js').DataUriImageRemovalReason, number>>;
  /** At most ten examples; no image payloads, source text or URLs. */
  affected: { collection: 'posts' | 'pages'; publicId?: number }[];
}

export type BuildWarning =
  | DataUriImagesRemovedWarning
  | import('@zeropress/preview-data-validator/content-policy').ContentBodyWarning
  | MenuDepthWarning
  | NativeSearchIndexLargeWarning
  | NativeSearchIndexSkippedWarning;

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
  writeStream(file: BuildCoreStreamFile): Promise<void>;
  constructor(options: { outDir: string });
  write(file: BuildCoreFile): Promise<void>;
}

export interface BuildCoreStreamFile {
  path: string;
  content: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;
  contentType: string;
}
export function buildSiteFromSource(input: {
  source: PreviewDataSource;
  workStore: PreviewDataWorkStore;
  themePackage: ThemePackage;
  writer: BuildWriter;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;
export function buildSiteFromSourceAndThemeDir(input: {
  source: PreviewDataSource;
  workStore: PreviewDataWorkStore;
  themeDir: string;
  writer: BuildWriter;
  options?: BuildOptions;
}): Promise<BuildSiteResult>;

export type { PreviewDataV07, PreviewDataSource, PreviewDataWorkStore } from '@zeropress/preview-data-validator';
