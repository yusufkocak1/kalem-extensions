import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/** The Kalem checkout the extensions are tested in: KALEM_DIR, or ../kalem next to this repository. */
export const KALEM_DIR = resolve(process.env.KALEM_DIR ?? join(import.meta.dirname, "..", "..", "kalem"));
export const KALEM_DESKTOP = join(KALEM_DIR, "apps", "desktop");
export const PACK = join(KALEM_DESKTOP, "scripts", "pack-extension.mjs");
export const EXTENSIONS = join(import.meta.dirname, "..", "extensions");
export const ELECTRON = createRequire(join(KALEM_DESKTOP, "package.json"))("electron") as unknown as string;
