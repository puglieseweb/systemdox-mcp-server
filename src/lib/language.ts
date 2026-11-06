export interface LanguageInfo {
  language: string;
  categories: string[];
}

const EXTENSION_MAP: Record<string, LanguageInfo> = {
  ".py": { language: "python", categories: ["api", "backend", "data-access"] },
  ".ts": { language: "typescript", categories: ["frontend", "api"] },
  ".tsx": { language: "typescript", categories: ["frontend"] },
  ".js": { language: "javascript", categories: ["frontend"] },
  ".jsx": { language: "javascript", categories: ["frontend"] },
  ".yaml": {
    language: "cloudformation",
    categories: ["infrastructure", "architecture"],
  },
  ".yml": {
    language: "cloudformation",
    categories: ["infrastructure", "architecture"],
  },
  ".json": { language: "json", categories: ["configuration"] },
  ".css": { language: "css", categories: ["frontend"] },
  ".html": { language: "html", categories: ["frontend"] },
  ".sql": { language: "sql", categories: ["data-access"] },
  ".sh": { language: "shell", categories: ["infrastructure"] },
  ".bash": { language: "shell", categories: ["infrastructure"] },
  ".tf": { language: "terraform", categories: ["infrastructure"] },
  ".md": { language: "markdown", categories: ["documentation"] },
};

const PATH_CATEGORY_RULES: Array<{ pattern: RegExp; categories: string[] }> = [
  { pattern: /backend\/functions\//, categories: ["api", "backend"] },
  { pattern: /backend\/layers\//, categories: ["backend"] },
  { pattern: /backend\//, categories: ["backend"] },
  { pattern: /apps\/app\//, categories: ["frontend"] },
  { pattern: /apps\/website\//, categories: ["frontend"] },
  { pattern: /apps\/portal\//, categories: ["frontend"] },
  { pattern: /packages\/ui\//, categories: ["frontend"] },
  { pattern: /infra\//, categories: ["infrastructure"] },
  { pattern: /\.github\//, categories: ["infrastructure"] },
  { pattern: /tests?\//, categories: ["testing"] },
  { pattern: /spec/, categories: ["testing"] },
  { pattern: /docs\/adr/, categories: ["architecture"] },
  { pattern: /template\.yaml$/, categories: ["infrastructure", "architecture"] },
];

export function detectLanguage(filePath: string): LanguageInfo | undefined {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return EXTENSION_MAP[ext];
}

export function detectCategories(filePaths: string[]): string[] {
  const categories = new Set<string>();

  for (const filePath of filePaths) {
    const langInfo = detectLanguage(filePath);
    if (langInfo) {
      for (const cat of langInfo.categories) {
        categories.add(cat);
      }
    }

    for (const rule of PATH_CATEGORY_RULES) {
      if (rule.pattern.test(filePath)) {
        for (const cat of rule.categories) {
          categories.add(cat);
        }
      }
    }
  }

  return Array.from(categories);
}

export function detectLanguages(filePaths: string[]): string[] {
  const languages = new Set<string>();
  for (const filePath of filePaths) {
    const info = detectLanguage(filePath);
    if (info) languages.add(info.language);
  }
  return Array.from(languages);
}
