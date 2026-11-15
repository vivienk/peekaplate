import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Match menu paths only: a wildcard would also rewrite JS/CSS and the directory JSON.
export const APP_REDIRECTS = `/diner /diner/ 302
/diner/ /diner-shell 200
/diner/:restaurant /diner-shell 200
/diner/:restaurant/ /diner-shell 200
/diner/venues/:venueId/menus/:menuId /diner-shell 200
/diner/venues/:venueId/menus/:menuId/ /diner-shell 200
`;

export async function prepareAppSite(dinerDirectory, outputDirectory) {
  const source = await realpath(dinerDirectory);
  const output = resolve(outputDirectory);
  const distance = relative(source, output);
  if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`)))
    throw new Error('Output must be separate from the diner source');
  const html = await readFile(resolve(source, 'index.html'), 'utf8');
  if (!/src="\/diner\/assets\//.test(html))
    throw new Error('Build diner with --base=/diner/ first');
  // A fresh output prevents overwriting an existing homepage, owner app or deployment artifact.
  await mkdir(output);
  await cp(source, resolve(output, 'diner'), {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (path) => {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error('Artifact symlinks are not allowed');
      return true;
    },
  });
  await writeFile(resolve(output, '_redirects'), APP_REDIRECTS, { flag: 'wx' });
  // Use the clean shell URL outside /diner: avoid canonical redirects and rewrite-loop detection.
  await writeFile(resolve(output, 'diner-shell.html'), html, { flag: 'wx' });
  await writeFile(
    resolve(output, '404.html'),
    '<!doctype html><html lang="en"><title>Page not found</title><h1>Page not found</h1></html>',
    { flag: 'wx' },
  );
  return output;
}

async function main() {
  const { values } = parseArgs({
    options: {
      diner: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values.diner || !values.output)
    throw new Error('Usage: pnpm prepare:app-site --diner BUILD_DIR --output NEW_APP_DIR');
  console.log(await prepareAppSite(values.diner, values.output));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
