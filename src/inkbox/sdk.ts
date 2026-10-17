// @inkbox/sdk is loaded on first use so the rest of the code (and dry runs) work without it installed.
// The specifier is a variable so TypeScript does not require the package's types at build time.
const SDK = "@inkbox/sdk";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InkboxSdk = any;

let cached: Promise<InkboxSdk> | undefined;

export function loadSdk(): Promise<InkboxSdk> {
  cached ??= import(SDK).catch((err) => {
    cached = undefined;
    throw new Error(`@inkbox/sdk is not installed (ask Karan to add it to package.json): ${(err as Error).message}`);
  });
  return cached;
}

/** A ready Inkbox client from INKBOX_API_KEY. The key is read from the environment only and never logged. */
export async function createClient(env: NodeJS.ProcessEnv = process.env): Promise<InkboxSdk> {
  const apiKey = env.INKBOX_API_KEY?.trim();
  if (!apiKey) throw new Error("INKBOX_API_KEY is not set");
  const { Inkbox } = await loadSdk();
  return new Inkbox({ apiKey }).ready();
}
