// Imported first by every test process (unit tests through --import, the fixture writer, the
// integration runner config and the restart test): the repository overrides an outer git command
// set (`git rebase --exec`, hooks) would make the tests' git calls write into that repository.
import { REPOSITORY_OVERRIDES } from '../src/git/env.ts';

for (const k of REPOSITORY_OVERRIDES) Reflect.deleteProperty(process.env, k);
