// Shared by the credit count and the indexer so users are only charged for files that get indexed.

const IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".cache",
  "dist",
  "build",
  "out",
  "public",
  "coverage",
  "cypress",
  "tmp",
  "temp",
  "logs",
  "log",
  "images",
  "assets",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
];

const IGNORED_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  ".DS_Store",
];

const IGNORED_EXTENSIONS = [
  // images & media
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "tif", "tiff", "psd",
  "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "ogg", "flac",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // archives & binaries
  "zip", "tar", "gz", "tgz", "rar", "7z", "jar", "exe", "dll", "so", "dylib", "bin", "class", "pyc", "wasm",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // generated
  "map", "min.js", "min.css", "lock",
];

export function shouldIndexPath(path: string): boolean {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1];
  if (segments.slice(0, -1).some((s) => IGNORED_DIRS.includes(s))) return false;
  if (IGNORED_FILES.includes(fileName)) return false;
  const lower = fileName.toLowerCase();
  return !IGNORED_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

/** Same rules in gitignore syntax, for GithubRepoLoader's `ignorePaths`. */
export function ignorePathPatterns(): string[] {
  return [
    ...IGNORED_DIRS.map((d) => `${d}/`),
    ...IGNORED_FILES,
    ...IGNORED_EXTENSIONS.map((ext) => `*.${ext}`),
  ];
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Accepts https://github.com/owner/repo, with or without protocol/www, a trailing slash,
 * `.git`, or extra segments like /tree/main. Returns null when it isn't a repo URL.
 */
export function parseGithubUrl(input: string): { owner: string; repo: string; url: string } | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const [owner, rawRepo] = parsed.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (!owner || !repo || !NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) return null;

  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
