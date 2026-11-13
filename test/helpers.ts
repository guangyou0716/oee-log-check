import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const statesExample = join(root, 'examples', 'states-example.csv');
export const countsExample = join(root, 'examples', 'counts-example.csv');
export const counterExample = join(root, 'examples', 'counter-example.csv');
