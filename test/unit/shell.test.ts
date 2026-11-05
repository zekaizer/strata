import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shellCommand, shellKind } from '../../src/core/shell.ts';

describe('commands typed into a terminal', () => {
  it("knows the shell from VS Code's default shell path", () => {
    assert.equal(shellKind('/bin/bash'), 'posix');
    assert.equal(shellKind('/usr/bin/zsh'), 'posix');
    assert.equal(shellKind('/opt/homebrew/bin/fish'), 'posix');
    assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
    assert.equal(shellKind('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
    assert.equal(shellKind('C:\\WINDOWS\\System32\\cmd.exe'), 'cmd');
    assert.equal(shellKind(''), 'unknown');
    assert.equal(shellKind('/usr/bin/nu'), 'unknown');
  });

  it('quotes for the shell, so a name like a;id stays one argument', () => {
    const args = ['git', 'push', 'origin', "refs/heads/a;id'x:refs/heads/a;id'x"];
    assert.equal(shellCommand(args, 'posix'), "git push origin 'refs/heads/a;id'\\''x:refs/heads/a;id'\\''x'");
    assert.equal(shellCommand(args, 'powershell'), "git push origin 'refs/heads/a;id''x:refs/heads/a;id''x'");
    assert.equal(shellCommand(['git', 'fetch', 'origin'], 'cmd'), 'git fetch origin');
  });

  it('quotes for PowerShell what PowerShell reads as more than a word', () => {
    assert.equal(shellCommand(['git', 'push', 'origin', 'x’;calc;’'], 'powershell'), "git push origin 'x’’;calc;’’'");
    assert.equal(shellCommand(['a‘b‚c‛d'], 'powershell'), "'a‘‘b‚‚c‛‛d'");
    assert.equal(
      shellCommand(['git', 'push', '--force-with-lease=refs/heads/fix,v2', 'origin', '@x'], 'powershell'),
      "git push '--force-with-lease=refs/heads/fix,v2' origin '@x'",
    );
    assert.equal(shellCommand(['-a.b', '--a.b=c', '-u', '--'], 'powershell'), "'-a.b' --a.b=c -u --");
    assert.equal(
      shellCommand(['git', 'push', 'x’;calc;’', 'refs/heads/fix,v2', '@x', '-a.b'], 'posix'),
      "git push 'x’;calc;’' refs/heads/fix,v2 @x -a.b",
    );
  });

  it('quotes a leading = that zsh expands to a command path', () => {
    assert.equal(shellCommand(['git', 'fetch', '=a', 'a=b'], 'posix'), "git fetch '=a' a=b");
  });

  it('gives up where it cannot quote safely', () => {
    assert.equal(shellCommand(['git', 'push', 'origin', 'a&calc'], 'cmd'), undefined);
    assert.equal(shellCommand(['git', 'push', 'origin', 'a$(id)'], 'unknown'), undefined);
    assert.equal(
      shellCommand(['git', 'push', '--progress', 'origin', 'refs/heads/x:refs/heads/x'], 'unknown'),
      'git push --progress origin refs/heads/x:refs/heads/x',
    );
  });
});
